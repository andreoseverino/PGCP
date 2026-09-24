import { apiRequest } from "./api";
import type { ActionItemPayload, ApiActionItem } from "./action-item-adapters";

/**
 * Ponto único de acesso a `/action-items`. Nenhum componente monta URL ou
 * payload por conta própria.
 *
 * O contrato e a adaptação vivem em `action-item-adapters.ts` e são
 * reexportados aqui, para quem consome ter um import só.
 */

export * from "./action-item-adapters";

interface ListResponse {
  actionItems: ApiActionItem[];
  count: number;
  limit: number;
}

export interface ListActionItemsFilters {
  status?: "open" | "completed" | "cancelled";
  meetingId?: string;
  overdue?: boolean;
  assignedToMe?: boolean;
}

export async function listActionItems(
  filters: ListActionItemsFilters = {},
  signal?: AbortSignal
): Promise<ApiActionItem[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.meetingId) params.set("meetingId", filters.meetingId);
  if (filters.overdue) params.set("overdue", "true");
  if (filters.assignedToMe) params.set("assignedToMe", "true");

  const query = params.toString();
  const { actionItems } = await apiRequest<ListResponse>(
    `/action-items${query ? `?${query}` : ""}`,
    { auth: true, signal }
  );
  return actionItems;
}

const comCorpo = (path: string, method: string, body: unknown) =>
  apiRequest<ApiActionItem>(path, {
    auth: true,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

export const createActionItem = (payload: ActionItemPayload) =>
  comCorpo("/action-items", "POST", payload);

/** PATCH parcial: envia só o que mudou. */
export const updateActionItem = (id: string, payload: ActionItemPayload) =>
  comCorpo(`/action-items/${id}`, "PATCH", payload);

/**
 * Concluir e reabrir. `completed_at` é efeito da transição, decidido pelo
 * servidor — o cliente não o envia.
 */
export const completeActionItem = (id: string) => updateActionItem(id, { status: "completed" });
export const reopenActionItem = (id: string) => updateActionItem(id, { status: "open" });
