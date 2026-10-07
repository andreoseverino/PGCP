import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import { meetingLocationsRouter } from "./routes.js";
import {
  assertLocationId,
  createMeetingLocation,
  listActiveMeetingLocations,
  listMeetingLocations,
  parseCep,
  parseMeetingLocationInput,
  parseStatusInput,
  parseUf,
  resolverLocalParaReuniao,
  setMeetingLocationActive,
  updateMeetingLocation,
  type MeetingLocationInput,
} from "./service.js";
import { inserirReuniao } from "../meetings/create.js";
import { updateMeeting } from "../meetings/update.js";
import { findMeeting } from "../meetings/service.js";
import { versionarReuniaoSeMudou } from "../meetings/versions.js";
import { montarEvento } from "../calendar/mapper.js";
import { dentroDaTransacao } from "../transacao-ambiente.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CORPO = {
  name: "  Sede   Centro ",
  street: "Av. Paulista",
  number: "1000",
  complement: "10º andar",
  neighborhood: "",
  city: "São Paulo",
  state: "sp",
  postalCode: "01310-100",
  notes: "Recepção no térreo.\nLevar documento.",
};

// ---------------------------------------------------------------------------
// Validação (pura)
// ---------------------------------------------------------------------------

test("local: obrigatórios nome, logradouro, número, cidade, UF e CEP; opcionais viram null", () => {
  const ok = parseMeetingLocationInput(CORPO);
  assert.deepEqual(ok, {
    name: "Sede Centro",
    street: "Av. Paulista",
    number: "1000",
    complement: "10º andar",
    neighborhood: null,
    city: "São Paulo",
    state: "SP",
    postalCode: "01310100",
    notes: "Recepção no térreo.\nLevar documento.",
  });
  for (const campo of ["name", "street", "number", "city", "state", "postalCode"]) {
    const corpo: Record<string, unknown> = { ...CORPO };
    delete corpo[campo];
    assert.throws(() => parseMeetingLocationInput(corpo), HttpError, `${campo} ausente`);
    assert.throws(() => parseMeetingLocationInput({ ...CORPO, [campo]: "   " }), HttpError, `${campo} vazio`);
  }
});

test("local: UF e CEP validados sem consulta externa", () => {
  assert.equal(parseUf("rs"), "RS");
  assert.throws(() => parseUf("XX"), HttpError);
  assert.throws(() => parseUf("São Paulo"), HttpError);
  assert.equal(parseCep("01310100"), "01310100");
  for (const cep of ["1310-100", "01310-1000", "ABCDE-FGH", "01.310-100", 1310100]) {
    assert.throws(() => parseCep(cep), HttpError, String(cep));
  }
});

test("local: mass assignment e entrada maliciosa recusados", () => {
  for (const extra of [{ isActive: false }, { id: ID }, { createdByUserId: ID }, { legacyKey: "sede-matriz" }, { latitude: 1 }]) {
    assert.throws(() => parseMeetingLocationInput({ ...CORPO, ...extra }), HttpError, JSON.stringify(extra));
  }
  assert.throws(() => parseMeetingLocationInput([]), HttpError);
  assert.throws(() => parseMeetingLocationInput(null), HttpError);
  assert.throws(() => parseMeetingLocationInput({ ...CORPO, name: { $ne: "" } }), HttpError);
  assert.throws(() => parseMeetingLocationInput({ ...CORPO, street: "Rua\u0000X" }), HttpError);
  assert.throws(() => parseMeetingLocationInput({ ...CORPO, name: "x".repeat(121) }), HttpError);
  assert.throws(() => parseMeetingLocationInput({ ...CORPO, notes: "x".repeat(501) }), HttpError);
  // HTML é guardado como TEXTO (escapado na saída), nunca interpretado.
  assert.equal(parseMeetingLocationInput({ ...CORPO, name: "<b>Sala</b>" }).name, "<b>Sala</b>");
});

