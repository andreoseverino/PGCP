import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import {
  clausulaDeReuniaoVisivel,
  type EspectadorPgcp,
} from "../meetings/visibility.js";

/**
 * FUP — acoes de acompanhamento (`action_items`).
 *
 * ATRASO NAO E ARMAZENADO. O banco guarda `due_date`, e "vencido" / "vence
 * hoje" saem da comparacao com a data de hoje. Persistir o numero de dias em
 * atraso faria o dado apodrecer: correto no dia em que foi gravado e errado em
 * todos os seguintes.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mesmo conjunto do CHECK `action_items_status_check`. */
export const ACTION_ITEM_STATUSES = ["open", "completed", "cancelled"] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ACTION_ITEMS_LIMIT_DEFAULT = 300;
export const ACTION_ITEMS_LIMIT_MAX = 1000;

export function assertValidId(id: string, campo = "Identificador"): string {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, `${campo} inválido.`);
  return id.toLowerCase();
}

// -----------------------------------------------------------------------------
// Contrato
// -----------------------------------------------------------------------------

/**
 * Responsavel pelo acompanhamento.
 *
 * Tres identificadores DISTINTOS, lado a lado e nunca convertidos um no outro:
 *
 *   userId                        -> identidade interna do PGCP
 *   entraTenantId + entraObjectId -> identidade Microsoft
 *   name                          -> snapshot textual
 *
 * O snapshot existe para a lista renderizar sem consultar o Microsoft Graph a
 * cada abertura.
 */
export interface ActionItemAssignee {
  userId: string | null;
  /** `users.name` quando ha conta no PGCP. NAO substitui `name`. */
  userName: string | null;
  name: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
}

/** De onde a acao nasceu. Estrutural quando possivel, texto so na falta dela. */
export interface ActionItemOrigin {
  meetingId: string | null;
  meetingTitle: string | null;
  agendaItemId: string | null;
  agendaItemTitle: string | null;
  governanceBody: { id: string; name: string } | null;
  label: string | null;
}

export interface ActionItem {
  id: string;
  title: string;
  description: string | null;
  assignee: ActionItemAssignee;
  origin: ActionItemOrigin;
  /** Data civil de vencimento, `YYYY-MM-DD`. Sem horario, sem fuso. */
  dueDate: string | null;
  status: ActionItemStatus;
  completedAt: string | null;
  /**
   * DERIVADO: dias de atraso na data de hoje. Negativo = ainda no prazo.
   * `null` quando nao ha prazo ou a acao ja foi concluida.
   */
  daysLate: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  title: string;
  description: string | null;
  assigned_user_id: string | null;
  user_name: string | null;
  assignee_name: string | null;
  assignee_entra_tenant_id: string | null;
  assignee_entra_object_id: string | null;
  origin_meeting_id: string | null;
  meeting_title: string | null;
  origin_agenda_item_id: string | null;
  agenda_item_title: string | null;
  body_id: string | null;
  body_name: string | null;
  origin_label: string | null;
  due_date: string | null;
  status: ActionItemStatus;
  completed_at: Date | null;
  days_late: number | null;
  created_at: Date;
  updated_at: Date;
}

function toActionItem(row: Row): ActionItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    assignee: {
      userId: row.assigned_user_id,
      userName: row.user_name,
      name: row.assignee_name,
      entraTenantId: row.assignee_entra_tenant_id,
      entraObjectId: row.assignee_entra_object_id,
    },
    origin: {
      meetingId: row.origin_meeting_id,
      meetingTitle: row.meeting_title,
      agendaItemId: row.origin_agenda_item_id,
      agendaItemTitle: row.agenda_item_title,
      governanceBody: row.body_id && row.body_name ? { id: row.body_id, name: row.body_name } : null,
      label: row.origin_label,
    },
    dueDate: row.due_date,
    status: row.status,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    daysLate: row.days_late,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/*
 * `due_date` sai como texto `YYYY-MM-DD`, nao como Date.
 *
 * O driver converteria `date` para um Date na meia-noite LOCAL do processo, e
 * serializar isso de volta em UTC pode devolver o dia anterior. Vencimento e
 * data civil: nao tem horario e nao deve passar por fuso nenhum.
 *
 * `days_late` e calculado aqui, contra `current_date` do banco — uma unica
 * referencia de "hoje", em vez de cada navegador usar a sua.
 */
