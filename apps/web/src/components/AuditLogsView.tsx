import React, { useState, useMemo } from "react";
import {
  FileSpreadsheet,
  Search,
  Filter,
  Printer,
  Download,
  Calendar,
  User,
  Tags,
  AlertCircle,
  CheckCircle,
  CornerDownRight,
  Eye,
  RefreshCw,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  Lock,
  Sparkles
} from "lucide-react";
import { AuditLog } from "../types";

interface AuditLogsViewProps {
  language: "en" | "pt";
  /** Página(s) já carregadas da trilha real, adaptadas para exibição. */
  logs: AuditLog[];
  /** Primeira carga em andamento. */
  loading?: boolean;
  /** Falha ao ler a trilha. Texto pronto para a pessoa. */
  error?: string | null;
  /** Há próxima página? Vem do `nextCursor` do servidor. */
  hasMore?: boolean;
  /** Carregando a próxima página. */
  loadingMore?: boolean;
  /** Pede a próxima página, usando o cursor guardado por quem chama. */
  onLoadMore?: () => void;
  /**
   * Motivo pelo qual a trilha não pode ser exibida agora.
   *
   * Quando presente, a tela mostra só o aviso — nunca uma tabela vazia que
   * pareça dizer "nada aconteceu".
   */
  unavailableReason?: string | null;
}

/*
 * A tela NÃO cria registros de auditoria.
 *
 * Até a 4.12a existia `onAddLog`, e a própria tela alimentava a lista que ela
 * mostrava. Auditoria é consequência de uma operação de domínio, gravada pelo
 * servidor na transação do ato — não algo que o navegador declara ter
 * acontecido.
 */
