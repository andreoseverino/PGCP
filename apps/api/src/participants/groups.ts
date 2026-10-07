import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import {
  buscarNoDiretorio,
  confirmarNoDiretorio,
  gravarPessoaDoDiretorio,
  type Ator,
  type DirectoryLookup,
} from "../directory-people/service.js";

/**
 * GRUPOS DE PARTICIPAÇÃO — Grupo do ÓRGÃO COLEGIADO.
 *
 * "Quem faz parte deste Comitê?" É a mesma relação da 027
 * (`participant_governance_bodies`), vista a partir do órgão. O grupo é o
 * PONTO DE PARTIDA da lista de participantes das reuniões NOVAS do órgão:
 * a tela de Nova reunião carrega o grupo (ajustável só para aquela reunião) e,
 * sem a tela, a criação inclui o grupo (`incluirGrupoDoOrgao`).
 *
 * Sem vínculo vivo: ENTRAR ou SAIR do grupo não muda reunião já criada (decisão
 * de produto, out/2026 — antes, entrar no grupo incluía a pessoa nas reuniões
 * abertas). Reunião existente muda só pela edição dela. Não autoriza nada e
 * não é App Role.
 *
 * O grupo do TEMA são os participantes padrão do tema da Biblioteca
 * (`agenda_topic_participants`), mantidos pelas rotas de `/agenda-topics`.
 *
 * Membro = pessoa do diretório (identidade Entra, confirmada no Graph) OU
 * externo do PGCP. Nunca um usuário criado, nunca uma identidade inventada.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertId(id: string, rotulo = "Identificador"): string {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, `${rotulo} inválido.`);
  return id.toLowerCase();
}

export interface GrupoDoOrgao {
  id: string;
  name: string;
  isActive: boolean;
  members: number;
}

export interface MembroDoGrupo {
  /** Id do vínculo (para remover do grupo). */
  id: string;
  origin: "entra" | "external";
  displayName: string;
  email: string | null;
  /** `oid` da pessoa do diretório (para virar convidada); `null` para externo. */
  entraObjectId: string | null;
}

/** Novo membro: SÓ a pessoa escolhida (oid do diretório OU externo cadastrado). */
export type NovoMembro = { entraObjectId: string } | { externalParticipantId: string };

export function parseNovoMembro(body: unknown): NovoMembro {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;
  for (const chave of Object.keys(dados)) {
    // Nome, e-mail, tenant e órgão nunca vêm do corpo.
    if (chave !== "entraObjectId" && chave !== "externalParticipantId") {
      throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
    }
  }
  const oid = dados.entraObjectId;
  const ext = dados.externalParticipantId;
  if ((oid === undefined) === (ext === undefined)) {
    throw new HttpError(400, "Informe a pessoa do diretório OU o participante externo.");
  }
  if (oid !== undefined) {
    if (typeof oid !== "string" || !UUID_PATTERN.test(oid)) throw new HttpError(400, "Pessoa do diretório inválida.");
    return { entraObjectId: oid.toLowerCase() };
  }
  if (typeof ext !== "string" || !UUID_PATTERN.test(ext)) throw new HttpError(400, "Participante externo inválido.");
  return { externalParticipantId: ext.toLowerCase() };
}

/** Membro visível para este tenant: externo, ou pessoa do diretório DO tenant. */
const DO_TENANT = `(g.external_participant_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM directory_people dp WHERE dp.id = g.directory_person_id AND dp.entra_tenant_id = $TENANT))`;

export async function listarGruposDeOrgao(tenantId: string): Promise<GrupoDoOrgao[]> {
  const { rows } = await pool.query<{ id: string; name: string; is_active: boolean; members: number }>(
    `SELECT gb.id, gb.name, gb.is_active,
            (SELECT count(*) FROM participant_governance_bodies g
              WHERE g.governance_body_id = gb.id AND ${DO_TENANT.replace("$TENANT", "$1")})::int AS members
       FROM governance_bodies gb
      ORDER BY gb.is_active DESC, gb.name`,
    [tenantId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active, members: r.members }));
}

async function nomeDoOrgao(executor: Pick<PoolClient, "query">, governanceBodyId: string): Promise<string> {
  const { rows } = await executor.query<{ name: string }>("SELECT name FROM governance_bodies WHERE id = $1", [governanceBodyId]);
  if (!rows[0]) throw new HttpError(404, "Órgão colegiado não encontrado.");
  return rows[0].name;
}

