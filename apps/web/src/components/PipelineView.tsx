import React, { useMemo, useState } from "react";
import { Columns3, List, MapPin, MonitorSmartphone, RefreshCw, Search, Users, Workflow } from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import { groupByStage, originLabel, PIPELINE_STAGES, type PipelineStage } from "../lib/pipeline";
import GovernanceBodyFilter from "./GovernanceBodyFilter";
import { filtrarPorOrgao, TODOS_OS_ORGAOS } from "../lib/governance-filter";

/**
 * PIPELINE — espaço operacional de PREPARAÇÃO.
 *
 * Concentra toda reunião já criada, venha do Calendário ou da Agenda Anual, e
 * é por aqui que se entra em cada uma para completar pautas, temas,
 * participantes e documentos. As etapas são derivadas (`lib/pipeline.ts`).
 *
 * "Lista" reaproveita a tela de reuniões existente (filtros, próximas/passadas,
 * exportação), agora sem o botão de nova reunião — agendar é no Calendário.
 */

interface PipelineViewProps {
  language: "en" | "pt";
  meetings: Meeting[];
  meetingsLoading: boolean;
  meetingsError: string | null;
  governanceBodies: GovernanceBody[];
  onReload: () => void;
  onMeetingClick: (meeting: Meeting) => void;
  /** Tela de lista existente, renderizada no modo "Lista", já filtrada por órgão. */
  renderList: (meetings: Meeting[]) => React.ReactNode;
}

const COR_DA_ETAPA: Record<PipelineStage, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  preparing: "bg-amber-50 text-amber-700",
  ready: "bg-emerald-50 text-emerald-700",
  done: "bg-sky-50 text-[#00658d]"
};

function rotuloDoConvite(status: Meeting["calendarSyncStatus"], pt: boolean): { texto: string; cor: string } {
  if (status === "synced") return { texto: pt ? "Convite enviado" : "Invite sent", cor: "text-emerald-600" };
  if (status === "stale") return { texto: pt ? "Convite a atualizar" : "Invite outdated", cor: "text-amber-600" };
  if (status === "failed") return { texto: pt ? "Convite falhou" : "Invite failed", cor: "text-red-600" };
  if (status === "pending") return { texto: pt ? "Convite pendente" : "Invite pending", cor: "text-slate-500" };
  return { texto: pt ? "Sem convite" : "No invite", cor: "text-slate-400" };
}

export default function PipelineView({
  language,
  meetings,
  meetingsLoading,
  meetingsError,
  governanceBodies,
  onReload,
  onMeetingClick,
  renderList
}: PipelineViewProps) {
  const pt = language === "pt";
  const [modo, setModo] = useState<"board" | "list">("board");
  const [busca, setBusca] = useState("");
  const [orgao, setOrgao] = useState(TODOS_OS_ORGAOS);

  // Órgão vale para Quadro e Lista; a busca textual é do Quadro.
  const doOrgao = useMemo(() => filtrarPorOrgao(meetings, orgao), [meetings, orgao]);
  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return doOrgao.filter(
      (m) => !termo || m.title.toLowerCase().includes(termo) || m.category.toLowerCase().includes(termo)
    );
  }, [doOrgao, busca]);

  const grupos = useMemo(() => groupByStage(filtradas), [filtradas]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-[#001e2d] flex items-center gap-2">
            <Workflow className="w-6 h-6 text-[#00658d]" />
            Pipeline
          </h2>
          <p className="text-xs text-slate-500 font-medium mt-1">
            {pt
              ? "Todas as reuniões agendadas — pelo Calendário ou pela Agenda Anual. Abra uma reunião para preparar pautas, temas, participantes e documentos."
              : "Every scheduled meeting — from the Calendar or the Annual plan. Open a meeting to prepare agendas, topics, participants and documents."}
          </p>
        </div>
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 self-start md:self-auto">
          {([
            ["board", Columns3, pt ? "Quadro" : "Board"],
            ["list", List, pt ? "Lista" : "List"]
          ] as const).map(([valor, Icone, rotulo]) => (
            <button
              key={valor}
              type="button"
              onClick={() => setModo(valor)}
              aria-pressed={modo === valor}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                modo === valor ? "bg-[#00658d] text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Icone className="w-3.5 h-3.5" />
              {rotulo}
            </button>
          ))}
        </div>
      </div>

      <div className="sm:w-64">
        <GovernanceBodyFilter
          language={language}
          id="pipeline-orgao"
          governanceBodies={governanceBodies}
          value={orgao}
          onChange={setOrgao}
        />
      </div>

      {modo === "list" ? (
        renderList(doOrgao)
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder={pt ? "Buscar reunião..." : "Search meeting..."}
                className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-[#00658d]"
              />
            </div>
            <button type="button" onClick={onReload} className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
              <RefreshCw className={`w-3.5 h-3.5 ${meetingsLoading ? "animate-spin" : ""}`} />
              {pt ? "Atualizar" : "Refresh"}
            </button>
          </div>

          {meetingsError && (
            <p role="alert" className="text-xs text-red-600 font-semibold">{meetingsError}</p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {PIPELINE_STAGES.map((etapa) => (
              <section key={etapa.id} className="bg-slate-50/70 border border-slate-200 rounded-2xl p-3 space-y-2 min-w-0">
                <header className="flex items-center justify-between px-1">
                  <h3 className="text-[11px] font-extrabold uppercase tracking-wide text-slate-600">{pt ? etapa.pt : etapa.en}</h3>
                  <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${COR_DA_ETAPA[etapa.id]}`}>
                    {grupos[etapa.id].length}
                  </span>
                </header>
                {grupos[etapa.id].length === 0 && (
                  <p className="text-[10px] text-slate-400 font-semibold px-1 py-3">{pt ? "Nenhuma reunião." : "No meetings."}</p>
                )}
                {grupos[etapa.id].map((m) => {
                  const convite = rotuloDoConvite(m.calendarSyncStatus, pt);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onMeetingClick(m)}
                      className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 hover:border-[#00658d]/40 hover:shadow-sm transition cursor-pointer space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-extrabold text-[#00658d] font-mono">
                          {m.date.split("-").reverse().join("/")} · {m.startTime}
                        </span>
                        <span className="text-[9px] font-bold text-slate-400 uppercase">{originLabel(m.origin, language)}</span>
                      </div>
                      <p className="text-[12px] font-extrabold text-slate-800 leading-snug">{m.title}</p>
                      <p className="text-[10px] text-slate-500 font-semibold truncate">{m.category}</p>
                      <div className="flex items-center gap-2.5 text-[10px] text-slate-500 font-semibold flex-wrap">
                        {m.modality === "in_person" ? (
                          <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{m.physicalLocation?.name ?? (pt ? "Presencial" : "In person")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1"><MonitorSmartphone className="w-3 h-3" />Online</span>
                        )}
                        <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{m.expectedParticipantsCount}</span>
                        <span>{m.agendaItemsCount} {pt ? "tema(s)" : "topic(s)"}</span>
                      </div>
                      <p className={`text-[10px] font-bold ${convite.cor}`}>{convite.texto}</p>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
