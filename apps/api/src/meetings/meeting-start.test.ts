import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PoolClient } from "pg";
import {
  PRE_START_MEETING_STATUSES,
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

function clientForStatus(initialStatus: string) {
  let status = initialStatus;
  const queries: QueryLog[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
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

  assert.match(body, /await emTransacao\(async \(client\) =>/);
  assert.match(body, /exigirReuniaoTravada\(client, meetingId\)/);
  assert.match(body, /UPDATE meeting_agenda_items/);
  assert.match(body, /startMeetingWhenAgendaItemCompletes\(client, meetingId, titulo, actor\)/);
});
