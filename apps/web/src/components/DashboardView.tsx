import React, { useState, useMemo, useEffect } from "react";
import {
  fetchMyCalendar,
  podeIngressar,
  type MyCalendarEvent
} from "../lib/my-calendar";
import { classificarErroAgenda, type EstadoAgendaIndisponivel } from "../lib/my-calendar-status";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Layers,
  CheckCircle,
  Clock,
  Users,
  Check
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  LabelList
} from "recharts";
import { Meeting, ActionItem, GovernanceBody } from "../types";
import { classificarPendencia, ordenarPendencias } from "../lib/action-items";
import { calendarDayState } from "../lib/calendar-day-style";
import { filtrarPorOrgao } from "../lib/governance-filter";
import { DEFAULT_TIMEZONE, instantToLocal } from "../lib/meeting-adapters";
import { calcularResumoOperacional } from "../lib/dashboard-kpis";
import { listAnnualAgendas, type AnnualAgendaSummary } from "../lib/annual-agendas";

/** Quantos itens a Visão Geral mostra. A gestão detalhada é na página de FUPs. */
const LIMITE_PENDENCIAS_VISIVEIS = 4;

interface DashboardViewProps {
  language: "en" | "pt";
  meetings: Meeting[];
  actionItems: ActionItem[];
  setActionItems: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  /**
   * FUPs do usuário autenticado, já filtrados pelo servidor por identidade. A
   * tela não decide o que é "meu" — nem por nome, nem por e-mail.
   */
  myActionItems?: ActionItem[];
  /** O ator pode alterar este FUP? Cortesia; o servidor revalida. */
  podeGerenciarFup?: (item: ActionItem) => boolean;
  /** Órgão colegiado do CONTEXTO GLOBAL (""=Todos). Filtro, não autorização. */
  orgaoContexto: string;
  governanceBodies?: GovernanceBody[];
  /** Cargas do App: enquanto `true`, o card mostra carregando — nunca um 0 falso. */
  meetingsLoading?: boolean;
  actionItemsLoading?: boolean;
  governanceBodiesLoading?: boolean;
  /** Card "Reuniões da semana" → Calendário. */
  onViewCalendar?: () => void;
  /*
   * SEM "Nova reunião" aqui (025): agendar é exclusivo do Calendário.
   */
  onMeetingClick: (meet: Meeting) => void;
  onViewAllMeetings: () => void;
  /** Abre a página de FUPs, onde vive a gestão detalhada. */
  onViewAllActionItems: () => void;
  onCompleteAction: (actionId: string) => void;
  triggerToast: (msg: string) => void;
}

