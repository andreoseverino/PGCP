import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { findDirectoryUserById, getGraphConfig, type DirectoryUser } from "../graph/client.js";
import { resolverEnderecoCorporativo } from "../calendar/mapper.js";
import {
  exigirExistencia,
  gravarClassificacoes,
  lerClassificacoes,
  parseClassificacoes,
  type Classificacoes,
  type VinculosLidos,
} from "../participants/classifications.js";

/**
 * PESSOAS DO DIRETÓRIO com classificação no PGCP (migration 027).
 *
 * A identidade continua sendo do Microsoft Entra ID: aqui fica só o par
 * (tenant, oid), um snapshot de nome/e-mail lido do Graph no vínculo, e as
 * classificações (órgãos/temas) usadas para SUGERIR participantes.
 *
 * NÃO cria `users` (login continua JIT), NÃO cria `external_participants`, NÃO
 * concede App Role e NÃO autoriza nada. Só existe linha para quem a
 * Administração vinculou explicitamente — nada de sincronizar o tenant.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DirectoryPerson extends VinculosLidos {
  id: string;
  origin: "entra";
  entraObjectId: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryPersonInput extends Classificacoes {
  entraObjectId: string;
}

function objeto(body: unknown, permitidos: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;
  for (const chave of Object.keys(dados)) {
    // Nome, e-mail e tenant vêm do Graph/token, nunca do cliente.
    if (!permitidos.includes(chave)) throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
  }
  return dados;
}

/** Criar/atualizar vínculo: só o `oid` escolhido no diretório + classificações. */
export function parseDirectoryPersonInput(body: unknown): DirectoryPersonInput {
  const dados = objeto(body, ["entraObjectId", "governanceBodyIds", "topicIds"]);
  if (typeof dados.entraObjectId !== "string" || !UUID_PATTERN.test(dados.entraObjectId)) {
    throw new HttpError(400, "Selecione a pessoa no diretório Microsoft.");
  }
  return { entraObjectId: dados.entraObjectId.toLowerCase(), ...parseClassificacoes(dados) };
}

/** PATCH: só as classificações. A identidade não muda. */
export function parseDirectoryPersonPatch(body: unknown): Classificacoes {
  return parseClassificacoes(objeto(body, ["governanceBodyIds", "topicIds"]));
}

/**
 * Busca a pessoa no Graph para CONFIRMAR que o oid existe no tenant.
 * Fail closed: sem verificar, não vincula (mesma postura do cadastro externo).
 */
export type DirectoryLookup = (oid: string) => Promise<DirectoryUser | null | "unavailable">;

export const buscarNoDiretorio: DirectoryLookup = async (oid) => {
  const config = getGraphConfig();
  if (!config) return "unavailable";
  try {
    return await findDirectoryUserById(config, oid);
  } catch {
    return "unavailable";
  }
};

export const MSG_DIRETORIO_INDISPONIVEL =
  "Não foi possível confirmar esta pessoa no diretório corporativo. Tente novamente em alguns minutos.";

interface Row {
  id: string;
  entra_object_id: string;
  display_name: string;
  email: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT id, entra_object_id, display_name, email, created_at, updated_at FROM directory_people`;

function toPerson(row: Row, v: VinculosLidos | undefined): DirectoryPerson {
  return {
    id: row.id,
    origin: "entra",
    entraObjectId: row.entra_object_id,
    displayName: row.display_name,
    email: row.email,
    governanceBodies: v?.governanceBodies ?? [],
    topics: v?.topics ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Pessoas vinculadas DO TENANT de quem consulta. Nunca o diretório inteiro. */
export async function listDirectoryPeople(tenantId: string): Promise<DirectoryPerson[]> {
  const { rows } = await pool.query<Row>(
    `${SELECT} WHERE entra_tenant_id = $1 ORDER BY display_name, id LIMIT 1000`,
    [tenantId],
  );
  const v = await lerClassificacoes(pool, "directory", rows.map((r) => r.id));
  return rows.map((r) => toPerson(r, v.get(r.id)));
}

async function findById(client: Pick<PoolClient, "query">, id: string, tenantId: string): Promise<DirectoryPerson> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE id = $1 AND entra_tenant_id = $2`, [id, tenantId]);
  if (!rows[0]) throw new HttpError(404, "Pessoa do diretório não encontrada.");
  const v = await lerClassificacoes(client, "directory", [id]);
  return toPerson(rows[0], v.get(id));
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
    const code = (error as { code?: string } | null)?.code;
    if (code === "23503") throw new HttpError(404, "Órgão colegiado ou tema não encontrado.");
    throw error;
  } finally {
    client.release();
  }
}