export async function listarMembrosDoOrgao(governanceBodyId: string, tenantId: string): Promise<MembroDoGrupo[]> {
  const id = assertId(governanceBodyId, "Identificador do órgão colegiado");
  await nomeDoOrgao(pool, id);
  const { rows } = await pool.query<{
    id: string;
    origin: "entra" | "external";
    display_name: string;
    email: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT g.id, 'entra' AS origin, dp.display_name, dp.email, dp.entra_object_id
       FROM participant_governance_bodies g
       JOIN directory_people dp ON dp.id = g.directory_person_id
      WHERE g.governance_body_id = $1 AND dp.entra_tenant_id = $2
     UNION ALL
     SELECT g.id, 'external', ep.full_name, ep.email, NULL
       FROM participant_governance_bodies g
       JOIN external_participants ep ON ep.id = g.external_participant_id
      WHERE g.governance_body_id = $1
      ORDER BY 3, 1`,
    [id, tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    origin: r.origin,
    displayName: r.display_name,
    email: r.email,
    entraObjectId: r.entra_object_id,
  }));
}

export interface ResultadoDaInclusao {
  members: MembroDoGrupo[];
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
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Adiciona ao grupo do órgão. Pessoa do diretório: confirmada no Graph (fail
 * closed) e gravada em `directory_people` sem tocar nos outros vínculos dela.
 * Externo: precisa existir no cadastro. Já membro → 409. Reuniões já criadas
 * do órgão NÃO mudam (sem vínculo vivo): só as próximas partem do grupo novo.
 */
export async function adicionarAoGrupoDoOrgao(
  governanceBodyId: string,
  membro: NovoMembro,
  ator: Ator,
  lookup: DirectoryLookup = buscarNoDiretorio,
): Promise<ResultadoDaInclusao> {
  const orgaoId = assertId(governanceBodyId, "Identificador do órgão colegiado");
  // Graph fora da transação: rede não segura conexão do banco.
  const doDiretorio = "entraObjectId" in membro ? await confirmarNoDiretorio(membro.entraObjectId, lookup) : null;

  await emTransacao(async (client) => {
    const orgao = await nomeDoOrgao(client, orgaoId);
    let coluna: "directory_person_id" | "external_participant_id";
    let pessoaId: string;
    let nome: string;
    if ("entraObjectId" in membro) {
      pessoaId = await gravarPessoaDoDiretorio(client, ator, membro.entraObjectId, doDiretorio!.nome, doDiretorio!.email);
      coluna = "directory_person_id";
      nome = doDiretorio!.nome;
    } else {
      const { rows } = await client.query<{ full_name: string; email: string }>(
        "SELECT full_name, email FROM external_participants WHERE id = $1",
        [membro.externalParticipantId],
      );
      if (!rows[0]) throw new HttpError(404, "Participante externo não encontrado.");
      pessoaId = membro.externalParticipantId;
      coluna = "external_participant_id";
      nome = rows[0].full_name;
    }
    // Coluna de mapa fechado, nunca do cliente. Índices parciais da 027 barram duplicata.
    const { rowCount } = await client.query(
      `INSERT INTO participant_governance_bodies (${coluna}, governance_body_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [pessoaId, orgaoId],
    );
    if ((rowCount ?? 0) === 0) throw new HttpError(409, "Esta pessoa já faz parte do grupo.");

    // Sem vínculo vivo: reuniões já existentes do órgão NÃO recebem a pessoa.
    // Ela entra nas reuniões NOVAS (lista carregada na Nova reunião).

    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Participante adicionado ao grupo do órgão colegiado",
      entityType: "governance_body",
      entityId: orgaoId,
      entityLabel: `${orgao.slice(0, 120)} — ${nome.slice(0, 120)}`,
      status: "success",
    });
  });
  return { members: await listarMembrosDoOrgao(orgaoId, ator.entraTenantId) };
}

/**
 * Remove do grupo. Só vale para reuniões NOVAS: quem já foi incluído em
 * reuniões existentes continua nelas. A pessoa (cadastro/diretório) não é apagada.
 */
export async function removerDoGrupoDoOrgao(governanceBodyId: string, membroId: string, ator: Ator): Promise<MembroDoGrupo[]> {
  const orgaoId = assertId(governanceBodyId, "Identificador do órgão colegiado");
  const vinculoId = assertId(membroId, "Identificador do participante");
  await emTransacao(async (client) => {
    const orgao = await nomeDoOrgao(client, orgaoId);
    // Órgão no WHERE (IDOR) e membro do tenant de quem remove.
    const { rows } = await client.query<{ nome: string }>(
      `DELETE FROM participant_governance_bodies g
        WHERE g.id = $1 AND g.governance_body_id = $2 AND ${DO_TENANT.replace("$TENANT", "$3")}
       RETURNING coalesce(
         (SELECT display_name FROM directory_people WHERE id = g.directory_person_id),
         (SELECT full_name FROM external_participants WHERE id = g.external_participant_id)
       ) AS nome`,
      [vinculoId, orgaoId, ator.entraTenantId],
    );
    if (!rows[0]) throw new HttpError(404, "Participante não encontrado neste grupo.");
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Participante removido do grupo do órgão colegiado",
      entityType: "governance_body",
      entityId: orgaoId,
      entityLabel: `${orgao.slice(0, 150)} — ${(rows[0].nome ?? "").slice(0, 150)}`,
      status: "success",
    });
  });
  return listarMembrosDoOrgao(orgaoId, ator.entraTenantId);
}