export default function AuditLogsView({
  language,
  logs,
  loading = false,
  error = null,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  unavailableReason = null
}: AuditLogsViewProps) {
  const [selectedPeriod, setSelectedPeriod] = useState("Últimos 7 dias");
  const [userQuery, setUserQuery] = useState("");
  const [selectedEntity, setSelectedEntity] = useState("Todos os Módulos");
  const [selectedAction, setSelectedAction] = useState("Todas as Ações");
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const t = {
    title: language === "en" ? "Audit Logs" : "Logs de Auditoria",
    subTitle: language === "en" 
      ? "Immutable ledger tracking of executive actions, confidential documents access, and general system updates." 
      : "Rastreamento imutável de ações executivas, acessos a documentos confidenciais e alterações de sistema.",
    btnPrint: language === "en" ? "Print Report" : "Imprimir Relatório",
    btnExport: language === "en" ? "Export CSV" : "Exportar CSV",
    
    secFiltersTitle: language === "en" ? "Advanced Filters" : "Filtros Avançados",
    lblPeriod: language === "en" ? "Period" : "Período",
    lblUser: language === "en" ? "User" : "Usuário",
    lblEntity: language === "en" ? "Affected Entity" : "Entidade Afetada",
    lblActionType: language === "en" ? "Action Type" : "Tipo de Ação",
    
    plcSearchUser: language === "en" ? "Search by name or ID..." : "Buscar por nome ou ID...",
    optAllModules: language === "en" ? "All Modules" : "Todos os Módulos",
    optAllActions: language === "en" ? "All Actions" : "Todas as Ações",
    
    colTimestamp: "Timestamp (UTC)",
    colUser: language === "en" ? "User" : "Usuário",
    colAction: language === "en" ? "Action" : "Ação",
    colEntity: language === "en" ? "Entity" : "Entidade",
    colStatus: language === "en" ? "Result" : "Resultado",
    
    statusSuccess: language === "en" ? "Success" : "Sucesso",
    statusFailure: language === "en" ? "Failure" : "Falha",
    
    paginationShowing: language === "en" ? "Showing 1-4 of" : "Mostrando 1 a 4 de",
    paginationRecords: language === "en" ? "records" : "registros",
    emptyLogs: language === "en" ? "No audit logs matching selection." : "Nenhum log de auditoria encontrado nos filtros aplicados.",
    loading: language === "en" ? "Loading the audit trail..." : "Carregando a trilha de auditoria...",
    loadMore: language === "en" ? "Load more" : "Carregar mais",
    loadingMore: language === "en" ? "Loading..." : "Carregando...",
    allLoaded: language === "en" ? "End of the trail." : "Fim da trilha."
  };

  // Filter logs based on inputs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // 1. User search query
      if (userQuery.trim() !== "") {
        const query = userQuery.toLowerCase();
        if (!log.user.toLowerCase().includes(query) && !log.role.toLowerCase().includes(query)) {
          return false;
        }
      }

      // 2. Affected Entity select filter
      if (selectedEntity !== "Todos os Módulos" && selectedEntity !== "All Modules") {
        const entityLabel = log.entity.toLowerCase();
        const categoryMap: Record<string, string> = {
          "Atas de Reunião": "ata",
          "Meeting Minutes": "ata",
          "Contratos": "contrato",
          "Contracts": "contrato",
          "Controle de Acessos": "sync"
        };
        const mappedKeyword = categoryMap[selectedEntity]?.toLowerCase();
        if (mappedKeyword && !entityLabel.includes(mappedKeyword)) {
          return false;
        }
      }

      // 3. Action type select filter
      if (selectedAction !== "Todas as Ações" && selectedAction !== "All Actions") {
        const actLabel = log.action.toLowerCase();
        const actionTypeMap: Record<string, string> = {
          "Leitura (View)": "visualização",
          "Criação (Create)": "criação",
          "Atualização (Update)": "alteração",
          "Deleção (Delete)": "deleção"
        };
        const searchKeyword = actionTypeMap[selectedAction]?.toLowerCase();
        if (searchKeyword && !actLabel.includes(searchKeyword)) {
          return false;
        }
      }

      return true;
    });
  }, [logs, userQuery, selectedEntity, selectedAction]);

  const handleExportCSV = () => {
    const headers = language === "en"
      ? "Timestamp (UTC),User,Role,Action,Entity,EntityID,Status\n"
      : "Data/Hora (UTC),Usuário,Cargo,Ação,Entidade,ID da Entidade,Status\n";
    // `l.status` já vem do banco como "Sucesso"/"Falha" (ver linha 364) — só
    // precisa de tradução para inglês, nunca o contrário.
    const statusLabel = (status: string) =>
      language === "en" ? (status === "Sucesso" ? "Success" : status === "Falha" ? "Failure" : status) : status;
    const rows = filteredLogs.map(l =>
      `"${l.timestamp}","${l.user}","${l.role}","${l.action}","${l.entity}","${l.entityId}","${statusLabel(l.status)}"`
    ).join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8;" });
    const u = URL.createObjectURL(blob);
    const mockLink = document.createElement("a");
    mockLink.setAttribute("href", u);
    mockLink.setAttribute("download", `Cielo_Corporate_AuditLogs.csv`);
    document.body.appendChild(mockLink);
    mockLink.click();
    document.body.removeChild(mockLink);
  };

  const handlePrint = () => {
    window.print();
  };

  // Helper icons mapper
  const renderLogIcon = (icon: string) => {
    switch (icon) {
      case "visibility":
        return <Eye className="w-4 h-4 text-slate-400" />;
      case "sync_problem":
      case "sync":
        return <RefreshCw className="w-4 h-4 text-slate-400" />;
      case "edit_document":
        return <FolderOpen className="w-4 h-4 text-slate-400" />;
      default:
        return <Tags className="w-4 h-4 text-slate-400" />;
    }
  };

  if (unavailableReason) {
    return (
      <div className="space-y-6">
        <header className="pb-4 border-b border-slate-200/60">
          <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">{t.title}</h2>
          <p className="text-slate-500 font-medium text-sm mt-1.5 max-w-2xl">{t.subTitle}</p>
        </header>

        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
          <Lock className="w-10 h-10 text-slate-300 mx-auto mb-4" />
          <p className="text-sm font-bold text-slate-800 max-w-xl mx-auto leading-relaxed">
            {unavailableReason}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header section */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-4 border-b border-slate-200/60">
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">
            {t.title}
          </h2>
          <p className="text-slate-500 font-medium text-sm mt-1.5 max-w-2xl">
            {t.subTitle}
          </p>
        </div>
        
        {/* Print and Export Buttons */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handlePrint}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors font-bold text-xs uppercase tracking-wider bg-white cursor-pointer"
          >
            <Printer className="w-4 h-4 text-slate-500" />
            {t.btnPrint}
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#00658d] hover:bg-[#00aeef] text-white transition-colors font-bold text-xs uppercase tracking-wider cursor-pointer"
          >
            <Download className="w-4 h-4" />
            {t.btnExport}
          </button>
        </div>
      </header>

      {/* Advanced Filters block section */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-4 text-slate-800">
          <Filter className="w-5 h-5 text-[#00658d]" />
          <h3 className="font-bold text-base">{t.secFiltersTitle}</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          
          {/* Filter 1: Period Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wide">
              {t.lblPeriod}
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4 pointer-events-none" />
              <select
                value={selectedPeriod}
                onChange={(e) => setSelectedPeriod(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2.5 text-xs text-slate-700 font-semibold focus:bg-white focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] appearance-none outline-none transition-all cursor-pointer"
              >
                <option value="Últimos 7 dias">{language === "en" ? "Last 7 days" : "Últimos 7 dias"}</option>
                <option value="Últimos 30 dias">{language === "en" ? "Last 30 days" : "Últimos 30 dias"}</option>
                <option value="Este Trimestre">{language === "en" ? "This Quarter" : "Este Trimestre"}</option>
              </select>
            </div>
          </div>

          {/* Filter 2: User input searching */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wide">
              {t.lblUser}
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
              <input
                type="text"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder={t.plcSearchUser}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-2 text-xs font-medium placeholder:text-slate-400 focus:bg-white focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] outline-none transition-all text-slate-800"
              />
            </div>
          </div>

          {/* Filter 3: Entity selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wide">
              {t.lblEntity}
            </label>
            <div className="relative">
              <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4 pointer-events-none" />
              <select
                value={selectedEntity}
                onChange={(e) => setSelectedEntity(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2.5 text-xs text-slate-700 font-semibold focus:bg-white focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] appearance-none outline-none transition-all cursor-pointer"
              >
                <option value="Todos os Módulos">{t.optAllModules}</option>
                <option value="Atas de Reunião">{language === "en" ? "Meeting Minutes" : "Atas de Reunião"}</option>
                <option value="Contratos">{language === "en" ? "Contracts" : "Contratos"}</option>
                <option value="Controle de Acessos">{language === "en" ? "Access Control" : "Controle de Acessos"}</option>
              </select>
            </div>
          </div>

          {/* Filter 4: Action Type */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wide">
              {t.lblActionType}
            </label>
            <div className="relative">
              <Tags className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4 pointer-events-none" />
              <select
                value={selectedAction}
                onChange={(e) => setSelectedAction(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 py-2.5 text-xs text-slate-700 font-semibold focus:bg-white focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] appearance-none outline-none transition-all cursor-pointer"
              >
                <option value="Todas as Ações">{t.optAllActions}</option>
                <option value="Leitura (View)">{language === "en" ? "Read/View" : "Leitura (View)"}</option>
                <option value="Criação (Create)">{language === "en" ? "Create" : "Criação (Create)"}</option>
                <option value="Atualização (Update)">{language === "en" ? "Update" : "Atualização (Update)"}</option>
                <option value="Deleção (Delete)">{language === "en" ? "Delete" : "Deleção (Delete)"}</option>
              </select>
            </div>
          </div>

        </div>
      </div>

      {/* Main Ledger data table layout */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[850px]">
            <thead>
              <tr className="bg-slate-50/70 border-b border-slate-100/80 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="py-4 px-6 w-48">{t.colTimestamp}</th>
                <th className="py-4 px-4">{t.colUser}</th>
                <th className="py-4 px-4">{t.colAction}</th>
                <th className="py-4 px-4">{t.colEntity}</th>
                <th className="py-4 px-6 text-right w-32">{t.colStatus}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm font-medium text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-400 text-sm font-semibold">
                    <RefreshCw className="w-8 h-8 text-slate-300 mx-auto mb-3 animate-spin" />
                    {t.loading}
                  </td>
                </tr>
              ) : error ? (
                /* Erro é erro: a tela não finge lista vazia. */
                <tr>
                  <td colSpan={5} className="py-12 text-center text-sm font-semibold">
                    <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
                    <span className="text-red-600">{error}</span>
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-400 text-sm font-medium">
                    <FileSpreadsheet className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                    {t.emptyLogs}
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => {
                  const isSuccess = log.status === "Sucesso";
                  const isExpanded = expandedLogId === log.id;

                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                        className="hover:bg-[#d5e0f8]/10 transition-colors cursor-pointer group"
                      >
                        {/* Timestamp columns styled in Monospace spacing */}
                        <td className="py-4 px-6 text-slate-500 font-mono text-xs whitespace-nowrap">
                          {log.timestamp}
                        </td>

                        {/* Executed User Details */}
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[#d5e0f8] text-[#00658d] flex items-center justify-center font-bold text-xs select-none">
                              {log.initials}
                            </div>
                            <div>
                              <div className="text-slate-900 font-bold text-sm">
                                {log.user}
                              </div>
                              <div className="text-[10px] text-slate-400 font-bold tracking-wide uppercase">
                                {log.role}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Action column with matching metadata icon */}
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-2 font-bold text-slate-800">
                            {renderLogIcon(log.icon)}
                            {log.action}
                          </div>
                        </td>

                        {/* Affected entity location */}
                        <td className="py-4 px-4 font-sans">
                          <div className="text-[#00658d] font-bold hover:underline">
                            {log.entity}
                          </div>
                          <div className="text-[10px] text-slate-400 font-semibold tracking-wide">
                            {log.entityId}
                          </div>
                        </td>

                        {/* Result output status columns */}
                        <td className="py-4 px-6 text-right">
                          <span
                            className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
                              isSuccess
                                ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                                : "bg-rose-50 text-rose-800 border border-rose-250"
                            }`}
                          >
                            {isSuccess ? t.statusSuccess : t.statusFailure}
                          </span>
                        </td>
                      </tr>

                      {/* Expanded View with logs metadata */}
                      {isExpanded && (
                        <tr className="bg-slate-50/50">
                          <td colSpan={5} className="py-4 px-8 border-l-4 border-[#00658d] animate-fade-in text-xs">
                            <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-2.5">
                              <h4 className="text-slate-900 font-bold uppercase tracking-wider text-[10px] text-slate-400 flex items-center gap-2">
                                <CornerDownRight className="w-3.5 h-3.5 text-[#00658d]" />
                                {language === "en" ? "Metadata Blockchain Verification" : "Verificação de Logs no Blockchain"}
                              </h4>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1 font-mono text-[11px] text-slate-600">
                                <div>
                                  <span className="block text-slate-400 font-bold uppercase text-[9px]">{language === "en" ? "Node ID" : "ID do Nodo"}</span>
                                  node_usc_1092
                                </div>
                                <div>
                                  <span className="block text-slate-400 font-bold uppercase text-[9px]">{language === "en" ? "Verification Certificate" : "Hash de Assinatura"}</span>
                                  {language === "en" ? "SHA-256 Verified" : "SHA-256 Verificado"}
                                </div>
                                <div className="col-span-2">
                                  <span className="block text-slate-400 font-bold uppercase text-[9px]">{language === "en" ? "Cielo SHA Block Hash" : "Hash do Bloco SHA Cielo"}</span>
                                  8fa10b9ce2f83d41fe0901da38ba4cf07161e1b52a1
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/*
          RODAPÉ — paginação por CURSOR, não por página numerada.

          A trilha cresce enquanto se navega; "página 3 de 12" seria um número
          que envelhece entre uma requisição e outra. O que a tela sabe dizer
          com honestidade é quantos registros ela carregou até agora e se o
          servidor ainda tem mais.
        */}
        {!loading && !error && filteredLogs.length > 0 && (
          <div className="border-t border-slate-100 p-4 bg-slate-50/40 flex items-center justify-between gap-3 select-none">
            <div className="text-slate-400 text-xs font-semibold">
              {t.paginationShowing}{" "}
              <span className="font-bold text-slate-700">{filteredLogs.length}</span>{" "}
              {t.paginationRecords}
            </div>

            {hasMore ? (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="px-4 py-2 bg-white border border-slate-200 hover:border-[#00aeef] text-[#00658d] text-xs font-extrabold rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                {loadingMore ? t.loadingMore : t.loadMore}
              </button>
            ) : (
              <span className="text-[11px] font-semibold text-slate-300">{t.allLoaded}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
