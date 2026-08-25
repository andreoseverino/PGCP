import pool from "../database.js";
import { HttpError } from "../http-error.js";

/**
 * Leitura da trilha corporativa — `audit_logs`.
 *
 * SOMENTE LEITURA. `audit_logs` e append-only: nao ha update, delete nem
 * endpoint de criacao. Auditoria e CONSEQUENCIA de uma operacao de dominio,
 * gravada por `recordAuditIn` na mesma transacao do ato que ela descreve —
 * nunca algo que o navegador declara ter acontecido.
 *
 * SEM ROTA HTTP NESTA ONDA, por decisao de seguranca.
 *
 * A trilha e informacao sensivel: mostra quem fez o que, quando, em qual
 * entidade. Hoje o sistema so sabe se o chamador esta AUTENTICADO e ATIVO —
 * `users` nao tem coluna de papel ou permissao, e `job_title` e rotulo de
 * exibicao, nao perfil funcional. Expor `GET /audit-logs` a qualquer usuario
 * ativo entregaria o historico completo da governanca para quem so provou ter
 * conta. Quando existir a fonte de autorizacao, a rota entra sem tocar neste
 * arquivo.
 *
 * SEM GRAPH. O nome do ator sai de `users` por JOIN, ou do snapshot
 * `actor_name` gravado na epoca. Renderizar historico nao consulta diretorio, e
 * ator NUNCA e reconciliado por nome, e-mail ou UPN.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pagina pequena por padrao: a tela mostra o topo, nao o arquivo inteiro. */
export const DEFAULT_PAGE_SIZE = 25;
/** Teto explicito. Trilha cresce sem parar; nao existe "traga tudo". */
export const MAX_PAGE_SIZE = 100;

export interface AuditLogEntry {
  id: string;
  /** ISO 8601. Quando o ato aconteceu. */
  occurredAt: string;
  /** `users.id`, ou nulo quando o usuario foi removido (FK ON DELETE SET NULL). */
  actorUserId: string | null;
  /**
   * Nome para exibicao. Vem de `users.name` quando o usuario ainda existe;
   * senao, do snapshot gravado na epoca. Snapshot NAO e identidade.
   */
  actorName: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  status: "success" | "failure";
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  /**
   * Cursor opaco para a proxima pagina. `null` quando acabou.
   *
   * Codifica `(occurred_at, id)` — o mesmo par da ordenacao. Com OFFSET, um log
   * novo gravado entre duas requisicoes empurraria a lista e faria a pagina
   * seguinte repetir um registro que a anterior ja mostrou; a trilha recebe
   * escrita o tempo todo, entao isso aconteceria de verdade.
   */
  nextCursor: string | null;
}

export interface AuditLogFilters {
  limit: number;
  cursor?: { occurredAt: string; id: string };
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  dateFrom?: string;
  dateTo?: string;
}

function codificarCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}|${id}`, "utf8").toString("base64url");
}

function decodificarCursor(valor: string): { occurredAt: string; id: string } {
  const bruto = Buffer.from(valor, "base64url").toString("utf8");
  const separador = bruto.lastIndexOf("|");
  if (separador <= 0) throw new HttpError(400, "Cursor inválido.");

  const occurredAt = bruto.slice(0, separador);
  const id = bruto.slice(separador + 1);
  if (!UUID_PATTERN.test(id) || Number.isNaN(new Date(occurredAt).getTime())) {
    throw new HttpError(400, "Cursor inválido.");
  }
  return { occurredAt, id };
}

/** Data civil `YYYY-MM-DD`. Round-trip recusa 2026-02-30, que `Date` aceitaria. */
function parseDataCivil(valor: unknown, campo: string): string {
  if (typeof valor !== "string") throw new HttpError(400, `O campo '${campo}' deve ser uma data.`);
  const data = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== valor) {
    throw new HttpError(400, `O campo '${campo}' deve estar no formato YYYY-MM-DD.`);
  }
  return valor;
}

/**
 * Le a query string. Allowlist fechada.
 *
 * Os filtros existem porque a tela de Auditoria ja os oferece: periodo (mapeado
 * para `dateFrom`/`dateTo`), modulo (`entityType`) e pessoa. Busca textual
 * livre NAO entra: hoje ela e client-side sobre a lista carregada, e transformar
 * isso em varredura no banco e decisao de outra onda.
 *
 * `action` fica de fora de proposito. O filtro da tela agrupa acoes por palavra
 * -chave em portugues; casar isso no SQL exigiria um vocabulario estavel de
 * acoes, que nao existe.
 */
export function parseAuditFilters(query: Record<string, unknown>): AuditLogFilters {
  const permitidos = new Set(["limit", "cursor", "actorUserId", "entityType", "entityId", "dateFrom", "dateTo"]);
  for (const chave of Object.keys(query)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O parâmetro '${chave}' não é aceito por este endpoint.`);
    }
  }

  let limit = DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const bruto = Number(query.limit);
    if (!Number.isInteger(bruto) || bruto < 1) {
      throw new HttpError(400, "O parâmetro 'limit' deve ser um inteiro maior que zero.");
    }
    // Teto silencioso em vez de erro: pedir demais nao e um pedido invalido, e
    // devolver 400 so ensinaria o cliente a paginar por tentativa.
    limit = Math.min(bruto, MAX_PAGE_SIZE);
  }

  const filtros: AuditLogFilters = { limit };

  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string") throw new HttpError(400, "Cursor inválido.");
    filtros.cursor = decodificarCursor(query.cursor);
  }

  if (query.actorUserId !== undefined) {
    if (typeof query.actorUserId !== "string" || !UUID_PATTERN.test(query.actorUserId)) {
      throw new HttpError(400, "O parâmetro 'actorUserId' deve ser um identificador válido.");
    }
    filtros.actorUserId = query.actorUserId.toLowerCase();
  }

  for (const campo of ["entityType", "entityId"] as const) {
    if (query[campo] !== undefined) {
      if (typeof query[campo] !== "string" || query[campo].trim().length === 0) {
        throw new HttpError(400, `O parâmetro '${campo}' deve ser um texto.`);
      }
      filtros[campo] = (query[campo] as string).trim();
    }
  }

  if (query.dateFrom !== undefined) filtros.dateFrom = parseDataCivil(query.dateFrom, "dateFrom");
  if (query.dateTo !== undefined) filtros.dateTo = parseDataCivil(query.dateTo, "dateTo");

  return filtros;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_name: string;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  status: "success" | "failure";
}

