import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";

export interface GovernanceBody {
  id: string;
  name: string;
  icon: string | null;
  isActive: boolean;
  /**
   * Identidade MICROSOFT do Presidente da Mesa deste orgao — fato do orgao,
   * nao da reuniao. Ver migration 023. `null` = ninguem cadastrado ainda.
   */
  chairEntraObjectId: string | null;
  /** Snapshot de exibicao, capturado no momento da escolha no diretorio. */
  chairName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GovernanceBodyRow {
  id: string;
  name: string;
  icon: string | null;
  is_active: boolean;
  chair_entra_object_id: string | null;
  chair_name: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Presidente da Mesa escolhido no diretorio corporativo.
 *
 * So `entraObjectId`: o tenant vem do token do ator, nunca do corpo — mesmo
 * principio de `OrganizerInput` em `meetings/create.ts`.
 */
export interface ChairInput {
  entraObjectId?: string;
  displayName?: string;
}

export interface GovernanceBodyInput {
  name: string;
  icon?: string | null;
  isActive?: boolean;
  /**
   * `undefined` = nao mexe no presidente atual; `null` = remove; objeto =
   * define/substitui. Os tres estados sao distintos de proposito — um PUT que
   * so muda o nome nao pode apagar o presidente por omissao.
   */
  chair?: ChairInput | null;
}

/**
 * Quem executou a mutacao.
 *
 * Vem SEMPRE de `req.pgcpUser`, resolvido por `requireActivePgcpUser` a partir
 * do token do Entra. NUNCA do corpo da requisicao: se o cliente pudesse dizer
 * quem agiu, a trilha registraria a afirmacao dele, nao o fato.
 *
 * Nao existe ator sintetico. Sem usuario autenticado a operacao nao acontece —
 * gravar "Sistema" ou "Desconhecido" seria inventar um responsavel.
 */
export interface GovernanceBodyActor {
  id: string;
  name: string;
  /** Tenant validado no token — usado para gravar a identidade do presidente. */
  entraTenantId: string;
}

/** `entity_type` da trilha. Mesmo vocabulario snake_case dos demais dominios. */
const AUDIT_ENTITY = "governance_body";

const COLUMNS =
  "id, name, icon, is_active, chair_entra_object_id, chair_name, created_at, updated_at";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toGovernanceBody(row: GovernanceBodyRow): GovernanceBody {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    isActive: row.is_active,
    chairEntraObjectId: row.chair_entra_object_id,
    chairName: row.chair_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Valida o Presidente da Mesa recebido no corpo — mesmo formato de
 * `parseOrganizerInput` em `meetings/create.ts`: so `entraObjectId` e
 * `displayName` sao aceitos, o tenant nunca vem do cliente.
 *
 * `null` explicito remove o presidente; `undefined` (campo ausente) preserva
 * o atual. Os dois casos so se distinguem porque o chamador testa
 * `"chair" in body` antes de chegar aqui — ver `parseInput`.
 */
function parseChairInput(valor: unknown): ChairInput | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== "object" || Array.isArray(valor)) {
    throw new HttpError(400, "O campo 'chair' deve ser um objeto ou nulo.");
  }

  const dados = valor as Record<string, unknown>;
  for (const proibido of ["entraTenantId", "userId"]) {
    if (dados[proibido] !== undefined) {
      throw new HttpError(
        400,
        `O campo 'chair.${proibido}' não pode ser informado: a identidade é resolvida pelo servidor.`,
      );
    }
  }

  const { entraObjectId, displayName } = dados;
  if (entraObjectId !== undefined && typeof entraObjectId !== "string") {
    throw new HttpError(400, "O campo 'chair.entraObjectId' deve ser um texto.");
  }
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new HttpError(400, "O campo 'chair.displayName' deve ser um texto.");
  }

  const nome = typeof displayName === "string" ? displayName.trim() : undefined;

  if (entraObjectId && !nome) {
    throw new HttpError(400, "Informe 'chair.displayName' junto com 'chair.entraObjectId'.");
  }
  if (!entraObjectId) {
    throw new HttpError(
      400,
      "O Presidente da Mesa precisa ser escolhido no diretório corporativo: informe 'chair.entraObjectId'.",
    );
  }

  return { entraObjectId, displayName: nome };
}

