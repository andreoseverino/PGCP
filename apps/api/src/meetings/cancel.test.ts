import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { Pool, PoolClient } from "pg";
import pool from "../database.js";
import { GraphError } from "../graph/client.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { deleteMeeting, eventoACancelar, MSG_REUNIAO_CANCELADA, recusarMutacaoEmReuniaoCancelada } from "./delete.js";
import { inserirReuniao } from "./create.js";
import { findMeeting, listMeetings } from "./service.js";
import { desenharPdfDaVersao, lerSnapshotDaVersao, versionarReuniaoSeMudou } from "./versions.js";
import { meetingsRouter } from "./routes.js";

/**
 * EXCLUIR REUNIÃO = CANCELAMENTO LÓGICO (036).
 *
 * Os testes de integração rodam no PostgreSQL local DENTRO de uma transação
 * que é desfeita no fim: o `deleteMeeting` recebe um "pool" falso cujas
 * transações viram SAVEPOINTs da transação externa. Nada fica no banco nem na
 * trilha. Sem banco acessível (ou sem a 036), são pulados.
 */

const ID = "11111111-1111-4111-8111-111111111111";

test("evento externo só é cancelado quando existe e ainda não foi cancelado", () => {
  assert.equal(eventoACancelar({ provider_event_id: "evt", organizer_entra_object_id: "oid", calendar_event_cancelled_at: null }), true);
  assert.equal(eventoACancelar({ provider_event_id: null, organizer_entra_object_id: "oid", calendar_event_cancelled_at: null }), false);
  assert.equal(eventoACancelar({ provider_event_id: "evt", organizer_entra_object_id: null, calendar_event_cancelled_at: null }), false);
  assert.equal(eventoACancelar({ provider_event_id: "evt", organizer_entra_object_id: "oid", calendar_event_cancelled_at: new Date() }), false);
});

test("autorização: excluir exige PGCP.Assessoria; mutação em reunião cancelada → 409; leitura e nova exclusão passam", async () => {
  const pilha = (meetingsRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }; handle?: unknown }>;
  }).stack;
  const rota = pilha.find((c) => c.route?.path === "/:id" && c.route.methods.delete)!.route!;
  assert.ok(rota.stack.some((s) => s.handle === requirePgcpAssessoria));

  const guarda = recusarMutacaoEmReuniaoCancelada(async () => true);
  const chamar = async (method: string, path: string) => {
    let codigo = 0;
    let corpo: unknown = null;
    let seguiu = false;
    const res = {
      status(c: number) { codigo = c; return this; },
      json(b: unknown) { corpo = b; return this; },
    };
    await guarda({ method, path, params: { id: ID } } as never, res as never, () => { seguiu = true; });
    return { codigo, corpo, seguiu };
  };
  for (const [m, p] of [["PATCH", "/"], ["POST", "/participants"], ["POST", "/calendar-sync"], ["PUT", "/minutes"], ["POST", "/documents"]]) {
    const r = await chamar(m!, p!);
    assert.equal(r.codigo, 409, `${m} ${p}`);
    assert.deepEqual(r.corpo, { error: MSG_REUNIAO_CANCELADA, code: "meeting_cancelled" });
  }
  assert.equal((await chamar("GET", "/")).seguiu, true, "histórico legível");
  assert.equal((await chamar("GET", "/versions")).seguiu, true, "versões legíveis");
  assert.equal((await chamar("DELETE", "/")).seguiu, true, "repetir a exclusão retenta o evento pendente");
  // Montada ANTES das rotas: vale para todas.
  const fonte = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.ok(fonte.indexOf('meetingsRouter.use("/:id", recusarMutacaoEmReuniaoCancelada())') < fonte.search(/meetingsRouter\.(get|post|patch|put|delete)\(/));
});

test("sem exclusão física: código não apaga reunião; listagens ativas filtram canceladas", () => {
  const sem = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/DELETE FROM meetings/.test(sem(readFileSync(new URL("./delete.ts", import.meta.url), "utf8"))));
  assert.match(readFileSync(new URL("./service.ts", import.meta.url), "utf8"), /const conditions: string\[\] = \["m\.cancelled_at IS NULL"\]/);
  assert.match(readFileSync(new URL("./export.ts", import.meta.url), "utf8"), /"m\.cancelled_at IS NULL"/);
  const agenda = readFileSync(new URL("../annual-agendas/service.ts", import.meta.url), "utf8");
  assert.ok((agenda.match(/cancelled_at IS NULL/g) ?? []).length >= 8, "Agenda Anual: contagens, visão, conteúdo, candidatas, edição, associação, reserva");
  assert.match(readFileSync(new URL("../calendar/service.ts", import.meta.url), "utf8"), /if \(row\.cancelled_at\) throw new HttpError\(409/);
  const mig = readFileSync(new URL("../../migrations/036_meeting_cancellation.sql", import.meta.url), "utf8");
  assert.match(mig, /FOREIGN KEY \(meeting_id\) REFERENCES meetings \(id\) ON DELETE RESTRICT/);
  assert.match(mig, /REVOKE DELETE ON public\.meetings FROM pcgp_app/);
});

