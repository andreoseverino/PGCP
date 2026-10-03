import type { AgendaItem, Meeting, MeetingAgenda } from "../types";

/**
 * PIPELINE — onde toda reunião criada (Calendário ou Agenda Anual) é preparada.
 *
 * As etapas são DERIVADAS dos eixos que já existem no banco; nenhum status novo
 * foi criado (ver migration 025):
 *
 *   Realizada            meetings.status em done/approved/closed
 *   Pronta para reunião  pautas aprovadas (agenda_validation = approved)
 *                        ou reunião já em andamento
 *   Em preparação        já tem tema cadastrado, ou pautas enviadas à validação
 *   Agendada             reservada, ainda sem preparação
 *
 * Puro, para ser afirmável sem React.
 */

export type PipelineStage = "scheduled" | "preparing" | "ready" | "done";

export const PIPELINE_STAGES: ReadonlyArray<{ id: PipelineStage; pt: string; en: string }> = [
  { id: "scheduled", pt: "Agendada", en: "Scheduled" },
  { id: "preparing", pt: "Em preparação", en: "In preparation" },
  { id: "ready", pt: "Pronta para reunião", en: "Ready" },
  { id: "done", pt: "Realizada", en: "Held" }
];

type MeetingParaEtapa = Pick<Meeting, "status" | "agendaItemsCount" | "agendaValidation">;

/**
 * Reunião operacional no Pipeline? A decisão é do servidor
 * (`releasedToPipeline`): de Agenda Anual, só depois de aprovada; avulsa,
 * sempre. O servidor também recusa as mutações (409) — isto só organiza a tela.
 */
export function operacionalNoPipeline(meeting: { releasedToPipeline?: boolean }): boolean {
  return meeting.releasedToPipeline !== false;
}

export function pipelineStage(meeting: MeetingParaEtapa): PipelineStage {
  if (meeting.status === "Done" || meeting.status === "Approved" || meeting.status === "Closed") {
    return "done";
  }
  if (meeting.status === "In Progress") return "ready";
  if (meeting.agendaValidation?.status === "approved") return "ready";
  if ((meeting.agendaItemsCount ?? 0) > 0 || meeting.agendaValidation?.status === "sent") {
    return "preparing";
  }
  return "scheduled";
}

/** Agrupa por etapa, com as mais próximas primeiro (Realizada: mais recentes primeiro). */
export function groupByStage<T extends MeetingParaEtapa & Pick<Meeting, "date" | "startTime">>(
  meetings: readonly T[]
): Record<PipelineStage, T[]> {
  const grupos: Record<PipelineStage, T[]> = { scheduled: [], preparing: [], ready: [], done: [] };
  for (const m of meetings) grupos[pipelineStage(m)].push(m);

  const chave = (m: T) => `${m.date} ${m.startTime}`;
  for (const etapa of ["scheduled", "preparing", "ready"] as const) {
    grupos[etapa].sort((a, b) => chave(a).localeCompare(chave(b)));
  }
  grupos.done.sort((a, b) => chave(b).localeCompare(chave(a)));
  return grupos;
}

/** Rótulo da origem para o usuário (sem expor MANUAL/ANNUAL_AGENDA). */
export function originLabel(origin: Meeting["origin"], language: "en" | "pt"): string {
  if (origin === "annual_agenda") return language === "pt" ? "Agenda Anual" : "Annual plan";
  return language === "pt" ? "Calendário" : "Calendar";
}

/**
 * Temas agrupados por PAUTA, na ordem das pautas; temas sem pauta ao final.
 * Reunião -> Pauta -> Tema, sem nível intermediário.
 */
export function temasPorPauta(
  agendas: readonly MeetingAgenda[],
  temas: readonly AgendaItem[]
): Array<{ agenda: MeetingAgenda | null; temas: AgendaItem[] }> {
  const ids = new Set(agendas.map((a) => a.id));
  const grupos = [...agendas]
    .sort((a, b) => a.position - b.position)
    .map((agenda) => ({ agenda: agenda as MeetingAgenda | null, temas: temas.filter((t) => t.agendaId === agenda.id) }));
  const soltos = temas.filter((t) => !t.agendaId || !ids.has(t.agendaId));
  if (soltos.length > 0) grupos.push({ agenda: null, temas: soltos });
  return grupos;
}
