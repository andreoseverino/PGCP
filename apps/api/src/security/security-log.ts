/**
 * Log estruturado de eventos de SEGURANCA — uma linha JSON por evento, em stdout.
 *
 * Pronto para ingestao por Log Analytics / Application Insights: o coletor lê
 * stdout do processo. Distinto de `audit_logs` (trilha de GOVERNANCA no
 * PostgreSQL): aqui ficam os eventos de SEGURANCA OPERACIONAL — autenticacao
 * recusada, autorizacao negada, rate limit, erro inesperado — que interessam ao
 * SIEM e nao ao registro de atos de negocio.
 *
 * REGRA ABSOLUTA: NUNCA registrar token, authorization code, client secret,
 * senha, cookie, connection string ou qualquer dado sensivel. Os campos abaixo
 * sao fechados de proposito — nao ha um `payload` livre onde algo sensivel
 * pudesse entrar por descuido. `detail`, quando usado, carrega apenas rotulos
 * seguros escolhidos por quem chama.
 */

export type SecurityEventType =
  | "auth_success"
  | "auth_failure"
  | "invalid_token"
  | "missing_app_role"
  | "unauthorized"
  | "forbidden"
  | "rate_limit"
  | "admin_change"
  | "integration_test"
  | "graph_error"
  | "unexpected_error";

export interface SecurityEvent {
  type: SecurityEventType;
  /** Mensagem curta e sem dado sensivel. */
  message?: string;
  /** Correlation id da requisicao, para casar com logs de outros componentes. */
  requestId?: string;
  /** `oid` do principal, quando ja resolvido. NUNCA o token. */
  principalOid?: string | null;
  /** Metodo + caminho (sem querystring — a querystring pode conter dado pessoal). */
  route?: string;
  /** Status HTTP resultante. */
  status?: number;
  /** Codigo simbolico (ex.: "insufficient_scope", "missing_app_role"). */
  code?: string;
  /** Rotulos seguros adicionais. Nunca segredo, nunca token, nunca PII livre. */
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * Emite o evento como uma linha JSON. `kind: "security"` permite ao coletor
 * separar estes eventos dos logs comuns da aplicacao.
 */
export function logSecurityEvent(event: SecurityEvent): void {
  const linha = { ts: new Date().toISOString(), kind: "security", ...event };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(linha));
}

/** Caminho sem querystring — a querystring pode carregar termo de busca/PII. */
export function safeRoute(method: string, originalUrl: string): string {
  const semQuery = originalUrl.split("?")[0] ?? originalUrl;
  return `${method} ${semQuery}`;
}
