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

export function describeMyCalendarError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { body?: { code?: string } } | null)?.body?.code;

  if (code === "consent_required") {
    return pt
      ? "A leitura do calendário ainda não foi autorizada nesta instalação."
      : "Calendar access has not been authorised in this installation yet.";
  }
  if (status === 0) return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  if (status === 401) return pt ? "Sua sessão expirou." : "Your session expired.";
  if (status === 503) {
    return pt
      ? "Integração com o Microsoft 365 não configurada."
      : "Microsoft 365 integration is not configured.";
  }

  return pt ? "Não foi possível carregar seu calendário." : "Could not load your calendar.";
}