test("status: só { isActive: boolean }; ids inválidos recusados", () => {
  assert.equal(parseStatusInput({ isActive: false }), false);
  assert.throws(() => parseStatusInput({ isActive: "false" }), HttpError);
  assert.throws(() => parseStatusInput({ isActive: true, name: "x" }), HttpError);
  for (const id of ["1", "sede-matriz", `${ID}' OR 1=1`, "../x", 42, null]) {
    assert.throws(() => assertLocationId(id), HttpError, String(id));
  }
  assert.equal(assertLocationId(ID.toUpperCase()), ID);
});

test("autorização: router inteiro sob Assessoria/Admin; sem DELETE físico", () => {
  const pilha = (meetingLocationsRouter as unknown as { stack: Array<{ handle: unknown; route?: { methods: Record<string, boolean> } }> }).stack;
  assert.equal(pilha[0]!.handle, requireAssessoriaOuAdmin, "guarda antes de qualquer rota");
  assert.ok(!pilha.some((c) => c.route?.methods.delete), "nenhuma rota DELETE");
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  assert.ok(!/DELETE FROM meeting_locations/i.test(fonte));
  // Lista de agendamento não expõe observação interna.
  assert.match(fonte, /SELECT id, name, street, number, complement, neighborhood, city, state, postal_code\s+FROM meeting_locations WHERE is_active/);
});

// ---------------------------------------------------------------------------
// Integração REAL (PostgreSQL local), tudo em BEGIN ... ROLLBACK.
// ---------------------------------------------------------------------------

let semBanco: string | false = false;
let base: { userId: string; bodyId: string } | null = null;
try {
  const { rows: u } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  const { rows: g } = await pool.query<{ id: string }>("SELECT id FROM governance_bodies WHERE is_active LIMIT 1");
  const { rows: t } = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_locations'");
  if (!u[0] || !g[0]) semBanco = "banco sem usuário/órgão ativos";
  else if (t.length === 0) semBanco = "migration 038 não aplicada";
  else base = { userId: u[0].id, bodyId: g[0].id };
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

/** Pool falso: BEGIN/COMMIT/ROLLBACK dos serviços viram SAVEPOINTs da transação do teste. */
function poolDentroDe(client: PoolClient): Pick<Pool, "connect" | "query"> {
  let n = 0;
  const traduzir = (sql: string, pilha: string[]) => {
    if (sql === "BEGIN") { const sp = `sp_${++n}`; pilha.push(sp); return `SAVEPOINT ${sp}`; }
    if (sql === "COMMIT") return `RELEASE SAVEPOINT ${pilha.pop()}`;
    if (sql === "ROLLBACK") return `ROLLBACK TO SAVEPOINT ${pilha.pop()}`;
    return sql;
  };
  return {
    query: ((sql: string, params?: unknown[]) => client.query(sql, params)) as never,
    connect: (async () => {
      const pilha: string[] = [];
      return {
        query: (sql: string, params?: unknown[]) => client.query(traduzir(sql, pilha), params),
        release: () => {},
      };
    }) as never,
  };
}

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

const ator = () => ({ userId: base!.userId, name: "Teste Locais" });
const atorReuniao = () => ({ ...ator(), entraTenantId: "00000000-0000-4000-8000-000000000000" });

function entrada(nome: string, extra: Partial<MeetingLocationInput> = {}): MeetingLocationInput {
  return { ...parseMeetingLocationInput({ ...CORPO, name: nome }), ...extra };
}

async function novaReuniao(client: PoolClient, local: string | null): Promise<string> {
  return inserirReuniao(
    client,
    {
      governanceBodyId: base!.bodyId,
      modality: local ? "in_person" : "online",
      physicalLocationId: local ?? undefined,
      title: "Teste local",
      startAt: "2030-04-10T12:00:00.000Z",
      endAt: "2030-04-10T13:00:00.000Z",
      timezone: "America/Sao_Paulo",
      participants: [],
      agendaItems: [],
    },
    atorReuniao(),
    { origin: "manual", annualAgendaId: null },
  );
}

test("integração: criar, editar, inativar e reativar — com trilha; inativo some do agendamento", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const db = poolDentroDe(client);
    const criado = await createMeetingLocation(entrada("Teste Local Alfa"), ator(), db);
    assert.equal(criado.isActive, true);
    assert.equal(criado.state, "SP");
    assert.ok((await listActiveMeetingLocations(client)).some((l) => l.id === criado.id));

    const editado = await updateMeetingLocation(criado.id, entrada("Teste Local Alfa", { number: "2000" }), ator(), db);
    assert.equal(editado.number, "2000");

    const inativo = await setMeetingLocationActive(criado.id, false, ator(), db);
    assert.equal(inativo.isActive, false);
    assert.ok(!(await listActiveMeetingLocations(client)).some((l) => l.id === criado.id), "inativo fora do agendamento");
    assert.ok((await listMeetingLocations(client)).some((l) => l.id === criado.id), "Administração ainda vê o inativo");
    // Repetir o mesmo status não gera trilha nova.
    await setMeetingLocationActive(criado.id, false, ator(), db);
    await setMeetingLocationActive(criado.id, true, ator(), db);

    const { rows } = await client.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE entity_type = 'meeting_location' AND entity_id = $1 ORDER BY created_at, id",
      [criado.id],
    );
    assert.deepEqual(rows.map((r) => r.action).sort(), ["Local atualizado", "Local criado", "Local inativado", "Local reativado"].sort());
  });
});

