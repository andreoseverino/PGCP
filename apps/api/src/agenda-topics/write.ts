import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import type { MeetingActor } from "../meetings/create.js";
import { assertValidId, findAgendaTopic, type AgendaTopicDetail } from "./service.js";

/**
 * Escrita na Biblioteca de pautas.
 *
 * Nada aqui toca a procedencia (`source_*`): ela e escrita EXCLUSIVAMENTE pela
 * operacao de dominio Postergar. Deixar o cliente informar origem permitiria
 * forjar um vinculo com uma reuniao que nunca postergou nada.
 */

const MAX_PARTICIPANTS = 200;

// -----------------------------------------------------------------------------
// Participante da pauta
// -----------------------------------------------------------------------------

export interface TopicParticipantInput {
  userId?: string;
  entraObjectId?: string;
  displayName?: string;
  email?: string;
}

const texto = (valor: unknown, campo: string, max: number): string | undefined => {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== "string") throw new HttpError(400, `O campo '${campo}' deve ser um texto.`);
  const limpo = valor.trim();
  if (limpo.length === 0) return undefined;
  if (limpo.length > max) throw new HttpError(400, `O campo '${campo}' excede ${max} caracteres.`);
  return limpo;
};

const uuidOpcional = (valor: unknown, campo: string): string | undefined => {
  const t = texto(valor, campo, 36);
  return t === undefined ? undefined : assertValidId(t, `O campo '${campo}'`);
};

/**
 * Valida um participante. Mesmas tres naturezas de `meeting_participants`:
 * usuario do PGCP, pessoa do diretorio sem conta, e externo.
 */
export function parseTopicParticipant(bruto: unknown, onde = "participant"): TopicParticipantInput {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    throw new HttpError(400, `${onde} deve ser um objeto.`);
  }
  const dados = bruto as Record<string, unknown>;

  if (dados.entraTenantId !== undefined) {
    throw new HttpError(
      400,
      `${onde} não pode informar 'entraTenantId': o tenant é definido pela autenticação.`,
    );
  }

  const userId = uuidOpcional(dados.userId, `${onde}.userId`);
  const entraObjectId = uuidOpcional(dados.entraObjectId, `${onde}.entraObjectId`);
  const displayName = texto(dados.displayName, `${onde}.displayName`, 200);
  const email = texto(dados.email, `${onde}.email`, 320);

  if (!userId && !displayName) {
    throw new HttpError(400, `${onde} precisa de 'displayName' quando não há 'userId'.`);
  }

  return { userId, entraObjectId, displayName, email };
}

/**
 * Liga o participante a `users` quando a pessoa JA existe — nunca provisiona.
 * Busca exclusiva por (tenant validado, oid): e-mail e nome nao identificam.
 */
async function vincularUsuarioExistente(
  client: PoolClient,
  entraObjectId: string | undefined,
  tenantId: string,
): Promise<string | null> {
  if (!entraObjectId) return null;
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE entra_tenant_id = $1 AND entra_object_id = $2",
    [tenantId, entraObjectId],
  );
  return rows[0]?.id ?? null;
}