/*
 * Colunas nomeadas uma a uma, nunca `SELECT *`: se um dia a tabela ganhar uma
 * coluna com conteudo sensivel, ela nao vaza no contrato por acidente.
 *
 * `audit_logs` NAO tem coluna `metadata` — conferido no schema. Nao ha payload
 * de fornecedor, claim, token nem trecho de documento para filtrar: a trilha
 * guarda rotulo e identificador, e as ondas anteriores ja garantiram que
 * conteudo de Anotacoes, Ata, snapshot e hash nunca sao escritos aqui.
 *
 * `COALESCE(u.name, a.actor_name)`: o nome atual do usuario quando ele ainda
 * existe; senao o snapshot da epoca. A FK e ON DELETE SET NULL, entao a trilha
 * sobrevive a remocao da pessoa — e continua dizendo honestamente quem agiu.
 */
const SELECT_LOGS = `
  SELECT a.id,
         a.occurred_at,
         a.actor_user_id,
         COALESCE(u.name, a.actor_name) AS actor_name,
         a.actor_role,
         a.action,
         a.entity_type,
         a.entity_id,
         a.entity_label,
         a.status
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id`;

function montar(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    status: row.status,
  };
}

/**
 * Pagina da trilha, do mais recente para o mais antigo.
 *
 * `ORDER BY occurred_at DESC, id DESC` — o desempate por `id` torna a ordem
 * TOTAL. Sem ele, dois registros gravados no mesmo instante (o que acontece:
 * varias entradas nascem na mesma transacao) sairiam em ordem arbitraria, e a
 * paginacao por cursor pularia ou repetiria linhas.
 */
export async function listAuditLogs(filtros: AuditLogFilters): Promise<AuditLogPage> {
  const condicoes: string[] = [];
  const valores: unknown[] = [];

  const parametro = (valor: unknown): string => {
    valores.push(valor);
    return `$${valores.length}`;
  };

  if (filtros.cursor) {
    // Comparacao de TUPLA: casa exatamente com a ordenacao composta e usa o
    // mesmo criterio de desempate, sem a aritmetica frágil de OR aninhado.
    condicoes.push(
      `(a.occurred_at, a.id) < (${parametro(filtros.cursor.occurredAt)}::timestamptz, ${parametro(filtros.cursor.id)}::uuid)`,
    );
  }
  if (filtros.actorUserId) condicoes.push(`a.actor_user_id = ${parametro(filtros.actorUserId)}::uuid`);
  if (filtros.entityType) condicoes.push(`a.entity_type = ${parametro(filtros.entityType)}`);
  if (filtros.entityId) condicoes.push(`a.entity_id = ${parametro(filtros.entityId)}`);
  if (filtros.dateFrom) condicoes.push(`a.occurred_at >= ${parametro(filtros.dateFrom)}::date`);
  // `dateTo` e inclusivo: o dia informado inteiro entra.
  if (filtros.dateTo) condicoes.push(`a.occurred_at < (${parametro(filtros.dateTo)}::date + 1)`);

  const where = condicoes.length > 0 ? `\n   WHERE ${condicoes.join("\n     AND ")}` : "";

  // Busca uma linha a mais para saber se existe proxima pagina sem um COUNT.
  const { rows } = await pool.query<AuditRow>(
    `${SELECT_LOGS}${where}
   ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT ${parametro(filtros.limit + 1)}`,
    valores,
  );

  const temMais = rows.length > filtros.limit;
  const pagina = temMais ? rows.slice(0, filtros.limit) : rows;
  const ultimo = pagina[pagina.length - 1];

  return {
    entries: pagina.map(montar),
    nextCursor: temMais && ultimo ? codificarCursor(ultimo.occurred_at.toISOString(), ultimo.id) : null,
  };
}