export default function DashboardView({
  language,
  meetings = [],
  actionItems = [],
  setActionItems,
  myActionItems = [],
  podeGerenciarFup = () => true,
  orgaoContexto,
  governanceBodies = [],
  meetingsLoading = false,
  actionItemsLoading = false,
  governanceBodiesLoading = false,
  onViewCalendar,
  onMeetingClick,
  onViewAllMeetings,
  onViewAllActionItems,
  onCompleteAction,
  triggerToast
}: DashboardViewProps) {
  
  /**
   * HOJE, no fuso das reuniões.
   *
   * Mesma regra de `meeting-adapters` (`instantToLocal` + `DEFAULT_TIMEZONE`)
   * que converte `startAt` em data exibida. Usar o fuso da máquina — ou pior,
   * `toISOString()` cru — faria o quadro marcar 29 enquanto a reunião das 23h
   * do dia 28 aparece no dia 28.
   */
  const todayStr = useMemo(
    () => instantToLocal(new Date().toISOString(), DEFAULT_TIMEZONE).date,
    []
  );

  // Mês inicial do quadro: o mês corrente, derivado do MESMO "hoje".
  const latestDateInfo = useMemo(() => {
    const [ano, mes] = todayStr.split("-").map(Number);
    return { year: ano, month: mes - 1 }; // month é 0-indexed
  }, [todayStr]);

  // Calendar Navigation State
  const [currentMonth, setCurrentMonth] = useState<number>(latestDateInfo.month);
  const [currentYear, setCurrentYear] = useState<number>(latestDateInfo.year);
  
  // Support auto sync if meetings change or filter updates
  useEffect(() => {
    setCurrentMonth(latestDateInfo.month);
    setCurrentYear(latestDateInfo.year);
  }, [latestDateInfo]);

  // Selected Day on Calendar
  const [selectedDayStr, setSelectedDayStr] = useState<string | null>(null);

  /*
   * AGENDA REAL DO OUTLOOK.
   *
   * Uma só experiência de calendário: este quadro passou a mostrar, além das
   * reuniões do PGCP, os compromissos reais da caixa de quem está logado —
   * lidos sob demanda via `GET /calendar/me` (On-Behalf-Of).
   *
   * NADA é persistido: agenda pessoal continua sendo do Outlook. O único
   * vínculo que o PGCP guarda é o das próprias reuniões.
   *
   * Falha do Graph NÃO derruba a Visão Geral: o quadro mostra o erro e o resto
   * da tela continua funcionando com os dados do PostgreSQL.
   */
  const [outlookEvents, setOutlookEvents] = useState<MyCalendarEvent[]>([]);
  const [outlookState, setOutlookState] = useState<"loading" | "ready" | "error">("loading");
  const [outlookError, setOutlookError] = useState<EstadoAgendaIndisponivel | null>(null);

  useEffect(() => {
    let cancelado = false;
    const controlador = new AbortController();

    setOutlookState("loading");
    setOutlookError(null);

    // Janela = o mês exibido no quadro. Navegar de mês recarrega.
    const inicio = new Date(currentYear, currentMonth, 1, 0, 0, 0, 0);
    const fim = new Date(currentYear, currentMonth + 1, 1, 0, 0, 0, 0);

    fetchMyCalendar({ start: inicio, end: fim, limit: 100 }, controlador.signal)
      .then((pagina) => {
        if (cancelado) return;
        setOutlookEvents(pagina.events);
        setOutlookState("ready");
      })
      .catch((erro) => {
        if (cancelado || (erro as Error)?.name === "AbortError") return;
        // Sem massa demo, sem evento inventado: o quadro diz o que houve.
        setOutlookEvents([]);
        setOutlookError(classificarErroAgenda(erro, language));
        setOutlookState("error");
      });

    return () => {
      cancelado = true;
      controlador.abort();
    };
  }, [currentMonth, currentYear, language]);

  /**
   * Eventos do Outlook por dia (`YYYY-MM-DD`).
   *
   * A data vem como hora LOCAL do fuso pedido, sem offset — fatiar a string é
   * mais fiel do que `new Date(...)`, que reinterpretaria o valor.
   */
  const outlookByDayMap = useMemo(() => {
    const map: Record<string, MyCalendarEvent[]> = {};
    for (const evento of outlookEvents) {
      if (!evento.start) continue;
      const dia = evento.start.slice(0, 10);
      (map[dia] ??= []).push(evento);
    }
    return map;
  }, [outlookEvents]);

  const outlookDoDia = useMemo(
    () => (selectedDayStr ? outlookByDayMap[selectedDayStr] ?? [] : []),
    [selectedDayStr, outlookByDayMap]
  );

  // Órgão colegiado = CONTEXTO GLOBAL (cabeçalho). "" = Todos. Agora por id.
  const filteredMeetings = useMemo(() => filtrarPorOrgao(meetings, orgaoContexto), [meetings, orgaoContexto]);

  /** FUPs concluídos nesta sessão — saem da lista antes do próximo recarregamento. */
  const [completedItems, setCompletedItems] = useState<Record<string, boolean>>({});

  // Translation Dictionaries
  const t = {
    dashboardTitle: language === "en" ? "Dashboard Portal" : "Plataforma de Governança Corporativa",
    
    // Filtro de órgão
    bodyFilterLabel: language === "en" ? "Governance Body" : "Órgão de Governança",
    bodyFilterAll: language === "en" ? "All" : "Todos",
    todayBtn: language === "en" ? "Today" : "Hoje",
    noSessionsToday: language === "pt" ? "Nenhuma reunião agendada para hoje." : "No meetings scheduled for today.",

    // Month strings
    months: language === "en" 
      ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
      : ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"],

    // Section Titles
    calendarTitle: language === "en" ? "Governance Timeline Heatmap" : "Quadro Mensal de Reuniões",
    calendarSub: language === "en" ? "Days with scheduled board meetings are highlighted. Click to drill down." : "Dias com sessões ou reuniões agendadas são destacados. Clique para filtrar.",
    clearText: language === "pt" ? "LIMPAR" : "CLEAR",
    noSessions: language === "pt" ? "Nenhuma reunião agendada para este dia." : "No governance meetings scheduled for this day.",
    noSessionsMonth: language === "pt" ? "Nenhuma reunião neste mês." : "No governance meetings in this month.",

    chartAppointments: language === "en" ? "Annual Schedule Overview" : "Agenda Anual",
    chartAppointmentsSub: language === "en" ? "Quantity of registered meetings in each month of the year." : "Quantidade de reuniões registradas em cada mês do ano.",
  };

  /*
   * Agenda Anual: única carga extra da Visão Geral (aprovações pendentes).
   * Falha não derruba a tela: o card de aprovações mostra "—".
   */
  const [agendasAnuais, setAgendasAnuais] = useState<AnnualAgendaSummary[] | null>(null);
  const [agendasAnuaisEstado, setAgendasAnuaisEstado] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const controlador = new AbortController();
    listAnnualAgendas(controlador.signal)
      .then((lista) => {
        setAgendasAnuais(lista);
        setAgendasAnuaisEstado("ready");
      })
      .catch((erro) => {
        if ((erro as Error)?.name === "AbortError") return;
        setAgendasAnuaisEstado("error");
      });
    return () => controlador.abort();
  }, []);

  // FUPs concluídos nesta sessão já saem da conta, como na lista abaixo.
  const resumo = useMemo(
    () =>
      calcularResumoOperacional({
        orgaoContexto,
        hoje: todayStr,
        governanceBodies,
        meetings,
        actionItems: actionItems.filter((item) => !completedItems[item.id]),
        annualAgendas: agendasAnuais
      }),
    [orgaoContexto, todayStr, governanceBodies, meetings, actionItems, completedItems, agendasAnuais]
  );

  const pt = language === "pt";
  /** `null` = carregando; `undefined` = indisponível ("—"). */
  const valorOu = (carregando: boolean, valor: number, indisponivel = false) =>
    carregando ? null : indisponivel ? undefined : valor;
  const nomeDoContexto = governanceBodies.find((b) => b.id === orgaoContexto)?.name;
  const cardsResumo: Array<{
    id: string;
    titulo: string;
    valor: number | null | undefined;
    auxiliar: string;
    icone: string;
    corIcone: string;
    destaque?: boolean;
    onClick?: () => void;
  }> = [
    {
      id: "orgaos",
      titulo: pt ? "Órgãos colegiados" : "Governance bodies",
      valor: valorOu(governanceBodiesLoading, resumo.orgaos),
      auxiliar: orgaoContexto
        ? nomeDoContexto ?? (pt ? "órgão selecionado" : "selected body")
        : pt ? `${resumo.orgaos} ${resumo.orgaos === 1 ? "estrutura ativa" : "estruturas ativas"}` : "active bodies",
      icone: "account_balance",
      corIcone: "bg-[#00658d]/5 text-[#00658d]"
    },
    {
      id: "aprovacoes",
      titulo: pt ? "Pendências de aprovação" : "Pending approvals",
      valor: valorOu(meetingsLoading || agendasAnuaisEstado === "loading", resumo.aprovacoes, agendasAnuaisEstado === "error"),
      auxiliar: agendasAnuaisEstado === "error"
        ? (pt ? "indisponível no momento" : "unavailable")
        : pt ? "aguardando aprovação" : "awaiting approval",
      icone: "approval",
      corIcone: "bg-amber-50 text-amber-600"
    },
    {
      id: "fup-vencidos",
      titulo: pt ? "FUP vencidos" : "Overdue FUPs",
      valor: valorOu(actionItemsLoading || (Boolean(orgaoContexto) && meetingsLoading), resumo.fupVencidos),
      auxiliar: pt ? "prazo expirado" : "past due",
      icone: "event_busy",
      corIcone: "bg-rose-50 text-rose-600",
      // Informativo: a página de FUP não aceita filtro de entrada.
      destaque: resumo.fupVencidos > 0
    },
    {
      id: "reunioes-semana",
      titulo: pt ? "Reuniões da semana" : "Meetings this week",
      valor: valorOu(meetingsLoading, resumo.reunioesSemana),
      auxiliar: pt ? "próximos 7 dias" : "next 7 days",
      icone: "calendar_month",
      corIcone: "bg-sky-50 text-[#00aeef]",
      onClick: onViewCalendar
    },
    {
      id: "atas",
      titulo: pt ? "Atas pendentes" : "Pending minutes",
      valor: valorOu(meetingsLoading, resumo.atasPendentes),
      auxiliar: pt ? "aguardando conclusão" : "awaiting completion",
      icone: "description",
      corIcone: "bg-indigo-50 text-indigo-600",
      onClick: onViewAllMeetings
    },
    {
      id: "acoes",
      titulo: pt ? "Ações pendentes" : "Open actions",
      valor: valorOu(actionItemsLoading || (Boolean(orgaoContexto) && meetingsLoading), resumo.acoesPendentes),
      auxiliar: pt ? "FUPs em aberto" : "open FUPs",
      icone: "task_alt",
      // Informativo: a página de FUP não aceita filtro de entrada.
      corIcone: "bg-emerald-50 text-emerald-600"
    }
  ];

  /*
   * MINHAS PENDÊNCIAS — derivação, nunca persistência.
   *
   * `daysLate` vem calculado pelo servidor contra a data dele; aqui só se
   * agrupa. `completedItems` guarda o que acabou de ser concluído nesta sessão,
   * para o item sair da lista antes do próximo recarregamento.
   */
  const minhasPendencias = useMemo(
    () =>
      ordenarPendencias(
        // Só o que ainda exige ação. `apiStatus` é a situação persistida;
        // concluído e cancelado saem da visão acionável e ficam no histórico.
        myActionItems.filter((item) => item.apiStatus === "open" && !completedItems[item.id])
      ),
    [myActionItems, completedItems]
  );

  const vencidas = minhasPendencias.filter((item) => classificarPendencia(item) === "overdue");
  const proximas = minhasPendencias.filter((item) => classificarPendencia(item) === "dueSoon");
  const minhasPendenciasVisiveis = minhasPendencias.slice(0, LIMITE_PENDENCIAS_VISIVEIS);

  /**
   * Prazo em uma linha. Sem data, diz que não há prazo — não inventa nenhum.
   */
  const descreverPrazo = (item: ActionItem): string => {
    const pt = language === "pt";
    if (!item.dueDate) return pt ? "Sem prazo definido" : "No due date";

    const data = new Date(`${item.dueDate}T00:00:00`).toLocaleDateString(pt ? "pt-BR" : "en-US", {
      day: "2-digit",
      month: "2-digit"
    });

    const grupo = classificarPendencia(item);
    if (grupo === "overdue") {
      const dias = item.daysLate;
      return pt
        ? `Venceu em ${data} · ${dias} ${dias === 1 ? "dia" : "dias"} de atraso`
        : `Due ${data} · ${dias} ${dias === 1 ? "day" : "days"} late`;
    }
    if (item.daysLate === 0) return pt ? `Vence hoje · ${data}` : `Due today · ${data}`;
    if (grupo === "dueSoon") {
      const faltam = -item.daysLate;
      return pt
        ? `Vence em ${faltam} ${faltam === 1 ? "dia" : "dias"} · ${data}`
        : `Due in ${faltam} ${faltam === 1 ? "day" : "days"} · ${data}`;
    }
    return pt ? `Prazo em ${data}` : `Due ${data}`;
  };

  // Handler for previous/next month navigation
  const handlePrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(prev => prev - 1);
    } else {
      setCurrentMonth(prev => prev - 1);
    }
    setSelectedDayStr(null);
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(prev => prev + 1);
    } else {
      setCurrentMonth(prev => prev + 1);
    }
    setSelectedDayStr(null);
  };

  /** Volta ao mês corrente e seleciona o dia de hoje. */
  const handleToday = () => {
    setCurrentMonth(latestDateInfo.month);
    setCurrentYear(latestDateInfo.year);
    setSelectedDayStr(todayStr);
  };

  // Generate real month matrix (Sun to Sat)
  const calendarCells = useMemo(() => {
    const cells = [];
    const firstDay = new Date(currentYear, currentMonth, 1);
    const startingDayOfWeek = firstDay.getDay(); // 0 = Sunday, 1 = Monday ...
    const daysCount = new Date(currentYear, currentMonth + 1, 0).getDate();

    // Previous month padding cells
    for (let i = 0; i < startingDayOfWeek; i++) {
      cells.push({ day: null, isCurrentMonth: false, dateStr: "" });
    }

    // Current month cells
    for (let dayNum = 1; dayNum <= daysCount; dayNum++) {
      const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      cells.push({
        day: dayNum,
        isCurrentMonth: true,
        dateStr
      });
    }

    return cells;
  }, [currentMonth, currentYear]);

  // Group meetings into days map for selected month
  const meetingsByDayMap = useMemo(() => {
    const map: Record<string, Meeting[]> = {};
    filteredMeetings.forEach(m => {
      if (!map[m.date]) {
        map[m.date] = [];
      }
      map[m.date].push(m);
    });
    return map;
  }, [filteredMeetings]);

  // Handle Complete Action Item inline
  const handleCompleteFUP = (id: string, title: string) => {
    setCompletedItems(prev => ({ ...prev, [id]: true }));
    triggerToast(language === "en" ? `Action Item marked as Completed!` : `Item de FUP concluído e removido!`);
    
  };

  // Selectable Day Meetings Query
  const selectedDayMeetings = useMemo(() => {
    if (!selectedDayStr) return [];
    return meetingsByDayMap[selectedDayStr] || [];
  }, [selectedDayStr, meetingsByDayMap]);

  // Current Month General Meetings list (fallback when no day selected)
  const currentMonthMeetings = useMemo(() => {
    return filteredMeetings.filter(m => {
      const parts = m.date.split("-");
      if (parts.length === 3) {
        const mYear = parseInt(parts[0], 10);
        const mMonth = parseInt(parts[1], 10) - 1; // 0-indexed
        return mYear === currentYear && mMonth === currentMonth;
      }
      return false;
    });
  }, [filteredMeetings, currentMonth, currentYear]);

  // Recharts: Bar Chart dataset representing monthly meeting volume
  const quarterlyVolumeData = useMemo(() => {
    const monthsShortPt = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    const monthsShortEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const labels = language === "pt" ? monthsShortPt : monthsShortEn;

    // Split meetings into monthly counts for currentYear (or any data available)
    return labels.map((label, index) => {
      const count = filteredMeetings.filter(m => {
        const parts = m.date.split("-");
        if (parts.length === 3) {
          const mYear = parseInt(parts[0], 10);
          const mMonth = parseInt(parts[1], 10) - 1;
          return mYear === currentYear && mMonth === index;
        }
        return false;
      }).length;

      // Add a small styled mock baseline comparison to make the Recharts bars beautiful
      return {
        name: label,
        Realizadas: count,
        Ações: Math.max(0, count * 2 - 1)
      };
    });
  }, [filteredMeetings, currentYear, language]);

  return (
    <div className="space-y-8 font-sans select-none animate-in fade-in duration-300">
      
      {/* 1. Dashboard Header Section — sem cartão atrás, só os elementos. */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-1">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-full bg-[#00658d]/5 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-3xl text-[#00658d] animate-pulse">space_dashboard</span>
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-[#001e2d] flex items-center gap-2">
              {t.dashboardTitle}
            </h1>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 shrink-0">

        </div>
      </div>

      {/* 2. RESUMO OPERACIONAL — uma única linha de cards; sem quebra.
          Faltando largura, a linha rola na horizontal (inclusive no mobile).
          Números de `calcularResumoOperacional` (lib/dashboard-kpis). */}
      <section aria-labelledby="resumo-operacional-titulo" className="space-y-3">
        <div className="px-1">
          <h2 id="resumo-operacional-titulo" className="text-sm font-extrabold text-[#001e2d] tracking-tight">
            {language === "pt" ? "Resumo operacional" : "Operational summary"}
          </h2>
          <p className="text-[11px] text-slate-500 font-medium">
            {language === "pt" ? "Indicadores que exigem atenção no dia a dia" : "Indicators that need day-to-day attention"}
          </p>
        </div>
        <div className="flex flex-nowrap gap-3 overflow-x-auto pb-2 snap-x snap-mandatory scrollbar-thin" role="list">
          {cardsResumo.map((card) => {
            const corpo = (
              <>
                <p className="text-[11px] font-bold text-slate-500 truncate" title={card.titulo}>{card.titulo}</p>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className={`text-2xl font-extrabold tracking-tight ${card.destaque ? "text-rose-600" : "text-[#001e2d]"}`}>
                    {card.valor === null ? (
                      <span className="inline-block w-8 h-6 rounded bg-slate-100 animate-pulse align-middle" aria-label={language === "pt" ? "Carregando" : "Loading"} />
                    ) : card.valor === undefined ? (
                      "—"
                    ) : (
                      card.valor
                    )}
                  </span>
                  <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${card.corIcone}`}>
                    <span className="material-symbols-outlined text-base" aria-hidden="true">{card.icone}</span>
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 font-semibold truncate mt-0.5" title={card.auxiliar}>{card.auxiliar}</p>
              </>
            );
            const classe = "min-w-[150px] flex-1 shrink-0 snap-start bg-white border border-slate-100 rounded-2xl px-3.5 py-3 text-left";
            return card.onClick ? (
              <button
                key={card.id}
                type="button"
                role="listitem"
                onClick={card.onClick}
                className={`${classe} cursor-pointer transition hover:border-[#00658d]/30 hover:shadow-xs focus:outline-none focus:ring-2 focus:ring-[#00658d]/20`}
              >
                {corpo}
              </button>
            ) : (
              <div key={card.id} role="listitem" className={classe}>
                {corpo}
              </div>
            );
          })}
        </div>
      </section>

      {/* 3. CALENDAR HEATMAP CONTAINER - HIGHLIGHTED AS THE FIRST GRAPHIC BLOCK */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5 md:p-6 flex flex-col lg:flex-row gap-6">
        
        {/* Left Side: Real Calendar Grid Styled Like the Second Screenshot (Flat, No shadows) */}
        <div className="w-full lg:w-[58%] flex flex-col justify-between space-y-4">
          <div className="border-b border-slate-100 pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5 text-left">
                <h2 className="text-sm font-extrabold text-[#001e2d] tracking-tight hover:text-[#00658d] flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-[#00658d]" />
                  {t.calendarTitle}
                </h2>
                <p className="text-[11px] text-slate-400 font-semibold leading-tight">
                  {t.calendarSub}
                </p>
                {/*
                  As duas fontes do quadro, ditas explicitamente: reunião de
                  governança (PostgreSQL) e compromisso da caixa do usuário
                  (Outlook, leitura sob demanda). Nada é fundido nem adivinhado.
                */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                  <span className="flex items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-sm bg-blue-500" />
                    {language === "en" ? "PGCP meetings" : "Reuniões do PGCP"}
                  </span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-full bg-violet-500" />
                    {language === "en" ? "Your Outlook agenda" : "Sua agenda do Outlook"}
                    {/* Motivo já na legenda (antes só aparecia ao clicar num dia). */}
                    {outlookState === "error" && outlookError && (
                      <span className="text-amber-600 normal-case" title={outlookError.mensagem}>
                        {` (${outlookError.rotulo})`}
                      </span>
                    )}
                  </span>
                  {/* Hoje tem canal próprio — borda —, e por isso entra na legenda. */}
                  <span className="flex items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-sm border-2 border-[#00658d]" />
                    {t.todayBtn}
                  </span>
                </div>
              </div>

              {/* Month/Year Selection Navigation buttons (Flat, Soft Borders) */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleToday}
                  className="px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-[#00658d] bg-[#c6e7ff]/25 border border-[#00658d]/15 rounded-lg hover:bg-[#00658d] hover:text-white transition cursor-pointer"
                >
                  {t.todayBtn}
                </button>

                <div className="flex items-center gap-1 bg-slate-50 border border-slate-100 rounded-xl p-0.5">
                <button
                  type="button"
                  onClick={handlePrevMonth}
                  className="p-1 hover:bg-white rounded hover:text-[#00658d] transition cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-[10px] font-extrabold text-[#001e2d] uppercase px-2 min-w-[100px] text-center">
                  {t.months[currentMonth]} {currentYear}
                </span>
                <button
                  type="button"
                  onClick={handleNextMonth}
                  className="p-1 hover:bg-white rounded hover:text-[#00658d] transition cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                </div>
              </div>
            </div>
          </div>

          {/* Calendar monthly view grid */}
          <div className="grid grid-cols-7 gap-1.5 text-center text-xs py-1">
            {/* Days header week */}
            {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((label, idx) => (
              <span key={idx} className="text-[9px] uppercase tracking-wide text-slate-400 font-extrabold border-b border-slate-50 pb-1.5">
                {label}
              </span>
            ))}

            {/* Render actual days with flat shades of blue heatmap */}
            {calendarCells.map((cell, idx) => {
              if (cell.day === null) {
                return <div key={`empty-${idx}`} className="min-h-[3.25rem]" />;
              }

              const meetingsOnDay = meetingsByDayMap[cell.dateStr] || [];
              const hasMeeting = meetingsOnDay.length > 0;
              // Compromissos reais da caixa do usuário, além das reuniões do PGCP.
              const outlookOnDay = outlookByDayMap[cell.dateStr] || [];
              const hasOutlook = outlookOnDay.length > 0;
              /*
                HOJE e SELECIONADO são canais visuais INDEPENDENTES — borda
                institucional para hoje, anel para a seleção —, calculados em
                `lib/calendar-day-style.ts`. Escolher outro dia não apaga a
                marca do dia de hoje; o mapa de calor por volume de reuniões
                continua sendo o fundo.
              */
              const { isToday, isSelected, className: dayStyle } = calendarDayState({
                dateStr: cell.dateStr,
                todayStr,
                selectedDayStr,
                meetingCount: meetingsOnDay.length
              });

              return (
                <button
                  key={cell.dateStr}
                  type="button"
                  onClick={() =>
                    setSelectedDayStr(isSelected && (hasMeeting || hasOutlook) ? null : cell.dateStr)
                  }
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected}
                  title={
                    [
                      isToday ? t.todayBtn : "",
                      ...meetingsOnDay.map((m) => m.title),
                      ...outlookOnDay.map((e) => e.subject ?? "")
                    ]
                      .filter(Boolean)
                      .join(" • ") || undefined
                  }
                  className={`w-full min-h-[3.25rem] rounded-lg p-1 flex flex-col items-start gap-0.5 overflow-hidden relative cursor-pointer transition duration-150 ${dayStyle}`}
                >
                  <span className="text-[10px] leading-none shrink-0 flex items-center gap-1 font-bold">
                    {/*
                      Hoje: quadrado preenchido na cor institucional e número
                      numa bolinha BRANCA com o número na mesma cor do fundo.
                    */}
                    <span
                      className={
                        isToday
                          ? "w-4 h-4 rounded-full bg-white text-[#00658d] font-black flex items-center justify-center"
                          : ""
                      }
                    >
                      {cell.day}
                    </span>
                    {/*
                      Marcador do Outlook, distinto do azul das reuniões do PGCP:
                      são fontes diferentes e a tela não as funde nem tenta
                      adivinhar que uma é a outra.
                    */}
                    {hasOutlook && (
                      <span
                        className={`w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0 ${isToday ? "ring-1 ring-white" : ""}`}
                        aria-hidden="true"
                      />
                    )}
                  </span>

                  {/* Nome compacto da primeira reunião do dia */}
                  {hasMeeting && (
                    <span className="w-full text-[7.5px] font-bold leading-tight text-left truncate">
                      {meetingsOnDay[0].title}
                    </span>
                  )}

                  {/* Indicador de reuniões adicionais */}
                  {meetingsOnDay.length > 1 && (
                    <span className="text-[7px] font-extrabold opacity-75 leading-none">
                      +{meetingsOnDay.length - 1}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Side: Interactive Meetings List for the day (Matching second reference screenshot style exactly) */}
        <div className="w-full lg:w-[42%] bg-slate-50/45 border border-slate-100 rounded-2xl p-5 flex flex-col justify-between">
          <div className="space-y-4">
            
            {/* Conditional Header: list chosen date, or fall back to listing month meetings */}
            {selectedDayStr ? (
              <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-3">
                <span className="bg-[#c6e7ff]/30 text-[#00658d] font-bold text-[10px] px-3 py-1 rounded-full border border-[#00658d]/10 uppercase tracking-wide select-none">
                  {language === "pt" 
                    ? `${selectedDayStr.split("-")[2]} de ${t.months[parseInt(selectedDayStr.split("-")[1], 10) - 1]} de ${selectedDayStr.split("-")[0]}`
                    : `${t.months[parseInt(selectedDayStr.split("-")[1], 10) - 1]} ${selectedDayStr.split("-")[2]}, ${selectedDayStr.split("-")[0]}`
                  }
                </span>

                <button
                  type="button"
                  onClick={() => setSelectedDayStr(null)}
                  className="text-[9px] font-extrabold uppercase tracking-widest text-[#00658d] hover:text-[#00aeef] transition cursor-pointer bg-white px-2 py-0.5 rounded border"
                >
                  {t.clearText}
                </button>
              </div>
            ) : null}

            {/* List rendered elements */}
            <div className="space-y-2.5 max-h-[360px] overflow-y-auto scrollbar-thin pr-1">

              {/*
                AGENDA REAL DO OUTLOOK do dia selecionado.

                Aparece junto das reuniões do PGCP, na mesma lista — uma só
                experiência de calendário. Não há tentativa de casar um evento
                com uma reunião do PGCP: título e data não são identidade, e
                inventar esse vínculo produziria associações erradas.
              */}
              {selectedDayStr && outlookState === "loading" && (
                <p className="text-[11px] text-slate-400 font-semibold text-center py-3">
                  {language === "en" ? "Loading your Outlook agenda..." : "Carregando sua agenda do Outlook..."}
                </p>
              )}

              {selectedDayStr && outlookState === "error" && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-[11px] font-bold text-amber-800">
                    {outlookError?.motivo === "nao_configurado"
                      ? language === "en" ? "Outlook agenda not configured in this environment" : "Agenda do Outlook não configurada neste ambiente"
                      : language === "en" ? "Outlook agenda unavailable" : "Agenda do Outlook indisponível"}
                  </p>
                  <p className="text-[10px] text-amber-700 font-medium mt-0.5">{outlookError?.mensagem}</p>
                </div>
              )}

              {selectedDayStr &&
                outlookState === "ready" &&
                outlookDoDia.map((evento) => (
                  <div
                    key={evento.id}
                    className="p-3 rounded-xl border border-violet-100 bg-violet-50/40 flex flex-col gap-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
                        <span className="text-[8.5px] font-extrabold uppercase tracking-wider text-violet-700">
                          Outlook
                        </span>
                      </div>
                      <h4 className="text-[11.5px] font-extrabold text-slate-800 truncate mt-0.5">
                        {evento.subject ?? (language === "en" ? "(no subject)" : "(sem assunto)")}
                      </h4>
                      <p className="text-[10px] text-slate-500 font-semibold">
                        {evento.start?.slice(11, 16)}
                        {evento.end ? ` – ${evento.end.slice(11, 16)}` : ""}
                        {evento.organizer ? ` · ${evento.organizer}` : ""}
                      </p>
                    </div>

                    {/*
                      Ingressar só com `joinUrl` real — vale inclusive para
                      reunião do Teams que não nasceu no PGCP. O link abre fora;
                      o PGCP não hospeda a chamada.
                    */}
                    {podeIngressar(evento) && (
                      <a
                        href={evento.joinUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="self-start px-3 py-1.5 bg-[#00658d] hover:bg-[#00aeef] text-white text-[10px] font-extrabold rounded-lg transition"
                      >
                        {language === "en" ? "Join meeting" : "Ingressar na reunião"}
                      </a>
                    )}
                  </div>
                ))}

              
              {selectedDayStr ? (
                // Filtered by selected day
                selectedDayMeetings.length === 0 ? (
                  // Vazio de verdade: nem reunião do PGCP, nem compromisso do
                  // Outlook. Com agenda carregando ou em erro, o bloco acima já
                  // explicou — repetir "nada aqui" seria afirmar demais.
                  outlookDoDia.length === 0 && outlookState === "ready" ? (
                    <div className="text-center py-10 text-slate-400 font-semibold text-xs leading-relaxed">
                      <span className="material-symbols-outlined text-4xl block text-slate-350 mb-1.5">event_busy</span>
                      {selectedDayStr === todayStr ? t.noSessionsToday : t.noSessions}
                    </div>
                  ) : null
                ) : (
                  selectedDayMeetings.map((meet) => {
                    const pautasCount = meet.agenda?.length || meet.agendaItemsCount || 0;
                    const participantsCount = meet.participants?.length || meet.expectedParticipantsCount || 0;
                    return (
                      <div
                        key={meet.id}
                        onClick={() => onMeetingClick(meet)}
                        className="group flex items-center justify-between gap-4 p-3 bg-white hover:bg-[#c6e7ff]/20 border border-slate-100 group-hover:border-sky-300 rounded-xl cursor-pointer transition-all duration-200"
                      >
                        {/* Details on the Left */}
                        <div className="truncate flex-1 text-left">
                          <p className="font-extrabold text-xs text-slate-800 leading-tight group-hover:text-[#00658d] transition truncate">
                            {meet.title}
                          </p>
                          <p className="text-[10px] text-[#00658d] font-bold uppercase tracking-wider mt-1.5 flex items-center gap-1.5 bg-[#c6e7ff]/10 inline-block px-1.5 py-0.2 rounded border border-[#00658d]/5 max-w-max">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#00aeef] shrink-0 animate-pulse" />
                            {meet.startTime} – {meet.endTime} • {meet.category}
                          </p>
                        </div>

                        {/* Indicators on the Right */}
                        <div className="flex items-center gap-1.5 shrink-0 select-none">
                          {/* 1. Qtd de pautas na reunião */}
                          <div 
                            title={language === "pt" ? `${pautasCount} pautas na reunião` : `${pautasCount} agenda items`}
                            className="flex items-center gap-1 bg-emerald-50 text-emerald-800 font-bold text-[10px] px-2 py-1 rounded-lg border border-emerald-100/50"
                          >
                            <Layers className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            <span className="font-extrabold font-mono">{pautasCount}</span>
                          </div>
                          {/* 2. Qtd de participantes na reunião */}
                          <div 
                            title={language === "pt" ? `${participantsCount} participantes` : `${participantsCount} participants`}
                            className="flex items-center gap-1 bg-cyan-50 text-cyan-800 font-bold text-[10px] px-2 py-1 rounded-lg border border-cyan-100/50"
                          >
                            <Users className="w-3.5 h-3.5 text-cyan-600 shrink-0" />
                            <span className="font-extrabold font-mono">{participantsCount}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )
              ) : (
                // Month overview fallback
                currentMonthMeetings.length === 0 ? (
                  <div className="text-center py-10 text-slate-400 font-semibold text-xs leading-relaxed">
                    <span className="material-symbols-outlined text-4xl block text-slate-350 mb-1.5">event_busy</span>
                    {t.noSessionsMonth}
                  </div>
                ) : (
                  currentMonthMeetings.map((meet) => {
                    const pautasCount = meet.agenda?.length || meet.agendaItemsCount || 0;
                    const participantsCount = meet.participants?.length || meet.expectedParticipantsCount || 0;
                    return (
                      <div
                        key={meet.id}
                        onClick={() => onMeetingClick(meet)}
                        className="group flex items-center justify-between gap-4 p-3 bg-white hover:bg-slate-50 border border-slate-100 rounded-xl cursor-pointer transition-all duration-200"
                      >
                        {/* Details on the Left with Date badge */}
                        <div className="truncate flex-1 text-left space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] uppercase tracking-wider bg-slate-100 text-slate-500 font-extrabold border rounded px-1.5 py-0.5 text-center shrink-0">
                              {meet.date.split("-")[2]}/{meet.date.split("-")[1]}
                            </span>
                            <span className="font-extrabold text-xs text-slate-800 truncate leading-tight group-hover:text-[#00658d] transition">
                              {meet.title}
                            </span>
                          </div>
                          <p className="text-[9px] text-[#00658d] font-bold uppercase tracking-wider flex items-center gap-1">
                            <Clock className="w-3 h-3 text-slate-400 pr-0.5" />
                            {meet.startTime} – {meet.endTime} ({meet.category})
                          </p>
                        </div>

                        {/* Indicators on the Right */}
                        <div className="flex items-center gap-1.5 shrink-0 select-none">
                          {/* 1. Qtd de pautas na reunião */}
                          <div 
                            title={language === "pt" ? `${pautasCount} pautas na reunião` : `${pautasCount} agenda items`}
                            className="flex items-center gap-1 bg-emerald-50 text-emerald-800 font-bold text-[10px] px-2 py-1 rounded-lg border border-emerald-100/50"
                          >
                            <Layers className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            <span className="font-extrabold font-mono">{pautasCount}</span>
                          </div>
                          {/* 2. Qtd de participantes na reunião */}
                          <div 
                            title={language === "pt" ? `${participantsCount} participantes` : `${participantsCount} participants`}
                            className="flex items-center gap-1 bg-cyan-50 text-cyan-800 font-bold text-[10px] px-2 py-1 rounded-lg border border-cyan-100/50"
                          >
                            <Users className="w-3.5 h-3.5 text-cyan-600 shrink-0" />
                            <span className="font-extrabold font-mono">{participantsCount}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )
              )}

            </div>
          </div>

        </div>

      </div>

      {/* 4. OTHER INTERACTIVE CLEAN ANALYTICS: BAR TRENDS & GOVERNANCE SLA (Flat, no shadows) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Left Card Area (Total Appointments Double Stacked Bars) */}
        <div className="lg:col-span-8 bg-white border border-slate-100 rounded-2xl p-5 md:p-6 flex flex-col justify-between space-y-5">
          <div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5 text-left">
                <h2 className="text-sm font-extrabold text-[#001e2d] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-lg text-[#00658d]">bar_chart_4_bars</span>
                  {t.chartAppointments}
                </h2>
                <p className="text-[11px] text-slate-400 font-semibold">
                  {t.chartAppointmentsSub}
                </p>
              </div>

              {/* Timeframe selector like in screenshot: Week, Month, Year */}
              <div className="flex items-center gap-1 bg-slate-50 border border-slate-100 rounded-lg p-0.5 select-none">
                {["Week", "Month", "Year"].map((frame) => (
                  <button
                    key={frame}
                    type="button"
                    className={`px-2 py-0.5 text-[10px] font-extrabold rounded cursor-pointer transition-all duration-150 ${
                      frame === "Month"
                        ? "bg-white text-[#00658d] border border-slate-100"
                        : "text-slate-400 hover:text-[#001e2d]"
                     }`}
                  >
                    {frame === "Week" && language === "pt" ? "Semana" : frame === "Month" && language === "pt" ? "Mês" : frame === "Year" && language === "pt" ? "Ano" : frame}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Recharts Bar implementation */}
          <div className="h-60 w-full select-none text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={quarterlyVolumeData}
                margin={{ top: 18, right: 10, left: -25, bottom: 0 }}
                barSize={20}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="name" 
                  tickLine={false} 
                  axisLine={false} 
                  tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: 700 }}
                />
                <YAxis 
                  tickLine={false} 
                  axisLine={false} 
                  allowDecimals={false}
                  tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: 700 }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#001e2d', 
                    borderRadius: '12px', 
                    border: 'none',
                    color: '#fff',
                    fontSize: '11px',
                    fontWeight: 700
                  }} 
                />
                <Bar 
                  dataKey="Realizadas" 
                  fill="#00658d" 
                  radius={[4, 4, 0, 0]} 
                  name={language === "pt" ? "Reuniões" : "Registered Meetings"}
                >
                  <LabelList 
                    dataKey="Realizadas" 
                    position="top" 
                    fill="#334155" 
                    fontSize={10} 
                    fontWeight={700}
                    formatter={(val: number) => val > 0 ? val : ""}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/*
          MINHAS PENDÊNCIAS — só FUP, só do usuário autenticado.

          A lista chega FILTRADA do servidor (`assignedToMe=true&status=open`),
          por identidade. Nada é filtrado aqui: o navegador não decide de quem é
          uma obrigação de governança.

          O que some daqui: FUP concluído ou cancelado. O histórico continua na
          página de FUPs — sair da visão acionável não é apagar.
        */}
        <div className="lg:col-span-4 bg-white border border-slate-100 rounded-2xl p-5 md:p-6 flex flex-col justify-between space-y-4">
          <div className="border-b border-indigo-50 pb-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-extrabold text-[#001e2d] flex items-center gap-1.5">
                <span className="material-symbols-outlined text-lg text-emerald-600">playlist_add_check</span>
                {language === "en" ? "My Pending Items" : "Minhas Pendências"}
              </h2>
              <span className="px-2 py-0.5 bg-slate-50 text-slate-500 border border-slate-200 rounded-full font-bold text-[9px] uppercase tracking-wider shrink-0 select-none">
                {minhasPendencias.length} {language === "en" ? "open" : "abertos"}
              </span>
            </div>

            {/* Contagens: só as que existem. Zero não vira selo. */}
            <p className="text-[11px] font-semibold text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {vencidas.length > 0 && (
                <span className="text-red-600 font-bold">
                  {vencidas.length}{" "}
                  {language === "en"
                    ? vencidas.length === 1 ? "overdue" : "overdue"
                    : vencidas.length === 1 ? "vencida" : "vencidas"}
                </span>
              )}
              {proximas.length > 0 && (
                <span className="text-amber-600 font-bold">
                  {proximas.length}{" "}
                  {language === "en" ? "due soon" : proximas.length === 1 ? "vence em breve" : "vencem em breve"}
                </span>
              )}
              {vencidas.length === 0 && proximas.length === 0 && (
                <span>
                  {language === "en"
                    ? "Nothing overdue or due in the next days."
                    : "Nada vencido nem vencendo nos próximos dias."}
                </span>
              )}
            </p>
          </div>

          <div className="flex-1 flex flex-col gap-2.5 overflow-y-auto max-h-[320px] pr-1">
            {minhasPendenciasVisiveis.map((fup) => {
              const grupo = classificarPendencia(fup);
              return (
                <div
                  key={fup.id}
                  className={`p-3 rounded-xl border bg-slate-50/20 hover:bg-slate-50/50 transition-all duration-200 text-left flex flex-col gap-2 ${
                    grupo === "overdue"
                      ? "border-red-200"
                      : grupo === "dueSoon"
                        ? "border-amber-200"
                        : "border-slate-100 hover:border-slate-200"
                  }`}
                >
                  <div className="space-y-1">
                    {/* Reunião de origem só aparece quando existe de verdade. */}
                    {fup.origin && (
                      <span className="text-[8px] uppercase tracking-wider font-extrabold text-slate-400 border px-1.5 py-0.2 rounded bg-white inline-block">
                        {fup.origin}
                      </span>
                    )}
                    <h4 className="text-[11px] font-extrabold text-slate-800 leading-snug line-clamp-2">
                      {fup.title}
                    </h4>
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-slate-100 gap-2">
                    <span
                      className={`text-[9px] font-bold flex items-center gap-1 min-w-0 ${
                        grupo === "overdue"
                          ? "text-red-600"
                          : grupo === "dueSoon"
                            ? "text-amber-600"
                            : "text-slate-400"
                      }`}
                    >
                      <Clock className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">{descreverPrazo(fup)}</span>
                    </span>

                    {podeGerenciarFup(fup) && (
                    <button
                      type="button"
                      onClick={() => handleCompleteFUP(fup.id, fup.title)}
                      className="px-1.5 py-0.5 text-[8px] uppercase tracking-wider font-extrabold rounded bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-0.5 cursor-pointer transition border border-transparent shrink-0"
                    >
                      <Check className="w-2 h-2 text-white" />
                      <span>{language === "pt" ? "Concluir" : "Resolve"}</span>
                    </button>
                    )}
                  </div>
                </div>
              );
            })}

            {minhasPendencias.length === 0 && (
              <div className="py-8 text-center border-2 border-dashed border-slate-100 rounded-xl text-slate-400 font-semibold text-xs bg-slate-50/20 flex flex-col items-center justify-center gap-1">
                <CheckCircle className="w-6 h-6 text-emerald-500" />
                <span>
                  {language === "en" ? "No pending items assigned to you." : "Nenhuma pendência atribuída a você."}
                </span>
              </div>
            )}
          </div>

          {/* A gestão detalhada continua na página de FUPs. */}
          <div className="text-right pt-1 select-none text-[10px]">
            <button
              type="button"
              onClick={onViewAllActionItems}
              className="text-[#00658d] hover:text-[#00aeef] font-bold inline-flex items-center gap-0.5 cursor-pointer"
            >
              <span>
                {minhasPendencias.length > LIMITE_PENDENCIAS_VISIVEIS
                  ? language === "pt"
                    ? `Ver todos os FUPs (+${minhasPendencias.length - LIMITE_PENDENCIAS_VISIVEIS})`
                    : `View all FUPs (+${minhasPendencias.length - LIMITE_PENDENCIAS_VISIVEIS})`
                  : language === "pt"
                    ? "Ver todos os FUPs"
                    : "View all FUPs"}
              </span>
              <span className="material-symbols-outlined text-[13px]">arrow_right_alt</span>
            </button>
          </div>
        </div>

      </div>

    </div>
  );
}