async function inserirParticipante(
  client: PoolClient,
  topicId: string,
  input: TopicParticipantInput,
  tenantId: string,
  ignorarDuplicidade = false,
): Promise<string | null> {
  if (input.userId) {
    const { rows } = await client.query("SELECT id FROM users WHERE id = $1", [input.userId]);
    if (rows.length === 0) {
      throw new HttpError(400, "O participante informa um usuário do PGCP que não existe.");
    }
  }

  const userId = input.userId ?? (await vincularUsuarioExistente(client, input.entraObjectId, tenantId));

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO agenda_topic_participants
            (agenda_topic_id, user_id, display_name, email, entra_tenant_id, entra_object_id)
          VALUES ($1, $2, $3, $4, $5, $6)
       ${ignorarDuplicidade ? "ON CONFLICT DO NOTHING" : ""}
       RETURNING id`,
    [
      topicId,
      userId,
      input.displayName ?? null,
      input.email ?? null,
      // O par so entra completo, e o tenant e sempre o da autenticacao.
      input.entraObjectId ? tenantId : null,
      input.entraObjectId ?? null,
    ],
  );

  return rows[0]?.id ?? null;
}

interface ResponsavelDaBiblioteca {
  label: string | null | undefined;
  entraTenantId: string | null | undefined;
  entraObjectId: string | null | undefined;
}

/**
 * Garante o responsavel-pessoa na lista da pauta da Biblioteca.
 *
 * Identidade e sempre o par Entra tenant+oid. O rotulo sozinho pode ser area,
 * orgao ou coletivo e nunca e usado para tentar reconhecer uma pessoa.
 */
export async function garantirResponsavelNaBiblioteca(
  client: PoolClient,
  topicId: string,
  responsavel: ResponsavelDaBiblioteca,
): Promise<void> {
  const displayName = responsavel.label?.trim();
  const tenantId = responsavel.entraTenantId?.trim();
  const entraObjectId = responsavel.entraObjectId?.trim();
  if (!displayName || !tenantId || !entraObjectId) return;

  await inserirParticipante(
    client,
    topicId,
    { displayName, entraObjectId },
    tenantId,
    true,
  );
}

/**
 * `participants` presente no PATCH representa a lista opcional completa.
 *
 * A reconciliacao roda na mesma transacao do UPDATE. A lista e substituida
 * somente quando o campo foi enviado; em seguida o responsavel e reinserido de
 * forma idempotente. Falha em qualquer INSERT desfaz tambem o DELETE e o PATCH.
 * Nenhuma correspondencia usa displayName.
 */
export async function reconciliarParticipantesDaBiblioteca(
  client: PoolClient,
  topicId: string,
  participants: readonly TopicParticipantInput[],
  participantTenantId: string,
  responsavel: ResponsavelDaBiblioteca,
): Promise<void> {
  await client.query(
    "DELETE FROM agenda_topic_participants WHERE agenda_topic_id = $1",
    [topicId],
  );

  const seen = new Set<string>();
  const stableKey = (participant: TopicParticipantInput): string | null => {
    if (participant.userId) return `user:${participant.userId.toLowerCase()}`;
    if (participant.entraObjectId) {
      return `entra:${participantTenantId.toLowerCase()}:${participant.entraObjectId.toLowerCase()}`;
    }
    if (participant.email) return `email:${participant.email.toLowerCase()}`;
    // Nome não é identidade. Duas entradas apenas textuais podem ser homônimas.
    return null;
  };

  for (const participant of participants) {
    const key = stableKey(participant);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    await inserirParticipante(
      client,
      topicId,
      participant,
      participantTenantId,
      true,
    );
  }

  const responsibleKey = responsavel.entraTenantId && responsavel.entraObjectId
    ? `entra:${responsavel.entraTenantId.toLowerCase()}:${responsavel.entraObjectId.toLowerCase()}`
    : null;
  if (!responsibleKey || !seen.has(responsibleKey)) {
    await garantirResponsavelNaBiblioteca(client, topicId, responsavel);
  }
}

// -----------------------------------------------------------------------------
// Pauta
// -----------------------------------------------------------------------------

export interface AgendaTopicInput {
  title: string;
  description?: string | null;
  estimatedDurationMinutes?: number | null;
  generatesActionItem?: boolean;
  responsibleLabel?: string | null;
  responsibleEntraObjectId?: string | null;
  agendaTopicTypeId?: string | null;
  agendaTopicNatureId?: string | null;
  governanceBodyId?: string | null;
  /** PADRÃO de tema circular. Copiado para a pauta ao vincular a uma reunião. */
  isCircularTheme?: boolean;
  participants?: TopicParticipantInput[];
}

const CAMPOS_PERMITIDOS = new Set([
  "title",
  "description",
  "estimatedDurationMinutes",
  "generatesActionItem",
  "responsibleLabel",
  "responsibleEntraObjectId",
  "agendaTopicTypeId",
  "agendaTopicNatureId",
  "governanceBodyId",
  "isCircularTheme",
  "participants",
]);

/**
 * Le o corpo. Allowlist fechada: campo desconhecido e RECUSADO, nao ignorado.
 *
 * FORA por decisao: `id`, `createdAt`, contadores, `source_*` (so o Postergar
 * escreve), `linkedMeetings` (deriva de meeting_agenda_items) e `category`, que
 * a auditoria mostrou não ter consumidor.
 */
export function parseAgendaTopicInput(body: unknown, parcial = false): AgendaTopicInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;

  for (const chave of Object.keys(dados)) {
    if (!CAMPOS_PERMITIDOS.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser definido por este endpoint.`);
    }
  }

  const saida = {} as AgendaTopicInput;

  if ("title" in dados || !parcial) {
    const t = texto(dados.title, "title", 300);
    if (!t) throw new HttpError(400, "O campo 'title' é obrigatório.");
    saida.title = t;
  }

  if ("description" in dados) saida.description = texto(dados.description, "description", 5000) ?? null;

  if ("estimatedDurationMinutes" in dados) {
    const valor = dados.estimatedDurationMinutes;
    if (valor === null) saida.estimatedDurationMinutes = null;
    else if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0 || valor > 24 * 60) {
      throw new HttpError(400, "'estimatedDurationMinutes' deve ser um inteiro entre 0 e 1440.");
    } else saida.estimatedDurationMinutes = valor;
  }

  if ("generatesActionItem" in dados) {
    if (typeof dados.generatesActionItem !== "boolean") {
      throw new HttpError(400, "'generatesActionItem' deve ser booleano.");
    }
    saida.generatesActionItem = dados.generatesActionItem;
  }

  if ("isCircularTheme" in dados) {
    if (typeof dados.isCircularTheme !== "boolean") {
      throw new HttpError(400, "'isCircularTheme' deve ser booleano (true ou false).");
    }
    saida.isCircularTheme = dados.isCircularTheme;
  }

  if ("responsibleLabel" in dados) {
    saida.responsibleLabel = texto(dados.responsibleLabel, "responsibleLabel", 200) ?? null;
  }
  if ("responsibleEntraObjectId" in dados) {
    saida.responsibleEntraObjectId =
      uuidOpcional(dados.responsibleEntraObjectId, "responsibleEntraObjectId") ?? null;
  }
  if (dados.responsibleEntraTenantId !== undefined) {
    throw new HttpError(400, "'responsibleEntraTenantId' não é aceito: o tenant vem da autenticação.");
  }

  // Identidade sem rotulo nao entra: a migration 003 exige o par, e a tela
  // precisaria do Graph so para escrever quem responde.
  if (saida.responsibleEntraObjectId && !saida.responsibleLabel) {
    throw new HttpError(400, "Informe 'responsibleLabel' junto de 'responsibleEntraObjectId'.");
  }

  for (const chave of ["agendaTopicTypeId", "agendaTopicNatureId", "governanceBodyId"] as const) {
    if (!(chave in dados)) continue;
    saida[chave] = dados[chave] === null ? null : (uuidOpcional(dados[chave], chave) ?? null);
  }

  if ("participants" in dados) {
    if (!Array.isArray(dados.participants)) {
      throw new HttpError(400, "'participants' deve ser uma lista.");
    }
    if (dados.participants.length > MAX_PARTICIPANTS) {
      throw new HttpError(400, `'participants' aceita no máximo ${MAX_PARTICIPANTS} itens.`);
    }
    saida.participants = dados.participants.map((p, i) =>
      parseTopicParticipant(p, `participants[${i}]`),
    );
  }

  if (parcial && Object.keys(saida).length === 0) {
    throw new HttpError(400, "Nenhum campo alterável foi informado.");
  }

  return saida;
}

