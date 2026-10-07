import { apiRequest, apiRequestBlob } from "./api";
import type { CreateParticipantPayload } from "./meeting-adapters";

/**
 * AGENDA ANUAL — consolida as reuniões (do Calendário) de um órgão no ano,
 * prepara Pauta -> Tema nas MESMAS entidades da reunião e passa por aprovação.
 * Aprovada, a versão enviada (snapshot) fica bloqueada; o Pipeline segue
 * operando as reuniões.
 */

export type AnnualAgendaStatus = "draft" | "pending_approval" | "approved";

export interface AnnualAgendaSummary {
  id: string;
  governanceBody: { id: string; name: string };
  year: number;
  title: string;
  status: AnnualAgendaStatus;
  approvalSentAt: string | null;
  approvalSentTo: string | null;
  approvedAt: string | null;
  itemsCount: number;
  reservedCount: number;
  /** Reuniões associadas (qualquer origem). */
  meetingsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnnualAgendaItem {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  meeting: {
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    timezone: string;
    status: string;
    calendarSyncStatus: "pending" | "synced" | "failed" | "stale" | null;
  } | null;
}

export interface AnnualAgendaMeeting {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  status: string;
  origin: "manual" | "annual_agenda";
  calendarSyncStatus: "pending" | "synced" | "failed" | "stale" | null;
  /** Nasceu da reserva de uma data planejada (não pode ser desassociada). */
  plannedItemId: string | null;
  agendas: Array<{ id: string; title: string; position: number }>;
  /** Temas na ordem GLOBAL da reunião, com cronograma calculado no servidor. */
  items: Array<{
    id: string;
    title: string;
    position: number;
    agendaId: string | null;
    agendaTopicId: string | null;
    durationMinutes: number | null;
    /** Ficha do tema (a mesma do Pipeline). */
    responsibleLabel: string | null;
    responsibleEntraObjectId: string | null;
    typeId: string | null;
    natureId: string | null;
    isCircularTheme: boolean;
    description: string | null;
    inicio: string;
    fim: string | null;
    /** Participantes vinculados AO TEMA. */
    participants: Array<{ id: string; name: string }>;
  }>;
  tempo: { reuniaoMin: number; temasMin: number; semDuracao: number; excessoMin: number; disponivelMin: number };
  /** Participantes DA REUNIÃO (`meeting_participants`), uma vez cada. */
  participants: Array<{ id: string; name: string; email: string | null; external: boolean; inGovernanceBodyGroup: boolean }>;
  /*
   * Sem aprovação (10/2026) a Agenda mostra sempre a reunião AO VIVO; os
   * campos de comparação com a versão aprovada (`current`, `sent`,
   * `changedAfterSending`) vêm sempre `null` do servidor e não são lidos.
   */
}

export interface AnnualAgendaVersion {
  id: string;
  number: number;
  state: "open" | "approved";
  sentAt: string;
  sentTo: string;
  approvedAt: string | null;
  approvedByName: string | null;
}

export interface AnnualAgendaDetail extends AnnualAgendaSummary {
  /** Sempre `true` desde a remoção da aprovação; a permissão é `canManage`. */
  editable: boolean;
  /** Datas planejadas (reserva). */
  items: AnnualAgendaItem[];
  meetings: AnnualAgendaMeeting[];
  candidates: Array<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    timezone: string;
    origin: "manual" | "annual_agenda";
    linkedToOtherAgenda: boolean;
  }>;
  /** Última versão enviada/aprovada ANTES de 10/2026 — só histórico. */
  version: AnnualAgendaVersion | null;
  totals: { reunioes: number; pautas: number; temas: number };
}

const json = (method: string, body?: unknown) => ({
  auth: true,
  method,
  ...(body === undefined
    ? {}
    : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
});

export async function listAnnualAgendas(signal?: AbortSignal): Promise<AnnualAgendaSummary[]> {
  const { annualAgendas } = await apiRequest<{ annualAgendas: AnnualAgendaSummary[] }>("/annual-agendas", {
    auth: true,
    signal
  });
  return annualAgendas;
}

/** Ano -> órgão -> agenda formal (ou não) -> reuniões do Calendário. */
export interface AnnualOverviewGroup {
  governanceBody: { id: string; name: string; isActive: boolean };
  agenda: { id: string; title: string; status: AnnualAgendaStatus; meetingsCount: number } | null;
  meetings: Array<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    timezone: string;
    status: string;
    origin: "manual" | "annual_agenda";
    annualAgendaId: string | null;
  }>;
}

/** Somente leitura: abrir a visão NÃO cria Agenda Anual. */
export async function getAnnualOverview(
  year: number,
  signal?: AbortSignal
): Promise<{ years: number[]; groups: AnnualOverviewGroup[] }> {
  const { years, groups } = await apiRequest<{ year: number; years: number[]; groups: AnnualOverviewGroup[] }>(
    `/annual-agendas/overview?year=${encodeURIComponent(String(year))}`,
    { auth: true, signal }
  );
  return { years, groups };
}

