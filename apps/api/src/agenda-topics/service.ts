import pool from "../database.js";
import { HttpError } from "../http-error.js";

/**
 * Biblioteca de pautas — leitura e mapeamento.
 *
 * `agenda_topics` guarda a pauta REUTILIZAVEL, sem contexto de reuniao. Em quais
 * reunioes ela esta vinculada NAO e coluna daqui: sai de
 * `meeting_agenda_items.agenda_topic_id`, e por isso uma pauta pode aparecer em
 * N reunioes. Casar por titulo — o que a tela antiga fazia — unia homonimos.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AGENDA_TOPICS_LIMIT_DEFAULT = 200;
export const AGENDA_TOPICS_LIMIT_MAX = 500;

export function assertValidId(id: string, campo = "Identificador"): string {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, `${campo} inválido.`);
  return id.toLowerCase();
}

// -----------------------------------------------------------------------------
// Contrato
// -----------------------------------------------------------------------------

export interface NamedRef {
  id: string;
  name: string;
}

/** Responsavel pela pauta. Pessoa do diretorio, area ou coletivo. */
export interface TopicResponsible {
  label: string;
  entraTenantId: string | null;
  entraObjectId: string | null;
}

/**
 * De onde a copia automatica veio. `null` em pauta criada manualmente — e
 * tambem depois que a reuniao de origem e excluida, porque a FK composta zera
 * os dois campos juntos.
 */
export interface TopicSource {
  meetingId: string;
  agendaItemId: string;
}

export interface TopicParticipant {
  id: string;
  userId: string | null;
  userName: string | null;
  displayName: string | null;
  email: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
}

/** Reuniao em que a pauta esta vinculada. Vem da FK, nunca do titulo. */
export interface LinkedMeeting {
  meetingId: string;
  agendaItemId: string;
  title: string;
  startAt: string;
  executionStatus: string;
}

