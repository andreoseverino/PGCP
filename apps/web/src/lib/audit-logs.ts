import { ApiError, apiRequest } from "./api";
import { getInitials } from "./user";
import type { AuditLog } from "../types";

/**
 * Trilha corporativa — leitura.
 *
 * SOMENTE LEITURA, de propósito: `audit_logs` é append-only e a trilha é
 * escrita pelas próprias operações de domínio, na transação do ato. Não existe
 * criar, editar nem limpar registro por aqui, e não deve existir.
 *
 * Restrita a `PGCP.Admin` no servidor — quem não tem a role recebe 403.
 */

/** Espelho de `AuditLogEntry` do backend. Nada além do que a tabela guarda. */
export interface ApiAuditLogEntry {
  id: string;
  /** ISO 8601, instante do ato. */
  occurredAt: string;
  /** `users.id`, ou nulo quando o usuário foi removido. */
  actorUserId: string | null;
  /** Nome de exibição: `users.name` atual ou o snapshot da época. */
  actorName: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  status: "success" | "failure";
}

export interface AuditLogPage {
  items: ApiAuditLogEntry[];
  /** Opaco. Codifica `(occurred_at, id)`; `null` quando acabou. */
  nextCursor: string | null;
  limit: number;
}

export interface AuditLogQuery {
  limit?: number;
  cursor?: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  /** Data civil `YYYY-MM-DD`. */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Uma página da trilha.
 *
 * Paginação por CURSOR, nunca por offset: a trilha recebe escrita o tempo todo,
 * e um registro novo entre duas requisições empurraria a lista — com offset, a
 * página seguinte repetiria o que a anterior já mostrou.
 */
export async function fetchAuditLogs(
  query: AuditLogQuery = {},
  signal?: AbortSignal
): Promise<AuditLogPage> {
  const params = new URLSearchParams();
  for (const [chave, valor] of Object.entries(query)) {
    if (valor !== undefined && valor !== null && valor !== "") {
      params.set(chave, String(valor));
    }
  }

  const busca = params.toString();
  return apiRequest<AuditLogPage>(`/audit-logs${busca ? `?${busca}` : ""}`, {
    auth: true,
    signal
  });
}

// -----------------------------------------------------------------------------
// Adaptação para a tela
// -----------------------------------------------------------------------------

/**
 * Ícone da ação — DERIVADO, só para apresentação.
 *
 * Não existe coluna de ícone no banco e não deve existir: é decoração, e
 * persistir decoração congelaria a aparência junto do fato.
 */
function iconeDaAcao(action: string): string {
  const texto = action.toLowerCase();
  if (texto.includes("sincroniza") || texto.includes("outlook")) return "sync";
  if (texto.includes("ata") || texto.includes("assinatura")) return "edit_document";
  if (texto.includes("autentic") || texto.includes("acesso")) return "visibility";
  return "tag";
}

/**
 * Instante em `YYYY-MM-DD HH:mm:ss`, no fuso de quem lê.
 *
 * O servidor grava e devolve o instante absoluto; a conversão para hora local é
 * apresentação, e por isso acontece aqui.
 */
function instanteLocal(iso: string): string {
  const data = new Date(iso);
  const dois = (n: number) => String(n).padStart(2, "0");
  return (
    `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())} ` +
    `${dois(data.getHours())}:${dois(data.getMinutes())}:${dois(data.getSeconds())}`
  );
}

/**
 * Registro da API → modelo visual da tela.
 *
 * Quem adapta é o FRONTEND. Fazer o backend imitar o formato da maquete antiga
 * levaria decoração (`initials`, `icon`) para dentro do contrato e, de lá, para
 * perto do banco.
 *
 * `initials` e `icon` são derivados de `actorName` e `action` — nunca vêm da
 * API e nunca voltam para ela.
 */
export function auditLogFromApi(entry: ApiAuditLogEntry): AuditLog {
  return {
    id: entry.id,
    timestamp: instanteLocal(entry.occurredAt),
    user: entry.actorName,
    role: entry.actorRole ?? "—",
    initials: getInitials(entry.actorName),
    action: entry.action,
    icon: iconeDaAcao(entry.action),
    // `entityLabel` é o rótulo do momento do ato (ex.: título da reunião);
    // sem ele, mostra o tipo, que sempre existe.
    entity: entry.entityLabel ?? entry.entityType,
    entityId: entry.entityId ?? "—",
    // Dois estados, os mesmos do CHECK do banco. Não há terceiro.
    status: entry.status === "success" ? "Sucesso" : "Falha"
  };
}

export function describeAuditLogsError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";

  if (error instanceof ApiError) {
    if (error.status === 403) {
      return pt
        ? "A trilha de auditoria é restrita aos administradores do PGCP."
        : "The audit trail is restricted to PGCP administrators.";
    }
    if (error.status === 401) {
      return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired. Sign in again.";
    }
    if (error.status === 0) {
      return pt ? "Sem conexão com o servidor." : "No connection to the server.";
    }
  }

  return pt
    ? "Não foi possível carregar a trilha de auditoria."
    : "Could not load the audit trail.";
}