/** Confere que tipo, natureza e órgão informados existem de verdade. */
async function validarReferencias(client: PoolClient, input: AgendaTopicInput): Promise<void> {
  const checagens: Array<[string | null | undefined, string, string]> = [
    [input.agendaTopicTypeId, "agenda_topic_types", "Tipo de pauta não encontrado."],
    [input.agendaTopicNatureId, "agenda_topic_natures", "Natureza de pauta não encontrada."],
    [input.governanceBodyId, "governance_bodies", "Órgão de governança não encontrado."],
  ];

  for (const [id, tabela, mensagem] of checagens) {
    if (!id) continue;
    const { rows } = await client.query(`SELECT id FROM ${tabela} WHERE id = $1`, [id]);
    if (rows.length === 0) throw new HttpError(404, mensagem);
  }
}

async function emTransacao<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw traduzirErro(error);
  } finally {
    client.release();
  }
}

function traduzirErro(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if ((error as { code?: string } | null)?.code === "23505") {
    return new HttpError(409, "A mesma pessoa foi informada mais de uma vez nesta pauta.");
  }
  return error;
}

export async function createAgendaTopic(
  input: AgendaTopicInput,
  actor: MeetingActor,
): Promise<AgendaTopicDetail> {
  const id = await emTransacao(async (client) => {
    await validarReferencias(client, input);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO agenda_topics
              (title, description, estimated_duration_minutes, generates_action_item,
               responsible_label, responsible_entra_tenant_id, responsible_entra_object_id,
               agenda_topic_type_id, agenda_topic_nature_id, governance_body_id,
               is_circular_theme)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
      [
        input.title,
        input.description ?? null,
        input.estimatedDurationMinutes ?? null,
        input.generatesActionItem ?? false,
        input.responsibleLabel ?? null,
        input.responsibleEntraObjectId ? actor.entraTenantId : null,
        input.responsibleEntraObjectId ?? null,
        input.agendaTopicTypeId ?? null,
        input.agendaTopicNatureId ?? null,
        input.governanceBodyId ?? null,
        input.isCircularTheme ?? false,
      ],
    );

    const topicId = rows[0]!.id;

    await reconciliarParticipantesDaBiblioteca(
      client,
      topicId,
      input.participants ?? [],
      actor.entraTenantId,
      {
        label: input.responsibleLabel,
        entraTenantId: input.responsibleEntraObjectId ? actor.entraTenantId : null,
        entraObjectId: input.responsibleEntraObjectId,
      },
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta criada na Biblioteca",
      entityType: "agenda_topic",
      entityId: topicId,
      entityLabel: input.title,
      status: "success",
    });

    return topicId;
  });

  return findAgendaTopic(id);
}

