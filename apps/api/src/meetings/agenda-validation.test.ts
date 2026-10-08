import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { reabrirValidacaoSePreReuniao } from "./agenda-validation.js";

/**
 * Regra de integridade da validação (opção B): alteração ESTRUTURAL de pauta
 * reabre a validação (sent/approved -> draft) SÓ antes de a reunião começar.
 *
 * Testado com um client de mentira que captura as queries — sem banco, sem rede.
 * Confere as duas coisas que importam: quando reabre e o que grava (respeitando
 * o CHECK de coerência da migration 016: draft exige sent_at e approved_at nulos).
 */

interface QueryRegistrada {
  sql: string;
  params: unknown[];
}

function clientDeMentira(linhaMeeting: Record<string, unknown> | null) {
  const queries: QueryRegistrada[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/FROM meetings WHERE id = \$1 FOR UPDATE/s.test(sql)) {
        return { rows: linhaMeeting ? [linhaMeeting] : [], rowCount: linhaMeeting ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, queries };
}

const ATOR = { userId: "11111111-1111-1111-1111-111111111111", name: "Secretaria" };

const reabriu = (queries: QueryRegistrada[]) =>
  queries.some((q) => /UPDATE meetings\s+SET agenda_validation_status = 'draft'/s.test(q.sql));
const gravouAudit = (queries: QueryRegistrada[]) =>
  queries.some((q) => /INSERT INTO audit_logs/s.test(q.sql));

test("reabre quando pré-reunião e validação enviada (sent -> draft)", async () => {
  const { client, queries } = clientDeMentira({
    title: "R", status: "scheduled", agenda_validation_status: "sent",
  });
  const r = await reabrirValidacaoSePreReuniao(client, "22222222-2222-2222-2222-222222222222", ATOR);
  assert.equal(r, true);
  assert.ok(reabriu(queries), "deveria emitir UPDATE para draft");
  assert.ok(gravouAudit(queries), "deveria registrar auditoria da reabertura");
  // Respeita o CHECK 016: zera timestamps/metadados.
  const upd = queries.find((q) => /UPDATE meetings/s.test(q.sql))!;
  assert.ok(/agenda_validation_sent_at = NULL/s.test(upd.sql));
  assert.ok(/agenda_approved_at = NULL/s.test(upd.sql));
});

test("reabre quando pré-reunião e validação aprovada (approved -> draft)", async () => {
  const { client, queries } = clientDeMentira({
    title: "R", status: "scheduled", agenda_validation_status: "approved",
  });
  assert.equal(await reabrirValidacaoSePreReuniao(client, "22222222-2222-2222-2222-222222222222", ATOR), true);
  assert.ok(reabriu(queries));
});

test("NÃO reabre em draft (já é o destino)", async () => {
  const { client, queries } = clientDeMentira({
    title: "R", status: "scheduled", agenda_validation_status: "draft",
  });
  assert.equal(await reabrirValidacaoSePreReuniao(client, "22222222-2222-2222-2222-222222222222", ATOR), false);
  assert.ok(!reabriu(queries));
});

test("NÃO reabre durante/depois da reunião, mesmo aprovada", async () => {
  for (const status of ["in_progress", "done", "closed"]) {
    const { client, queries } = clientDeMentira({
      title: "R", status, agenda_validation_status: "approved",
    });
    assert.equal(
      await reabrirValidacaoSePreReuniao(client, "22222222-2222-2222-2222-222222222222", ATOR),
      false,
      `status ${status} não deveria reabrir`,
    );
    assert.ok(!reabriu(queries), `status ${status} não deveria emitir UPDATE`);
  }
});

test("NÃO reabre reunião inexistente", async () => {
  const { client, queries } = clientDeMentira(null);
  assert.equal(await reabrirValidacaoSePreReuniao(client, "22222222-2222-2222-2222-222222222222", ATOR), false);
  assert.ok(!reabriu(queries));
});

test("pautas: aprovação DIRETA (sem e-mail) — aprova a partir do rascunho; envio por e-mail responde 410", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("./agenda-validation.ts", import.meta.url), "utf8");
  const aprovar = fonte.slice(fonte.indexOf("export async function aprovarPautas"), fonte.indexOf("export async function reabrirValidacaoSePreReuniao"));
  assert.ok(!/!== "sent"/.test(aprovar), "rascunho também aprova");
  const { meetingsRouter } = await import("./routes.js");
  const pilha = (meetingsRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
  }).stack;
  const rota = pilha.find((c) => c.route?.path === "/:id/agenda-validation" && c.route.methods.post)?.route;
  assert.ok(rota);
  let codigo = 0;
  let corpo: { code?: string } = {};
  const res = { status(c: number) { codigo = c; return this; }, json(b: { code?: string }) { corpo = b; return this; } };
  rota.stack.at(-1)!.handle({}, res);
  assert.equal(codigo, 410);
  assert.equal(corpo.code, "agenda_validation_email_removed");
});
