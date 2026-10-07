import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { PoolClient } from "pg";
import pool from "../database.js";
import type { MeetingDetail } from "./service.js";
import {
  desenharPdfDaVersao,
  hashDoConteudo,
  jsonCanonico,
  lerSnapshotDaVersao,
  montarSnapshotDaReuniao,
  resumoDaMudanca,
  versionarReuniaoSeMudou,
} from "./versions.js";
import { inserirReuniao } from "./create.js";
import { dentroDaTransacao } from "../transacao-ambiente.js";

const ID = "11111111-1111-4111-8111-111111111111";

function detalhe(sobrescrever: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: ID,
    title: "09:00 | Cielo | Reunião Ordinária do Comitê",
    description: "<p><strong>Objetivo</strong></p>",
    governanceBody: { id: "g1", name: "Comitê Executivo", chairEntraObjectId: null, chairName: "Ana Externa", chairExternalParticipantId: "e1" },
    organizer: { userId: "u1", name: "Bia" },
    startAt: "2026-10-20T12:00:00.000Z",
    endAt: "2026-10-20T14:00:00.000Z",
    timezone: "America/Sao_Paulo",
    meetingLink: null,
    onlineMeetingProvider: "teamsForBusiness",
    modality: "online",
    physicalLocation: null,
    origin: "manual",
    annualAgendaId: null,
    annualAgendaStatus: null,
    releasedToPipeline: true,
    calendarSyncStatus: "synced",
    minutesStatus: null,
    sessionType: "ordinary",
    status: "scheduled",
    agendaValidation: { status: "draft", sentAt: null, sentTo: null, approvedAt: null },
    recurrence: null,
    pendingRequirements: null,
    participantsCount: 2,
    agendaItemsCount: 1,
    agendaItemsWithoutDuration: 0,
    documentsCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    participants: [
      { id: "p2", userId: null, userName: null, displayName: "Zé Externo", email: "ZE@parceiro.com", entraTenantId: null, entraObjectId: null, participantType: "external", roleInMeeting: null, isConfirmed: false, attended: null, inGovernanceBodyGroup: true },
      { id: "p1", userId: "u1", userName: "Bia", displayName: "Bia", email: "bia@cielo.com.br", entraTenantId: "t", entraObjectId: "o", participantType: "internal", roleInMeeting: "Secretária", isConfirmed: true, attended: null, inGovernanceBodyGroup: false },
    ],
    agendas: [{ id: "a1", title: "Finanças", position: 1 }],
    agendaItems: [
      { id: "i1", agendaId: "a1", title: "Resultado", position: 1, scheduledStartTime: "09:00:00", durationMinutes: 30, executionStatus: "pending", agendaTopicId: null, postponedFromItemId: null, responsible: { label: "CFO", entraTenantId: null, entraObjectId: null }, presenterLabel: null, isCircularTheme: false, type: null, nature: null, description: null, generatesActionItem: true, participants: [{ participantId: "p1", name: "Bia" }] },
    ],
    calendar: { meetingId: ID, provider: "outlook", providerEventId: "evt", webLink: "https://outlook", joinUrl: "https://teams", syncStatus: "synced", lastSyncedAt: "2026-10-02T00:00:00.000Z", lastError: null },
    ...sobrescrever,
  } as MeetingDetail;
}

test("snapshot: participantes externos identificados; ordem estável; e-mail normalizado", () => {
  const s = montarSnapshotDaReuniao(detalhe());
  assert.deepEqual(s.conteudo.participantes.map((p) => [p.nome, p.email, p.externo]), [
    ["Bia", "bia@cielo.com.br", false],
    ["Zé Externo", "ze@parceiro.com", true],
  ]);
  assert.deepEqual(s.contexto.presidenteDaMesa, { nome: "Ana Externa", externo: true });
  assert.deepEqual(s.contexto.membrosDoComite, ["Zé Externo"]);
  assert.deepEqual(s.conteudo.pautas[0]!.temas[0]!.titulo, "Resultado");
  assert.deepEqual(s.conteudo.convite, { enviado: true, teams: true });
  assert.equal(lerSnapshotDaVersao(JSON.parse(JSON.stringify(s))).formato, 1);
});

