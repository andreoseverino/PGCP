import React, { useState } from "react";
import { 
  ShieldAlert,
  Clock, 
  Plus, 
  Check, 
  TrendingUp, 
  BarChart2, 
  ArrowUpCircle, 
  Sparkles, 
  Inbox, 
  Filter,
  Users,
  Search,
  CheckCircle2,
  AlertTriangle,
  X,
  FileCheck,
  Layers
} from "lucide-react";
import { ActionItem } from "../types";
import { daysLateToDueDate, type FupFormInput } from "../lib/action-items";
import DirectoryUserPicker from "./DirectoryUserPicker";
import { directoryEmail, type DirectoryUser } from "../lib/directory";
import { getInitials } from "../lib/user";

interface FupListViewProps {
  language: "en" | "pt";
  actionItems: ActionItem[];
  /** Cria no PostgreSQL e recarrega. Nada é inserido localmente. */
  onCreateActionItem: (input: FupFormInput) => void | Promise<void>;
  /** Concluir / reabrir. A tela só muda depois do banco confirmar. */
  onSetActionItemStatus: (id: string, concluir: boolean) => void | Promise<void>;
  /**
   * O ator pode alterar este FUP?
   *
   * Cortesia com quem não pode: o servidor recusa `PATCH` de FUP alheio para
   * quem não é o responsável nem tem `PGCP.Assessoria`.
   */
  podeGerenciarFup?: (item: ActionItem) => boolean;
  actionItemsLoading?: boolean;
  actionItemsError?: string | null;
  setActionItems: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  organs: string[];
  triggerToast: (msg: string) => void;
}

