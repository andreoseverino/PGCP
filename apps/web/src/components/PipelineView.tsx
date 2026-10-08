import React, { useMemo } from "react";
import { AlertTriangle, ChevronRight, Clock, ListChecks, Trash2, Users, Workflow } from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import { filtrarPorOrgao } from "../lib/governance-filter";
import { PIPELINE_STAGES, pipelineStage, type PipelineStage } from "../lib/pipeline";
import { pendenciasDaReuniao } from "../lib/pipeline-list";

/**
 * PIPELINE — espaço operacional de PREPARAÇÃO, no visual da Agenda Anual: ano
 * e órgãos à esquerda, reuniões do órgão no ano à direita (10/2026; substituiu
 * o Quadro por etapas e a Lista). Clicar numa reunião abre o DETALHE DA
 * REUNIÃO, onde pautas, temas, participantes, documentos e Ata são editados;
 * ao voltar, a aba reabre no mesmo ano/órgão (estado guardado pelo App).
 *
 * As reuniões vêm da lista já carregada pelo App (`GET /meetings`), filtrada
 * pelo órgão do contexto global e SÓ as que estão na versão APROVADA da Agenda
 * Anual (`approvedInAnnualAgenda`, calculado no servidor): o Pipeline começa
 * quando a Agenda do órgão é aprovada. Etapa e pendências são derivadas
 * (`lib/pipeline.ts`, `lib/pipeline-list.ts`). Excluir (= cancelar, 036) fica
 * no cartão, só para quem agenda; a confirmação é do App.
 */

export interface PipelineSelecao {
  ano: number | null;
  orgaoId: string | null;
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

const COR_DA_ETAPA: Record<PipelineStage, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  preparing: "bg-amber-50 text-amber-700",
  ready: "bg-sky-50 text-[#00658d]",
  done: "bg-emerald-50 text-emerald-700"
};

