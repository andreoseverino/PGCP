import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { marcarReuniaoPreparada } from "./service.js";

/**
 * MARCA "PREPARADA" (043): só sinalização. Os testes garantem que ela não
 * vira estado de fluxo — sem versão, sem convite, sem status.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const ator = { userId: ID, name: "Teste", entraTenantId: ID };

const semComentarios = (f: string) =>
  readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("marca preparada: só sinalização — sem versão, convite, status ou e-mail", () => {
  const fonte = semComentarios("./service.ts");
  const corpo = fonte.slice(
    fonte.indexOf("export async function marcarReuniaoPreparada"),
    fonte.indexOf("export async function desassociarReuniao"),
  );
  assert.ok(corpo.length > 0);
  assert.ok(!/versionarReuniao|syncMeetingCalendar|sendMail|status\s*=/.test(corpo), "nada de fluxo");
  assert.match(corpo, /m\.annual_agenda_id = \$2 AND m\.cancelled_at IS NULL FOR UPDATE OF m/, "pertença + não cancelada");
  assert.ok(!/exigirEditavel/.test(corpo), "vale também com a Agenda aprovada");
  const rotas = semComentarios("./routes.ts");
  assert.match(rotas, /put\("\/:id\/meetings\/:meetingId\/prepared", requirePgcpAssessoria,/);
});

let semBanco: string | false = false;
try {
  await pool.query("SELECT 1");
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

test("marca preparada: corpo validado antes do banco; agenda inexistente = 404", { skip: semBanco }, async () => {
  for (const valor of [undefined, "sim", 1, null]) {
    await assert.rejects(marcarReuniaoPreparada(ID, ID, valor, ator), (e) => e instanceof HttpError && e.status === 400);
  }
  await assert.rejects(marcarReuniaoPreparada(ID, ID, true, ator), (e) => e instanceof HttpError && e.status === 404);
});

test("043: desmarcada não pode ter autor (CHECK)", { skip: semBanco }, async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; u: string }>(
      "SELECT m.id, (SELECT id FROM users LIMIT 1) AS u FROM meetings m WHERE m.cancelled_at IS NULL LIMIT 1",
    );
    if (!rows[0]?.u) return;
    await assert.rejects(
      client.query("UPDATE meetings SET prepared_at = NULL, prepared_by_user_id = $2 WHERE id = $1", [rows[0].id, rows[0].u]),
      /meetings_prepared_check/,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});