const COLUNA_DE: Record<string, string> = {
  title: "title",
  description: "description",
  estimatedDurationMinutes: "estimated_duration_minutes",
  generatesActionItem: "generates_action_item",
  agendaTopicTypeId: "agenda_topic_type_id",
  agendaTopicNatureId: "agenda_topic_nature_id",
  governanceBodyId: "governance_body_id",
  isCircularTheme: "is_circular_theme",
};

export async function updateAgendaTopic(
  id: string,
  input: AgendaTopicInput,
  actor: MeetingActor,
): Promise<AgendaTopicDetail> {
  assertValidId(id);

  await emTransacao(async (client) => {
    const existe = await client.query<{ title: string }>(
      "SELECT title FROM agenda_topics WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (existe.rows.length === 0) throw new HttpError(404, "Pauta não encontrada na biblioteca.");

    await validarReferencias(client, input);

    const atribuicoes: string[] = [];
    const valores: unknown[] = [id];
    const bind = (coluna: string, valor: unknown) => {
      valores.push(valor);
      atribuicoes.push(`${coluna} = $${valores.length}`);
    };

    for (const [chave, coluna] of Object.entries(COLUNA_DE)) {
      const valor = (input as unknown as Record<string, unknown>)[chave];
      if (valor !== undefined) bind(coluna, valor);
    }

    // Rotulo e identidade andam juntos: mexer num sem o outro deixaria um `oid`
    // apontando para alguem cujo nome exibido ja e outro.
    if (input.responsibleLabel !== undefined || input.responsibleEntraObjectId !== undefined) {
      bind("responsible_label", input.responsibleLabel ?? null);
      bind("responsible_entra_object_id", input.responsibleEntraObjectId ?? null);
      bind("responsible_entra_tenant_id", input.responsibleEntraObjectId ? actor.entraTenantId : null);
    }

    if (atribuicoes.length > 0) {
      await client.query(
        `UPDATE agenda_topics SET ${atribuicoes.join(", ")} WHERE id = $1`,
        valores,
      );
    }

    const atual = await client.query<{
      responsible_label: string | null;
      responsible_entra_tenant_id: string | null;
      responsible_entra_object_id: string | null;
    }>(
      `SELECT responsible_label,
              responsible_entra_tenant_id,
              responsible_entra_object_id
         FROM agenda_topics
        WHERE id = $1`,
      [id],
    );
    const responsavel = {
      label: atual.rows[0]!.responsible_label,
      entraTenantId: atual.rows[0]!.responsible_entra_tenant_id,
      entraObjectId: atual.rows[0]!.responsible_entra_object_id,
    };

    if (input.participants !== undefined) {
      await reconciliarParticipantesDaBiblioteca(
        client,
        id,
        input.participants,
        actor.entraTenantId,
        responsavel,
      );
    } else {
      // PATCH sem `participants` preserva a colecao. A unica inclusao possivel
      // e o novo responsavel, necessaria para manter a invariante.
      await garantirResponsavelNaBiblioteca(client, id, responsavel);
    }

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta atualizada na Biblioteca",
      entityType: "agenda_topic",
      entityId: id,
      entityLabel: input.title ?? existe.rows[0]!.title,
      status: "success",
    });
  });

  return findAgendaTopic(id);
}

