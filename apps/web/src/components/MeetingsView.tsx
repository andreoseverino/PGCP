import React, { useState, useMemo, useEffect } from "react";
import {
  Calendar,
  Search,
  Filter,
  Download,
  Clock,
  Users,
  Layers,
  ArrowRight,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  HelpCircle,
  FileCheck,
  AlertCircle,
  Edit2,
  Trash2
} from "lucide-react";
import { Meeting } from "../types";
import { getAgendaProgress, readDoneTopicIdsFor, readPostponedTopicIdsFor } from "../lib/meeting-progress";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  pageWindow,
  paginate,
  parsePageSize,
  type PageSize
} from "../lib/pagination";

interface MeetingsViewProps {
  language: "en" | "pt";
  meetings: Meeting[];
  /** Carga inicial vinda de GET /meetings ainda em andamento. */
  meetingsLoading?: boolean;
  /** Mensagem pronta para exibir. `null` quando a carga deu certo. */
  meetingsError?: string | null;
  onReloadMeetings?: () => void;
  onMeetingClick: (meet: Meeting) => void;
  /**
   * Mostrar ações de Assessoria (excluir). "Nova reunião" saiu desta tela
   * (025): agendar é exclusivo do Calendário.
   *
   * Cortesia com quem não pode, não controle de acesso: o servidor
   * revalida `PGCP.Assessoria` em toda mutação de reunião.
   */
  canSchedule?: boolean;
  onDeleteMeeting: (id: string) => void;
}

