import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exigirLiberadaParaPipeline, liberadaParaPipeline, MSG_EM_PREPARACAO_NA_AGENDA } from "./pipeline-release.js";

const ID = "11111111-1111-4111-8111-111111111111";

async function chamar(status: string | null, method: string, path: string, id = ID) {
  const guarda = exigirLiberadaParaPipeline(async () => status);
  let codigo = 0;
  let corpo: unknown = null;
  let seguiu = false;
  const res = {
    status(c: number) {
      codigo = c;
      return this;
    },
    json(b: unknown) {
      corpo = b;
      return this;
    },
  };
  await guarda({ method, path, params: { id } } as never, res as never, () => {
    seguiu = true;
  });
  return { codigo, corpo, seguiu };
}

test("liberação: avulsa e aprovada operam no Pipeline; em elaboração/enviada não", () => {
  assert.equal(liberadaParaPipeline(null), true, "reunião sem Agenda Anual");
  assert.equal(liberadaParaPipeline("approved"), true);
  assert.equal(liberadaParaPipeline("draft"), false);
  assert.equal(liberadaParaPipeline("pending_approval"), false);
});

test("guarda do /meetings: mutação antes da aprovação → 409 com mensagem de negócio", async () => {
  for (const [method, path] of [["PATCH", "/"], ["POST", "/agenda-items"], ["DELETE", "/participants/x"], ["PUT", "/minutes"], ["POST", "/agenda-approval"], ["DELETE", "/"]]) {
    for (const status of ["draft", "pending_approval"]) {
      const r = await chamar(status, method!, path!);
      assert.equal(r.codigo, 409, `${method} ${path} (${status})`);
      assert.deepEqual(r.corpo, { error: MSG_EM_PREPARACAO_NA_AGENDA, code: "annual_agenda_not_approved" });
      assert.equal(r.seguiu, false);
    }
  }
  assert.ok(!/id|uuid|annual_agenda_id|SQL/i.test(MSG_EM_PREPARACAO_NA_AGENDA), "sem detalhe técnico");
});

test("guarda: leitura, convite de calendário, avulsa e aprovada seguem; id inválido vai para a rota", async () => {
  assert.equal((await chamar("draft", "GET", "/")).seguiu, true, "leitura do detalhe");
  assert.equal((await chamar("draft", "GET", "/minutes/pdf")).seguiu, true);
  assert.equal((await chamar("draft", "POST", "/calendar-sync")).seguiu, true, "convite sai no agendamento (025)");
  assert.equal((await chamar(null, "PATCH", "/")).seguiu, true, "reunião avulsa");
  assert.equal((await chamar("approved", "POST", "/agenda-items")).seguiu, true, "aprovada: Pipeline opera");
  assert.equal((await chamar("draft", "PATCH", "/", "nao-e-uuid")).seguiu, true, "400 continua com a rota");
});

test("guarda montada ANTES das rotas de /meetings; a Agenda Anual edita por rotas próprias", () => {
  const rotas = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  const guarda = rotas.indexOf('meetingsRouter.use("/:id", exigirLiberadaParaPipeline())');
  const primeiraRota = rotas.search(/meetingsRouter\.(get|post|patch|put|delete)\(/);
  assert.ok(guarda > 0 && guarda < primeiraRota, "vale para todas as rotas do router");
  // A Agenda não passa pelo router /meetings: chama as funções dentro da própria transação.
  const agenda = readFileSync(new URL("../annual-agendas/routes.ts", import.meta.url), "utf8");
  assert.ok(!/meetingsRouter|meetings\/routes/.test(agenda));
  assert.match(agenda, /post\("\/:id\/meetings\/:meetingId\/participants", requirePgcpAssessoria, conteudo\(/);
  assert.match(agenda, /delete\("\/:id\/meetings\/:meetingId\/participants\/:participantId", requirePgcpAssessoria, conteudo\(/);
  // Listagem: a decisão vem do servidor.
  const servico = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  assert.match(servico, /releasedToPipeline: liberadaParaPipeline\(row\.annual_agenda_status\)/);
});