// ---------------------------------------------------------------------------
// Integração
// ---------------------------------------------------------------------------

let semBanco: string | false = false;
let base: { userId: string; bodyId: string } | null = null;
try {
  const { rows: u } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  const { rows: g } = await pool.query<{ id: string }>("SELECT id FROM governance_bodies WHERE is_active LIMIT 1");
  const { rows: c } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'meetings' AND column_name = 'cancelled_at'");
  if (!u[0] || !g[0]) semBanco = "banco sem usuário/órgão ativos";
  else if (c.length === 0) semBanco = "migration 036 não aplicada";
  else base = { userId: u[0].id, bodyId: g[0].id };
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

/** "Pool" sobre UM cliente em transação: BEGIN/COMMIT/ROLLBACK viram SAVEPOINT. */
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

const ATOR = () => ({ id: base!.userId, name: "Teste Cancelamento" });

/** Reunião com convite "existente" no Outlook (evento + organizador) e versão 1. */
async function reuniaoComConvite(client: PoolClient): Promise<string> {
  const id = await inserirReuniao(
    client,
    {
      governanceBodyId: base!.bodyId,
      modality: "online",
      title: "Teste cancelamento",
      startAt: "2031-05-10T12:00:00.000Z",
      endAt: "2031-05-10T13:00:00.000Z",
      timezone: "America/Sao_Paulo",
      participants: [{ displayName: "Externo Cancel", email: "externo.cancel@parceiro.example", participantType: "external" }],
      agendaItems: [],
    },
    { userId: base!.userId, name: "Teste", entraTenantId: "00000000-0000-4000-8000-000000000000" },
    { origin: "manual", annualAgendaId: null },
  );
  await client.query(
    "UPDATE meetings SET organizer_entra_object_id = $2, organizer_entra_tenant_id = $3 WHERE id = $1",
    [id, "22222222-2222-4222-8222-222222222222", "00000000-0000-4000-8000-000000000000"],
  );
  await client.query(
    `INSERT INTO meeting_calendar_integrations (meeting_id, provider, provider_event_id, sync_status, last_synced_at)
          VALUES ($1, 'outlook', 'evento-teste', 'synced', now())
     ON CONFLICT (meeting_id, provider) DO UPDATE SET provider_event_id = 'evento-teste', sync_status = 'synced', last_synced_at = now()`,
    [id],
  );
  await versionarReuniaoSeMudou(client, id, { userId: base!.userId, name: "Teste" }, { criacao: true });
  // Documento anexado: antes impedia a exclusão; agora fica no histórico.
  await client.query(
    `INSERT INTO documents (source, meeting_id, original_filename, mime_type, size_bytes, sha256, object_key, uploaded_by_user_id)
          VALUES ('user', $1, 'ata-previa.pdf', 'application/pdf', 10, $2, $3, $4)`,
    [id, "a".repeat(64), `teste/${id}/doc.pdf`, base!.userId],
  );
  return id;
}

test("cancelar: evento externo cancelado, reunião sai das listagens ativas, histórico preservado", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const id = await reuniaoComConvite(client);
    const chamadas: Array<[string, string]> = [];
    const r = await deleteMeeting(id, ATOR(), {
      db: poolDentroDe(client),
      cancelarNoGraph: async (oid, evento) => { chamadas.push([oid, evento]); },
    });

    // 1. Evento externo cancelado pelo Graph, no calendário do organizador.
    assert.deepEqual(chamadas, [["22222222-2222-4222-8222-222222222222", "evento-teste"]]);
    assert.equal(r.calendarCancellation, "cancelled");

    // 2. Fora dos fluxos ativos; detalhe continua legível como histórico.
    const ativas = await listMeetings({ limit: 200 }, client);
    assert.ok(!ativas.some((m) => m.id === id));
    const detalhe = await findMeeting(id, client);
    assert.ok(detalhe.cancelledAt && detalhe.calendarEventCancelledAt);
    assert.equal(detalhe.participants.length, 1, "participantes preservados");

    // 3/4. Versões preservadas, com a fotografia do cancelamento, e PDF gerável.
    const { rows: versoes } = await client.query<{ version: number; change_summary: string; snapshot: unknown }>(
      "SELECT version, change_summary, snapshot FROM meeting_versions WHERE meeting_id = $1 ORDER BY version",
      [id],
    );
    assert.deepEqual(versoes.map((v) => [v.version, v.change_summary]), [
      [1, "Versão inicial (criação da reunião)"],
      [2, "Reunião cancelada (exclusão lógica)"],
    ]);
    const ultima = lerSnapshotDaVersao(versoes[1]!.snapshot);
    assert.equal(ultima.conteudo.cancelada, true);
    const pdf = await desenharPdfDaVersao(ultima, { numero: 2, resumo: versoes[1]!.change_summary, geradaEm: new Date().toISOString(), responsavel: "Teste" });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

    // Documento continua lá.
    const { rows: docs } = await client.query("SELECT 1 FROM documents WHERE meeting_id = $1", [id]);
    assert.equal(docs.length, 1);

    // 5. Trilha: cancelamento + evento cancelado + versão.
    const { rows: trilha } = await client.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at, id",
      [id],
    );
    for (const acao of ["Reunião cancelada (exclusão lógica)", "Evento Outlook cancelado", "Versão da reunião registrada"]) {
      assert.ok(trilha.some((t) => t.action === acao), acao);
    }

    // 6. Sem cascata: apagar a reunião é recusado (FK RESTRICT ou privilégio) e
    //    as versões continuam lá; versão também não se apaga.
    await client.query("SAVEPOINT apagar");
    await assert.rejects(client.query("DELETE FROM meetings WHERE id = $1", [id]));
    await client.query("ROLLBACK TO SAVEPOINT apagar");
    await assert.rejects(client.query("DELETE FROM meeting_versions WHERE meeting_id = $1", [id]));
    await client.query("ROLLBACK TO SAVEPOINT apagar");
    const { rows: ainda } = await client.query("SELECT 1 FROM meeting_versions WHERE meeting_id = $1", [id]);
    assert.equal(ainda.length, 2);

    // Cancelada é somente leitura no banco e não volta.
    await assert.rejects(client.query("UPDATE meetings SET title = 'reativar' WHERE id = $1", [id]), /somente leitura/);
    await client.query("ROLLBACK TO SAVEPOINT apagar");
    await assert.rejects(client.query("UPDATE meetings SET cancelled_at = NULL, cancelled_by_user_id = NULL WHERE id = $1", [id]), /não pode ser reativada/);
    await client.query("ROLLBACK TO SAVEPOINT apagar");
  });
});

