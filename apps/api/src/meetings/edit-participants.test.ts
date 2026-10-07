import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { meetingsRouter } from "./routes.js";
import { inserirReuniao } from "./create.js";
import { addParticipant, parseUpdateInput, removeParticipant, updateMeeting } from "./update.js";
import { parseListaDeParticipantes } from "./participants-sync.js";
import { findMeeting } from "./service.js";
import { versionarReuniaoSeMudou } from "./versions.js";
import { dentroDaTransacao } from "../transacao-ambiente.js";

/**
 * Participantes na EDIÇÃO da reunião (lista completa no PATCH): uma operação
 * lógica — uma transação, uma versão, uma sincronização do convite — com as
 * MESMAS regras da aba Participantes do Pipeline.
 */

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fonte = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// Contrato (puro)
// ---------------------------------------------------------------------------

test("PATCH aceita a lista completa: existentes só por id, novos com as regras da inclusão avulsa", () => {
  const r = parseUpdateInput({
    participants: [{ id: ID.toUpperCase() }, { displayName: "Externa", email: "e@parceiro.example", participantType: "external" }],
  });
  assert.deepEqual(r.participants?.manter, [ID]);
  assert.equal(r.participants?.novos[0]!.displayName, "Externa");
  assert.deepEqual(parseUpdateInput({ participants: [] }).participants, { manter: [], novos: [] }, "lista vazia = remover todos");
});

test("lista inválida é recusada (tipo, tamanho, id, repetição, tenant do corpo, campos extras)", () => {
  for (const participants of [
    "x",
    { id: ID },
    [{ id: "nao-uuid" }],
    [{ id: ID }, { id: ID }],
    [{ id: ID, displayName: "Forjado" }],
    [{ displayName: "X", entraTenantId: ID }],
    [{}],
    Array.from({ length: 201 }, (_, i) => ({ displayName: `P${i}` })),
  ]) {
    assert.throws(() => parseUpdateInput({ participants }), HttpError, JSON.stringify(participants).slice(0, 60));
  }
  assert.throws(() => parseListaDeParticipantes(null), HttpError);
});

