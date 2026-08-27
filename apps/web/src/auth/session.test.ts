import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionUser } from "./session.js";

/**
 * Regressão da PERDA DE APP ROLES após inatividade/reload.
 *
 * Causa raiz: a leitura da sessão descartava `appRoles`. Num remount (reload ou
 * aba descartada pelo navegador), o usuário voltava autenticado porém SEM papel.
 * Estes testes fixam o contrato: `parseSessionUser` RESTAURA `appRoles`.
 *
 * `PGCP.Assessoria`/`PGCP.Admin` são os App Roles reais (espelham o backend);
 * usados aqui só como literais para provar que o gate de UI voltaria a valer.
 */
const ASSESSORIA = "PGCP.Assessoria";
const ADMIN = "PGCP.Admin";

test("restaura appRoles do Admin — Admin continua Admin após remount", () => {
  const saved = JSON.stringify({ name: "Ana", role: "Diretora", appRoles: [ADMIN] });
  const u = parseSessionUser(saved);
  assert.ok(u, "sessão válida não pode virar null");
  assert.deepEqual(u!.appRoles, [ADMIN]);
  assert.equal(u!.appRoles?.includes(ADMIN), true);
});

test("restaura appRoles da Assessoria — permanece após remount", () => {
  const u = parseSessionUser(JSON.stringify({ name: "Bruno", role: "Assessor", appRoles: [ASSESSORIA] }));
  assert.equal(u?.appRoles?.includes(ASSESSORIA), true);
});

test("preserva múltiplos papéis", () => {
  const u = parseSessionUser(JSON.stringify({ name: "C", role: "x", appRoles: [ASSESSORIA, ADMIN] }));
  assert.deepEqual(u?.appRoles, [ASSESSORIA, ADMIN]);
});

test("round-trip do que a sessão grava é restaurado com os papéis", () => {
  // Simula exatamente o `startSession`: grava o usuário e relê no remount.
  const gravado = JSON.stringify({ name: "Dora", role: "Secretária", appRoles: [ASSESSORIA] });
  const relido = parseSessionUser(gravado);
  assert.equal(relido?.appRoles?.includes(ASSESSORIA), true);
});

test("usuário sem papel NÃO ganha papel (sem escalonamento)", () => {
  const semRoles = parseSessionUser(JSON.stringify({ name: "E", role: "Membro" }));
  assert.ok(semRoles);
  assert.equal(semRoles!.appRoles, undefined);
  assert.equal(semRoles!.appRoles?.includes(ASSESSORIA) ?? false, false);

  const arrayVazio = parseSessionUser(JSON.stringify({ name: "E", role: "Membro", appRoles: [] }));
  assert.deepEqual(arrayVazio!.appRoles, []);
});

test("appRoles com formato inválido é ignorado (não injeta papel)", () => {
  // String em vez de array, e array com itens não-string: nada de papel forjado.
  assert.equal(parseSessionUser(JSON.stringify({ name: "F", role: "x", appRoles: "PGCP.Admin" }))!.appRoles, undefined);
  assert.deepEqual(
    parseSessionUser(JSON.stringify({ name: "G", role: "x", appRoles: [ADMIN, 1, null, { a: 1 }] }))!.appRoles,
    [ADMIN],
  );
});

test("sessão ausente ou corrompida vira null (chamador aplica o padrão)", () => {
  assert.equal(parseSessionUser(null), null);
  assert.equal(parseSessionUser(""), null);
  assert.equal(parseSessionUser("{não é json"), null);
  assert.equal(parseSessionUser(JSON.stringify({ name: "", role: "" })), null);
  assert.equal(parseSessionUser(JSON.stringify({ role: "x" })), null); // sem name
});