/** Garante que o :id da rota e um UUID antes de ir ao banco. */
export function assertValidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new HttpError(400, "Identificador inválido.");
  }
}

/** Valida e normaliza o corpo da requisicao. Nao confia no frontend. */
export function parseInput(body: unknown): GovernanceBodyInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Corpo da requisição inválido.");
  }

  const dados = body as Record<string, unknown>;
  const { name, icon, isActive } = dados;

  if (typeof name !== "string") {
    throw new HttpError(400, "O campo 'name' é obrigatório e deve ser um texto.");
  }

  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new HttpError(400, "O nome do órgão não pode ser vazio.");
  }
  if (trimmedName.length > 200) {
    throw new HttpError(400, "O nome do órgão deve ter no máximo 200 caracteres.");
  }

  if (icon !== undefined && icon !== null && typeof icon !== "string") {
    throw new HttpError(400, "O campo 'icon' deve ser um texto ou nulo.");
  }

  if (isActive !== undefined && typeof isActive !== "boolean") {
    throw new HttpError(400, "O campo 'isActive' deve ser booleano.");
  }

  // Distingue "campo ausente" (nao mexe no presidente) de `chair: null`
  // explicito (remove o presidente) — por isso testa a CHAVE, nao o valor.
  const chair: ChairInput | null | undefined = "chair" in dados
    ? (dados.chair === null ? null : parseChairInput(dados.chair))
    : undefined;

  return {
    name: trimmedName,
    icon: typeof icon === "string" ? icon.trim() || null : (icon as null | undefined),
    isActive: isActive as boolean | undefined,
    chair,
  };
}

/**
 * Traduz erro do PostgreSQL para HttpError com mensagem apresentavel.
 * Qualquer coisa nao mapeada sobe como esta e vira 500 generico na rota.
 *
 * Nao ha tratamento de 23503 (violacao de FK): governance_bodies nao possui
 * chave estrangeira de saida, e o registro nunca e excluido fisicamente --
 * orgaos sao desativados via is_active. Reunioes historicas sao preservadas.
 */
function translateDatabaseError(error: unknown): never {
  const { code } = (error ?? {}) as { code?: string };

  if (code === "23505") {
    throw new HttpError(409, "Já existe um órgão de governança com este nome.");
  }

  throw error;
}

export async function listGovernanceBodies(): Promise<GovernanceBody[]> {
  const { rows } = await pool.query<GovernanceBodyRow>(
    `SELECT ${COLUMNS} FROM governance_bodies ORDER BY name`,
  );
  return rows.map(toGovernanceBody);
}

export async function findGovernanceBody(id: string): Promise<GovernanceBody> {
  assertValidId(id);

  const { rows } = await pool.query<GovernanceBodyRow>(
    `SELECT ${COLUMNS} FROM governance_bodies WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) {
    throw new HttpError(404, "Órgão de governança não encontrado.");
  }
  return toGovernanceBody(rows[0]!);
}

/**
 * Cria o orgao e registra a trilha na MESMA transacao.
 *
 * A auditoria NAO e best-effort aqui: se `recordAuditIn` falhar, o COMMIT nao
 * acontece e o orgao nao passa a existir. Ou o ato e o registro existem juntos,
 * ou nenhum dos dois — orgao de governanca criado sem rastro seria pior do que
 * a criacao ter falhado.
 */
export async function createGovernanceBody(
  input: GovernanceBodyInput,
  actor: GovernanceBodyActor,
): Promise<GovernanceBody> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<GovernanceBodyRow>(
      `INSERT INTO governance_bodies
              (name, icon, is_active, chair_entra_tenant_id, chair_entra_object_id, chair_name)
       VALUES ($1, $2, COALESCE($3, true), $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        input.name,
        input.icon ?? null,
        input.isActive ?? null,
        input.chair?.entraObjectId ? actor.entraTenantId : null,
        input.chair?.entraObjectId ?? null,
        input.chair?.displayName ?? null,
      ],
    );

    const criado = toGovernanceBody(rows[0]!);

    await recordAuditIn(client, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Órgão de governança criado",
      entityType: AUDIT_ENTITY,
      entityId: criado.id,
      entityLabel: criado.name,
      status: "success",
    });

    await client.query("COMMIT");
    return criado;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    translateDatabaseError(error);
  } finally {
    client.release();
  }
}