test("falha no Graph: reunião cancelada no PGCP, cancelamento externo PENDENTE e auditado; repetir retenta sem nova versão", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const id = await reuniaoComConvite(client);
    const db = poolDentroDe(client);
    const r = await deleteMeeting(id, ATOR(), {
      db,
      cancelarNoGraph: async () => { throw new GraphError("Graph indisponível (teste).", "ServiceUnavailable", 503); },
    });
    assert.equal(r.calendarCancellation, "pending");
    assert.match(r.warning!, /Tente excluir novamente/);
    const { rows } = await client.query<{ cancelled_at: Date | null; calendar_event_cancelled_at: Date | null }>(
      "SELECT cancelled_at, calendar_event_cancelled_at FROM meetings WHERE id = $1",
      [id],
    );
    assert.ok(rows[0]!.cancelled_at, "estado local consistente: cancelada");
    assert.equal(rows[0]!.calendar_event_cancelled_at, null, "evento explicitamente pendente");
    const { rows: falha } = await client.query(
      "SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'Cancelamento do evento Outlook falhou' AND status = 'failure'",
      [id],
    );
    assert.equal(falha.length, 1);

    // Retentativa (mesma rota DELETE): só o evento; nada local é refeito.
    let chamou = 0;
    const r2 = await deleteMeeting(id, ATOR(), { db, cancelarNoGraph: async () => { chamou++; } });
    assert.equal(chamou, 1);
    assert.equal(r2.calendarCancellation, "cancelled");
    assert.equal(r2.cancelledAt, r.cancelledAt);
    const { rows: v } = await client.query("SELECT 1 FROM meeting_versions WHERE meeting_id = $1", [id]);
    assert.equal(v.length, 2, "sem versão duplicada");
    // Terceira vez: nada pendente, nenhuma chamada externa.
    const r3 = await deleteMeeting(id, ATOR(), { db, cancelarNoGraph: async () => { chamou++; } });
    assert.equal(chamou, 1);
    assert.equal(r3.calendarCancellation, "cancelled");
  });
});

test("reunião sem convite externo: cancela só no PGCP; inexistente = 404", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const id = await reuniaoComConvite(client);
    await client.query("UPDATE meeting_calendar_integrations SET provider_event_id = NULL, sync_status = 'pending' WHERE meeting_id = $1", [id]);
    let chamou = false;
    const r = await deleteMeeting(id, ATOR(), { db: poolDentroDe(client), cancelarNoGraph: async () => { chamou = true; } });
    assert.equal(chamou, false);
    assert.equal(r.calendarCancellation, "not_required");
    await assert.rejects(
      deleteMeeting("33333333-3333-4333-8333-333333333333", ATOR(), { db: poolDentroDe(client) }),
      (e: unknown) => (e as { status?: number }).status === 404,
    );
  });
});