export default function PipelineView({
  language,
  meetings,
  meetingsLoading,
  governanceBodies,
  orgaoContexto,
  selecao,
  onSelecao,
  onOpenMeeting,
  canSchedule,
  onDeleteMeeting
}: {
  language: "en" | "pt";
  meetings: Meeting[];
  meetingsLoading: boolean;
  governanceBodies: GovernanceBody[];
  orgaoContexto: string;
  selecao: PipelineSelecao;
  onSelecao: (s: PipelineSelecao) => void;
  onOpenMeeting: (m: Meeting) => void;
  canSchedule: boolean;
  /** Abre a confirmação de exclusão (App). */
  onDeleteMeeting: (id: string) => void;
}) {
  const pt = language === "pt";
  const visiveis = useMemo(
    () =>
      filtrarPorOrgao(meetings, orgaoContexto).filter(
        (m) => !m.cancelledAt && m.governanceBodyId && m.approvedInAnnualAgenda === true
      ),
    [meetings, orgaoContexto]
  );

  const anos = useMemo(() => {
    const set = new Set(visiveis.map((m) => Number(m.date.slice(0, 4))).filter(Boolean));
    set.add(new Date().getFullYear());
    return [...set].sort((a, b) => b - a);
  }, [visiveis]);
  const ano = selecao.ano ?? new Date().getFullYear();

  const grupos = useMemo(() => {
    const doAno = visiveis.filter((m) => m.date.startsWith(`${ano}-`));
    const porOrgao = new Map<string, Meeting[]>();
    for (const m of doAno) porOrgao.set(m.governanceBodyId!, [...(porOrgao.get(m.governanceBodyId!) ?? []), m]);
    return [...porOrgao.entries()]
      .map(([id, lista]) => ({
        orgao: governanceBodies.find((b) => b.id === id) ?? { id, name: lista[0]!.category, isActive: true },
        reunioes: [...lista].sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
      }))
      .sort((a, b) => a.orgao.name.localeCompare(b.orgao.name, "pt-BR"));
  }, [visiveis, ano, governanceBodies]);

  const atual = grupos.find((g) => g.orgao.id === selecao.orgaoId) ?? null;
  const hoje = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-extrabold text-[#001e2d] flex items-center gap-2">
          <Workflow className="w-6 h-6 text-[#00658d]" />
          Pipeline
        </h2>
        <p className="text-xs text-slate-500 font-medium mt-1 max-w-2xl">
          {pt
            ? "As reuniões da Agenda Anual aprovada, por órgão colegiado. Clique numa reunião para abrir o detalhe e preparar pautas, temas, participantes e documentos."
            : "Meetings from the approved annual plan, by governance body. Click a meeting to open its detail and prepare agendas, topics, participants and documents."}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-5 items-start">
        <aside className="space-y-2">
          <div className="bg-white border border-slate-200 rounded-2xl p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="pipeline-ano" className={LABEL}>{pt ? "Ano" : "Year"}</label>
              <select
                id="pipeline-ano"
                value={ano}
                onChange={(e) => onSelecao({ ano: Number(e.target.value), orgaoId: null })}
                className="bg-white border border-slate-200 rounded-xl px-2 py-2 text-xs text-slate-700 cursor-pointer"
              >
                {anos.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
          {meetingsLoading && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}
          {!meetingsLoading && grupos.length === 0 && (
            <p className="text-[11px] text-slate-400 font-semibold bg-white border border-dashed border-slate-200 rounded-2xl p-4">
              {pt
                ? "Nenhuma reunião aprovada. As reuniões aparecem aqui quando a Agenda Anual do órgão é aprovada."
                : "No approved meetings. Meetings show up here once the body's annual plan is approved."}
            </p>
          )}
          {grupos.map((g) => {
            const proxima = g.reunioes.find((m) => m.date >= hoje);
            return (
              <button
                key={g.orgao.id}
                type="button"
                onClick={() => onSelecao({ ano, orgaoId: g.orgao.id })}
                className={`w-full text-left bg-white border rounded-2xl p-4 space-y-1 cursor-pointer transition ${
                  selecao.orgaoId === g.orgao.id ? "border-[#00658d] ring-1 ring-[#00658d]/30" : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-extrabold text-[#00658d]">{ano}</span>
                  <span className="text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {g.reunioes.length} {pt ? (g.reunioes.length === 1 ? "reunião" : "reuniões") : "meetings"}
                  </span>
                </div>
                <p className="text-[13px] font-extrabold text-slate-800">{g.orgao.name}</p>
                <p className="text-[10px] text-slate-500 font-semibold">
                  {proxima
                    ? `${pt ? "Próxima" : "Next"}: ${proxima.date.split("-").reverse().join("/")} · ${proxima.startTime}`
                    : pt ? "Sem reuniões futuras" : "No upcoming meetings"}
                </p>
              </button>
            );
          })}
        </aside>

        {atual ? (
          <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 space-y-5 min-w-0">
            <header className="min-w-0">
              <p className="text-[10px] font-extrabold text-[#00658d] uppercase tracking-wide">{atual.orgao.name}</p>
              <h3 className="text-xl font-extrabold text-[#001e2d]">{atual.orgao.name} — {ano}</h3>
              <span className="text-[10px] text-slate-500 font-semibold">
                {atual.reunioes.length} {pt ? "reuniões" : "meetings"} ·{" "}
                {atual.reunioes.reduce((s, m) => s + (m.agendaItemsCount ?? 0), 0)} {pt ? "temas" : "topics"}
              </span>
            </header>

            <div className="space-y-2.5">
              <h4 className="text-xs font-extrabold text-slate-800">{pt ? "Reuniões do ano" : "Meetings of the year"}</h4>
              {atual.reunioes.map((m) => {
                const etapa = pipelineStage(m);
                const rotulo = PIPELINE_STAGES.find((s) => s.id === etapa)!;
                const pendencias = pendenciasDaReuniao(m, language);
                return (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenMeeting(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenMeeting(m);
                      }
                    }}
                    className="w-full text-left border border-slate-200 rounded-2xl bg-white hover:border-[#00658d]/40 hover:bg-sky-50/30 transition cursor-pointer flex items-start gap-3 p-3.5 group focus:outline-none focus:ring-2 focus:ring-[#00658d]/30"
                  >
                    <div className="w-12 shrink-0 text-center">
                      <p className="text-lg font-extrabold text-[#001e2d] leading-none">{m.date.slice(8, 10)}</p>
                      <p className="text-[10px] font-extrabold text-[#00658d]">{MESES[Number(m.date.slice(5, 7)) - 1]}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-extrabold text-slate-800 truncate group-hover:text-[#00658d]" title={m.title}>{m.title}</p>
                      <p className="text-[10px] text-slate-500 font-semibold flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                        <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{m.startTime}–{m.endTime}</span>
                        <span className="inline-flex items-center gap-1"><ListChecks className="w-3 h-3" />{m.agendaItemsCount ?? 0} {pt ? "tema(s)" : "topic(s)"}</span>
                        {m.expectedParticipantsCount !== undefined && (
                          <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{m.expectedParticipantsCount}</span>
                        )}
                      </p>
                      {pendencias.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {pendencias.map((p) => (
                            <span
                              key={p.tipo}
                              className={`inline-flex items-center gap-1 text-[9px] font-extrabold px-1.5 py-0.5 rounded-full ${
                                p.grave ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              <AlertTriangle className="w-2.5 h-2.5" />
                              {p.texto}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full shrink-0 mt-0.5 ${COR_DA_ETAPA[etapa]}`}>
                      {pt ? rotulo.pt : rotulo.en}
                    </span>
                    {canSchedule && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteMeeting(m.id);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={pt ? "Excluir reunião" : "Delete meeting"}
                        aria-label={pt ? `Excluir reunião ${m.title}` : `Delete meeting ${m.title}`}
                        className="p-1 -mt-0.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-[#00658d] shrink-0 mt-0.5" />
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-10 text-center text-[11px] text-slate-400 font-semibold">
            {grupos.length > 0
              ? pt ? "Selecione um órgão para ver as reuniões do ano." : "Select a body to see the year's meetings."
              : pt ? "Nenhuma reunião neste ano." : "No meetings this year."}
          </div>
        )}
      </div>
    </div>
  );
}
