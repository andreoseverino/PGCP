import "../env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { inserirReuniao, parseAgendaItemInput, type AgendaItemInput } from "./create.js";
import { parseAgendaItemPatch } from "./update.js";
import { parseRecorrenciaDoTema } from "./topic-recurrence.js";
import { parseAgendaTopicInput } from "../agenda-topics/write.js";

/** Recorrência do tema (039): inclusão automática em reunião NOVA do mesmo órgão. */

test("recorrência: só a lista fechada; vazio/null = não se repete; ausente = herda", () => {
  assert.equal(parseRecorrenciaDoTema("monthly"), "monthly");
  assert.equal(parseRecorrenciaDoTema(null), null);
  assert.equal(parseRecorrenciaDoTema(""), null);
  for (const v of ["Mensal", "daily", 30, true, { x: 1 }]) assert.throws(() => parseRecorrenciaDoTema(v), HttpError, String(v));
  assert.equal(parseAgendaItemInput({ title: "T" }).recurrence, undefined, "ausente herda da Biblioteca");
  assert.equal(parseAgendaItemInput({ title: "T", recurrence: "weekly" }).recurrence, "weekly");
  assert.equal(parseAgendaItemPatch({ recurrence: null }).recurrence, null);
  assert.throws(() => parseAgendaItemPatch({ recurrence: "anual" }), HttpError);
  assert.equal(parseAgendaTopicInput({ title: "T", recurrence: "quarterly" }).recurrence, "quarterly");
});

let semBanco: string | false = false;
let userId = "";
try {
  const { rows: u } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  const { rows: c } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'meeting_agenda_items' AND column_name = 'recurrence'");
  if (!u[0]) semBanco = "banco sem usuário ativo";
  else if (c.length === 0) semBanco = "migration 039 não aplicada";
  else userId = u[0].id;
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

const TENANT = "00000000-0000-4000-8000-000000000000";
const ator = () => ({ userId, name: "Teste Recorrência", entraTenantId: TENANT });

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

const orgao = async (client: PoolClient, nome: string) =>
  (await client.query<{ id: string }>("INSERT INTO governance_bodies (name) VALUES ($1) RETURNING id", [nome])).rows[0]!.id;

const temaDaBiblioteca = async (client: PoolClient, titulo: string, recorrencia: string | null) =>
  (await client.query<{ id: string }>(
    "INSERT INTO agenda_topics (title, recurrence, estimated_duration_minutes) VALUES ($1, $2, 20) RETURNING id",
    [titulo, recorrencia],
  )).rows[0]!.id;

const reuniao = (client: PoolClient, orgaoId: string, dia: string, agendaItems: AgendaItemInput[] = []) =>
  inserirReuniao(
    client,
    {
      governanceBodyId: orgaoId,
      modality: "online",
      title: `Teste recorrência ${dia}`,
      startAt: `${dia}T12:00:00.000Z`,
      endAt: `${dia}T13:00:00.000Z`,
      timezone: "America/Sao_Paulo",
      participants: [],
      agendaItems,
    },
    ator(),
    { origin: "manual", annualAgendaId: null },
  );

const temas = async (client: PoolClient, meetingId: string) =>
  (await client.query<{ title: string; recurrence: string | null; meeting_agenda_id: string | null; agenda_topic_id: string | null }>(
    "SELECT title, recurrence, meeting_agenda_id, agenda_topic_id FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position",
    [meetingId],
  )).rows;

test("integração: mensal entra na 1ª reunião nova do órgão após 1 mês, sem pauta, e conta a partir da última vez", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const o = await orgao(client, "Órgão Teste Recorrência A");
    const t = await temaDaBiblioteca(client, "Resultado Mensal", "monthly");
    const jan = await reuniao(client, o, "2030-01-10", [{ title: "Resultado Mensal", agendaTopicId: t }]);
    assert.equal((await temas(client, jan))[0]!.recurrence, "monthly", "herdou o padrão da Biblioteca");

    const jan20 = await reuniao(client, o, "2030-01-20");
    assert.deepEqual(await temas(client, jan20), [], "ainda não venceu");

    const fev = await reuniao(client, o, "2030-02-10");
    const incluido = await temas(client, fev);
    assert.deepEqual(incluido.map((x) => [x.title, x.recurrence, x.meeting_agenda_id, x.agenda_topic_id]), [["Resultado Mensal", "monthly", null, t]]);
    const { rows: trilha } = await client.query(
      "SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'Temas recorrentes incluídos automaticamente (1)'", [fev]);
    assert.equal(trilha.length, 1);

    // Conta desde a ÚLTIMA vez (10/02): 20/02 não recebe.
    assert.deepEqual(await temas(client, await reuniao(client, o, "2030-02-20")), []);
    // Reunião já existente não muda (sem vínculo vivo).
    assert.deepEqual(await temas(client, jan20), []);
    // Mesmo tema já enviado no corpo: não duplica.
    const mar = await reuniao(client, o, "2030-03-15", [{ title: "Resultado Mensal", agendaTopicId: t }]);
    assert.equal((await temas(client, mar)).length, 1);
  });
});

test("integração: semanal; outro órgão não recebe; cancelada não conta; desligar a recorrência para", { skip: semBanco }, async () => {
  await emRollback(async (client) => {
    const o = await orgao(client, "Órgão Teste Recorrência B");
    const outro = await orgao(client, "Órgão Teste Recorrência C");
    const t = await temaDaBiblioteca(client, "Status Semanal", null);
    const s1 = await reuniao(client, o, "2030-05-06", [{ title: "Status Semanal", agendaTopicId: t, recurrence: "weekly" }]);
    assert.deepEqual(await temas(client, await reuniao(client, outro, "2030-05-20")), [], "outro órgão");
    const s2 = await reuniao(client, o, "2030-05-13");
    assert.equal((await temas(client, s2)).length, 1, "7 dias depois");

    // Última ocorrência cancelada não conta: volta a valer a de 13/05.
    await client.query("UPDATE meetings SET cancelled_at = now(), cancelled_by_user_id = $2 WHERE id = $1", [s2, userId]);
    const s3 = await reuniao(client, o, "2030-05-14");
    assert.equal((await temas(client, s3)).length, 1, "conta da 06/05, já vencida");

    // Desligada na última vez: não entra mais.
    await client.query("UPDATE meeting_agenda_items SET recurrence = NULL WHERE meeting_id = $1", [s3]);
    assert.deepEqual(await temas(client, await reuniao(client, o, "2030-06-30")), []);
    assert.ok(s1);
  });
});
