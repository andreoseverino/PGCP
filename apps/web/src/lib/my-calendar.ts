import { apiRequest } from "./api";

/**
 * Meu Calendário — agenda do próprio usuário, lida sob demanda.
 *
 * Nada é persistido no PGCP: o calendário pessoal continua sendo do Outlook. O
 * único vínculo que o PGCP guarda é o das próprias reuniões.
 *
 * O navegador nunca recebe token do Graph — manda o token da API do PGCP, e a
 * troca On-Behalf-Of acontece no servidor.
 */

export interface MyCalendarEvent {
  id: string;
  subject: string | null;
  /** Hora local do fuso devolvido em `timezone`. */
  start: string | null;
  end: string | null;
  timezone: string | null;
  /** Nome de exibição de quem organiza. Snapshot, nunca identidade. */
  organizer: string | null;
  isOnlineMeeting: boolean;
  joinUrl: string | null;
  webLink: string | null;
}

export interface MyCalendarPage {
  events: MyCalendarEvent[];
  /** Continuação opaca do Graph. `null` quando acabou. */
  nextLink: string | null;
}

export interface MyCalendarRange {
  start: Date;
  end: Date;
  limit?: number;
  nextLink?: string;
}

export function fetchMyCalendar(range: MyCalendarRange, signal?: AbortSignal): Promise<MyCalendarPage> {
  const params = new URLSearchParams({
    start: range.start.toISOString(),
    end: range.end.toISOString()
  });
  if (range.limit) params.set("limit", String(range.limit));
  if (range.nextLink) params.set("nextLink", range.nextLink);

  return apiRequest<MyCalendarPage>(`/calendar/me?${params}`, { auth: true, signal });
}

/**
 * O evento pode ser ingressado?
 *
 * Só com `joinUrl`. `isOnlineMeeting` sozinho não basta: existe evento marcado
 * como online cujo link o Graph não devolve, e um botão que abre `undefined`
 * seria pior do que botão nenhum.
 *
 * Vale para qualquer evento da agenda — inclusive os que não nasceram no PGCP.
 */
export function podeIngressar(evento: MyCalendarEvent): boolean {
  return typeof evento.joinUrl === "string" && evento.joinUrl.startsWith("http");
}
