import { apiRequest } from "./api";

/**
 * PARTICIPANTES EXTERNOS do PGCP (`/external-participants`) — pessoas FORA do
 * Microsoft Entra ID, cadastradas em Administração → Participantes.
 *
 * Esta API só conhece registros locais. A busca que junta Entra + PGCP é a da
 * seleção de participantes de reunião (`participant-search.ts`).
 *
 * Participante NÃO é usuário: cadastro PGCP não dá login, App Role nem
 * identidade Microsoft.
 */

export {
  validateExternalParticipant,
  type ExternalParticipant,
  type ExternalParticipantPayload
} from "./external-participants-rules";
import type { ExternalParticipant, ExternalParticipantPayload } from "./external-participants-rules";

interface SaveResponse {
  participant: ExternalParticipant;
}

export async function listExternalParticipants(q?: string, signal?: AbortSignal): Promise<ExternalParticipant[]> {
  const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  const { participants } = await apiRequest<{ participants: ExternalParticipant[] }>(
    `/external-participants${qs}`,
    { auth: true, signal }
  );
  return participants;
}

const json = (method: string, body: unknown) => ({
  auth: true,
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

export const createExternalParticipant = (payload: ExternalParticipantPayload) =>
  apiRequest<SaveResponse>("/external-participants", json("POST", payload));

export const updateExternalParticipant = (id: string, payload: ExternalParticipantPayload) =>
  apiRequest<SaveResponse>(`/external-participants/${id}`, json("PATCH", payload));

export const deleteExternalParticipant = (id: string) =>
  apiRequest<void>(`/external-participants/${id}`, { auth: true, method: "DELETE" });

export function describeExternalParticipantError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;
  if (status === 403) return pt ? "Sua conta não pode gerenciar participantes." : "Your account cannot manage participants.";
  // 4xx e o 503 da validação no diretório (fail closed) já vêm com texto pronto.
  if (status && ((status >= 400 && status < 500) || status === 503) && mensagem) return mensagem;
  if (status === 0) return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  return pt ? "Não foi possível concluir a operação." : "The operation could not be completed.";
}
