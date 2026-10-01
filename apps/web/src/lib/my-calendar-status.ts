/**
 * Estado da agenda do Outlook na Visão Geral — classificação PURA do erro de
 * `GET /calendar/me`, para a tela dizer O MOTIVO e não só "indisponível".
 *
 *   nao_configurado  503 do backend: Graph sem configuração neste ambiente
 *                    (esperado em desenvolvimento local)
 *   sem_autorizacao  `consent_required`: Calendars.Read delegada sem
 *                    consentimento no tenant (dependência externa)
 *   sessao           401: credencial da sessão não aceita / expirada
 *   indisponivel     demais falhas (rede, Graph, timeout, 429, 5xx)
 *
 * Nunca devolve mensagem bruta do Graph, tenant ou token.
 */

export type MotivoAgendaIndisponivel = "nao_configurado" | "sem_autorizacao" | "sessao" | "indisponivel";

export interface EstadoAgendaIndisponivel {
  motivo: MotivoAgendaIndisponivel;
  /** Rótulo curto (legenda do quadro). */
  rotulo: string;
  /** Explicação para quem lê o detalhe. */
  mensagem: string;
}

export function classificarErroAgenda(error: unknown, language: "en" | "pt"): EstadoAgendaIndisponivel {
  const pt = language === "pt";
  const e = error as { status?: number; code?: string; body?: { code?: string } } | null;
  const status = e?.status;
  const code = e?.code ?? e?.body?.code;

  if (code === "consent_required") {
    return {
      motivo: "sem_autorizacao",
      rotulo: pt ? "sem autorização" : "not authorised",
      mensagem: pt
        ? "A leitura do calendário ainda não foi autorizada nesta instalação."
        : "Calendar access has not been authorised in this installation yet."
    };
  }
  if (status === 503) {
    return {
      motivo: "nao_configurado",
      rotulo: pt ? "não configurada neste ambiente" : "not configured here",
      mensagem: pt
        ? "Integração com o Microsoft 365 não configurada neste ambiente."
        : "Microsoft 365 integration is not configured in this environment."
    };
  }
  if (status === 401) {
    return {
      motivo: "sessao",
      rotulo: pt ? "sessão expirada" : "session expired",
      mensagem: pt ? "Sua sessão expirou. Entre novamente." : "Your session expired. Sign in again."
    };
  }
  return {
    motivo: "indisponivel",
    rotulo: pt ? "indisponível" : "unavailable",
    mensagem:
      status === 0
        ? pt ? "Sem conexão com o servidor." : "No connection to the server."
        : pt ? "Não foi possível carregar seu calendário." : "Could not load your calendar."
  };
}
