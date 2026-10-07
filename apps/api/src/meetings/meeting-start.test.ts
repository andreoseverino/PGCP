import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";
import {
  PRE_START_MEETING_STATUSES,
  exigirProntaParaIniciar,
  pendenciasParaIniciar,
  startMeetingWhenAgendaItemCompletes,
} from "./meeting-start.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = {
  userId: "22222222-2222-4222-8222-222222222222",
  name: "Assessoria",
  entraTenantId: "33333333-3333-4333-8333-333333333333",
};

interface QueryLog {
  sql: string;
  params: unknown[];
}

/** Por padrao a reuniao esta pronta: convite sincronizado (validacao nao conta mais). */
function clientForStatus(
  initialStatus: string,
  preparo: { validacao?: string; convite?: string | null } = {},
) {
  let status = initialStatus;
  const queries: QueryLog[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes("SELECT m.status") && sql.includes("meeting_calendar_integrations")) {
        return {
          rows: [{
            status,
            // Validação de pautas não é mais consultada: fica fora da linha de propósito.
            sync_status: preparo.convite === undefined ? "synced" : preparo.convite,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE meetings")) {
        if ((PRE_START_MEETING_STATUSES as readonly string[]).includes(status)) {
          status = "in_progress";
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, queries, status: () => status };
}

test("concluir a primeira pauta inicia reuniao agendada e audita", async () => {
  const fake = clientForStatus("scheduled");

  assert.equal(
    await startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
    true,
  );
  assert.equal(fake.status(), "in_progress");
  assert.ok(fake.queries.some((q) => q.sql.includes("INSERT INTO audit_logs")));
});

test("concluir outra pauta mantem reuniao em andamento sem nova transicao", async () => {
  const fake = clientForStatus("in_progress");

  assert.equal(
    await startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
    false,
  );
  assert.equal(fake.status(), "in_progress");
  assert.equal(fake.queries.some((q) => q.sql.includes("INSERT INTO audit_logs")), false);
});

test("estados terminais nao voltam para em andamento", async () => {
  for (const terminal of ["done", "closed"]) {
    const fake = clientForStatus(terminal);
    assert.equal(
      await startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
      false,
    );
    assert.equal(fake.status(), terminal);
  }
});

test("duas conclusoes concorrentes produzem uma unica transicao", async () => {
  const fake = clientForStatus("scheduled");
  const results = await Promise.all([
    startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
    startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
  ]);

  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(fake.status(), "in_progress");
  assert.equal(fake.queries.filter((q) => q.sql.includes("INSERT INTO audit_logs")).length, 1);
});

test("pendencias: so o convite com evento; aprovacao das pautas nao e mais exigida", () => {
  assert.deepEqual(pendenciasParaIniciar({ calendarSyncStatus: "synced" }), []);
  assert.deepEqual(pendenciasParaIniciar({ calendarSyncStatus: "stale" }), []);
  for (const semEvento of ["pending", "failed", null]) {
    assert.deepEqual(pendenciasParaIniciar({ calendarSyncStatus: semEvento }), ["convite_nao_enviado"]);
  }
});

test("reuniao com pautas NAO aprovadas (draft/sent) inicia normalmente quando ha convite", async () => {
  for (const validacao of ["draft", "sent"]) {
    const fake = clientForStatus("scheduled", { validacao, convite: "synced" });
    await exigirProntaParaIniciar(fake.client, MEETING_ID);
    assert.equal(
      await startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
      true,
    );
  }
});

test("barreira recusa com 409 reuniao pre-inicio sem convite", async () => {
  const fake = clientForStatus("scheduled", { validacao: "draft", convite: null });
  await assert.rejects(exigirProntaParaIniciar(fake.client, MEETING_ID), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 409);
    assert.match(error.message, /convite do Outlook\/Teams ainda não foi enviado/);
    assert.doesNotMatch(error.message, /aprovad/);
    return true;
  });
});

test("barreira nao se aplica a reuniao que ja saiu da fase pre-inicio", async () => {
  for (const atual of ["in_progress", "done", "closed"]) {
    const fake = clientForStatus(atual, { validacao: "draft", convite: null });
    await exigirProntaParaIniciar(fake.client, MEETING_ID);
  }
});

test("concluir pauta de reuniao sem convite nao inicia a reuniao", async () => {
  const fake = clientForStatus("scheduled", { validacao: "approved", convite: "pending" });
  await assert.rejects(
    startMeetingWhenAgendaItemCompletes(fake.client, MEETING_ID, "Reunião executiva", ACTOR),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(fake.status(), "scheduled");
  assert.equal(fake.queries.some((q) => q.sql.includes("INSERT INTO audit_logs")), false);
});

test("PATCH de status passa pela mesma barreira ao iniciar", () => {
  const source = readFileSync(new URL("./update.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(input\.status === "in_progress"\)\s*{\s*await exigirProntaParaIniciar\(client, meetingId\);/,
  );
});

test("helper so e acionado ao concluir, nunca ao reabrir pauta", () => {
  const source = readFileSync(new URL("./update.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(input\.executionStatus === "completed"\)\s*{\s*await startMeetingWhenAgendaItemCompletes\(/,
  );
  assert.doesNotMatch(source, /input\.executionStatus === "pending"[\s\S]{0,120}startMeetingWhenAgendaItemCompletes/);
});

test("transicao e conclusao permanecem na mesma transacao e sob lock", () => {
  const source = readFileSync(new URL("./update.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function updateAgendaItem(");
  const end = source.indexOf("export async function removeAgendaItem(", start);
  const body = source.slice(start, end);

  // Transação da mutação + versão da reunião (034) no fim da MESMA transação.
  assert.match(body, /await emTransacaoVersionada\(meetingId, actor, async \(client\) =>/);
  assert.match(body, /exigirReuniaoTravada\(client, meetingId\)/);
  assert.match(body, /UPDATE meeting_agenda_items/);
  assert.match(body, /startMeetingWhenAgendaItemCompletes\(client, meetingId, titulo, actor\)/);
});
