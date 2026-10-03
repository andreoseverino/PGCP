import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";

/**
 * CLASSIFICACAO de pessoas (migration 027): Orgaos colegiados (0..N) e Temas
 * da Biblioteca (`agenda_topics`, 0..N). Nao autoriza e nao e App Role.
 *
 * Desde a 031 o vinculo com ORGAO e o "grupo do orgao": inclui a pessoa nas
 * reunioes NOVAS do orgao (`incluirGrupoDoOrgao`; tela em `participants/groups.ts`).
 * O vinculo com TEMA (`participant_topics`) segue so como sugestao — os
 * participantes padrao do tema sao os da Biblioteca (`agenda_topic_participants`).
 *
 * Mesmo codigo para as duas origens de pessoa:
 *   externo do PGCP       (external_participants)
 *   pessoa do diretorio   (directory_people, identidade Entra)
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_VINCULOS = 50;

export interface Classificacoes {
  governanceBodyIds: string[];
  topicIds: string[];
}

export type Sujeito =
  | { tipo: "external"; id: string }
  | { tipo: "directory"; id: string };

function listaDeIds(valor: unknown, campo: string): string[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor)) throw new HttpError(400, `O campo '${campo}' deve ser uma lista.`);
  if (valor.length > MAX_VINCULOS) {
    throw new HttpError(400, `O campo '${campo}' aceita no máximo ${MAX_VINCULOS} itens.`);
  }
  const ids = valor.map((v) => {
    if (typeof v !== "string" || !UUID_PATTERN.test(v)) {
      throw new HttpError(400, `O campo '${campo}' só aceita identificadores válidos.`);
    }
    return v.toLowerCase();
  });
  // Duplicado no corpo e ignorado: o conjunto final e o que importa.
  return [...new Set(ids)];
}

/** Le `governanceBodyIds` e `topicIds` de um corpo ja recortado pela allowlist. */
export function parseClassificacoes(dados: Record<string, unknown>): Classificacoes {
  return {
    governanceBodyIds: listaDeIds(dados.governanceBodyIds, "governanceBodyIds"),
    topicIds: listaDeIds(dados.topicIds, "topicIds"),
  };
}

/** Orgaos e temas precisam existir — 404 legivel em vez de violacao de FK. */
export async function exigirExistencia(client: Pick<PoolClient, "query">, c: Classificacoes): Promise<void> {
  if (c.governanceBodyIds.length > 0) {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM governance_bodies WHERE id = ANY($1::uuid[])",
      [c.governanceBodyIds],
    );
    if (rows[0]!.n !== c.governanceBodyIds.length) throw new HttpError(404, "Órgão colegiado não encontrado.");
  }
  if (c.topicIds.length > 0) {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agenda_topics WHERE id = ANY($1::uuid[])",
      [c.topicIds],
    );
    if (rows[0]!.n !== c.topicIds.length) throw new HttpError(404, "Tema da Biblioteca não encontrado.");
  }
}

const COLUNA: Record<Sujeito["tipo"], string> = {
  external: "external_participant_id",
  directory: "directory_person_id",
};

/**
 * Substitui o conjunto de vinculos do sujeito (DELETE + INSERT na transacao do
 * chamador). Remover um vinculo nunca apaga a pessoa.
 */
export async function gravarClassificacoes(
  client: Pick<PoolClient, "query">,
  sujeito: Sujeito,
  c: Classificacoes,
): Promise<void> {
  // Coluna vem de mapa fechado, nunca do cliente.
  const coluna = COLUNA[sujeito.tipo];
  await client.query(`DELETE FROM participant_governance_bodies WHERE ${coluna} = $1`, [sujeito.id]);
  await client.query(`DELETE FROM participant_topics WHERE ${coluna} = $1`, [sujeito.id]);
  if (c.governanceBodyIds.length > 0) {
    await client.query(
      `INSERT INTO participant_governance_bodies (${coluna}, governance_body_id)
       SELECT $1, unnest($2::uuid[])`,
      [sujeito.id, c.governanceBodyIds],
    );
  }
  if (c.topicIds.length > 0) {
    await client.query(
      `INSERT INTO participant_topics (${coluna}, agenda_topic_id)
       SELECT $1, unnest($2::uuid[])`,
      [sujeito.id, c.topicIds],
    );
  }
}

export interface VinculosLidos {
  governanceBodies: Array<{ id: string; name: string }>;
  topics: Array<{ id: string; title: string }>;
}

/** Vinculos de varios sujeitos do mesmo tipo, em duas consultas. */
export async function lerClassificacoes(
  executor: Pick<PoolClient, "query">,
  tipo: Sujeito["tipo"],
  ids: string[],
): Promise<Map<string, VinculosLidos>> {
  const mapa = new Map<string, VinculosLidos>();
  for (const id of ids) mapa.set(id, { governanceBodies: [], topics: [] });
  if (ids.length === 0) return mapa;
  const coluna = COLUNA[tipo];

  const { rows: orgaos } = await executor.query<{ sujeito: string; id: string; name: string }>(
    `SELECT pgb.${coluna} AS sujeito, gb.id, gb.name
       FROM participant_governance_bodies pgb
       JOIN governance_bodies gb ON gb.id = pgb.governance_body_id
      WHERE pgb.${coluna} = ANY($1::uuid[])
      ORDER BY gb.name`,
    [ids],
  );
  for (const r of orgaos) mapa.get(r.sujeito)?.governanceBodies.push({ id: r.id, name: r.name });

  const { rows: temas } = await executor.query<{ sujeito: string; id: string; title: string }>(
    `SELECT pt.${coluna} AS sujeito, t.id, t.title
       FROM participant_topics pt
       JOIN agenda_topics t ON t.id = pt.agenda_topic_id
      WHERE pt.${coluna} = ANY($1::uuid[])
      ORDER BY t.title`,
    [ids],
  );
  for (const r of temas) mapa.get(r.sujeito)?.topics.push({ id: r.id, title: r.title });

  return mapa;
}