test("hash: mesmo conteúdo (inclusive em outra ordem de chaves/linhas) = mesmo hash; contexto não conta", () => {
  const a = montarSnapshotDaReuniao(detalhe());
  const b = montarSnapshotDaReuniao(detalhe({ participants: [...detalhe().participants].reverse() }));
  assert.equal(hashDoConteudo(a.conteudo), hashDoConteudo(b.conteudo));
  assert.equal(jsonCanonico({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  // Só contexto mudou (sincronização, grupo, presidente): NENHUMA versão nova.
  const soContexto = montarSnapshotDaReuniao(
    detalhe({
      calendar: { ...detalhe().calendar!, lastSyncedAt: "2026-10-09T00:00:00.000Z", syncStatus: "stale" },
      governanceBody: { ...detalhe().governanceBody, chairName: "Outro", name: "Novo nome" },
      updatedAt: "2026-10-09T00:00:00.000Z",
    }),
  );
  assert.equal(hashDoConteudo(soContexto.conteudo), hashDoConteudo(a.conteudo));
  // Mudança real muda o hash.
  const outraData = montarSnapshotDaReuniao(detalhe({ startAt: "2026-10-21T12:00:00.000Z" }));
  assert.notEqual(hashDoConteudo(outraData.conteudo), hashDoConteudo(a.conteudo));
});

test("resumo da mudança em linguagem de negócio", () => {
  const a = montarSnapshotDaReuniao(detalhe()).conteudo;
  assert.equal(resumoDaMudanca(null, a), "Versão inicial (criação da reunião)");
  assert.equal(resumoDaMudanca(null, a, "legado"), "Primeira versão registrada (reunião anterior ao versionamento)");
  const b = montarSnapshotDaReuniao(detalhe({ startAt: "2026-10-21T12:00:00.000Z", description: "<p>novo</p>", participants: [] })).conteudo;
  assert.equal(resumoDaMudanca(a, b), "Alterado: Data e horário, Descrição, Participantes");
});

test("PDF da versão: documento válido com os dados da fotografia", async () => {
  const pdf = await desenharPdfDaVersao(montarSnapshotDaReuniao(detalhe()), {
    numero: 3,
    resumo: "Alterado: Participantes",
    geradaEm: "2026-10-05T15:00:00.000Z",
    responsavel: "Bia",
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 2000);
});

test("fiação: toda mutação de reunião versiona na MESMA transação; leitura nunca versiona", () => {
  const fonte = (arq: string) => readFileSync(new URL(arq, import.meta.url), "utf8");
  const update = fonte("./update.ts");
  for (const fn of [
    "updateMeeting", "addParticipant", "removeParticipant", "addAgendaItem", "updateAgendaItem",
    "removeAgendaItem", "addAgendaItemParticipant", "removeAgendaItemParticipant", "reorderAgendaItems",
  ]) {
    const inicio = update.indexOf(`export async function ${fn}(`);
    const corpo = update.slice(inicio, update.indexOf("\nexport ", inicio + 10));
    assert.match(corpo, /await emTransacaoVersionada\(meetingId, actor, async \(client\) =>/, fn);
  }
  assert.equal((fonte("./agendas.ts").match(/emTransacaoVersionada\(meetingId, actor,/g) ?? []).length, 3);
  assert.equal((fonte("./postpone.ts").match(/emTransacaoVersionada\(meetingId, actor,/g) ?? []).length, 2);
  assert.match(fonte("./create.ts"), /versionarReuniaoSeMudou\(client, meetingId, actor, \{ criacao: true \}\);\s*await client\.query\("COMMIT"\)/);
  assert.match(fonte("../calendar/service.ts"), /await client\.query\("COMMIT"\);[\s\S]{0,400}versionarEmTransacaoPropria\(meetingId/);
  assert.ok(!/versionar/.test(fonte("./service.ts")), "leitura não versiona");
});

// ---------------------------------------------------------------------------
// Integração REAL (PostgreSQL local), tudo dentro de BEGIN ... ROLLBACK:
// nada fica no banco nem na trilha. Sem banco acessível, os testes são pulados.
// ---------------------------------------------------------------------------

let semBanco: string | false = false;
let base: { userId: string; bodyId: string } | null = null;
try {
  const { rows: u } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  const { rows: g } = await pool.query<{ id: string }>("SELECT id FROM governance_bodies WHERE is_active LIMIT 1");
  const { rows: t } = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_versions'");
  if (!u[0] || !g[0]) semBanco = "banco sem usuário/órgão ativos";
  else if (t.length === 0) semBanco = "migration 034 não aplicada";
  else base = { userId: u[0].id, bodyId: g[0].id };
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

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

async function novaReuniao(client: PoolClient, titulo: string): Promise<string> {
  return inserirReuniao(
    client,
    {
      governanceBodyId: base!.bodyId,
      modality: "online",
      title: titulo,
      description: "<p>inicial</p>",
      startAt: "2030-03-10T12:00:00.000Z",
      endAt: "2030-03-10T13:00:00.000Z",
      timezone: "America/Sao_Paulo",
      participants: [{ displayName: "Externo Teste", email: "externo.teste@parceiro.example", participantType: "external" }],
      agendaItems: [],
    },
    { userId: base!.userId, name: "Teste", entraTenantId: "00000000-0000-4000-8000-000000000000" },
    { origin: "manual", annualAgendaId: null },
  );
}

const versoes = async (client: PoolClient, id: string) =>
  (await client.query<{ version: number; change_summary: string }>(
    "SELECT version, change_summary FROM meeting_versions WHERE meeting_id = $1 ORDER BY version",
    [id],
  )).rows;

test("integração: criação gera v1; sem mudança não gera; mudança real gera v2 associada à reunião certa", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const ator = { userId: base!.userId, name: "Teste" };
    const a = await novaReuniao(client, "Teste versão A");
    const b = await novaReuniao(client, "Teste versão B");
    assert.equal(await versionarReuniaoSeMudou(client, a, ator, { criacao: true }), 1);
    assert.equal(await versionarReuniaoSeMudou(client, b, ator, { criacao: true }), 1);
    // Abrir e salvar sem mudar: nenhuma versão.
    await client.query("UPDATE meetings SET title = title WHERE id = $1", [a]);
    assert.equal(await versionarReuniaoSeMudou(client, a, ator), null);
    // Mudança real.
    await client.query("UPDATE meetings SET description = '<p>alterada</p>' WHERE id = $1", [a]);
    assert.equal(await versionarReuniaoSeMudou(client, a, ator), 2);
    assert.deepEqual((await versoes(client, a)).map((v) => [v.version, v.change_summary]), [
      [1, "Versão inicial (criação da reunião)"],
      [2, "Alterado: Descrição"],
    ]);
    assert.deepEqual((await versoes(client, b)).map((v) => v.version), [1], "a outra reunião não ganhou versão");
    // Snapshot persistido marca o externo e a trilha foi gravada na mesma transação.
    const { rows } = await client.query<{ s: { conteudo: { participantes: Array<{ externo: boolean; email: string }> } } }>(
      "SELECT snapshot AS s FROM meeting_versions WHERE meeting_id = $1 AND version = 2",
      [a],
    );
    assert.deepEqual(rows[0]!.s.conteudo.participantes.map((p) => [p.email, p.externo]), [["externo.teste@parceiro.example", true]]);
    const { rows: trilha } = await client.query(
      "SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'Versão da reunião registrada'",
      [a],
    );
    assert.equal(trilha.length, 2);
  });
});

test("integração: falha depois da alteração desfaz a versão junto (ROLLBACK)", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const ator = { userId: base!.userId, name: "Teste" };
    const id = await novaReuniao(client, "Teste falha");
    await versionarReuniaoSeMudou(client, id, ator, { criacao: true });
    await client.query("SAVEPOINT mutacao");
    await client.query("UPDATE meetings SET title = 'Teste falha alterado' WHERE id = $1", [id]);
    assert.equal(await versionarReuniaoSeMudou(client, id, ator), 2);
    // A mutação falha depois (ex.: violação no fim da transação): tudo volta.
    await assert.rejects(client.query("UPDATE meetings SET end_at = start_at WHERE id = $1", [id]));
    await client.query("ROLLBACK TO SAVEPOINT mutacao");
    assert.deepEqual((await versoes(client, id)).map((v) => v.version), [1], "nenhuma versão inválida sobrou");
  });
});

test("integração: dentro da transação ambiente (Agenda Anual) a função delegada não versiona", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const ator = { userId: base!.userId, name: "Teste" };
    const id = await novaReuniao(client, "Teste ambiente");
    await client.query("UPDATE meetings SET title = 'mudou' WHERE id = $1", [id]);
    assert.equal(await dentroDaTransacao(client, () => versionarReuniaoSeMudou(client, id, ator)), null);
    // Fora do contexto ambiente (quem abriu a transação), versiona uma vez.
    assert.equal(await versionarReuniaoSeMudou(client, id, ator), 1);
  });
});