const SELECT = `
  SELECT ai.id,
         ai.title,
         ai.description,
         ai.assigned_user_id,
         u.name AS user_name,
         ai.assignee_name,
         ai.assignee_entra_tenant_id,
         ai.assignee_entra_object_id,
         ai.origin_meeting_id,
         m.title  AS meeting_title,
         ai.origin_agenda_item_id,
         mai.title AS agenda_item_title,
         gb.id AS body_id, gb.name AS body_name,
         ai.origin_label,
         to_char(ai.due_date, 'YYYY-MM-DD') AS due_date,
         ai.status,
         ai.completed_at,
         CASE
           WHEN ai.due_date IS NULL OR ai.status <> 'open' THEN NULL
           ELSE (current_date - ai.due_date)
         END::int AS days_late,
         ai.created_at,
         ai.updated_at
    FROM action_items ai
    LEFT JOIN users u                 ON u.id = ai.assigned_user_id
    LEFT JOIN meetings m              ON m.id = ai.origin_meeting_id
    LEFT JOIN meeting_agenda_items mai ON mai.id = ai.origin_agenda_item_id
    LEFT JOIN governance_bodies gb    ON gb.id = ai.governance_body_id
`;

export interface ListFilters {
  status?: ActionItemStatus;
  meetingId?: string;
  /** Só o que já venceu e continua aberto. */
  overdue?: boolean;
  /** Só as ações do usuário autenticado — por identidade, nunca por nome. */
  assignedTo?: { userId: string; entraTenantId: string; entraObjectId: string | null };
  /**
   * Quem está lendo. OBRIGATÓRIO: define o universo visível, e não é filtro
   * opcional que a query string possa desligar.
   */
  viewer: EspectadorPgcp;
  limit: number;
}

/**
 * Restringe a consulta ao que o espectador pode ver.
 *
 * DUAS portas, e só duas:
 *
 *   1. o FUP é dele — por IDENTIDADE (`assigned_user_id` ou o par tenant+oid)
 *   2. o FUP nasceu de uma reunião que ele pode ver — a política da reunião é
 *      a fonte de verdade, e vem de `meetings/visibility.ts`
 *
 * FUP SEM reunião de origem e que não é dele fica FORA. Ausência de origem não
 * pode virar porta larga: seria o único caso em que remover o vínculo ampliaria
 * o acesso.
 */
function clausulaDeFupVisivel(viewer: EspectadorPgcp, bind: (valor: unknown) => string): string {
  const meu = [`ai.assigned_user_id = ${bind(viewer.userId)}`];
  if (viewer.entraObjectId) {
    meu.push(
      `(ai.assignee_entra_tenant_id = ${bind(viewer.entraTenantId)} AND ai.assignee_entra_object_id = ${bind(viewer.entraObjectId)})`,
    );
  }

  const daReuniao =
    `EXISTS (SELECT 1 FROM meetings m
              WHERE m.id = ai.origin_meeting_id
                AND ${clausulaDeReuniaoVisivel("m", viewer, bind)})`;

  return `((${meu.join(" OR ")}) OR ${daReuniao})`;
}

