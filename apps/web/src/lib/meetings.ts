import { apiRequest } from "./api";
import type {
  ApiMeetingDetail,
  ApiMeetingSummary,
  CreateAgendaItemPayload,
  CreateMeetingPayload,
  CreateParticipantPayload
} from "./meeting-adapters";

/**
 * Ponto único de acesso a `/meetings`. Nenhum componente monta URL ou payload
 * por conta própria.
 *
 * A conversão entre o contrato da API e o modelo das telas vive em
 * `meeting-adapters.ts` e é reexportada aqui, para quem consome ter um import
 * só.
 */

export * from "./meeting-adapters";

// -----------------------------------------------------------------------------
// Chamadas
// -----------------------------------------------------------------------------

interface ListResponse {
  meetings: ApiMeetingSummary[];
  count: number;
  limit: number;
  truncated: boolean;
}

export async function listMeetings(signal?: AbortSignal): Promise<ApiMeetingSummary[]> {
  const { meetings } = await apiRequest<ListResponse>("/meetings", { auth: true, signal });
  return meetings;
}

export async function getMeeting(id: string, signal?: AbortSignal): Promise<ApiMeetingDetail> {
  return apiRequest<ApiMeetingDetail>(`/meetings/${id}`, { auth: true, signal });
}

export async function createMeeting(payload: CreateMeetingPayload): Promise<ApiMeetingDetail> {
  return apiRequest<ApiMeetingDetail>("/meetings", {
    auth: true,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

/**
 * Mensagem para a usuária, a partir do status HTTP.
 *
 * A API já devolve texto pronto para 400 e 409 — são erros de preenchimento e
 * o servidor sabe qual campo. Os demais viram texto local, porque "Erro interno
 * ao processar a solicitação" não ajuda ninguém a decidir o que fazer.
 */
export function describeMeetingError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;

  if (status === 0) {
    return pt
      ? "Não foi possível falar com o servidor. Verifique se a API está no ar."
      : "Could not reach the server. Check whether the API is running.";
  }

  if (status === 400 || status === 409) {
    return mensagem ?? (pt ? "Dados inválidos." : "Invalid data.");
  }

  if (status === 401) {
    return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired. Sign in again.";
  }

  if (status === 403) {
    return pt
      ? "Sua conta não tem acesso a este recurso no PGCP."
      : "Your account does not have access to this resource in PGCP.";
  }

  if (status === 404) {
    return pt
      ? "O órgão de governança selecionado não existe mais. Recarregue a página."
      : "The selected governance body no longer exists. Reload the page.";
  }

  return pt
    ? "Não foi possível concluir a operação. Tente novamente."
    : "The operation could not be completed. Please try again.";
}

// -----------------------------------------------------------------------------
// Mutações do núcleo
// -----------------------------------------------------------------------------
//
// Toda mutação devolve o detalhe RELIDO do banco — o mesmo corpo de
// GET /meetings/:id. A tela substitui o estado por essa resposta em vez de
// adivinhar o resultado; assim o PostgreSQL continua sendo a fonte de verdade
// mesmo quando a gravação altera mais do que o campo tocado.

/** Campos de cabeçalho e o status formal. Nunca filhos da reunião. */
export interface UpdateMeetingPayload {
  title?: string;
  description?: string | null;
  governanceBodyId?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  location?: string | null;
  meetingLink?: string | null;
  recurrence?: string | null;
  pendingRequirements?: string | null;
  /** Só as transições que o produto executa hoje. */
  status?: "scheduled" | "in_progress" | "done";
}

const mutar = (path: string, method: string, body?: unknown) =>
  apiRequest<ApiMeetingDetail>(path, {
    auth: true,
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });

export const updateMeeting = (id: string, payload: UpdateMeetingPayload) =>
  mutar(`/meetings/${id}`, "PATCH", payload);

export const addParticipant = (meetingId: string, payload: CreateParticipantPayload) =>
  mutar(`/meetings/${meetingId}/participants`, "POST", payload);

export const removeParticipant = (meetingId: string, participantId: string) =>
  mutar(`/meetings/${meetingId}/participants/${participantId}`, "DELETE");

export const addAgendaItem = (meetingId: string, payload: CreateAgendaItemPayload) =>
  mutar(`/meetings/${meetingId}/agenda-items`, "POST", payload);

/** PATCH parcial: envia só o que mudou. */
export type AgendaItemPatchPayload = Partial<CreateAgendaItemPayload> & {
  executionStatus?: "pending" | "completed" | "postponed";
};

export const updateAgendaItem = (meetingId: string, itemId: string, payload: AgendaItemPatchPayload) =>
  mutar(`/meetings/${meetingId}/agenda-items/${itemId}`, "PATCH", payload);

/**
 * Transição de estado da pauta. Só os três persistíveis — "Apresentando" não
 * tem caminho até aqui, por construção do tipo.
 */
export const setAgendaItemStatus = (
  meetingId: string,
  itemId: string,
  executionStatus: "pending" | "completed" | "postponed"
) => updateAgendaItem(meetingId, itemId, { executionStatus });

export const removeAgendaItem = (meetingId: string, itemId: string) =>
  mutar(`/meetings/${meetingId}/agenda-items/${itemId}`, "DELETE");

/**
 * Reordena enviando a lista COMPLETA de ids na ordem desejada.
 *
 * Os ids são preservados: o servidor só reescreve `position`. Enviar as pautas
 * inteiras faria o banco recriá-las e trocar os UUIDs que o FUP vai referenciar.
 */
export const reorderAgendaItems = (
  meetingId: string,
  agendaItemIds: string[],
  scheduledStartTimes?: Record<string, string>
) => mutar(`/meetings/${meetingId}/agenda-items/order`, "PUT", { agendaItemIds, scheduledStartTimes });

/**
 * Postergar / Retomar — operações de DOMÍNIO, uma chamada cada.
 *
 * O backend coordena estado da pauta, cópia na Biblioteca e auditoria numa
 * transação. Duas chamadas do navegador não seriam atômicas.
 */
export const postponeAgendaItem = (meetingId: string, itemId: string) =>
  mutar(`/meetings/${meetingId}/agenda-items/${itemId}/postpone`, "POST");

export const resumeAgendaItem = (meetingId: string, itemId: string) =>
  mutar(`/meetings/${meetingId}/agenda-items/${itemId}/resume`, "POST");
