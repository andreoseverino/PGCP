import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { inserirReuniao, parseCreateInput, type ParticipantInput } from "./create.js";
import { findMeeting } from "./service.js";
import { parseUpdateInput, updateMeeting } from "./update.js";
import { estaExcluidaDaReuniao } from "./participant-exclusions.js";
import { dentroDaTransacao } from "../transacao-ambiente.js";

/**
 * Participantes do GRUPO DO ÓRGÃO na criação (lista carregada na tela) e sem
 * vínculo vivo com reuniões já criadas.
 */

const fonte = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("criação: `participantsIncludeGroup` só aceita booleano; ausente mantém o comportamento anterior", () => {
  const base = {
    governanceBodyId: "11111111-1111-4111-8111-111111111111",
    title: "X",
    startAt: "2030-01-01T12:00:00Z",
    endAt: "2030-01-01T13:00:00Z",
    timezone: "America/Sao_Paulo",
  };
  assert.equal(parseCreateInput({ ...base, participantsIncludeGroup: true }).participantsIncludeGroup, true);
  assert.equal(parseCreateInput(base).participantsIncludeGroup, undefined);
  assert.throws(() => parseCreateInput({ ...base, participantsIncludeGroup: "true" }), HttpError);
  const create = fonte("./create.ts");
  assert.match(create, /if \(input\.participantsIncludeGroup\) \{\s*await registrarOmitidosDoGrupo\(/);
  assert.match(create, /\} else \{\s*await incluirGrupoDoOrgao\(/);
});

let semBanco: string | false = false;
let userId = "";
try {
  const { rows: u } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  if (!u[0]) semBanco = "banco sem usuário ativo";
  else userId = u[0].id;
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

const TENANT = "00000000-0000-4000-8000-000000000000";
const OID_ANA = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OID_BRUNO = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const OID_DANI = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const ator = () => ({ userId, name: "Teste Grupo", entraTenantId: TENANT });

async function emRollback(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Órgão novo com Ana e Bruno (diretório) e Carla (externa). */
async function orgaoComGrupo(client: PoolClient, nome: string): Promise<string> {
  const { rows: gb } = await client.query<{ id: string }>("INSERT INTO governance_bodies (name) VALUES ($1) RETURNING id", [nome]);
  const orgao = gb[0]!.id;
  for (const [oid, n, email] of [[OID_ANA, "Ana Grupo", "ana.grupo@cielo.example"], [OID_BRUNO, "Bruno Grupo", "bruno.grupo@cielo.example"]]) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO directory_people (entra_tenant_id, entra_object_id, display_name, email, created_by_user_id)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entra_tenant_id, entra_object_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [TENANT, oid, n, email, userId],
    );
    await client.query("INSERT INTO participant_governance_bodies (directory_person_id, governance_body_id) VALUES ($1, $2)", [rows[0]!.id, orgao]);
  }
  const { rows: ext } = await client.query<{ id: string }>(
    `INSERT INTO external_participants (full_name, email, created_by_user_id) VALUES ('Carla Grupo', 'carla.grupo@parceiro.example', $1) RETURNING id`,
    [userId],
  );
  await client.query("INSERT INTO participant_governance_bodies (external_participant_id, governance_body_id) VALUES ($1, $2)", [ext[0]!.id, orgao]);
  return orgao;
}

const criar = (client: PoolClient, orgao: string, participants: ParticipantInput[], participantsIncludeGroup?: boolean) =>
  inserirReuniao(
    client,
    {
      governanceBodyId: orgao,
      modality: "online",
      title: "Teste grupo do órgão",
      startAt: "2030-06-10T12:00:00.000Z",
      endAt: "2030-06-10T13:00:00.000Z",
      timezone: "America/Sao_Paulo",
      participants,
      agendaItems: [],
      participantsIncludeGroup,
    },
    ator(),
    { origin: "manual", annualAgendaId: null },
  );

const nomes = async (client: PoolClient, id: string) =>
  (await findMeeting(id, client)).participants.map((p) => p.displayName).sort();

test("integração: lista da tela é a autoridade — removido do grupo não volta; manual entra; grupo intocado", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const orgao = await orgaoComGrupo(client, "Órgão Teste Grupo A");
    // Tela carregou Ana, Bruno, Carla; usuária removeu Bruno e adicionou Dani.
    const id = await criar(client, orgao, [
      { entraObjectId: OID_ANA, displayName: "Ana Grupo", email: "ana.grupo@cielo.example" },
      { displayName: "Carla Grupo", email: "carla.grupo@parceiro.example", participantType: "external" },
      { entraObjectId: OID_DANI, displayName: "Dani Manual", email: "dani@cielo.example" },
    ], true);
    assert.deepEqual(await nomes(client, id), ["Ana Grupo", "Carla Grupo", "Dani Manual"]);
    const carla = (await findMeeting(id, client)).participants.find((p) => p.displayName === "Carla Grupo")!;
    assert.equal(carla.participantType, "external");

    // Bruno ficou de fora DESTA reunião (exceção 031) — e continua no grupo.
    assert.equal(await estaExcluidaDaReuniao(client, id, { entraTenantId: TENANT, entraObjectId: OID_BRUNO, email: "bruno.grupo@cielo.example" }), true);
    const { rows: grupo } = await client.query("SELECT 1 FROM participant_governance_bodies WHERE governance_body_id = $1", [orgao]);
    assert.equal(grupo.length, 3, "cadastro do órgão não muda");

    // Editar outro campo depois não recoloca Bruno.
    await dentroDaTransacao(client, () => updateMeeting(id, parseUpdateInput({ description: "<p>outra</p>" }), ator()));
    assert.deepEqual(await nomes(client, id), ["Ana Grupo", "Carla Grupo", "Dani Manual"]);
  });
});