export const getAnnualAgenda = (id: string, signal?: AbortSignal) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}`, { auth: true, signal });

export const createAnnualAgenda = (payload: { governanceBodyId: string; year: number; title: string }) =>
  apiRequest<AnnualAgendaDetail>("/annual-agendas", json("POST", payload));

export const deleteAnnualAgenda = (id: string) =>
  apiRequest<void>(`/annual-agendas/${id}`, { auth: true, method: "DELETE" });

/** PRÉVIA: compilado do estado atual (PDF). */
export const downloadAnnualAgendaPdf = (id: string) =>
  apiRequestBlob(`/annual-agendas/${id}/pdf`, { auth: true });

/** Documento da versão enviada/aprovada antes de 10/2026 (histórico, snapshot gravado). */
export const downloadAnnualAgendaDocument = (id: string) =>
  apiRequestBlob(`/annual-agendas/${id}/document`, { auth: true });

/** Associa reunião existente (só o vínculo; nenhum convite novo). */
export const associateAnnualMeeting = (id: string, meetingId: string) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/meetings`, json("POST", { meetingId }));

export const dissociateAnnualMeeting = (id: string, meetingId: string) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/meetings/${meetingId}`, { auth: true, method: "DELETE" });

// Pauta -> Tema pela Agenda Anual (mesmas entidades da reunião).
const conteudo = (id: string, meetingId: string) => `/annual-agendas/${id}/meetings/${meetingId}`;

export const renameAnnualPauta = (id: string, meetingId: string, agendaId: string, title: string) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agendas/${agendaId}`, json("PATCH", { title }));

export const deleteAnnualPauta = (id: string, meetingId: string, agendaId: string) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agendas/${agendaId}`, { auth: true, method: "DELETE" });

/** Edição pela Agenda Anual: campos do cadastro do tema, só nesta reunião (nunca o tema-mestre). */
export const updateAnnualTema = (
  id: string,
  meetingId: string,
  itemId: string,
  payload: {
    title?: string;
    agendaId?: string;
    durationMinutes?: number | null;
    responsibleLabel?: string | null;
    responsibleEntraObjectId?: string | null;
    agendaTopicTypeId?: string | null;
    agendaTopicNatureId?: string | null;
    isCircularTheme?: boolean;
    description?: string | null;
  }
) => apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agenda-items/${itemId}`, json("PATCH", payload));

/**
 * Cadastro completo do "+ Novo tema": o servidor cadastra o tema na Biblioteca
 * (participantes viram os participantes padrão) e cria a instância na reunião.
 */
export interface NovoTemaPayload {
  title: string;
  durationMinutes: number;
  responsibleLabel?: string;
  responsibleEntraObjectId?: string;
  agendaTopicTypeId?: string;
  agendaTopicNatureId?: string;
  isCircularTheme: boolean;
  description?: string;
  agendaId?: string;
  participants: CreateParticipantPayload[];
}

/** Tema da Biblioteca: só o id (+ duração/pauta); o servidor resolve o resto. */
export interface TemaDaBibliotecaPayload {
  agendaTopicId: string;
  durationMinutes?: number;
  agendaId?: string;
}

/**
 * "+ Novo tema" / "Adicionar da Biblioteca": tema direto na reunião. Sem pauta,
 * o servidor cria a pauta padrão na mesma transação.
 */
export const createAnnualTema = (id: string, meetingId: string, payload: NovoTemaPayload | TemaDaBibliotecaPayload) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/temas`, json("POST", payload));

/** Ordem dos temas (arrastar e soltar); horários recalculados no servidor. */
export const reorderAnnualTemas = (id: string, meetingId: string, agendaItemIds: string[]) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agenda-items/order`, json("PUT", { agendaItemIds }));

/** Participantes DA REUNIÃO pela Agenda (mesmas regras da aba Participantes do Pipeline). */
export const addAnnualMeetingParticipant = (id: string, meetingId: string, payload: CreateParticipantPayload) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/participants`, json("POST", payload));

export const removeAnnualMeetingParticipant = (id: string, meetingId: string, participantId: string) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/participants/${participantId}`, { auth: true, method: "DELETE" });

export const linkAnnualTemaParticipant = (id: string, meetingId: string, itemId: string, payload: CreateParticipantPayload) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agenda-items/${itemId}/participants`, json("POST", payload));

export const unlinkAnnualTemaParticipant = (id: string, meetingId: string, itemId: string, participantId: string) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agenda-items/${itemId}/participants/${participantId}`, {
    auth: true,
    method: "DELETE"
  });

export const deleteAnnualTema = (id: string, meetingId: string, itemId: string) =>
  apiRequest<AnnualAgendaDetail>(`${conteudo(id, meetingId)}/agenda-items/${itemId}`, { auth: true, method: "DELETE" });

/**
 * Rótulo da Agenda Anual formalizada. Sem aprovação (10/2026) o status gravado
 * (`draft`/`pending_approval`/`approved`) é só histórico e não muda o rótulo.
 */
export function annualStatusLabel(_status: AnnualAgendaStatus, language: "en" | "pt"): string {
  return language === "pt" ? "Formalizada" : "Prepared";
}

export function describeAnnualAgendaError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;
  if (status === 0) return pt ? "Não foi possível falar com o servidor." : "Could not reach the server.";
  if (status === 401) return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired.";
  if (status === 403) {
    return mensagem && mensagem.includes("Mail.Send")
      ? mensagem
      : pt
        ? "Sua conta não tem acesso a esta ação no PGCP."
        : "Your account cannot perform this action.";
  }
  if (status && status >= 400 && status < 500 && mensagem) return mensagem;
  return pt ? "Não foi possível concluir a operação. Tente novamente." : "The operation could not be completed.";
}
