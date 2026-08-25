import { apiRequest } from "./api";

/**
 * Anotações da reunião — ponto único de acesso a `/meetings/:id/notes`.
 *
 * Documento operacional, distinto da Ata. Nada aqui toca `meeting_minutes`.
 */

export interface MeetingNotes {
  meetingId: string;
  contentHtml: string;
  /** `0` = a reunião ainda não tem documento; é a revisão para criá-lo. */
  revision: number;
  updatedByUserId: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

/**
 * Conflito de revisão: outra sessão gravou entre a leitura e esta gravação.
 *
 * Carrega o estado ATUAL do servidor para a tela poder oferecer recarregar sem
 * descartar o que a pessoa digitou.
 */
export class NotesConflictError extends Error {
  constructor(readonly current: MeetingNotes | null, message: string) {
    super(message);
    this.name = "NotesConflictError";
  }
}

export const getMeetingNotes = (meetingId: string, signal?: AbortSignal) =>
  apiRequest<MeetingNotes>(`/meetings/${meetingId}/notes`, { auth: true, signal });

/**
 * Grava as anotações.
 *
 * `expectedRevision` é a revisão que o editor tinha ao começar a digitar. O
 * servidor só aceita se ela ainda for a vigente — sem isso, duas abas na mesma
 * reunião fariam a última a salvar apagar a outra em silêncio.
 */
export async function saveMeetingNotes(
  meetingId: string,
  contentHtml: string,
  expectedRevision: number,
  signal?: AbortSignal
): Promise<MeetingNotes> {
  try {
    return await apiRequest<MeetingNotes>(`/meetings/${meetingId}/notes`, {
      auth: true,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentHtml, expectedRevision }),
      signal
    });
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 409) {
      const corpo = (error as { body?: { current?: MeetingNotes } } | null)?.body;
      throw new NotesConflictError(
        corpo?.current ?? null,
        (error as Error).message ?? "As anotações foram alteradas em outra sessão."
      );
    }
    throw error;
  }
}

export function describeNotesError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;

  if (error instanceof NotesConflictError) {
    return pt
      ? "As anotações foram alteradas em outra sessão."
      : "The notes were changed in another session.";
  }
  if (status === 0) {
    return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  }
  if (status === 401) return pt ? "Sua sessão expirou." : "Your session expired.";
  if (status === 403) return pt ? "Sem acesso a este recurso." : "No access.";

  return pt ? "Não foi possível salvar." : "Could not save.";
}
