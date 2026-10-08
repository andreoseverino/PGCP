import "../env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { exportarReunioesDoTema, listarReunioesDoTema, parseFiltrosDaExportacaoDoTema } from "./linked-meetings.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const espectador = { userId: ID, entraTenantId: ID, entraObjectId: null };

test("parse: formato obrigatório, query fechada, meetingIds validados e deduplicados", () => {
  assert.deepEqual(parseFiltrosDaExportacaoDoTema({ format: "pdf" }), { formato: "pdf" });
  assert.deepEqual(parseFiltrosDaExportacaoDoTema({ format: "xlsx", meetingIds: `${ID}, ${ID2},${ID}` }), {
    formato: "xlsx",
    meetingIds: [ID, ID2],
  });
  for (const query of [
    {},
    { format: "csv" },
    { format: "pdf", extra: "1" },
    { format: "pdf", meetingIds: "" },
    { format: "pdf", meetingIds: "abc" },
    { format: "pdf", meetingIds: `${ID},1 OR 1=1` },
    { format: "pdf", meetingIds: [ID] },
  ]) {
    assert.throws(() => parseFiltrosDaExportacaoDoTema(query), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(query));
  }
});

let semBanco: string | false = false;
try {
  await pool.query("SELECT 1");
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

test("integração: lista uma linha por reunião do tema e exporta só a seleção", { skip: semBanco }, async () => {
  await assert.rejects(listarReunioesDoTema(ID, espectador), (e) => e instanceof HttpError && e.status === 404);

  // Tema com mais reuniões vinculadas na base real (baseline com dado real).
  const { rows } = await pool.query<{ id: string; n: number }>(
    `SELECT agenda_topic_id AS id, count(DISTINCT meeting_id)::int AS n
       FROM meeting_agenda_items WHERE agenda_topic_id IS NOT NULL
      GROUP BY agenda_topic_id ORDER BY n DESC LIMIT 1`,
  );
  if (!rows[0]) return;
  const { id, n } = rows[0];

  const lista = await listarReunioesDoTema(id, espectador);
  assert.equal(lista.length, n, "todas as reuniões, inclusive canceladas e passadas");
  assert.equal(new Set(lista.map((r) => r.meetingId)).size, n, "sem repetição de reunião");
  for (let i = 1; i < lista.length; i++) assert.ok(lista[i - 1]!.startAt >= lista[i]!.startAt, "mais recente primeiro");

  const tudo = await exportarReunioesDoTema(id, { formato: "xlsx" }, espectador);
  assert.match(tudo.nome, /^reunioes-do-tema-.*\.xlsx$/);
  assert.ok(tudo.conteudo.length > 0);

  const pdf = await exportarReunioesDoTema(id, { formato: "pdf", meetingIds: [lista[0]!.meetingId] }, espectador);
  assert.equal(pdf.conteudo.subarray(0, 4).toString(), "%PDF");

  // Reunião que não é do tema não entra, mesmo pedida.
  const { rows: outra } = await pool.query<{ id: string }>(
    `SELECT m.id FROM meetings m
      WHERE NOT EXISTS (SELECT 1 FROM meeting_agenda_items ai WHERE ai.meeting_id = m.id AND ai.agenda_topic_id = $1)
      LIMIT 1`,
    [id],
  );
  if (outra[0]) {
    const { consultarReunioesParaExportacao } = await import("../meetings/export.js");
    const r = await consultarReunioesParaExportacao(
      { formato: "pdf", agendaTopicId: id, meetingIds: [outra[0].id, lista[0]!.meetingId] },
      espectador,
    );
    assert.deepEqual(r.map((x) => x.id), [lista[0]!.meetingId]);
  }
});
