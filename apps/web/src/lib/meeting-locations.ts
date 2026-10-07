import { apiRequest } from "./api";

/**
 * LOCAIS de reunião presencial (`/meeting-locations`) — cadastro da
 * Administração. Sem exclusão: inativar tira o local das reuniões NOVAS; as
 * reuniões que já o usam guardam a própria cópia do endereço.
 */

export * from "./meeting-locations-rules";
import type { MeetingLocation, MeetingLocationPayload } from "./meeting-locations-rules";

interface SaveResponse {
  location: MeetingLocation;
}

const json = (method: string, body: unknown) => ({
  auth: true,
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

export async function listAdminMeetingLocations(signal?: AbortSignal): Promise<MeetingLocation[]> {
  const { locations } = await apiRequest<{ locations: MeetingLocation[] }>("/meeting-locations", { auth: true, signal });
  return locations;
}

export const createMeetingLocation = (payload: MeetingLocationPayload) =>
  apiRequest<SaveResponse>("/meeting-locations", json("POST", payload));

export const updateMeetingLocation = (id: string, payload: MeetingLocationPayload) =>
  apiRequest<SaveResponse>(`/meeting-locations/${encodeURIComponent(id)}`, json("PATCH", payload));

export const setMeetingLocationActive = (id: string, isActive: boolean) =>
  apiRequest<SaveResponse>(`/meeting-locations/${encodeURIComponent(id)}/status`, json("PUT", { isActive }));

export function describeMeetingLocationError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;
  if (status === 403) return pt ? "Sua conta não pode gerenciar locais." : "Your account cannot manage locations.";
  if (status && status >= 400 && status < 500 && mensagem) return mensagem;
  if (status === 0) return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  return pt ? "Não foi possível concluir a operação." : "The operation could not be completed.";
}