test("autorização: PATCH /meetings/:id exige PGCP.Assessoria (403 para os demais)", () => {
  const pilha = (meetingsRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack;
  const patch = pilha.find((c) => c.route?.path === "/:id" && c.route.methods.patch);
  assert.ok(patch?.route?.stack.some((h) => h.handle === requirePgcpAssessoria));
});

test("uma operação: versão e convite só no fim da edição; sem segunda implementação de regra", () => {
  const sync = fonte("./participants-sync.ts");
  assert.ok(!/versionar|syncCalendar|syncMeetingCalendar/.test(sync), "lista não versiona nem sincroniza sozinha");
  assert.match(sync, /excluirMeetingParticipant\(client, meetingId, id, actor, titulo\)/);
  assert.match(sync, /inserirMeetingParticipant\(client, meetingId, p, actor, titulo\)/);
  assert.match(sync, /prepararParticipantes\(client, lista\.novos, actor\.entraTenantId\)/);
  const update = fonte("./update.ts");
  assert.match(update, /aplicarListaDeParticipantes\(client, meetingId, listaDeParticipantes, actor/);
  // Inclusão avulsa (Pipeline) e edição usam a MESMA checagem de duplicidade.
  assert.equal((update.match(/exigirQueNaoParticipa\(client, meetingId, preparado!\)/g) ?? []).length, 1);
  // PATCH: uma chamada HTTP = uma sincronização (depois do commit).
  assert.match(fonte("./routes.ts"), /meetingsRouter\.patch\("\/:id", requirePgcpAssessoria, mutacao\("atualizar"[\s\S]{0,140}\{ sincroniza: true \}/);
});

// ---------------------------------------------------------------------------
// Integração REAL (PostgreSQL local), em BEGIN ... ROLLBACK
// ---------------------------------------------------------------------------

let semBanco: string | false = false;
let base: { userId: string; bodyId: string } | null = null;
try {
  const { rows: u } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  const { rows: g } = await pool.query<{ id: string }>("SELECT id FROM governance_bodies WHERE is_active LIMIT 1");
  if (!u[0] || !g[0]) semBanco = "banco sem usuário/órgão ativos";
  else base = { userId: u[0].id, bodyId: g[0].id };
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

const TENANT = "00000000-0000-4000-8000-000000000000";
const OID_RESP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ator = () => ({ userId: base!.userId, name: "Teste Edição", entraTenantId: TENANT });
const externo = (n: string) => ({ displayName: `Externo ${n}`, email: `externo.${n}.edicao@parceiro.example`, participantType: "external" as const });

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

/** Reunião com A, B, C (externos) e um responsável de tema (diretório). Convite já enviado (synced). */
async function cenario(client: PoolClient) {
  const id = await inserirReuniao(
    client,
    {
      governanceBodyId: base!.bodyId,
      modality: "online",
      title: "Teste edição participantes",
      description: "<p>inicial</p>",
      startAt: "2030-05-10T12:00:00.000Z",
      endAt: "2030-05-10T13:00:00.000Z",
      timezone: "America/Sao_Paulo",
      participants: [externo("a"), externo("b"), externo("c"), { entraObjectId: OID_RESP, displayName: "Responsável Tema" }],
      agendaItems: [{ title: "Tema com responsável", responsibleEntraObjectId: OID_RESP, responsibleLabel: "Responsável Tema" }],
    },
    ator(),
    { origin: "manual", annualAgendaId: null },
  );
  await client.query(
    `INSERT INTO meeting_calendar_integrations (meeting_id, provider, sync_status, provider_event_id, last_synced_at)
          VALUES ($1, 'outlook', 'synced', $2, now())
     ON CONFLICT (meeting_id, provider) DO UPDATE
           SET sync_status = 'synced', provider_event_id = EXCLUDED.provider_event_id, last_synced_at = now()`,
    [id, `evento-teste-${id}`],
  );
  assert.equal(await versionarReuniaoSeMudou(client, id, ator(), { criacao: true }), 1);
  const detalhe = await findMeeting(id, client);
  const porEmail = (n: string) => detalhe.participants.find((p) => p.email === externo(n).email)!.id;
  const responsavel = detalhe.participants.find((p) => p.entraObjectId === OID_RESP)!.id;
  return { id, a: porEmail("a"), b: porEmail("b"), c: porEmail("c"), responsavel };
}

const editar = (client: PoolClient, id: string, corpo: unknown) =>
  dentroDaTransacao(client, () => updateMeeting(id, parseUpdateInput(corpo), ator()));

const statusDoConvite = async (client: PoolClient, id: string) =>
  (await client.query<{ s: string }>("SELECT sync_status AS s FROM meeting_calendar_integrations WHERE meeting_id = $1", [id])).rows[0]!.s;

test("integração: adiciona 2, remove 1 e altera descrição numa edição só → uma versão, convite desatualizado uma vez", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const r = await cenario(client);
    const depois = await editar(client, r.id, {
      description: "<p>nova</p>",
      participants: [{ id: r.a }, { id: r.c }, { id: r.responsavel }, externo("d"), externo("e")],
    });
    const emails = depois.participants.map((p) => p.email).filter(Boolean).sort();
    assert.deepEqual(emails, ["externo.a.edicao@parceiro.example", "externo.c.edicao@parceiro.example", "externo.d.edicao@parceiro.example", "externo.e.edicao@parceiro.example"]);
    assert.ok(depois.participants.find((p) => p.email === externo("d").email)!.participantType === "external");
    assert.match(depois.description ?? "", /nova/);
    assert.equal(await statusDoConvite(client, r.id), "stale", "uma sincronização pendente (feita uma vez pela rota)");

    // UMA versão para a edição inteira; versionar de novo não acha diferença.
    assert.equal(await versionarReuniaoSeMudou(client, r.id, ator()), 2);
    assert.equal(await versionarReuniaoSeMudou(client, r.id, ator()), null);
    const { rows: v } = await client.query<{ change_summary: string }>(
      "SELECT change_summary FROM meeting_versions WHERE meeting_id = $1 AND version = 2", [r.id]);
    assert.match(v[0]!.change_summary, /Descrição/);
    assert.match(v[0]!.change_summary, /Participantes/);

    // Auditoria coerente: 2 inclusões, 1 remoção, 1 edição da reunião.
    const { rows: trilha } = await client.query<{ action: string; n: string }>(
      `SELECT action, count(*) AS n FROM audit_logs
        WHERE actor_name = 'Teste Edição' AND action IN ('Participante adicionado', 'Participante removido da reunião', 'Reunião atualizada')
          AND created_at >= now() - interval '1 hour' AND entity_label LIKE '%participantes%'
        GROUP BY action ORDER BY action`);
    const n = Object.fromEntries(trilha.map((t) => [t.action, Number(t.n)]));
    assert.equal(n["Participante removido da reunião"], 1);
    assert.equal(n["Reunião atualizada"], 1);
    assert.ok((n["Participante adicionado"] ?? 0) >= 2);
  });
});

test("integração: só adicionar / só remover funcionam; salvar a mesma lista não muda nada", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const r = await cenario(client);
    const todos = [{ id: r.a }, { id: r.b }, { id: r.c }, { id: r.responsavel }];

    // Mesma lista: sem trilha, sem convite, sem versão.
    const { rows: antes } = await client.query<{ n: string }>("SELECT count(*) AS n FROM audit_logs");
    await editar(client, r.id, { participants: todos });
    const { rows: depoisMesma } = await client.query<{ n: string }>("SELECT count(*) AS n FROM audit_logs");
    assert.equal(depoisMesma[0]!.n, antes[0]!.n, "nenhuma auditoria");
    assert.equal(await statusDoConvite(client, r.id), "synced", "convite não reenviado");
    assert.equal(await versionarReuniaoSeMudou(client, r.id, ator()), null, "nenhuma versão");

    await editar(client, r.id, { participants: [...todos, externo("f")] });
    assert.equal((await findMeeting(r.id, client)).participants.length, 5);
    assert.equal(await statusDoConvite(client, r.id), "stale");

    await editar(client, r.id, { participants: [{ id: r.a }, { id: r.responsavel }] });
    assert.deepEqual((await findMeeting(r.id, client)).participants.map((p) => p.id).sort(), [r.a, r.responsavel].sort());
  });
});

