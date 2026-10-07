import { apiRequest } from "./api";
import type { PhysicalLocation } from "../types";
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

/** Resultado de excluir (= cancelar) a reunião. */
export interface ResultadoDoCancelamento {
  meetingId: string;
  cancelledAt: string;
  /** `pending` = o Graph falhou; excluir de novo reenvia o cancelamento. */
  calendarCancellation: "cancelled" | "not_required" | "pending";
  warning?: string;
}

/**
 * Exclui a reunião = CANCELAMENTO LÓGICO (036). Nada é apagado: versões,
 * documentos, Ata e trilha ficam como histórico; o evento do Outlook/Teams é
 * cancelado (convidados recebem o cancelamento). Repetir é idempotente.
 */
export const deleteMeeting = (id: string): Promise<ResultadoDoCancelamento> =>
  apiRequest<ResultadoDoCancelamento>(`/meetings/${id}`, { auth: true, method: "DELETE" });

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
  /** Só reunião sem tipo (legado). Com tipo, o servidor monta o título. */
  title?: string;
  /** Tipo (030): define o título padronizado, recomposto pelo servidor. */
  sessionType?: "ordinary" | "extraordinary";
  description?: string | null;
  governanceBodyId?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  meetingLink?: string | null;
  recurrence?: string | null;
  pendingRequirements?: string | null;
  /** Só as transições que o produto executa hoje. */
  status?: "scheduled" | "in_progress" | "done";
  /** Modalidade/local (025). Trocar atualiza o MESMO evento no Outlook. */
  modality?: "online" | "in_person";
  physicalLocationId?: string | null;
  /**
   * LISTA COMPLETA de participantes (edição no modal). Existente = `{ id }`;
   * nova pessoa = mesmo corpo da inclusão avulsa. Quem sumir da lista sai da
   * reunião. Tudo numa edição só: uma versão, uma atualização do convite.
   */
  participants?: Array<{ id: string } | CreateParticipantPayload>;
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

/**
 * Remove a pessoa DA REUNIÃO (aba Participantes). O cascade da 020 apaga os
 * vínculos dela com todos os temas. Não toca no cadastro de participante externo.
 */
export const removeParticipant = (meetingId: string, participantId: string) =>
  mutar(`/meetings/${meetingId}/participants/${participantId}`, "DELETE");

/**
 * PAUTAS (025) — agrupadores de temas. Reunião -> Pauta -> Tema.
 * Excluir pauta com temas responde 409 (mova ou exclua os temas antes).
 */
export const addAgenda = (meetingId: string, title: string) =>
  mutar(`/meetings/${meetingId}/agendas`, "POST", { title });

export const renameAgenda = (meetingId: string, agendaId: string, title: string) =>
  mutar(`/meetings/${meetingId}/agendas/${agendaId}`, "PATCH", { title });

export const removeAgenda = (meetingId: string, agendaId: string) =>
  mutar(`/meetings/${meetingId}/agendas/${agendaId}`, "DELETE");

/** Locais ATIVOS do cadastro (Administração → Locais) para o agendamento. */
export async function listMeetingLocations(signal?: AbortSignal): Promise<PhysicalLocation[]> {
  const { locations } = await apiRequest<{ locations: PhysicalLocation[] }>("/meetings/locations", {
    auth: true,
    signal
  });
  return locations;
}

/** TEMAS da reunião (endpoint técnico `agenda-items`). */
export const addAgendaItem = (meetingId: string, payload: CreateAgendaItemPayload) =>
  mutar(`/meetings/${meetingId}/agenda-items`, "POST", payload);

/** PATCH parcial: envia só o que mudou. */
export type AgendaItemPatchPayload = Omit<Partial<CreateAgendaItemPayload>, "agendaId"> & {
  /** Move o tema de pauta; `null` = sem pauta. */
  agendaId?: string | null;
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
 * Participantes POR TEMA. Vincular usa o MESMO payload de participante — se a
 * pessoa não estiver na reunião, o backend a adiciona. Remover do tema desfaz
 * SÓ o vínculo com aquele tema: a pessoa segue na reunião e nos demais temas.
 */
export const addAgendaItemParticipant = (meetingId: string, itemId: string, payload: CreateParticipantPayload) =>
  mutar(`/meetings/${meetingId}/agenda-items/${itemId}/participants`, "POST", payload);

export const removeAgendaItemParticipant = (meetingId: string, itemId: string, participantId: string) =>
  mutar(`/meetings/${meetingId}/agenda-items/${itemId}/participants/${participantId}`, "DELETE");

// -----------------------------------------------------------------------------
// Mensagem Teams por pauta
// -----------------------------------------------------------------------------

export const TEAMS_MESSAGE_MAX_LENGTH = 4000;

export interface TeamsDeliveryResult {
  participantId: string;
  participantName: string;
  status: "sent" | "failed";
  code?: string;
  retryAfterSeconds?: number;
}

export interface TeamsMessageResponse {
  meetingId: string;
  agendaItemId: string;
  total: number;
  sent: number;
  failed: number;
  results: TeamsDeliveryResult[];
  retryAfterSeconds?: number;
}

/** Envia somente texto; os destinatarios sao resolvidos pela API a partir da pauta. */
export const sendAgendaItemTeamsMessage = (
  meetingId: string,
  itemId: string,
  message: string
) => apiRequest<TeamsMessageResponse>(
  `/meetings/${meetingId}/agenda-items/${itemId}/teams-message`,
  {
    auth: true,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  }
);

/** Chamada automatica: texto e destinatarios sao determinados integralmente pela API. */
export const callAgendaItemParticipants = (
  meetingId: string,
  itemId: string
) => apiRequest<TeamsMessageResponse>(
  `/meetings/${meetingId}/agenda-items/${itemId}/teams-call`,
  { auth: true, method: "POST" }
);

export function describeTeamsMessageError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const message = (error as { message?: string } | null)?.message;

  if (status === 400) return message ?? (pt ? "Mensagem inválida." : "Invalid message.");
  if (status === 401) return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired. Sign in again.";
  if (status === 403) {
    return pt
      ? "Não foi possível enviar em nome da sua conta. Entre novamente; se persistir, procure a Secretaria de Governança."
      : "The message could not be sent as your account. Sign in again; if it persists, contact Governance.";
  }
  if (status === 404) {
    return pt
      ? "A pauta não foi encontrada nesta reunião. Recarregue a página."
      : "The agenda item was not found in this meeting. Reload the page.";
  }
  if (status === 422) {
    return message ?? (
      pt
        ? "A reunião ainda não possui os dados necessários para realizar a chamada."
        : "The meeting does not yet have the information required for this call."
    );
  }
  if (status === 429) {
    return pt
      ? "O Teams está limitando os envios. Aguarde o tempo indicado e tente novamente."
      : "Teams is throttling messages. Wait for the indicated time and try again.";
  }
  if (status === 0) {
    return pt
      ? "Não foi possível falar com o servidor. Verifique sua conexão."
      : "Could not reach the server. Check your connection.";
  }
  return pt
    ? "Não foi possível enviar a mensagem no Teams. Tente novamente."
    : "The Teams message could not be sent. Try again.";
}

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