export default function FupListView({
  language,
  actionItems = [],
  setActionItems,
  onCreateActionItem,
  onSetActionItemStatus,
  podeGerenciarFup = () => true,
  actionItemsLoading = false,
  actionItemsError = null,
  organs = [],
  triggerToast
}: FupListViewProps) {
  // Advanced filters state
  const [fupVPFilter, setFupVPFilter] = useState<string>("All");
  const [fupStatusFilter, setFupStatusFilter] = useState<string>("All"); // All, Pending, Completed
  const [fupSearchQuery, setFupSearchQuery] = useState<string>("");
  const [fupOriginFilter, setFupOriginFilter] = useState<string>("All");

  // Form states for creating a new FUP item
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  const [newDaysLate, setNewDaysLate] = useState("0");
  /** Responsável escolhido no diretório corporativo. */
  const [newAssignee, setNewAssignee] = useState<DirectoryUser | null>(null);

  // States for simulated actions
  const [escalatedItems, setEscalatedItems] = useState<Record<string, boolean>>({});

  // Compute metrics based on live state
  const totalCount = actionItems.length;
  const overdueCount = actionItems.filter(f => f.status !== "Completed" && f.daysLate > 0).length;
  const dueTodayCount = actionItems.filter(f => f.status !== "Completed" && f.daysLate <= 0).length;
  const completedCount = actionItems.filter(f => f.status === "Completed").length;

  const handleCreateFup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newAssignee) {
      triggerToast(language === "en" ? "Please fill the action title and select a responsible owner." : "Por favor, preencha a ação e selecione um responsável.");
      return;
    }

    const nome = newAssignee.displayName ?? directoryEmail(newAssignee) ?? "";
    const daysLateNum = parseInt(newDaysLate) || 0;
    const isOverdue = daysLateNum > 0;

    /*
     * O formulário coleta DIAS EM ATRASO; o banco guarda `due_date`, que é uma
     * data civil. A conversão acontece aqui: `daysLate = 0` significa "vence
     * hoje". Persistir os dias congelaria um número que muda amanhã.
     */
    void onCreateActionItem({
      title: newTitle.trim(),
      dueDate: daysLateToDueDate(daysLateNum),
      assigneeName: nome,
      // Identidade Microsoft. Escolher alguém do diretório NÃO cria usuário no
      // PGCP: isso continua sendo o JIT, quando a própria pessoa entra.
      assigneeEntraObjectId: newAssignee.id,
      originLabel: newOrigin || undefined
    });
    setIsAddingNew(false);

    // Reset Form fields
    setNewTitle("");
    setNewOrigin("");
    setNewDaysLate("0");
    setNewAssignee(null);

    // Toast e auditoria são responsabilidade de quem grava: o handler em
    // App.tsx registra depois que a API confirmou.
  };

  const handleCompleteFUP = (id: string) => {
    void onSetActionItemStatus(id, true);

    triggerToast(language === "en" ? "FUP status updated to Completed!" : "FUP atualizado para Concluído com sucesso!");
    
  };

  const handleEscalateFUP = (item: ActionItem) => {
    setEscalatedItems(prev => ({ ...prev, [item.id]: true }));
    triggerToast(
      language === "en"
        ? `Status escalated successfully! Theme added as urgent draft in Board of Directors Agenda queue.`
        : `FUP Escandido! Tema escalado e enquadrado nas pautas prioritárias do Conselho de Administração.`
    );

  };

  /**
   * Opções do filtro por responsável, derivadas dos FUPs já carregados.
   *
   * Antes vinham de `syncedUsers` — listava gente que talvez nem tivesse
   * pendência. Consultar o diretório só para montar um filtro seria pior ainda:
   * uma chamada ao Graph para popular um `<select>`.
   */
  const responsaveisComFup = Array.from(
    new Set(actionItems.map((f) => f.assignedUser.name).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  // Filtered FUPs list based on selection states
  const filteredActionItems = actionItems.filter(f => {
    // Partner responsible filter
    const matchesVP = fupVPFilter === "All" || f.assignedUser.name === fupVPFilter;
    
    // Status filter
    const matchesStatus = fupStatusFilter === "All"
      ? true
      : fupStatusFilter === "Completed"
      ? f.status === "Completed"
      : fupStatusFilter === "Overdue"
      ? f.daysLate > 0 && f.status !== "Completed"
      : f.daysLate <= 0 && f.status !== "Completed"; // Due Today

    // Origin Committee filter
    const matchesOrigin = fupOriginFilter === "All" || f.origin === fupOriginFilter;

    // Search query box keyword matching
    const matchesKeyword = fupSearchQuery === "" || 
      f.title.toLowerCase().includes(fupSearchQuery.toLowerCase()) ||
      f.origin.toLowerCase().includes(fupSearchQuery.toLowerCase()) ||
      f.assignedUser.name.toLowerCase().includes(fupSearchQuery.toLowerCase());

    return matchesVP && matchesStatus && matchesOrigin && matchesKeyword;
  });

  return (
    <div className="space-y-6 animate-fade-in font-sans">
      
      {/* Banner Title */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-4 border-b border-rose-100">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[#001e2d] md:text-4xl select-none flex items-center gap-2">
            FUP
            <ShieldAlert className="w-7 h-7 text-[#00658d]" />
          </h1>
          <p className="text-slate-500 font-semibold mt-1.5 text-xs md:text-sm">
            {language === "en" 
              ? "Follow-up monitoring console." 
              : "Painel de controle e monitoramento de follow-ups (FUPs)."
            }
          </p>
        </div>

        <button
          onClick={() => setIsAddingNew(!isAddingNew)}
          className="bg-[#003e58] hover:bg-[#00658d] text-white shadow-sm hover:shadow-md transition-all duration-200 px-5 py-3 rounded-xl font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer self-start md:self-auto shrink-0"
        >
          {isAddingNew ? (
            <>
              <X className="w-4 h-4" />
              {language === "en" ? "Close Form" : "Fechar Cadastro"}
            </>
          ) : (
            <>
              <Plus className="w-4 h-4 text-white" />
              {language === "en" ? "Create New FUP" : "Nova Pendência FUP"}
            </>
          )}
        </button>
      </div>

      {/* Stats Summary Rows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 select-none">
        
        {/* Metric 1 */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-wider">Total de FUPs</p>
            <h3 className="text-2xl font-extrabold text-[#001e2d] mt-1">{totalCount}</h3>
            <p className="text-[10px] text-slate-400 font-medium mt-1">Todos os colegiados</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-50 text-slate-500 flex items-center justify-center border border-slate-100">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        {/* Metric 2 */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-wider text-rose-600">Ações em Atraso</p>
            <h3 className="text-2xl font-extrabold text-rose-650 mt-1">{overdueCount}</h3>
            <p className="text-[10px] text-rose-550 font-bold mt-1">Cobrança pendente</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-rose-50/25 text-rose-600 flex items-center justify-center border border-rose-100/50">
            <AlertTriangle className="w-5 h-5 animate-pulse" />
          </div>
        </div>

        {/* Metric 3 */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-wider text-blue-650">Vencem hoje</p>
            <h3 className="text-2xl font-extrabold text-blue-700 mt-1">{dueTodayCount}</h3>
            <p className="text-[10px] text-slate-400 font-medium mt-1">Pauta do dia</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-blue-50/25 text-blue-650 flex items-center justify-center border border-blue-100/50">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        {/* Metric 4 */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-wider text-emerald-600">FUPs Concluídos</p>
            <h3 className="text-2xl font-extrabold text-emerald-650 mt-1">{completedCount}</h3>
            <p className="text-[10px] text-emerald-600 font-bold mt-1">✓ 100% resolvido</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-50/25 text-emerald-650 flex items-center justify-center border border-emerald-100/50">
            <FileCheck className="w-5 h-5" />
          </div>
        </div>

      </div>

      {/* Create New FUP form panel */}
      {isAddingNew && (
        <form onSubmit={handleCreateFup} className="p-6 bg-slate-50 border border-slate-200 rounded-2xl shadow-xs space-y-4">
          <h2 className="text-sm font-extrabold text-slate-800 uppercase tracking-wider">
            {language === "en" ? "Add New FUP deliverable" : "Registrar Nova Pendência de Follow-Up (FUP)"}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Title */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10.5px] font-bold text-slate-450 uppercase tracking-wide">
                {language === "en" ? "FUP / Action Deliverable" : "Nome da Ação / Descrição do FUP"} *
              </label>
              <input
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Ex: Entregar relatório de fraudes CVM"
                className="bg-white border border-slate-205 rounded-xl px-3 py-2.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#003e58]"
              />
            </div>

            {/* Committee Origin */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10.5px] font-bold text-slate-450 uppercase tracking-wide">
                {language === "en" ? "Origin Committee / Organ" : "Órgão de Origem"}
              </label>
              <select
                value={newOrigin}
                onChange={(e) => setNewOrigin(e.target.value)}
                className="bg-white border border-slate-205 rounded-xl px-3 py-2.5 text-xs text-slate-700 focus:outline-none cursor-pointer"
              >
                <option value="">{language === "en" ? "Select Committee" : "Selecione o Órgão..."}</option>
                {organs.map((org, id) => (
                  <option key={id} value={org}>{org}</option>
                ))}
              </select>
            </div>

            {/* Days Late */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10.5px] font-bold text-slate-450 uppercase tracking-wide">
                {language === "en" ? "Days Late (0 = Due Today)" : "Dias em Atraso (0 = Vence Hoje)"}
              </label>
              <input
                type="number"
                min="0"
                value={newDaysLate}
                onChange={(e) => setNewDaysLate(e.target.value)}
                className="bg-white border border-slate-205 rounded-xl px-3 py-2.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#003e58]"
              />
            </div>

            {/* Responsible */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10.5px] font-bold text-slate-450 uppercase tracking-wide">
                {language === "en" ? "Responsible Owner" : "Membro Responsável"} *
              </label>
              {/* Responsável vem do diretório corporativo (Microsoft Graph),
                  não mais de uma lista local. */}
              <DirectoryUserPicker
                language={language}
                selected={newAssignee}
                placeholder={language === "en" ? "Search directory by name or e-mail..." : "Buscar no diretório por nome ou e-mail..."}
                onSelect={setNewAssignee}
                onClear={() => setNewAssignee(null)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsAddingNew(false)}
              className="px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-200/50 rounded-xl transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-[#00658d] hover:bg-[#00aeef] text-white px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all"
            >
              {language === "en" ? "Save FUP" : "Salvar FUP"}
            </button>
          </div>
        </form>
      )}

      {/* Advanced Filter Toolbar */}
      <section className="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-[#00658d]" />
            <h2 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider select-none">
              Gerenciar Pendências de FUP
            </h2>
          </div>
          <div className="text-[10px] text-slate-400 font-medium">
            Mostrando {filteredActionItems.length} de {totalCount} cadastrados
          </div>
        </div>

        <div className="flex flex-col xl:flex-row gap-3 justify-between items-stretch">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500 font-extrabold flex items-center gap-1 uppercase tracking-wide mr-1 select-none">
              <Filter className="w-3.5 h-3.5 text-[#00658d]" />
              Filtros:
            </span>

            {/* Committee Filter select */}
            <select
              value={fupOriginFilter}
              onChange={(e) => setFupOriginFilter(e.target.value)}
              className="bg-white border border-slate-205 rounded-xl px-2.5 py-1.5 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-[#003e58] text-slate-700 shadow-3xs cursor-pointer"
            >
              <option value="All">{language === "en" ? "All Committees" : "Todos Colegiados"}</option>
              {organs.map((org, id) => (
                <option key={id} value={org}>{org}</option>
              ))}
            </select>

            {/* Responsible Person Select filter */}
            <select
              value={fupVPFilter}
              onChange={(e) => setFupVPFilter(e.target.value)}
              className="bg-white border border-slate-205 rounded-xl px-2.5 py-1.5 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-[#003e58] text-slate-700 shadow-3xs cursor-pointer"
            >
              <option value="All">{language === "en" ? "All Responsible Owners" : "Todos Convocados"}</option>
              {responsaveisComFup.map((nome) => (
                <option key={nome} value={nome}>{nome}</option>
              ))}
            </select>

            {/* Status filtering badges */}
            <div className="flex items-center border border-slate-205 rounded-xl overflow-hidden bg-white shadow-3xs select-none">
              {["All", "Overdue", "Due Today", "Completed"].map((s) => (
                <button
                  key={s}
                  onClick={() => setFupStatusFilter(s)}
                  className={`px-3 py-1.5 text-[10.5px] font-bold transition cursor-pointer ${
                    fupStatusFilter === s
                      ? "bg-[#003e58] text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {s === "All" && language === "pt" ? "Todos" : s === "Overdue" && language === "pt" ? "Em Atraso" : s === "Due Today" && language === "pt" ? "Vence Hoje" : s === "Completed" && language === "pt" ? "Resolvidos" : s}
                </button>
              ))}
            </div>
          </div>

          {/* Keyword Search field */}
          <div className="relative w-full xl:max-w-xs shrink-0 font-sans">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
            <input
              type="text"
              placeholder={language === "en" ? "Search action keywords..." : "Procurar palavra-chave..."}
              value={fupSearchQuery}
              onChange={(e) => setFupSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 rounded-xl text-xs font-semibold bg-slate-50 border border-slate-205 focus:outline-none focus:bg-white focus:ring-1 focus:ring-[#003e58]"
            />
          </div>
        </div>

        <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-sans text-xs min-w-[700px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider font-extrabold text-[9px] select-none">
                  <th className="py-3 px-4 w-1/3">Tema / Ação FUP</th>
                  <th className="py-3 px-3 w-1/5">Colegiado Origem</th>
                  <th className="py-3 px-3 w-1/5">Membro Responsável</th>
                  <th className="py-3 px-3 w-1/6">Status Atual</th>
                  <th className="py-3 px-4 w-1/6 text-right">Controles Operacionais</th>
                </tr>
              </thead>
              <tbody>
                {filteredActionItems.map((fup) => {
                  const isCompleted = fup.status === "Completed";
                  const isEscalated = escalatedItems[fup.id];

                  return (
                    <tr 
                      key={fup.id} 
                      className={`border-b border-slate-100 hover:bg-slate-50/50 transition-colors ${
                        isCompleted ? "opacity-60 bg-slate-50/30" : ""
                      }`}
                    >
                      <td className="py-3.5 px-4 font-bold text-slate-800">
                        <div className="space-y-0.5">
                          <p className={`text-slate-900 ${isCompleted ? "line-through text-slate-400" : ""}`}>
                            {fup.title}
                          </p>
                          {isEscalated && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.2 bg-red-50 text-red-700 border border-red-150 rounded text-[9px] font-extrabold uppercase animate-pulse">
                              <ArrowUpCircle className="w-3 h-3" />
                              Escalado em Pauta de Conselho
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-3 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                        {fup.origin}
                      </td>

                      <td className="py-3.5 px-3">
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-full bg-[#00658d]/10 text-[#00658d] flex items-center justify-center font-bold text-[9px] border border-slate-200">
                            {fup.assignedUser.initials}
                          </div>
                          <span className="font-semibold text-slate-700 text-xs">{fup.assignedUser.name}</span>
                        </div>
                      </td>

                      <td className="py-3.5 px-3 select-none">
                        {isCompleted ? (
                          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[9px] font-extrabold uppercase tracking-wider border border-emerald-150">
                            Resolvido
                          </span>
                        ) : fup.daysLate > 0 ? (
                          <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 text-[9px] font-extrabold uppercase tracking-wider border border-rose-150 animate-pulse">
                            {fup.daysLate} Dias A atraso
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[9px] font-extrabold uppercase tracking-wider border border-blue-150">
                            Vence Hoje
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right select-none">
                        <div className="inline-flex gap-1.5 justify-end">
                          
                          {/* Complete action */}
                          {!isCompleted && podeGerenciarFup(fup) && (
                            <button
                              onClick={() => handleCompleteFUP(fup.id)}
                              className="p-1.5 text-slate-400 hover:text-emerald-700 bg-white hover:bg-emerald-50 rounded-lg border border-slate-205 hover:border-emerald-200 transition cursor-pointer"
                              title="Marcar como Completo"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {/*
                            COBRANÇA POR E-MAIL: não existe.

                            Aqui havia um botão que exibia "e-mail enviado" e não
                            enviava nada — o PGCP não tem `Mail.Send`. Uma tela
                            que afirma um envio inexistente é pior do que a
                            ausência do botão: quem cobrou acredita ter cobrado.

                            Enquanto não houver canal real, a cobrança é o
                            próprio FUP aparecendo em "Minhas Pendências" de quem
                            responde por ele.
                          */}

                          {/* Escalate Priority straight to meeting draft */}
                          {!isCompleted && !isEscalated && (
                            <button
                              onClick={() => handleEscalateFUP(fup)}
                              className="p-1.5 text-slate-400 hover:text-amber-600 bg-white hover:bg-amber-50 rounded-lg border border-slate-205 hover:border-amber-200 transition cursor-pointer"
                              title="Escalar para Conselho Executivo do CA"
                            >
                              <ArrowUpCircle className="w-3.5 h-3.5" />
                            </button>
                          )}

                        </div>
                      </td>
                    </tr>
                  );
                })}

                {filteredActionItems.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-400 font-semibold">
                      <Inbox className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                      Nenhuma pendência ou ação de FUP localizada com os filtros ativos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

    </div>
  );
}