export interface AgendaTopicSummary {
  id: string;
  title: string;
  description: string | null;
  estimatedDurationMinutes: number | null;
  generatesActionItem: boolean;
  responsible: TopicResponsible | null;
  type: NamedRef | null;
  nature: NamedRef | null;
  governanceBody: NamedRef | null;
  ownerUserId: string | null;
  /** PADRÃO de tema circular. Copiado para a pauta ao vincular a uma reunião. */
  isCircularTheme: boolean;
  /** TEMA FUTURO (042): ainda sem reunião; vira regular ao entrar numa. */
  isFuture: boolean;
  /** "AAAA-MM" previsto; `null` em tema regular. */
  expectedMonth: string | null;
  expectedGovernanceBody: NamedRef | null;
  source: TopicSource | null;
  /** DERIVADO: nasceu de um Postergar. Equivale a `source !== null`. */
  isAutomaticCopy: boolean;
  /** DERIVADO: COUNT sobre meeting_agenda_items. */
  linkedMeetingsCount: number;
  participantsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgendaTopicDetail extends AgendaTopicSummary {
  participants: TopicParticipant[];
  linkedMeetings: LinkedMeeting[];
}

// -----------------------------------------------------------------------------
// Linhas
// -----------------------------------------------------------------------------

interface TopicRow {
  id: string;
  title: string;
  description: string | null;
  estimated_duration_minutes: number | null;
  generates_action_item: boolean;
  responsible_label: string | null;
  responsible_entra_tenant_id: string | null;
  responsible_entra_object_id: string | null;
  owner_user_id: string | null;
  is_circular_theme: boolean;
  is_future: boolean;
  expected_month: string | null;
  expected_body_id: string | null;
  expected_body_name: string | null;
  source_meeting_id: string | null;
  source_agenda_item_id: string | null;
  type_id: string | null;
  type_name: string | null;
  nature_id: string | null;
  nature_name: string | null;
  body_id: string | null;
  body_name: string | null;
  linked_meetings_count: number;
  participants_count: number;
  created_at: Date;
  updated_at: Date;
}

function toSummary(row: TopicRow): AgendaTopicSummary {
  const source =
    row.source_meeting_id && row.source_agenda_item_id
      ? { meetingId: row.source_meeting_id, agendaItemId: row.source_agenda_item_id }
      : null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    generatesActionItem: row.generates_action_item,
    responsible: row.responsible_label
      ? {
          label: row.responsible_label,
          entraTenantId: row.responsible_entra_tenant_id,
          entraObjectId: row.responsible_entra_object_id,
        }
      : null,
    type: row.type_id && row.type_name ? { id: row.type_id, name: row.type_name } : null,
    nature: row.nature_id && row.nature_name ? { id: row.nature_id, name: row.nature_name } : null,
    governanceBody: row.body_id && row.body_name ? { id: row.body_id, name: row.body_name } : null,
    ownerUserId: row.owner_user_id,
    isCircularTheme: row.is_circular_theme,
    isFuture: row.is_future,
    expectedMonth: row.expected_month,
    expectedGovernanceBody:
      row.expected_body_id && row.expected_body_name ? { id: row.expected_body_id, name: row.expected_body_name } : null,
    source,
    isAutomaticCopy: source !== null,
    linkedMeetingsCount: row.linked_meetings_count,
    participantsCount: row.participants_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const SUMMARY_SELECT = `
  SELECT t.id,
         t.title,
         t.description,
         t.estimated_duration_minutes,
         t.generates_action_item,
         t.responsible_label,
         t.responsible_entra_tenant_id,
         t.responsible_entra_object_id,
         t.owner_user_id,
         t.is_circular_theme,
         t.is_future,
         to_char(t.expected_month, 'YYYY-MM') AS expected_month,
         egb.id  AS expected_body_id, egb.name AS expected_body_name,
         t.source_meeting_id,
         t.source_agenda_item_id,
         tt.id   AS type_id,   tt.name AS type_name,
         tn.id   AS nature_id, tn.name AS nature_name,
         gb.id   AS body_id,   gb.name AS body_name,
         (SELECT count(DISTINCT ai.meeting_id) FROM meeting_agenda_items ai WHERE ai.agenda_topic_id = t.id)::int AS linked_meetings_count,
         (SELECT count(*) FROM agenda_topic_participants p WHERE p.agenda_topic_id = t.id)::int   AS participants_count,
         t.created_at,
         t.updated_at
    FROM agenda_topics t
    LEFT JOIN agenda_topic_types    tt ON tt.id = t.agenda_topic_type_id
    LEFT JOIN agenda_topic_natures  tn ON tn.id = t.agenda_topic_nature_id
    LEFT JOIN governance_bodies     gb ON gb.id = t.governance_body_id
    LEFT JOIN governance_bodies     egb ON egb.id = t.expected_governance_body_id
`;

export interface ListTopicsFilters {
  /** Só cópias automáticas, ou só pautas manuais. */
  automatic?: boolean;
  generatesActionItem?: boolean;
  typeId?: string;
  natureId?: string;
  limit: number;
}

export async function listAgendaTopics(filters: ListTopicsFilters): Promise<AgendaTopicSummary[]> {
  const condicoes: string[] = [];
  const params: unknown[] = [];
  const bind = (valor: unknown) => {
    params.push(valor);
    return `$${params.length}`;
  };

  if (filters.automatic !== undefined) {
    condicoes.push(
      filters.automatic ? "t.source_agenda_item_id IS NOT NULL" : "t.source_agenda_item_id IS NULL",
    );
  }
  if (filters.generatesActionItem !== undefined) {
    condicoes.push(`t.generates_action_item = ${bind(filters.generatesActionItem)}`);
  }
  if (filters.typeId) condicoes.push(`t.agenda_topic_type_id = ${bind(filters.typeId)}`);
  if (filters.natureId) condicoes.push(`t.agenda_topic_nature_id = ${bind(filters.natureId)}`);

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(" AND ")}` : "";

  const { rows } = await pool.query<TopicRow>(
    `${SUMMARY_SELECT} ${where} ORDER BY t.created_at DESC, t.id LIMIT ${bind(filters.limit)}`,
    params,
  );
  return rows.map(toSummary);
}

export async function findAgendaTopic(id: string): Promise<AgendaTopicDetail> {
  assertValidId(id);

  const { rows } = await pool.query<TopicRow>(`${SUMMARY_SELECT} WHERE t.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new HttpError(404, "Tema não encontrado na Biblioteca.");

  const [participants, linkedMeetings] = await Promise.all([
    listTopicParticipants(id),
    listLinkedMeetings(id),
  ]);

  return { ...toSummary(row), participants, linkedMeetings };
}

export async function listTopicParticipants(topicId: string): Promise<TopicParticipant[]> {
  const { rows } = await pool.query<{
    id: string;
    user_id: string | null;
    user_name: string | null;
    display_name: string | null;
    email: string | null;
    entra_tenant_id: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT p.id, p.user_id, u.name AS user_name, p.display_name, p.email,
            coalesce(p.entra_tenant_id, u.entra_tenant_id) AS entra_tenant_id,
            coalesce(p.entra_object_id, u.entra_object_id) AS entra_object_id
       FROM agenda_topic_participants p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.agenda_topic_id = $1
      ORDER BY coalesce(p.display_name, u.name), p.id`,
    [topicId],
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    displayName: r.display_name,
    email: r.email,
    entraTenantId: r.entra_tenant_id,
    entraObjectId: r.entra_object_id,
  }));
}

/**
 * Reunioes em que a pauta esta vinculada.
 *
 * A resposta sai da FK `meeting_agenda_items.agenda_topic_id`. NUNCA de
 * comparacao de titulo: duas pautas homonimas sao duas pautas.
 */
export async function listLinkedMeetings(topicId: string): Promise<LinkedMeeting[]> {
  const { rows } = await pool.query<{
    meeting_id: string;
    agenda_item_id: string;
    title: string;
    start_at: Date;
    execution_status: string;
  }>(
    `SELECT m.id AS meeting_id, ai.id AS agenda_item_id, m.title, m.start_at, ai.execution_status
       FROM meeting_agenda_items ai
       JOIN meetings m ON m.id = ai.meeting_id
      WHERE ai.agenda_topic_id = $1
      ORDER BY m.start_at DESC`,
    [topicId],
  );

  return rows.map((r) => ({
    meetingId: r.meeting_id,
    agendaItemId: r.agenda_item_id,
    title: r.title,
    startAt: r.start_at.toISOString(),
    executionStatus: r.execution_status,
  }));
}

// -----------------------------------------------------------------------------
// Cadastros de tipo e natureza
// -----------------------------------------------------------------------------

export type TaxonomyKind = "types" | "natures";

const TABELA_DE: Record<TaxonomyKind, string> = {
  types: "agenda_topic_types",
  natures: "agenda_topic_natures",
};

/** Coluna de `agenda_topics` que referencia cada cadastro. */
const COLUNA_DE_USO: Record<TaxonomyKind, string> = {
  types: "agenda_topic_type_id",
  natures: "agenda_topic_nature_id",
};

export interface TaxonomyItem {
  id: string;
  name: string;
  isActive: boolean;
  /** DERIVADO: quantas pautas referenciam. Governa o que pode ser excluído. */
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listTaxonomy(kind: TaxonomyKind): Promise<TaxonomyItem[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    is_active: boolean;
    usage_count: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT c.id, c.name, c.is_active,
            (SELECT count(*) FROM agenda_topics t WHERE t.${COLUNA_DE_USO[kind]} = c.id)::int AS usage_count,
            c.created_at, c.updated_at
       FROM ${TABELA_DE[kind]} c
      ORDER BY c.name`,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.is_active,
    usageCount: r.usage_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

export function parseTaxonomyName(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const { name } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new HttpError(400, "O campo 'name' é obrigatório.");
  }
  const limpo = name.trim();
  if (limpo.length > 200) throw new HttpError(400, "O campo 'name' excede 200 caracteres.");
  return limpo;
}

export async function createTaxonomyItem(kind: TaxonomyKind, name: string): Promise<TaxonomyItem> {
  try {
    await pool.query(`INSERT INTO ${TABELA_DE[kind]} (name) VALUES ($1)`, [name]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, `Já existe um cadastro com o nome "${name}".`);
    }
    throw error;
  }
  const item = (await listTaxonomy(kind)).find((i) => i.name === name);
  if (!item) throw new HttpError(500, "Erro interno ao ler o cadastro criado.");
  return item;
}

/**
 * Desativa em vez de excluir quando o cadastro esta EM USO.
 *
 * Apagar um tipo referenciado por pautas ou quebraria a FK (RESTRICT) ou
 * exigiria zerar o vinculo das pautas em silencio — as duas coisas ruins.
 * Desativar tira da lista de escolha e preserva o historico.
 */
export async function setTaxonomyActive(
  kind: TaxonomyKind,
  id: string,
  isActive: boolean,
): Promise<TaxonomyItem> {
  assertValidId(id);
  const { rowCount } = await pool.query(
    `UPDATE ${TABELA_DE[kind]} SET is_active = $2 WHERE id = $1`,
    [id, isActive],
  );
  if (rowCount === 0) throw new HttpError(404, "Cadastro não encontrado.");

  const item = (await listTaxonomy(kind)).find((i) => i.id === id);
  if (!item) throw new HttpError(404, "Cadastro não encontrado.");
  return item;
}

export async function renameTaxonomyItem(
  kind: TaxonomyKind,
  id: string,
  name: string,
): Promise<TaxonomyItem> {
  assertValidId(id);
  try {
    const { rowCount } = await pool.query(`UPDATE ${TABELA_DE[kind]} SET name = $2 WHERE id = $1`, [
      id,
      name,
    ]);
    if (rowCount === 0) throw new HttpError(404, "Cadastro não encontrado.");
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, `Já existe um cadastro com o nome "${name}".`);
    }
    throw error;
  }

  const item = (await listTaxonomy(kind)).find((i) => i.id === id);
  if (!item) throw new HttpError(404, "Cadastro não encontrado.");
  return item;
}

/**
 * Exclusao FISICA, permitida somente quando ninguem referencia.
 *
 * Em uso -> 409 com a contagem, e a saida e desativar. Nunca sumir em silencio
 * com um cadastro que pautas existentes apontam.
 */
export async function deleteTaxonomyItem(kind: TaxonomyKind, id: string): Promise<void> {
  assertValidId(id);

  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agenda_topics WHERE ${COLUNA_DE_USO[kind]} = $1`,
    [id],
  );
  if (rows[0]!.n > 0) {
    throw new HttpError(
      409,
      `Este cadastro está em uso por ${rows[0]!.n} pauta(s) e não pode ser excluído. Desative-o.`,
    );
  }

  const { rowCount } = await pool.query(`DELETE FROM ${TABELA_DE[kind]} WHERE id = $1`, [id]);
  if (rowCount === 0) throw new HttpError(404, "Cadastro não encontrado.");
}