export default function MeetingsView({
  language,
  meetings,
  meetingsLoading = false,
  meetingsError = null,
  onReloadMeetings,
  onMeetingClick,
  canSchedule = false,
  onDeleteMeeting
}: MeetingsViewProps) {
  const [activeTab, setActiveTab] = useState<"Upcoming" | "Past">("Upcoming");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("All Statuses");
  const [selectedCategory, setSelectedCategory] = useState("Category");
  const [selectedMonth, setSelectedMonth] = useState("All Months");
  const [currentPage, setCurrentPage] = useState(1);
  /*
   * Quantidade por página. Client-side: `GET /meetings` não pagina — o contrato
   * só aceita um teto (`limit`) e devolve a lista inteira. Trocar isto por
   * paginação de servidor exigiria endpoint novo, e a tela não precisa.
   */
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

  const t = {
    title: language === "en" ? "Meetings" : "Reuniões",
    subTitle: language === "en" ? "Manage and review corporate governance sessions." : "Gerencie e analise as sessões de governança corporativa.",
    btnExport: language === "en" ? "Export" : "Exportar",
    tabUpcoming: language === "en" ? "Upcoming" : "Próximas",
    tabPast: language === "en" ? "Past" : "Concluídas",
    searchPlaceholder: language === "en" ? "Search meetings..." : "Buscar reuniões...",
    optAllStatuses: language === "en" ? "All Statuses" : "Todos os Status",
    optCategory: language === "en" ? "Category" : "Categoria",
    optAllCategories: language === "en" ? "All Categories" : "Todas as Categorias",
    labelExpected: language === "en" ? "Expected" : "Confirmados",
    labelAgendaItems: language === "en" ? "Agenda Items" : "Itens de Pauta",
    btnViewDetails: language === "en" ? "View Details" : "Ver Detalhes",
    btnReviewNow: language === "en" ? "Review Now" : "Revisar Agora",
    showingLabel: language === "en" ? "Showing" : "Exibindo",
    ofLabel: language === "en" ? "of" : "de",
    resultsText: language === "en" ? "meetings" : "reuniões",
    itemsPerPageLabel: language === "en" ? "Items per page:" : "Itens por página:",
    previousPage: language === "en" ? "Previous page" : "Página anterior",
    nextPage: language === "en" ? "Next page" : "Próxima página",
    missingPreRead: language === "en" ? "Missing pre-read board packet materials." : "Ausente: Materiais prévios recomendados para o conselho.",
    optAllMonths: language === "en" ? "All Months" : "Todos os Meses",
    
    // Header labels for the list/table view
    colDate: language === "en" ? "Date & Time" : "Data e Horário",
    colMeeting: language === "en" ? "Meeting & Category" : "Reunião e Segmento",
    colExpected: language === "en" ? "Participants" : "Participantes",
    colStatus: language === "en" ? "Status" : "Status",
    colActions: language === "en" ? "Actions" : "Ações"
  };

  // Dynamically extract all unique month-years from meeting dates
  const availableMonths = useMemo(() => {
    const list: string[] = [];
    meetings.forEach((m) => {
      if (!m.date) return;
      const dateObj = new Date(m.date + "T10:00:00");
      const monthLabel = dateObj.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", {
        month: "long",
        year: "numeric"
      });
      const capitalized = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
      if (!list.includes(capitalized)) {
        list.push(capitalized);
      }
    });

    // Chronological sorting
    return list.sort((a, b) => {
      const getCompareDate = (monthStr: string) => {
        const found = meetings.find(m => {
          const d = new Date(m.date + "T10:00:00");
          const lbl = d.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", { month: "long", year: "numeric" });
          const cap = lbl.charAt(0).toUpperCase() + lbl.slice(1);
          return cap === monthStr;
        });
        return found ? found.date : "";
      };
      return getCompareDate(a).localeCompare(getCompareDate(b));
    });
  }, [meetings, language]);

  /*
   * Categorias reais, derivadas das reuniões — igual `availableMonths` acima.
   * As opções fixas ("Board Meeting", "Committee", "Shareholder") eram
   * texto de protótipo em inglês que nunca batia com `m.category` (nome do
   * órgão de governança, em português): o filtro nunca filtrava nada.
   */
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    meetings.forEach((m) => {
      if (m.category) set.add(m.category);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [meetings]);

  // Filter meetings based on tab, search, status, category, and selected month
  const filteredMeetings = useMemo(() => {
    return meetings.filter((m) => {
      // 1. Tab check: "Past" corresponds to "Done" and "Closed"
      const isPast = m.status === "Done" || m.status === "Closed";
      if (activeTab === "Upcoming" && isPast) return false;
      if (activeTab === "Past" && !isPast) return false;

      // 2. Search check:
      if (searchQuery.trim() !== "") {
        const query = searchQuery.toLowerCase();
        const matchesTitle = m.title.toLowerCase().includes(query);
        const matchesOrg = m.organizer.toLowerCase().includes(query);
        if (!matchesTitle && !matchesOrg) return false;
      }

      // 3. Status check:
      if (selectedStatus !== "All Statuses" && selectedStatus !== "Todos os Status") {
        if (m.status !== selectedStatus) return false;
      }

      // 4. Category check:
      if (selectedCategory !== "Category" && selectedCategory !== "All Categories" && selectedCategory !== "Todas as Categorias") {
        if (m.category !== selectedCategory) return false;
      }

      // 5. Month-Year limit filter check:
      if (selectedMonth !== "All Months" && selectedMonth !== "Todos os Meses") {
        const d = new Date(m.date + "T10:00:00");
        const lbl = d.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", { month: "long", year: "numeric" });
        const capitalized = lbl.charAt(0).toUpperCase() + lbl.slice(1);
        if (capitalized !== selectedMonth) return false;
      }

      return true;
    });
  }, [meetings, activeTab, searchQuery, selectedStatus, selectedCategory, selectedMonth, language]);

  /** Rótulo do mês da reunião, no mesmo formato usado pelo filtro de mês. */
  const monthLabelOf = (m: Meeting) => {
    const d = new Date(m.date + "T10:00:00");
    const monthLabel = d.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", {
      month: "long",
      year: "numeric"
    });
    return monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  };

  // Group meetings by Month string
  const meetingsGroupedByMonth = useMemo(() => {
    const groups: { [key: string]: Meeting[] } = {};
    filteredMeetings.forEach((m) => {
      if (!m.date) return;
      const capitalized = monthLabelOf(m);
      if (!groups[capitalized]) {
        groups[capitalized] = [];
      }
      groups[capitalized].push(m);
    });
    return groups;
  }, [filteredMeetings, language]);

  // Sort groups chronologically
  const sortedMonthKeys = useMemo(() => {
    return Object.keys(meetingsGroupedByMonth).sort((a, b) => {
      const dateA = meetingsGroupedByMonth[a][0]?.date || "";
      const dateB = meetingsGroupedByMonth[b][0]?.date || "";
      if (activeTab === "Upcoming") {
        return dateA.localeCompare(dateB); // closest first for upcoming sessions
      } else {
        return dateB.localeCompare(dateA); // most recent first for past review
      }
    });
  }, [meetingsGroupedByMonth, activeTab]);

  /*
   * PAGINAÇÃO.
   *
   * A tela já tem uma ordem de exibição: os grupos de mês na ordem de
   * `sortedMonthKeys` e, dentro de cada grupo, a ordem que veio da API. A
   * página é um CORTE dessa mesma sequência — nada é reordenado, só recortado.
   * Por isso o achatamento sai dos grupos, e não de `filteredMeetings`.
   */
  const orderedMeetings = useMemo(
    () => sortedMonthKeys.flatMap((key) => meetingsGroupedByMonth[key]),
    [sortedMonthKeys, meetingsGroupedByMonth]
  );

  const pagina = useMemo(
    () => paginate(orderedMeetings, currentPage, pageSize),
    [orderedMeetings, currentPage, pageSize]
  );

  /*
   * Filtro, busca ou troca de tamanho podem encolher o total e deixar
   * `currentPage` apontando para uma página que não existe mais. `paginate` já
   * devolve a página válida; aqui o ESTADO é trazido de volta para ela, para os
   * controles não dizerem "página 7" enquanto mostram a 1.
   */
  useEffect(() => {
    if (pagina.page !== currentPage) setCurrentPage(pagina.page);
  }, [pagina.page, currentPage]);

  /** Os mesmos grupos de mês, contendo só o que esta página mostra. */
  const pageGroups = useMemo(() => {
    const groups: { key: string; meetings: Meeting[] }[] = [];
    pagina.items.forEach((m) => {
      const key = monthLabelOf(m);
      const ultimo = groups[groups.length - 1];
      if (ultimo && ultimo.key === key) ultimo.meetings.push(m);
      else groups.push({ key, meetings: [m] });
    });
    return groups;
  }, [pagina.items, language]);

  const handleExportCSV = () => {
    const headers = language === "en"
      ? "ID,Title,Date,Time,Category,Status,Organizer\n"
      : "ID,Título,Data,Horário,Categoria,Status,Organizador\n";
    // Mesmo rótulo do badge na tela (linha ~621) — nunca o valor bruto do enum.
    const statusLabel = (status: string) =>
      language === "en"
        ? status
        : status === "In Progress" ? "Iniciação"
        : status === "Scheduled" ? "Agendada"
        : status === "Done" ? "Concluído"
        : status === "Closed" ? "Fechado"
        : status === "Needs Approval" ? "Requer Aprovação"
        : status === "Draft" ? "Rascunho"
        : status;
    const dataRows = filteredMeetings.map(m =>
      `"${m.id}","${m.title}","${m.date}","${m.startTime} - ${m.endTime}","${m.category}","${statusLabel(m.status)}","${m.organizer}"`
    ).join("\n");
    const csvContent = "data:text/csv;charset=utf-8," + headers + dataRows;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Cielo_Meetings_Export_${activeTab}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 text-xs text-slate-700 font-semibold leading-relaxed">
      {/* Top Header section */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200/60">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 font-sans">
            {t.title}
          </h2>
          <p className="text-slate-500 font-medium text-sm mt-1 matches-subheading-style">
            {t.subTitle}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExportCSV}
            className="px-4 py-2.5 rounded-lg border border-slate-200 text-slate-600 font-bold text-xs uppercase tracking-wider bg-white hover:bg-slate-50 hover:border-slate-300 transition-all flex items-center gap-2 cursor-pointer transition-all"
          >
            <Download className="w-3.5 h-3.5 text-slate-500 animate-pulse" />
            {t.btnExport}
          </button>
        </div>
      </header>

      {/* Filter and Control Toolbar */}
      <section className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-3 w-full">
        {/* Navigation Tab buttons */}
        <div className="flex p-0.5 bg-slate-100 rounded-lg w-full lg:w-auto shrink-0 select-none">
          <button
            onClick={() => { setActiveTab("Upcoming"); setCurrentPage(1); }}
            className={`flex-1 lg:flex-none px-6 py-2 rounded-md font-bold text-xs uppercase tracking-wider transition-all duration-200 ${
              activeTab === "Upcoming"
                ? "bg-white text-[#00658d]"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.tabUpcoming}
          </button>
          <button
            onClick={() => { setActiveTab("Past"); setCurrentPage(1); }}
            className={`flex-1 lg:flex-none px-6 py-2 rounded-md font-bold text-xs uppercase tracking-wider transition-all duration-200 ${
              activeTab === "Past"
                ? "bg-white text-[#00658d]"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.tabPast}
          </button>
        </div>

        {/* Dynamic Filters form */}
        <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
          {/* Searching input */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              placeholder={t.searchPlaceholder}
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-sans placeholder:text-slate-400 focus:bg-white focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] outline-none transition-all text-slate-800"
            />
          </div>

          {/* Status Selection */}
          <div className="relative">
            <select
              value={selectedStatus}
              onChange={(e) => { setSelectedStatus(e.target.value); setCurrentPage(1); }}
              className="appearance-none bg-slate-50 hover:bg-slate-100/50 text-slate-600 font-semibold text-xs border border-slate-200 rounded-xl pl-4 pr-9 py-2 cursor-pointer focus:ring-1 focus:ring-[#00658d] focus:bg-white focus:outline-none transition-all"
            >
              <option value="All Statuses">{t.optAllStatuses}</option>
              <option value="Scheduled">{language === "en" ? "Scheduled" : "Agendada"}</option>
              <option value="Draft">{language === "en" ? "Draft" : "Rascunho"}</option>
              <option value="Needs Approval">{language === "en" ? "Needs Approval" : "Requer Aprovação"}</option>
              <option value="In Progress">{language === "en" ? "In Progress" : "Iniciação"}</option>
            </select>
          </div>

          {/* Category selection selector */}
          <div className="relative">
            <select
              value={selectedCategory}
              onChange={(e) => { setSelectedCategory(e.target.value); setCurrentPage(1); }}
              className="appearance-none bg-slate-50 hover:bg-slate-100/50 text-slate-600 font-semibold text-xs border border-slate-200 rounded-xl pl-4 pr-9 py-2 cursor-pointer focus:ring-1 focus:ring-[#00658d] focus:bg-white focus:outline-none transition-all"
            >
              <option value="Category">{t.optCategory}</option>
              {availableCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          {/* Month level selecting filter dropdown */}
          <div className="relative">
            <select
              value={selectedMonth}
              onChange={(e) => { setSelectedMonth(e.target.value); setCurrentPage(1); }}
              className="appearance-none bg-slate-50 hover:bg-slate-100/50 text-slate-600 font-semibold text-xs border border-slate-200 rounded-xl pl-4 pr-9 py-2 cursor-pointer focus:ring-1 focus:ring-[#00658d] focus:bg-white focus:outline-none transition-all"
            >
              <option value="All Months">{t.optAllMonths}</option>
              {availableMonths.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* HORIZONTAL LIST / TABLE VIEW */}
      <section className="bg-white overflow-hidden w-full max-w-full">
        <div className="overflow-x-auto w-full">
          <table className="w-full text-left border-collapse min-w-[800px]">
            
            {/* Table Headers */}
            <thead>
              <tr className="bg-slate-50/75 border-b border-slate-200 text-slate-450 text-[10px] uppercase tracking-wider select-none">
                {/*
                  Largura das colunas declarada SO aqui, em porcentagem, e nunca
                  repetida nas celulas: com `table-layout: auto` o cabecalho e
                  quem dimensiona a coluna inteira.

                  "Reunião e Segmento" leva `w-full` — o idioma de tabela para
                  "fique com a sobra". As outras seis somam 64%, entao o titulo
                  absorve o restante em vez de deixar folga onde ficava a antiga
                  coluna de Local. Porcentagem, e nao pixel, para o conjunto
                  continuar acompanhando a largura disponivel.
                */}
                <th className="py-4 px-5 font-bold w-[13%]">{t.colDate}</th>
                <th className="py-4 px-5 font-bold w-full">{t.colMeeting}</th>
                <th className="py-4 px-5 font-bold text-center w-[8%]">{t.labelAgendaItems}</th>
                <th className="py-4 px-5 font-bold text-center w-[10%]">{t.colExpected}</th>
                <th className="py-4 px-5 font-bold text-center w-[15%]">{t.colStatus}</th>
                <th className="py-4 px-5 font-bold text-center w-[10%]">% Concluído</th>
                <th className="py-4 px-5 font-bold text-right w-[8%]">{t.colActions}</th>
              </tr>
            </thead>

            {/* Table Body */}
            <tbody>
              {/*
                Quatro desfechos distintos, e nenhum deles se disfarça de outro:
                carregando, erro, banco vazio e filtro sem resultado. Mostrar
                "nenhuma reunião" enquanto a chamada está em voo — ou quando ela
                falhou — faria a tela afirmar que o banco está vazio sem saber.
              */}
              {meetingsLoading ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400 font-semibold text-xs">
                    <span className="inline-block w-6 h-6 border-2 border-slate-200 border-t-[#00658d] rounded-full animate-spin mb-3" />
                    <div>{language === "en" ? "Loading meetings..." : "Carregando reuniões..."}</div>
                  </td>
                </tr>
              ) : meetingsError ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center">
                    <div className="inline-flex flex-col items-center gap-3 max-w-md">
                      <AlertCircle className="w-9 h-9 text-rose-400" />
                      <p className="text-xs font-semibold text-rose-700 leading-relaxed">{meetingsError}</p>
                      {onReloadMeetings && (
                        <button
                          type="button"
                          onClick={onReloadMeetings}
                          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-[11px] font-bold uppercase tracking-wider transition cursor-pointer"
                        >
                          {language === "en" ? "Try again" : "Tentar novamente"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : meetings.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400 font-semibold text-xs leading-relaxed">
                    <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                    {language === "en"
                      ? "No meetings registered yet. Schedule the first one."
                      : "Nenhuma reunião cadastrada ainda. Agende a primeira."}
                  </td>
                </tr>
              ) : sortedMonthKeys.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-slate-400 font-semibold text-xs leading-relaxed">
                    <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                    {language === "en" ? "No meetings match your current filters." : "Nenhuma reunião corresponde aos filtros aplicados."}
                  </td>
                </tr>
              ) : (
                pageGroups.map((grupo) => (
                  <React.Fragment key={grupo.key}>
                    {/* Month Section Header Row */}
                    <tr className="bg-slate-55 bg-slate-50/90 border-y border-slate-200 select-none">
                      <td colSpan={7} className="py-2.5 px-5 font-bold font-sans text-[11px] text-[#00658d] uppercase tracking-wider">
                        {grupo.key}
                      </td>
                    </tr>
                    {grupo.meetings.map((meet) => {
                      const isNeedsApproval = meet.status === "Needs Approval";
                      const isDraft = meet.status === "Draft";
                      const isPast = meet.status === "Done" || meet.status === "Closed";

                      // Parse date Widget representation
                      const dateObj = new Date(meet.date + "T10:00:00");
                      const parsedMonth = dateObj.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", { month: "short" }).toUpperCase();
                      const parsedDay = dateObj.getDate();
                      const parsedWeekDay = dateObj.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", { weekday: "short" });
               
                      // Simple 24h formatter (assuming HH:mm string input)
                      const fmtTime = (time: string) => {
                          // If it contains AM/PM, try to convert, else return as is
                          if (time.includes("AM") || time.includes("PM")) {
                            const [hStr, mStr] = time.replace(" AM", "").replace(" PM", "").split(":");
                            let h = parseInt(hStr);
                            if (time.includes("PM") && h < 12) h += 12;
                            if (time.includes("AM") && h === 12) h = 0;
                            return `${h.toString().padStart(2, '0')}:${mStr}`;
                          }
                          return time;
                      }

                      // Progresso REAL: mesma fonte usada na aba Anotações.
                      // Adiadas são lidas à parte para não contarem como
                      // concluídas. Sem pauta, não há métrica.
                      const progress = getAgendaProgress(
                        meet,
                        readDoneTopicIdsFor(meet),
                        readPostponedTopicIdsFor(meet)
                      );

                      return (
                        <React.Fragment key={meet.id}>
                          <tr 
                            onClick={() => onMeetingClick(meet)}
                            className="hover:bg-slate-50/60 transition-colors border-b border-slate-100 cursor-pointer group"
                          >
                            
                            {/* COLUMN 1: DATE & TIME */}
                            <td className="py-4 px-5 align-middle whitespace-nowrap">
                              <div className="flex items-center gap-3">
                                {/* Colorful Date box widget */}
                                <div className="flex flex-col items-center justify-center w-11 h-11 rounded-lg bg-[#f1f5f9] group-hover:bg-[#e2e8f0] select-none shrink-0 leading-none transition-colors">
                                  <span className="text-[9px] font-bold uppercase text-slate-400 mb-0.5">{parsedMonth}</span>
                                  <span className="text-sm font-extrabold text-slate-800">{parsedDay}</span>
                                </div>
                                <div className="flex flex-col gap-0.5">
                                  <div className="text-[11px] text-slate-800 font-extrabold flex items-center gap-1">
                                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                                    {fmtTime(meet.startTime)}
                                  </div>
                                </div>
                              </div>
                            </td>
                            
                            {/* COLUMN 2: MEETING & CATEGORY */}
                            <td className="py-4 px-5 align-middle">
                              <div className="min-w-0">
                                <span className="px-2 py-0.5 rounded text-[9.5px] font-bold uppercase bg-slate-100 text-slate-500 border border-slate-200 inline-flex items-center gap-1 mb-1.5 leading-none">
                                  <Layers className="w-2.5 h-2.5" />
                                  {meet.category || "Governance"}
                                </span>
                                <div className="text-xs font-bold text-slate-900 group-hover:text-[#00658d] transition-colors leading-snug line-clamp-1">
                                  {meet.title}
                                </div>
                                <div className="text-[10.5px] text-slate-400 font-semibold mt-0.5 truncate">
                                  {meet.description || "Nenhuma introdução adicional."}
                                </div>
                              </div>
                            </td>

                            {/* COLUMN 3: AGENDA ITEMS */}
                            <td className="py-4 px-5 align-middle text-center">
                                <span className="text-xs font-bold text-[#00658d] bg-[#00658d]/10 px-2.5 py-1 rounded-lg">
                                    {meet.agenda ? meet.agenda.length : (meet.agendaItemsCount ?? 0)}
                                </span>
                            </td>
                            
                            {/* COLUMN 4: PARTICIPANTS */}
                            <td className="py-4 px-5 align-middle text-center">
                                <span className="text-xs font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-lg">
                                    {meet.participants ? meet.participants.length : (meet.expectedParticipantsCount ?? 0)}
                                </span>
                            </td>

                            {/* COLUMN 5: STATUS BADGE */}
                            <td className="py-4 px-5 align-middle text-center">
                              <span
                                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider whitespace-nowrap ${
                                  meet.status === "Needs Approval"
                                    ? "bg-rose-50 text-rose-600"
                                    : meet.status === "Draft"
                                    ? "bg-amber-50 text-amber-700"
                                    : meet.status === "Done" || meet.status === "Closed"
                                    ? "bg-slate-100 text-slate-600"
                                    : meet.status === "Scheduled"
                                    ? "bg-blue-50 text-blue-600"
                                    : meet.status === "Approved"
                                    ? "bg-emerald-50 text-emerald-600"
                                    : "bg-cyan-50 text-[#00658d]"
                                }`}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    meet.status === "Needs Approval"
                                      ? "bg-rose-500"
                                      : meet.status === "Draft"
                                      ? "bg-amber-500"
                                      : meet.status === "Done" || meet.status === "Closed"
                                      ? "bg-slate-500"
                                      : meet.status === "Scheduled"
                                      ? "bg-blue-500"
                                      : meet.status === "Approved"
                                      ? "bg-emerald-500"
                                      : "bg-[#00aeef]"
                                  }`}
                                />
                                {language === "en" ? meet.status : (
                                  meet.status === "In Progress" ? "Iniciação" : 
                                  meet.status === "Scheduled" ? "Agendada" :
                                  meet.status === "Done" ? "Concluído" :
                                  meet.status === "Closed" ? "Fechado" :
                                  meet.status === "Needs Approval" ? "Requer Aprovação" :
                                  meet.status === "Draft" ? "Rascunho" :
                                  meet.status
                                )}
                              </span>
                            </td>
                            
                            {/* NEW COLUMN: PERCENTAGE */}
                            <td className="py-4 px-5 align-middle text-center">
                                <div className="w-20 bg-slate-200 rounded-full h-1.5 block mx-auto">
                                    <div className="bg-emerald-600 h-1.5 rounded-full" style={{width: `${progress.percentage ?? 0}%`}}></div>
                                </div>
                                <span className="text-[10px] font-bold text-slate-600 mt-1 block">
                                    {progress.percentage === null ? "—" : `${progress.percentage}%`}
                                </span>
                            </td>

                            {/* COLUMN 6: ACTIONS */}
                            <td className="py-4 px-5 align-middle text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-2">
                                {/* Cortesia com quem não pode: o servidor revalida PGCP.Assessoria. */}
                                {canSchedule && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onDeleteMeeting(meet.id);
                                    }}
                                    className="p-1.5 text-slate-400 hover:text-rose-600 bg-white hover:bg-rose-50 rounded-lg border border-slate-200 hover:border-rose-200 transition"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>

                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                ))
              )}
            </tbody>
            <tfoot className="border-t border-slate-100">
                <tr>
                    <td colSpan={7} className="py-4"></td>
                </tr>
            </tfoot>
          </table>
        </div>
      </section>
      {/*
        Paginação. Os botões eram estáticos ("1 2 3", sem clique) e a tabela
        renderizava TODAS as reuniões filtradas; agora eles operam sobre o
        resultado já filtrado, e o intervalo exibido vem de `paginate`.
      */}
      {pagina.totalItems > 0 && (
        <nav
          aria-label={t.title}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-200 pt-5 mt-4 select-none"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-slate-400 text-xs font-medium">
              {t.showingLabel} {pagina.from}–{pagina.to} {t.ofLabel} {pagina.totalItems} {t.resultsText}
            </span>

            <label className="flex items-center gap-2 text-slate-400 text-xs font-medium">
              {t.itemsPerPageLabel}
              <select
                value={pageSize}
                onChange={(e) => {
                  // Volta para a página 1: a página atual pode não existir no
                  // novo tamanho, e recomeçar do topo é o que o usuário espera.
                  setPageSize(parsePageSize(e.target.value));
                  setCurrentPage(1);
                }}
                className="appearance-none bg-slate-50 hover:bg-slate-100/50 text-slate-600 font-semibold text-xs border border-slate-200 rounded-lg px-3 py-1.5 cursor-pointer focus:ring-1 focus:ring-[#00658d] focus:bg-white focus:outline-none transition-all"
              >
                {PAGE_SIZE_OPTIONS.map((opcao) => (
                  <option key={opcao} value={opcao}>
                    {opcao}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            <button
              type="button"
              onClick={() => setCurrentPage(pagina.page - 1)}
              disabled={!pagina.hasPrevious}
              aria-label={t.previousPage}
              className="p-1 px-2.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {pageWindow(pagina.page, pagina.totalPages).map((numero) => (
              <button
                key={numero}
                type="button"
                onClick={() => setCurrentPage(numero)}
                aria-current={numero === pagina.page ? "page" : undefined}
                className={
                  numero === pagina.page
                    ? "w-7 h-7 rounded bg-[#00658d] text-white flex items-center justify-center font-bold text-xs cursor-pointer"
                    : "w-7 h-7 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 flex items-center justify-center font-bold text-xs transition cursor-pointer"
                }
              >
                {numero}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setCurrentPage(pagina.page + 1)}
              disabled={!pagina.hasNext}
              aria-label={t.nextPage}
              className="p-1 px-2.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

