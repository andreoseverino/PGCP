import assert from "node:assert/strict";
import { test } from "node:test";
import { classificarErroAgenda } from "./my-calendar-status";

const erro = (status: number, code?: string) => ({ status, code, body: code ? { code } : undefined, message: "AADSTS65001 raw graph text" });

test("ambiente sem Graph configurado (503) não é tratado como falha genérica", () => {
  const e = classificarErroAgenda(erro(503), "pt");
  assert.equal(e.motivo, "nao_configurado");
  assert.equal(e.rotulo, "não configurada neste ambiente");
});

test("consentimento ausente é identificado (dependência do tenant)", () => {
  assert.equal(classificarErroAgenda(erro(403, "consent_required"), "pt").motivo, "sem_autorizacao");
});

test("sessão expirada e falhas gerais têm mensagens próprias", () => {
  assert.equal(classificarErroAgenda(erro(401), "pt").motivo, "sessao");
  assert.equal(classificarErroAgenda(erro(502, "obo_error"), "pt").motivo, "indisponivel");
  assert.equal(classificarErroAgenda(erro(429), "pt").motivo, "indisponivel");
  assert.match(classificarErroAgenda(erro(0), "pt").mensagem, /Sem conexão/);
});

test("nunca repassa texto bruto do Graph", () => {
  for (const e of [erro(503), erro(403, "consent_required"), erro(401), erro(502)]) {
    const r = classificarErroAgenda(e, "pt");
    assert.ok(!/AADSTS|graph text/i.test(r.mensagem + r.rotulo));
  }
});
