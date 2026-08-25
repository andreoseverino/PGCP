import { apiRequest } from "./api";
import type {
  AgendaTopicPayload,
  ApiAgendaTopic,
  ApiAgendaTopicDetail,
  TaxonomyItem,
  TaxonomyKind,
  TopicParticipantPayload
} from "./agenda-topic-adapters";

/**
 * Ponto único de acesso a `/agenda-topics`. Nenhum componente monta URL ou
 * payload por conta própria.
 *
 * O contrato e a adaptação vivem em `agenda-topic-adapters.ts` e são
 * reexportados aqui, para quem consome ter um import só.
 */

export * from "./agenda-topic-adapters";

// -----------------------------------------------------------------------------
// Chamadas
// -----------------------------------------------------------------------------

interface ListResponse {
  topics: ApiAgendaTopic[];
  count: number;
  limit: number;
}

export async function listAgendaTopics(signal?: AbortSignal): Promise<ApiAgendaTopic[]> {
  const { topics } = await apiRequest<ListResponse>("/agenda-topics", { auth: true, signal });
  return topics;
}

export const getAgendaTopic = (id: string, signal?: AbortSignal) =>
  apiRequest<ApiAgendaTopicDetail>(`/agenda-topics/${id}`, { auth: true, signal });

const comCorpo = <T>(path: string, method: string, body?: unknown) =>
  apiRequest<T>(path, {
    auth: true,
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });

export const createAgendaTopic = (payload: AgendaTopicPayload) =>
  comCorpo<ApiAgendaTopicDetail>("/agenda-topics", "POST", payload);

export const updateAgendaTopic = (id: string, payload: AgendaTopicPayload) =>
  comCorpo<ApiAgendaTopicDetail>(`/agenda-topics/${id}`, "PATCH", payload);

export const deleteAgendaTopic = (id: string) =>
  comCorpo<void>(`/agenda-topics/${id}`, "DELETE");

export const addAgendaTopicParticipant = (topicId: string, payload: TopicParticipantPayload) =>
  comCorpo<ApiAgendaTopicDetail>(`/agenda-topics/${topicId}/participants`, "POST", payload);

export const removeAgendaTopicParticipant = (topicId: string, participantId: string) =>
  comCorpo<ApiAgendaTopicDetail>(`/agenda-topics/${topicId}/participants/${participantId}`, "DELETE");

// ---------------------------------------------------------------- taxonomia

interface TaxonomyResponse {
  items: TaxonomyItem[];
}

export async function listTaxonomy(kind: TaxonomyKind, signal?: AbortSignal): Promise<TaxonomyItem[]> {
  const { items } = await apiRequest<TaxonomyResponse>(`/agenda-topics/taxonomy/${kind}`, {
    auth: true,
    signal
  });
  return items;
}

export const listAgendaTopicTypes = (signal?: AbortSignal) => listTaxonomy("types", signal);
export const listAgendaTopicNatures = (signal?: AbortSignal) => listTaxonomy("natures", signal);

export const createTaxonomyItem = (kind: TaxonomyKind, name: string) =>
  comCorpo<TaxonomyItem>(`/agenda-topics/taxonomy/${kind}`, "POST", { name });

export const renameTaxonomyItem = (kind: TaxonomyKind, id: string, name: string) =>
  comCorpo<TaxonomyItem>(`/agenda-topics/taxonomy/${kind}/${id}`, "PATCH", { name });

export const setTaxonomyActive = (kind: TaxonomyKind, id: string, isActive: boolean) =>
  comCorpo<TaxonomyItem>(`/agenda-topics/taxonomy/${kind}/${id}`, "PATCH", { isActive });

export const deleteTaxonomyItem = (kind: TaxonomyKind, id: string) =>
  comCorpo<void>(`/agenda-topics/taxonomy/${kind}/${id}`, "DELETE");