export interface Ator {
  userId: string;
  name: string;
  entraTenantId: string;
}

/**
 * Confirma o `oid` no Graph e devolve o snapshot de nome/e-mail DO GRAPH.
 * Fail closed: sem confirmar, nada é gravado. Reusada pelos grupos de participação.
 */
export async function confirmarNoDiretorio(
  entraObjectId: string,
  lookup: DirectoryLookup = buscarNoDiretorio,
): Promise<{ nome: string; email: string | null }> {
  const encontrado = await lookup(entraObjectId);
  if (encontrado === "unavailable") throw new HttpError(503, MSG_DIRETORIO_INDISPONIVEL);
  if (!encontrado) throw new HttpError(404, "Pessoa não encontrada no diretório corporativo.");
  const email = resolverEnderecoCorporativo(encontrado.mail, encontrado.userPrincipalName);
  return { nome: encontrado.displayName?.trim() || email || encontrado.id, email };
}

/**
 * Grava (ou atualiza o snapshot de) a pessoa do diretório — idempotente por
 * (tenant, oid), nunca duplica. NÃO mexe em órgãos/temas da pessoa.
 */
export async function gravarPessoaDoDiretorio(
  client: Pick<PoolClient, "query">,
  ator: Ator,
  entraObjectId: string,
  nome: string,
  email: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO directory_people (entra_tenant_id, entra_object_id, display_name, email, created_by_user_id)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (entra_tenant_id, entra_object_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email,
                   updated_by_user_id = $5
     RETURNING id`,
    [ator.entraTenantId, entraObjectId, nome.slice(0, 300), email, ator.userId],
  );
  return rows[0]!.id;
}

/**
 * Vincula (ou atualiza) a pessoa do diretório: confirma o oid no Graph, grava
 * o snapshot de nome/e-mail DO GRAPH e substitui as classificações.
 * Idempotente por (tenant, oid) — nunca duplica a pessoa.
 */
export async function upsertDirectoryPerson(
  input: DirectoryPersonInput,
  ator: Ator,
  lookup: DirectoryLookup = buscarNoDiretorio,
): Promise<DirectoryPerson> {
  const { nome, email } = await confirmarNoDiretorio(input.entraObjectId, lookup);

  return emTransacao(async (client) => {
    await exigirExistencia(client, input);
    const id = await gravarPessoaDoDiretorio(client, ator, input.entraObjectId, nome, email);
    await gravarClassificacoes(client, { tipo: "directory", id }, input);

    // Uma entrada consolidada por ato (não uma por órgão/tema). Sem e-mail.
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Vínculos de pessoa do diretório atualizados",
      entityType: "directory_person",
      entityId: id,
      entityLabel: `${nome.slice(0, 200)} — ${input.governanceBodyIds.length} órgão(s), ${input.topicIds.length} tema(s)`,
      status: "success",
    });
    return findById(client, id, ator.entraTenantId);
  });
}

export async function updateDirectoryPerson(id: string, c: Classificacoes, ator: Ator): Promise<DirectoryPerson> {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Identificador inválido.");
  return emTransacao(async (client) => {
    const atual = await findById(client, id, ator.entraTenantId);
    await exigirExistencia(client, c);
    await gravarClassificacoes(client, { tipo: "directory", id }, c);
    await client.query("UPDATE directory_people SET updated_by_user_id = $2 WHERE id = $1", [id, ator.userId]);
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Vínculos de pessoa do diretório atualizados",
      entityType: "directory_person",
      entityId: id,
      entityLabel: `${atual.displayName.slice(0, 200)} — ${c.governanceBodyIds.length} órgão(s), ${c.topicIds.length} tema(s)`,
      status: "success",
    });
    return findById(client, id, ator.entraTenantId);
  });
}

/** Remove a CLASSIFICAÇÃO da pessoa. Não toca no Entra, em `users` nem em reuniões. */
export async function deleteDirectoryPerson(id: string, ator: Ator): Promise<void> {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Identificador inválido.");
  await emTransacao(async (client) => {
    const { rows } = await client.query<{ display_name: string }>(
      "DELETE FROM directory_people WHERE id = $1 AND entra_tenant_id = $2 RETURNING display_name",
      [id, ator.entraTenantId],
    );
    if (!rows[0]) throw new HttpError(404, "Pessoa do diretório não encontrada.");
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Vínculos de pessoa do diretório removidos",
      entityType: "directory_person",
      entityId: id,
      entityLabel: rows[0].display_name.slice(0, 200),
      status: "success",
    });
  });
}
