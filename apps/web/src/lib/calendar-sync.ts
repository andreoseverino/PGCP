import { apiRequest } from "./api";

/**
 * Projeção da reunião no calendário externo.
 *
 * PGCP é a fonte de verdade; o Outlook é a projeção. Nada volta do calendário
 * para cá — alterar o evento lá não muda pauta, quórum, Ata ou estado.
 *
 * A tela NUNCA afirma "convite enviado" por conta própria: o estado vem do
 * servidor, e `failed` é `failed`.
 */

export type CalendarSyncStatus = "pending" | "synced" | "failed" | "stale";

export interface CalendarIntegration {
  meetingId: string;
  provider: string;
  providerEventId: string | null;
  webLink: string | null;
  joinUrl: string | null;
  syncStatus: CalendarSyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/** Pessoa que não pode ser convidada por não ter endereço utilizável. */
export interface ParticipanteSemEndereco {
  participantId: string;
  displayName: string;
}

/**
 * Pré-condição não cumprida: a reunião continua salva, o convite não foi
 * enviado, e o motivo é acionável.
 */
export class CalendarPreconditionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly participants: ParticipanteSemEndereco[] = []
  ) {
    super(message);
    this.name = "CalendarPreconditionError";
  }
}

/**
 * Dispara a sincronização.
 *
 * Explícita, e não embutida na criação da reunião: PostgreSQL e Graph não
 * compartilham transação, e esconder a chamada externa dentro do POST faria a
 * criação parecer ter falhado quando só o calendário falhou.
 *
 * Idempotente no servidor — reenviar não cria um segundo evento.
 */
export async function syncMeetingCalendar(
  meetingId: string,
  signal?: AbortSignal
): Promise<CalendarIntegration> {
  try {
    return await apiRequest<CalendarIntegration>(`/meetings/${meetingId}/calendar-sync`, {
      auth: true,
      method: "POST",
      signal
    });
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 422) {
      const body = (error as {
        body?: { code?: string; participants?: ParticipanteSemEndereco[] };
      } | null)?.body;
      throw new CalendarPreconditionError(
        body?.code ?? "precondition_failed",
        (error as Error).message,
        body?.participants ?? []
      );
    }
    throw error;
  }
}

/**
 * Estado que a TELA mostra, derivado do estado que o servidor guarda.
 *
 * Os quatro valores do banco continuam intactos — nada aqui os reescreve. O que
 * existe é uma distinção que só a tela precisa fazer:
 *
 *   stale sem erro   a reunião mudou e o convite ainda não foi reprojetado
 *   stale COM erro   a reprojeção foi tentada e a Microsoft recusou
 *
 * Os dois são `stale` no banco, e com razão: o evento existe e está
 * desatualizado. Mas mostrar "Atualização pendente" para o segundo esconderia
 * uma falha atrás de uma palavra que parece rotina.
 *
 * Sem integração preparada, `pending`: ausência de projeção não é erro.
 */
export type CalendarVisualState = "pending" | "synced" | "stale" | "failed";

export function calendarVisualState(
  calendar: Pick<CalendarIntegration, "syncStatus" | "lastError"> | null | undefined
): CalendarVisualState {
  if (!calendar) return "pending";
  if (calendar.syncStatus === "stale" && calendar.lastError) return "failed";
  return calendar.syncStatus;
}

/**
 * O botão de tentar de novo faz sentido?
 *
 * Só fora de `synced`. Em `synced` não há o que recuperar, e um botão ali
 * sugeriria que ainda falta um passo depois de cada edição — exatamente o que a
 * sincronização automática eliminou.
 *
 * A decisão de EXIBIR ainda depende de `PGCP.Assessoria`, que é de quem
 * chama: aqui não se decide autorização.
 */
export function permiteTentarNovamente(
  calendar: Pick<CalendarIntegration, "syncStatus" | "lastError"> | null | undefined
): boolean {
  return Boolean(calendar) && calendarVisualState(calendar) !== "synced";
}

export function describeCalendarStatus(
  status: CalendarVisualState,
  language: "en" | "pt"
): string {
  const pt = language === "pt";
  switch (status) {
    case "synced":
      return pt ? "Sincronizado" : "Synchronised";
    case "stale":
      return pt ? "Atualização pendente" : "Update pending";
    case "failed":
      return pt ? "Falha na sincronização" : "Synchronisation failed";
    default:
      /*
       * `pending` é a integração preparada cuja tentativa ainda não terminou
       * com sucesso. NÃO diz "sincronizando": quem está em andamento é o
       * pedido em curso, e isso a tela sabe pelo próprio estado local.
       */
      return pt ? "Sincronização pendente" : "Synchronisation pending";
  }
}

export function describeCalendarError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  if (error instanceof CalendarPreconditionError) return error.message;

  const status = (error as { status?: number } | null)?.status;
  if (status === 0) return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  if (status === 401) return pt ? "Sua sessão expirou." : "Your session expired.";
  if (status === 404) return pt ? "Reunião não encontrada." : "Meeting not found.";

  return pt
    ? "Não foi possível sincronizar com o calendário."
    : "Could not synchronise with the calendar.";
}