export async function listActionItems(filters: ListFilters): Promise<ActionItem[]> {
  const condicoes: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  // SEMPRE primeiro: o universo visível não é opcional nem negociável por
  // parâmetro. Os demais filtros recortam DENTRO dele.
  condicoes.push(clausulaDeFupVisivel(filters.viewer, bind));

  if (filters.status) condicoes.push(`ai.status = ${bind(filters.status)}`);
  if (filters.meetingId) condicoes.push(`ai.origin_meeting_id = ${bind(filters.meetingId)}`);
  if (filters.overdue) condicoes.push("ai.status = 'open' AND ai.due_date < current_date");

  if (filters.assignedTo) {
    // Pela IDENTIDADE, nas duas formas em que ela pode estar gravada. Filtrar
    // por nome traria homonimos e perderia quem trocou de nome.
    const { userId, entraTenantId, entraObjectId } = filters.assignedTo;
    const partes = [`ai.assigned_user_id = ${bind(userId)}`];
    if (entraObjectId) {
      partes.push(
        `(ai.assignee_entra_tenant_id = ${bind(entraTenantId)} AND ai.assignee_entra_object_id = ${bind(entraObjectId)})`,
      );
    }
    condicoes.push(`(${partes.join(" OR ")})`);
  }

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(" AND ")}` : "";

  const { rows } = await pool.query<Row>(
    `${SELECT} ${where}
      ORDER BY ai.status = 'completed', ai.due_date NULLS LAST, ai.created_at DESC
      LIMIT ${bind(filters.limit)}`,
    params,
  );

  return rows.map(toActionItem);
}

/**
 * Consulta por ID, com a MESMA regra da lista.
 *
 * Esconder da lista e continuar servindo por UUID seria segurança de fachada.
 * Invisível responde 404, igual a inexistente: distinguir os dois na mensagem
 * confirmaria a existência do registro para quem não pode vê-lo.
 */
export async function findActionItem(id: string, viewer: EspectadorPgcp): Promise<ActionItem> {
  assertValidId(id);

  const params: unknown[] = [id];
  const bind = (valor: unknown) => {
    params.push(valor);
    return `$${params.length}`;
  };

  const { rows } = await pool.query<Row>(
    `${SELECT} WHERE ai.id = $1 AND ${clausulaDeFupVisivel(viewer, bind)}`,
    params,
  );
  if (rows.length === 0) throw new HttpError(404, "Ação de acompanhamento não encontrada.");
  return toActionItem(rows[0]!);
}

/**
 * Leitura SEM filtro de visibilidade.
 *
 * Uso restrito: devolver o registro logo depois de uma escrita que ja passou
 * pela autorizacao. Nao serve para atender requisicao de leitura — para isso
 * existe `findActionItem`, que aplica a regra.
 */
export async function findActionItemAposEscrita(id: string): Promise<ActionItem> {
  const { rows } = await pool.query<Row>(`${SELECT} WHERE ai.id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, "Ação de acompanhamento não encontrada.");
  return toActionItem(rows[0]!);
}

export async function findActionItemIn(client: PoolClient, id: string): Promise<ActionItem> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE ai.id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, "Ação de acompanhamento não encontrada.");
  return toActionItem(rows[0]!);
}

export function parseListFilters(query: Record<string, unknown>, principal: {
  userId: string;
  entraTenantId: string;
  entraObjectId: string | null;
}): ListFilters {
  // O espectador vem do TOKEN, sempre. Nenhum parâmetro da query string o
  // escolhe, o amplia ou o desliga.
  const filtros: ListFilters = { viewer: principal, limit: ACTION_ITEMS_LIMIT_DEFAULT };

  const texto = (valor: unknown, campo: string): string | undefined => {
    if (valor === undefined) return undefined;
    if (typeof valor !== "string") throw new HttpError(400, `'${campo}' deve ser informado uma vez.`);
    return valor.trim() || undefined;
  };

  const status = texto(query.status, "status");
  if (status) {
    if (!(ACTION_ITEM_STATUSES as readonly string[]).includes(status)) {
      throw new HttpError(400, `'status' aceita apenas: ${ACTION_ITEM_STATUSES.join(", ")}.`);
    }
    filtros.status = status as ActionItemStatus;
  }

  const meetingId = texto(query.meetingId, "meetingId");
  if (meetingId) filtros.meetingId = assertValidId(meetingId, "O parâmetro 'meetingId'");

  for (const [campo, alvo] of [["overdue", "overdue"], ["assignedToMe", "assignedTo"]] as const) {
    const valor = texto(query[campo], campo);
    if (valor === undefined) continue;
    if (valor !== "true" && valor !== "false") {
      throw new HttpError(400, `'${campo}' aceita apenas 'true' ou 'false'.`);
    }
    if (valor === "false") continue;
    if (alvo === "overdue") filtros.overdue = true;
    else filtros.assignedTo = principal;
  }

  const limit = texto(query.limit, "limit");
  if (limit) {
    const valor = Number(limit);
    if (!Number.isInteger(valor) || valor < 1 || valor > ACTION_ITEMS_LIMIT_MAX) {
      throw new HttpError(400, `'limit' deve ser um inteiro entre 1 e ${ACTION_ITEMS_LIMIT_MAX}.`);
    }
    filtros.limit = valor;
  }

  return filtros;
}
