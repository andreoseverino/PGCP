import { apiRequest, apiRequestBlob } from "./api";
import type { MeetingMinutes } from "./meeting-minutes-adapters";

/**
 * Ata da reunião — ponto único de acesso a `/meetings/:id/minutes`.
 *
 * Documento FORMAL, distinto das anotações. Nada aqui lê ou escreve
 * `meeting_notes`: anotar e lavrar a Ata são atos diferentes.
 *
 * SEM GERAÇÃO DE CONTEÚDO. Não há chamada a modelo, síntese ou resumo. O
 * esqueleto que a tela oferece é montado por `buildMinutesTemplate` a partir de
 * fatos já registrados, e o texto real é escrito por quem participou da sessão.
 *
 * SEM ASSINATURA. Não existe endpoint de assinatura porque não existe
 * assinatura real — e uma rota que devolvesse sucesso sem assinar nada seria
 * pior do que a ausência dela.
 */

export * from "./meeting-minutes-adapters";

/**
 * Conflito de revisão: outra sessão gravou entre a leitura e esta gravação.
 *
 * Carrega o estado ATUAL do servidor para a tela poder oferecer recarregar sem
 * descartar o que a pessoa digitou.
 */
export class MinutesConflictError extends Error {
  constructor(readonly current: MeetingMinutes | null, message: string) {
    super(message);
    this.name = "MinutesConflictError";
  }
}

function traduzirConflito(error: unknown, padrao: string): never {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) {
    const corpo = (error as { body?: { current?: MeetingMinutes } } | null)?.body;
    throw new MinutesConflictError(corpo?.current ?? null, (error as Error).message ?? padrao);
  }
  throw error;
}

export const getMeetingMinutes = (meetingId: string, signal?: AbortSignal) =>
  apiRequest<MeetingMinutes>(`/meetings/${meetingId}/minutes`, { auth: true, signal });

/**
 * Baixa a Ata como PDF — nunca .txt. O servidor gera na hora a partir do
 * conteúdo persistido; o nome do arquivo vem do `Content-Disposition`.
 */
export const downloadMeetingMinutesPdf = (meetingId: string) =>
  apiRequestBlob(`/meetings/${meetingId}/minutes/pdf`, { auth: true });

/**
 * Grava a Ata.
 *
 * `expectedRevision` é a revisão que o editor tinha ao começar; `0` cria a Ata.
 * Salvamento é EXPLÍCITO — não há autosave, porque um PUT por tecla num
 * documento formal produziria dezenas de revisões intermediárias sem
 * significado.
 */
export async function saveMeetingMinutes(
  meetingId: string,
  content: string,
  expectedRevision: number,
  signal?: AbortSignal
): Promise<MeetingMinutes> {
  try {
    return await apiRequest<MeetingMinutes>(`/meetings/${meetingId}/minutes`, {
      auth: true,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, expectedRevision }),
      signal
    });
  } catch (error) {
    traduzirConflito(error, "A Ata foi alterada em outra sessão.");
  }
}

export function describeMinutesError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;

  if (error instanceof MinutesConflictError) {
    return pt ? "A Ata foi alterada em outra sessão." : "The minutes were changed in another session.";
  }
  if (status === 0) {
    return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  }
  if (status === 401) return pt ? "Sua sessão expirou." : "Your session expired.";
  if (status === 403) return pt ? "Sem acesso a este recurso." : "No access.";
  if (status === 404) return pt ? "Reunião não encontrada." : "Meeting not found.";

  return pt ? "Não foi possível salvar a Ata." : "Could not save the minutes.";
}