test("integração: duplicidade, responsável por tema, id de outra reunião e usuário inexistente são recusados", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const r = await cenario(client);
    const outra = await cenario(client);
    const casos: Array<[unknown, number]> = [
      [[{ id: r.a }, { id: r.b }, { id: r.c }, { id: r.responsavel }, externo("a")], 409],
      [[{ id: r.a }, { id: r.b }, { id: r.c }, { id: r.responsavel }, externo("x"), externo("x")], 409],
      [[{ id: r.a }, { id: r.b }, { id: r.c }], 409],
      [[{ id: r.a }, { id: outra.b }, { id: r.responsavel }], 404],
      [[{ id: r.a }, { id: r.responsavel }, { userId: ID }], 400],
    ];
    for (const [participants, status] of casos) {
      await client.query("SAVEPOINT caso");
      await assert.rejects(editar(client, r.id, { participants }), (e: HttpError) => e.status === status, JSON.stringify(participants).slice(0, 80));
      await client.query("ROLLBACK TO SAVEPOINT caso");
    }
    assert.equal((await findMeeting(outra.id, client)).participants.length, 4, "a outra reunião não foi tocada");
  });
});

test("integração: falha no meio desfaz TUDO (descrição e participantes) — transação real", { skip: semBanco }, async () => {
  // Reunião real, sem commit: a edição falha e o emTransacao faz ROLLBACK.
  const { rows } = await pool.query<{ id: string; description: string | null }>(
    "SELECT id, description FROM meetings WHERE cancelled_at IS NULL ORDER BY created_at LIMIT 1");
  if (!rows[0]) return;
  const m = rows[0];
  const antes = await findMeeting(m.id);
  const { rows: v0 } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM meeting_versions WHERE meeting_id = $1", [m.id]);
  await assert.rejects(
    updateMeeting(m.id, parseUpdateInput({
      description: "<p>NÃO DEVE FICAR</p>",
      // Mantém todos e inclui um usuário inexistente: falha DEPOIS do UPDATE da descrição.
      participants: [...antes.participants.map((p) => ({ id: p.id })), { userId: ID }],
    }), ator()),
    (e: HttpError) => e.status === 400,
  );
  const depois = await findMeeting(m.id);
  assert.equal(depois.description, antes.description);
  assert.deepEqual(depois.participants.map((p) => p.id).sort(), antes.participants.map((p) => p.id).sort());
  const { rows: v1 } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM meeting_versions WHERE meeting_id = $1", [m.id]);
  assert.equal(v1[0]!.n, v0[0]!.n, "nenhuma versão");
});

test("integração: Pipeline (inclusão/remoção avulsa) continua funcionando com as mesmas regras", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const r = await cenario(client);
    const comNovo = await dentroDaTransacao(client, () => addParticipant(r.id, externo("g"), ator()));
    assert.ok(comNovo.participants.some((p) => p.email === externo("g").email));
    await client.query("SAVEPOINT dup");
    await assert.rejects(dentroDaTransacao(client, () => addParticipant(r.id, externo("g"), ator())), (e: HttpError) => e.status === 409);
    await client.query("ROLLBACK TO SAVEPOINT dup");
    await assert.rejects(dentroDaTransacao(client, () => removeParticipant(r.id, r.responsavel, ator())), (e: HttpError) => e.status === 409);
    await client.query("ROLLBACK TO SAVEPOINT dup");
    const semB = await dentroDaTransacao(client, () => removeParticipant(r.id, r.b, ator()));
    assert.ok(!semB.participants.some((p) => p.id === r.b));
  });
});
