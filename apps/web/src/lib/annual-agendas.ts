import { apiRequest, apiRequestBlob } from "./api";
import type { CreateOrganizerPayload, CreateParticipantPayload } from "./meeting-adapters";

/**
 * AGENDA ANUAL — planejamento das reuniões de um órgão no ano.
 *
 * Reservar cria as reuniões e os convites Outlook/Teams SEM esperar a
 * aprovação do planejamento (regra de produto). Aprovação e reserva são eixos
 * independentes; a tela mostra os dois lado a lado.
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

export interface AnnualAgendaDetail extends AnnualAgendaSummary {
  items: AnnualAgendaItem[];
}

export interface ReservePayload {
  modality: "online" | "in_person";
  physicalLocationKey?: string;
  organizer?: CreateOrganizerPayload;
  participants: CreateParticipantPayload[];
}

export interface ReserveResult {
  created: number;
  invitations: Array<{ meetingId: string; title: string; syncStatus: string; error?: string }>;
  agenda: AnnualAgendaDetail;
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

export const getAnnualAgenda = (id: string, signal?: AbortSignal) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}`, { auth: true, signal });

export const createAnnualAgenda = (payload: { governanceBodyId: string; year: number; title: string }) =>
  apiRequest<AnnualAgendaDetail>("/annual-agendas", json("POST", payload));

export const deleteAnnualAgenda = (id: string) =>
  apiRequest<void>(`/annual-agendas/${id}`, { auth: true, method: "DELETE" });

export interface AnnualItemPayload {
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

export const addAnnualAgendaItem = (id: string, payload: AnnualItemPayload) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/items`, json("POST", payload));

export const updateAnnualAgendaItem = (id: string, itemId: string, payload: AnnualItemPayload) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/items/${itemId}`, json("PATCH", payload));

export const deleteAnnualAgendaItem = (id: string, itemId: string) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/items/${itemId}`, { auth: true, method: "DELETE" });

export const reserveAnnualAgenda = (id: string, payload: ReservePayload) =>
  apiRequest<ReserveResult>(`/annual-agendas/${id}/reserve`, json("POST", payload));

export const requestAnnualAgendaApproval = (id: string, approverEmail: string) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/approval-request`, json("POST", { approverEmail }));

export const markAnnualAgendaApproved = (id: string) =>
  apiRequest<AnnualAgendaDetail>(`/annual-agendas/${id}/approval`, json("POST"));

export const downloadAnnualAgendaPdf = (id: string) =>
  apiRequestBlob(`/annual-agendas/${id}/pdf`, { auth: true });

export function annualStatusLabel(status: AnnualAgendaStatus, language: "en" | "pt"): string {
  const pt = language === "pt";
  if (status === "approved") return pt ? "Aprovada" : "Approved";
  if (status === "pending_approval") return pt ? "Aguardando aprovação" : "Awaiting approval";
  return pt ? "Em elaboração" : "Draft";
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