/**
 * Atualiza o orgao. Tambem e o caminho de ativacao/desativacao: basta enviar
 * `isActive`. Nao existe exclusao fisica -- desativar preserva o registro e
 * todos os vinculos historicos (reunioes, pautas, acoes).
 */
/**
 * Acao da trilha, decidida pela transicao REAL de `is_active`.
 *
 * O servidor compara o valor anterior com o gravado; o cliente nao diz qual
 * evento aconteceu. Quando o mesmo PUT muda nome e estado, a transicao tem
 * precedencia — ativar ou desativar um orgao e a decisao de governanca, e a
 * renomeacao fica registrada em `entity_label` com o nome final.
 *
 * Uma requisicao produz UMA entrada. Nunca duas.
 */
function acaoDaAtualizacao(antes: boolean, depois: boolean): string {
  if (antes === depois) return "Órgão de governança atualizado";
  return depois ? "Órgão de governança ativado" : "Órgão de governança desativado";
}

/**
 * Atualiza o orgao. Tambem e o caminho de ativacao/desativacao: basta enviar
 * `isActive`. Nao existe exclusao fisica -- desativar preserva o registro e
 * todos os vinculos historicos (reunioes, pautas, acoes).
 *
 * Tudo numa transacao: leitura do estado anterior, escrita e trilha. Sem isso,
 * outra requisicao poderia mudar `is_active` entre o SELECT e o UPDATE e a
 * trilha registraria uma transicao que nao foi essa.
 */
export async function updateGovernanceBody(
  id: string,
  input: GovernanceBodyInput,
  actor: GovernanceBodyActor,
): Promise<GovernanceBody> {
  assertValidId(id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE trava a linha ate o COMMIT: o `is_active` lido aqui e o mesmo
    // que o UPDATE logo abaixo vai substituir.
    const anterior = await client.query<{ is_active: boolean }>(
      "SELECT is_active FROM governance_bodies WHERE id = $1 FOR UPDATE",
      [id],
    );

    if (anterior.rows.length === 0) {
      throw new HttpError(404, "Órgão de governança não encontrado.");
    }

    // icon e is_active sao opcionais: quando omitidos, o valor atual e mantido.
    // isActive: false chega como false (?? so cai em null/undefined), entao
    // COALESCE(false, is_active) resolve para false corretamente.
    //
    // chair NAO da para resolver com COALESCE: `null` explicito (remover o
    // presidente) e "campo ausente" (manter) tem que produzir resultados
    // diferentes, e os dois chegam aqui como valores nulos nos parametros. O
    // CASE decide pelo flag `chairProvided`, calculado no service a partir da
    // presenca da chave no corpo (`parseInput`).
    const chairProvided = input.chair !== undefined;
    const chairEntraTenantId = chairProvided && input.chair?.entraObjectId ? actor.entraTenantId : null;
    const chairEntraObjectId = chairProvided ? input.chair?.entraObjectId ?? null : null;
    const chairName = chairProvided ? input.chair?.displayName ?? null : null;

    const { rows } = await client.query<GovernanceBodyRow>(
      `UPDATE governance_bodies
          SET name                  = $2,
              icon                  = COALESCE($3, icon),
              is_active             = COALESCE($4, is_active),
              chair_entra_tenant_id = CASE WHEN $5 THEN $6 ELSE chair_entra_tenant_id END,
              chair_entra_object_id = CASE WHEN $5 THEN $7 ELSE chair_entra_object_id END,
              chair_name            = CASE WHEN $5 THEN $8 ELSE chair_name END
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [
        id,
        input.name,
        input.icon ?? null,
        input.isActive ?? null,
        chairProvided,
        chairEntraTenantId,
        chairEntraObjectId,
        chairName,
      ],
    );

    const atualizado = toGovernanceBody(rows[0]!);

    await recordAuditIn(client, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: acaoDaAtualizacao(anterior.rows[0]!.is_active, atualizado.isActive),
      entityType: AUDIT_ENTITY,
      entityId: atualizado.id,
      entityLabel: atualizado.name,
      status: "success",
    });

    await client.query("COMMIT");
    return atualizado;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HttpError) throw error;
    translateDatabaseError(error);
  } finally {
    client.release();
  }
}
