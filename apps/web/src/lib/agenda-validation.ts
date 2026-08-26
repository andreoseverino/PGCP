import { ApiError, apiRequest } from "./api";
import type { ApiMeetingDetail } from "./meetings";

/**
 * Validação de pautas — o passo entre preparar a reunião e convidar as pessoas.
 *
 * Eixo SEPARADO do status da reunião e do estado do convite:
 *
 *   draft     em preparação; nada saiu do PGCP
 *   sent      PDF enviado ao aprovador, aguardando a validação dele
 *   approved  a Secretaria registrou que o aprovador validou
 *
 * A aprovação acontece FORA do sistema: o aprovador responde por e-mail e
 * alguém registra isso aqui. Não há leitura automática de resposta.
 */

export type AgendaValidationStatus = "draft" | "sent" | "approved";

export interface AgendaValidation {
  status: AgendaValidationStatus;
  sentAt: string | null;
  /** E-mail do aprovador a quem a pauta foi enviada. */
  sentTo: string | null;
  approvedAt: string | null;
}

interface RespostaValidacao {
  agendaValidationStatus: AgendaValidationStatus;
  sentAt: string;
  sentTo: string;
  /** Reunião relida, no mesmo formato de GET /meetings/:id. */
  meeting: ApiMeetingDetail;
}

interface RespostaAprovacao {
  agendaValidationStatus: AgendaValidationStatus;
  approvedAt: string;
  meeting: ApiMeetingDetail;
}

/**
 * Gera o .pdf no servidor e envia ao aprovador.
 *
 * O e-mail sai da caixa de QUEM ESTÁ NA SESSÃO (Graph delegado), então o
 * aprovador responde para a pessoa certa. O aprovador não precisa ter conta
 * no PGCP.
 */
export function sendAgendaForValidation(
  meetingId: string,
  approverEmail: string
): Promise<RespostaValidacao> {
  return apiRequest<RespostaValidacao>(`/meetings/${meetingId}/agenda-validation`, {
    auth: true,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approverEmail })
  });
}

/** Registra que a validação voltou aprovada. Idempotente no servidor. */
export function approveAgenda(meetingId: string): Promise<RespostaAprovacao> {
  return apiRequest<RespostaAprovacao>(`/meetings/${meetingId}/agenda-approval`, {
    auth: true,
    method: "POST"
  });
}

/**
 * Traduz a falha para texto acionável.
 *
 * Os dois casos que a pessoa precisa distinguir: o que ela mesma corrige
 * (e-mail inválido, pauta ainda não enviada) e o que depende do administrador
 * do Microsoft 365 (permissão de envio não concedida).
 */
export function describeValidationError(erro: unknown, language: "pt" | "en" = "pt"): string {
  const en = language === "en";

  if (!(erro instanceof ApiError)) {
    return en
      ? "Could not complete the operation. Try again."
      : "Não foi possível concluir a operação. Tente novamente.";
  }

  if (erro.code === "consent_required") {
    // Dependência externa real: sem a permissão delegada Mail.Send, nenhum
    // envio funciona, e quem resolve é o administrador do tenant.
    return en
      ? "The PGCP is not yet authorised to send e-mail on your behalf. Ask the Microsoft 365 administrator to grant the delegated Mail.Send permission."
      : "O PGCP ainda não está autorizado a enviar e-mail em seu nome. Peça ao administrador do Microsoft 365 para conceder a permissão delegada Mail.Send.";
  }

  if (erro.status === 0) {
    return en ? "Could not reach the PGCP API." : "Não foi possível conectar à API do PGCP.";
  }

  // 400 (e-mail inválido), 409 (fora de ordem) e 413 (anexo grande) já vêm
  // com mensagem pronta e acionável do servidor.
  return erro.message;
}