test("integração: nome duplicado 409; id inexistente 404; importado sem endereço não ativa", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const db = poolDentroDe(client);
    await createMeetingLocation(entrada("Teste Local Beta"), ator(), db);
    await assert.rejects(createMeetingLocation(entrada("  teste local BETA "), ator(), db), (e: HttpError) => e.status === 409);
    await assert.rejects(updateMeetingLocation(ID, entrada("X Teste"), ator(), db), (e: HttpError) => e.status === 404);
    await assert.rejects(setMeetingLocationActive(ID, true, ator(), db), (e: HttpError) => e.status === 404);
    // Local importado SEM endereço (como as sedes da 038 antes de completar).
    // Criado aqui: as sedes reais podem já ter sido completadas e ativadas.
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO meeting_locations (legacy_key, name, is_active) VALUES ('teste-legado-038', 'Teste Legado Sem Endereço', false) RETURNING id",
    );
    await assert.rejects(setMeetingLocationActive(rows[0]!.id, true, ator(), db), (e: HttpError) => e.status === 409);
  });
});

test("integração: runtime sem DELETE em meeting_locations", { skip: semBanco }, async () => {
  const { rows } = await pool.query<{ existe: boolean; pode: boolean | null }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') AS existe,
            CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app')
                 THEN has_table_privilege('pcgp_app', 'meeting_locations', 'DELETE') END AS pode`,
  );
  if (rows[0]!.existe) assert.equal(rows[0]!.pode, false);
});

test("integração: reunião presencial usa local ATIVO; inativo/inexistente recusados; online sem local", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const db = poolDentroDe(client);
    const local = await createMeetingLocation(entrada("Teste Local Gama"), ator(), db);
    const id = await novaReuniao(client, local.id);
    const reuniao = await findMeeting(id, client);
    assert.equal(reuniao.modality, "in_person");
    assert.equal(reuniao.physicalLocation?.id, local.id);
    assert.equal(reuniao.physicalLocation?.street, "Av. Paulista");
    assert.ok(!("notes" in (reuniao.physicalLocation ?? {})), "observação interna não vai para a reunião");

    const online = await findMeeting(await novaReuniao(client, null), client);
    assert.equal(online.physicalLocation, null);

    await setMeetingLocationActive(local.id, false, ator(), db);
    await client.query("SAVEPOINT inativo");
    await assert.rejects(novaReuniao(client, local.id), (e: HttpError) => e.status === 400);
    await client.query("ROLLBACK TO SAVEPOINT inativo");
    await assert.rejects(novaReuniao(client, ID), (e: HttpError) => e.status === 404);
    await client.query("ROLLBACK TO SAVEPOINT inativo");
    await assert.rejects(resolverLocalParaReuniao(client, "nao-uuid"), (e: HttpError) => e.status === 400);

    // Banco também segura: presencial sem cópia viola o CHECK.
    await client.query("SAVEPOINT chk");
    await assert.rejects(
      client.query("UPDATE meetings SET physical_location_snapshot = NULL WHERE id = $1", [id]),
      /meetings_location_snapshot_pair_check/,
    );
    await client.query("ROLLBACK TO SAVEPOINT chk");
  });
});

test("integração: editar o cadastro NÃO muda a reunião; trocar o local muda, versiona e o convite usa a cópia", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const db = poolDentroDe(client);
    const a = await createMeetingLocation(entrada("Teste Local Delta"), ator(), db);
    const b = await createMeetingLocation(entrada("Teste Local Épsilon", { street: "Rua Nova", number: "5" }), ator(), db);
    const id = await novaReuniao(client, a.id);
    assert.equal(await versionarReuniaoSeMudou(client, id, ator(), { criacao: true }), 1);

    // Cadastro editado e inativado depois: reunião mantém o endereço histórico.
    await updateMeetingLocation(a.id, entrada("Teste Local Delta", { street: "Rua Mudada", number: "9" }), ator(), db);
    await setMeetingLocationActive(a.id, false, ator(), db);
    let reuniao = await findMeeting(id, client);
    assert.equal(reuniao.physicalLocation?.street, "Av. Paulista");
    assert.equal(await versionarReuniaoSeMudou(client, id, ator()), null, "editar o cadastro não gera versão da reunião");

    // Graph mockado: o evento é montado da cópia, não do cadastro.
    const evento = montarEvento({ ...reuniao, startAt: new Date(reuniao.startAt), endAt: new Date(reuniao.endAt), onlineMeetingProvider: "teamsForBusiness" }, []);
    assert.match(evento.location!.displayName, /Av\. Paulista, 1000/);
    assert.ok(!evento.location!.displayName.includes("Rua Mudada"));

    // Salvar mantendo o MESMO local (mesmo inativo) não reescreve a cópia.
    await dentroDaTransacao(client, () => updateMeeting(id, { physicalLocationId: a.id }, atorReuniao()));
    reuniao = await findMeeting(id, client);
    assert.equal(reuniao.physicalLocation?.street, "Av. Paulista");

    // Trocar para outro local ATIVO: nova cópia e nova versão.
    await dentroDaTransacao(client, () => updateMeeting(id, { physicalLocationId: b.id }, atorReuniao()));
    reuniao = await findMeeting(id, client);
    assert.equal(reuniao.physicalLocation?.id, b.id);
    assert.equal(reuniao.physicalLocation?.street, "Rua Nova");
    assert.equal(await versionarReuniaoSeMudou(client, id, ator()), 2);
    const { rows } = await client.query<{ change_summary: string; local_v1: string; local_v2: string }>(
      `SELECT v2.change_summary, v1.snapshot->'conteudo'->>'local' AS local_v1, v2.snapshot->'conteudo'->>'local' AS local_v2
         FROM meeting_versions v1 JOIN meeting_versions v2 ON v2.meeting_id = v1.meeting_id AND v2.version = 2
        WHERE v1.meeting_id = $1 AND v1.version = 1`,
      [id],
    );
    assert.match(rows[0]!.change_summary, /Modalidade\/local/);
    assert.match(rows[0]!.local_v1, /Av\. Paulista, 1000/, "versão antiga preservada");
    assert.match(rows[0]!.local_v2, /Rua Nova, 5/);

    // Voltar ao local inativo é uma escolha NOVA: recusada.
    await client.query("SAVEPOINT volta");
    await assert.rejects(
      dentroDaTransacao(client, () => updateMeeting(id, { physicalLocationId: a.id }, atorReuniao())),
      (e: HttpError) => e.status === 400,
    );
    await client.query("ROLLBACK TO SAVEPOINT volta");

    // Online limpa referência e cópia juntas.
    await dentroDaTransacao(client, () => updateMeeting(id, { modality: "online" }, atorReuniao()));
    reuniao = await findMeeting(id, client);
    assert.equal(reuniao.physicalLocation, null);
    const { rows: m } = await client.query("SELECT physical_location_id, physical_location_snapshot FROM meetings WHERE id = $1", [id]);
    assert.deepEqual(m[0], { physical_location_id: null, physical_location_snapshot: null });
  });
});