export async function addTopicParticipant(
  topicId: string,
  input: TopicParticipantInput,
  actor: MeetingActor,
): Promise<AgendaTopicDetail> {
  assertValidId(topicId);

  await emTransacao(async (client) => {
    const { rows } = await client.query<{ title: string }>(
      "SELECT title FROM agenda_topics WHERE id = $1",
      [topicId],
    );
    if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada na biblioteca.");

    await inserirParticipante(client, topicId, input, actor.entraTenantId);

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Participante adicionado à pauta",
      entityType: "agenda_topic_participant",
      entityId: topicId,
      entityLabel: rows[0]!.title,
      status: "success",
    });
  });

  return findAgendaTopic(topicId);
}

/** Barreira final: o participante que representa o responsavel nao sai. */
export async function exigirParticipanteRemovivelDaBiblioteca(
  client: PoolClient,
  topicId: string,
  participantId: string,
): Promise<string> {
  const { rows } = await client.query<{ title: string; is_responsible: boolean }>(
    `SELECT t.title,
            EXISTS (
              SELECT 1
                FROM agenda_topic_participants p
                LEFT JOIN users u ON u.id = p.user_id
               WHERE p.id = $2
                 AND p.agenda_topic_id = t.id
                 AND t.responsible_entra_object_id IS NOT NULL
                 AND coalesce(p.entra_tenant_id, u.entra_tenant_id) = t.responsible_entra_tenant_id
                 AND coalesce(p.entra_object_id, u.entra_object_id) = t.responsible_entra_object_id
            ) AS is_responsible
       FROM agenda_topics t
      WHERE t.id = $1`,
    [topicId, participantId],
  );
  if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada na biblioteca.");
  if (rows[0]!.is_responsible) {
    throw new HttpError(
      409,
      "O responsável atual deve permanecer participante da pauta. Troque o responsável antes de removê-lo.",
    );
  }
  return rows[0]!.title;
}

export async function removeTopicParticipant(
  topicId: string,
  participantId: string,
  actor: MeetingActor,
): Promise<AgendaTopicDetail> {
  assertValidId(topicId);
  assertValidId(participantId, "Identificador do participante");

  await emTransacao(async (client) => {
    const title = await exigirParticipanteRemovivelDaBiblioteca(
      client,
      topicId,
      participantId,
    );

    // `agenda_topic_id` no WHERE: sem ele, o id de um participante de outra
    // pauta apagaria a linha errada.
    const { rowCount } = await client.query(
      "DELETE FROM agenda_topic_participants WHERE id = $1 AND agenda_topic_id = $2",
      [participantId, topicId],
    );
    if (rowCount === 0) throw new HttpError(404, "Participante não encontrado nesta pauta.");

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Participante removido da pauta",
      entityType: "agenda_topic_participant",
      entityId: participantId,
      entityLabel: title,
      status: "success",
    });
  });

  return findAgendaTopic(topicId);
}

/**
 * Exclusao FISICA da pauta, permitida somente quando nenhuma reuniao a
 * referencia.
 *
 * A FK de `meeting_agenda_items.agenda_topic_id` e ON DELETE SET NULL: apagar
 * uma pauta vinculada nao daria erro — apenas cortaria, em silencio, a
 * procedencia de itens de reuniao que ja aconteceram. Recusar com 409 e a regra
 * segura; a copia automatica sai pelo Retomar, nao por aqui.
 */
export async function deleteAgendaTopic(id: string, actor: MeetingActor): Promise<void> {
  assertValidId(id);

  await emTransacao(async (client) => {
    const { rows } = await client.query<{ title: string; vinculos: number }>(
      `SELECT t.title,
              (SELECT count(*) FROM meeting_agenda_items ai WHERE ai.agenda_topic_id = t.id)::int AS vinculos
         FROM agenda_topics t WHERE t.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada na biblioteca.");

    if (rows[0]!.vinculos > 0) {
      throw new HttpError(
        409,
        `Esta pauta está vinculada a ${rows[0]!.vinculos} reunião(ões) e não pode ser excluída.`,
      );
    }

    // Participantes saem por CASCADE.
    await client.query("DELETE FROM agenda_topics WHERE id = $1", [id]);

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta removida da Biblioteca",
      entityType: "agenda_topic",
      entityId: id,
      entityLabel: rows[0]!.title,
      status: "success",
    });
  });
}