test("integração: sem a flag (outros clientes) o servidor inclui o grupo como antes", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const orgao = await orgaoComGrupo(client, "Órgão Teste Grupo B");
    const id = await criar(client, orgao, []);
    assert.deepEqual(await nomes(client, id), ["Ana Grupo", "Bruno Grupo", "Carla Grupo"]);
  });
});

test("integração: duplicidade na criação é recusada pelo servidor (Entra e externo pelo e-mail)", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const orgao = await orgaoComGrupo(client, "Órgão Teste Grupo C");
    for (const lista of [
      [{ entraObjectId: OID_ANA, displayName: "Ana" }, { entraObjectId: OID_ANA, displayName: "Ana de novo" }],
      [
        { displayName: "Carla", email: "carla.grupo@parceiro.example", participantType: "external" as const },
        { displayName: "Carla 2", email: "CARLA.grupo@parceiro.example", participantType: "external" as const },
      ],
    ]) {
      await client.query("SAVEPOINT dup");
      await assert.rejects(criar(client, orgao, lista, true), (e: HttpError) => e.status === 409);
      await client.query("ROLLBACK TO SAVEPOINT dup");
    }
  });
});

test("integração: entrar no grupo depois NÃO muda reunião já criada (sem vínculo vivo)", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const orgao = await orgaoComGrupo(client, "Órgão Teste Grupo D");
    const id = await criar(client, orgao, [], undefined);
    // Nova pessoa no grupo (o caminho da Administração não toca em reuniões; ver groups.test.ts).
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO directory_people (entra_tenant_id, entra_object_id, display_name, created_by_user_id)
            VALUES ($1, $2, 'Dani Depois', $3) RETURNING id`,
      [TENANT, OID_DANI, userId],
    );
    await client.query("INSERT INTO participant_governance_bodies (directory_person_id, governance_body_id) VALUES ($1, $2)", [rows[0]!.id, orgao]);
    assert.ok(!(await nomes(client, id)).includes("Dani Depois"));
  });
});

test("edição: trocar o órgão NÃO recalcula participantes no servidor (a tela decide e envia a lista)", () => {
  const update = fonte("./update.ts");
  const corpo = update.slice(update.indexOf("export async function updateMeeting("), update.indexOf("async function recomporTituloPadronizado("));
  assert.ok(!/incluirGrupoDoOrgao|participant_governance_bodies/.test(corpo));
});
