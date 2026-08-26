import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { PGCP_ADMIN, PGCP_ASSESSORIA, hasAppRole } from "./app-roles.js";

/**
 * Testes da decisao de APP ROLE.
 *
 * `hasAppRole` e o unico ponto onde o PGCP decide se uma pessoa tem um papel.
 * Testa-lo direto cobre a regra sem precisar de token, banco ou HTTP — o resto
 * da cadeia (`requireAppRole` -> `requireActivePgcpUser` -> `requireEntraAuth`)
 * apenas encaminha o resultado desta funcao.
 *
 * A FIACAO dos papeis nas rotas (qual rota exige qual papel) e coberta em
 * `route-guards.test.ts`.
 *
 * Regra que estes testes protegem: o papel vem do claim `roles`, assinado pelo
 * Entra, e a comparacao e por IGUALDADE EXATA. Nada de prefixo, sufixo,
 * `startsWith`, `includes` de substring ou normalizacao de caixa — qualquer uma
 * dessas coisas transformaria um papel inventado em acesso real.
 */

/** Requisicao minima com os papeis que o token trouxe. */
function req(appRoles: string[] | undefined): Request {
  return { principal: appRoles === undefined ? undefined : { appRoles } } as unknown as Request;
}

test("concede quando o papel esta presente, exatamente como escrito", () => {
  assert.equal(hasAppRole(req([PGCP_ASSESSORIA]), PGCP_ASSESSORIA), true);
  assert.equal(hasAppRole(req([PGCP_ADMIN]), PGCP_ADMIN), true);
  assert.equal(hasAppRole(req([PGCP_ADMIN, PGCP_ASSESSORIA]), PGCP_ASSESSORIA), true);
});

test("nega sem papel, sem principal e com lista vazia", () => {
  // Autenticar NAO e autorizar: um token perfeitamente valido de alguem sem
  // papel nenhum nao pode abrir uma operacao que exige papel.
  assert.equal(hasAppRole(req([]), PGCP_ASSESSORIA), false);
  assert.equal(hasAppRole(req(undefined), PGCP_ASSESSORIA), false);
  assert.equal(hasAppRole(req(undefined), PGCP_ADMIN), false);
});

test("as duas roles sao INDEPENDENTES — nenhuma implica a outra", () => {
  // Nao existe hierarquia no codigo. Quem precisa das duas capacidades recebe
  // as DUAS atribuicoes no Entra.
  assert.equal(hasAppRole(req([PGCP_ADMIN]), PGCP_ASSESSORIA), false, "Admin nao implica Assessoria");
  assert.equal(hasAppRole(req([PGCP_ASSESSORIA]), PGCP_ADMIN), false, "Assessoria nao implica Admin");
});

test("papel desconhecido nao concede nada, por mais convincente que pareca", () => {
  for (const inventado of ["PGCP.SuperUser", "PGCP.Owner", "Global.Administrator", "admin"]) {
    assert.equal(hasAppRole(req([inventado]), PGCP_ADMIN), false, `${inventado} nao pode virar Admin`);
    assert.equal(
      hasAppRole(req([inventado]), PGCP_ASSESSORIA),
      false,
      `${inventado} nao pode virar Assessoria`,
    );
  }
});

test("prefixo, sufixo e substring NAO satisfazem o papel", () => {
  // Se a comparacao usasse startsWith/includes, qualquer um destes abriria a
  // porta. A igualdade exata e o que impede isso.
  for (const parecido of [
    "PGCP.Admin.Extra",
    "PGCP.Administrator",
    "PGCP.AdminReadOnly",
    "Nao.PGCP.Admin",
    "Admin",
    "PGCP.Admi",
    " PGCP.Admin",
    "PGCP.Admin ",
  ]) {
    assert.equal(hasAppRole(req([parecido]), PGCP_ADMIN), false, `"${parecido}" nao e PGCP.Admin`);
  }

  for (const parecido of ["PGCP.Assessoria.Junior", "PGCP.AssessoriaPlena", "Assessoria"]) {
    assert.equal(
      hasAppRole(req([parecido]), PGCP_ASSESSORIA),
      false,
      `"${parecido}" nao e PGCP.Assessoria`,
    );
  }
});

test("a comparacao diferencia CAIXA", () => {
  for (const caixa of ["pgcp.admin", "PGCP.ADMIN", "Pgcp.Admin"]) {
    assert.equal(hasAppRole(req([caixa]), PGCP_ADMIN), false, `"${caixa}" nao e PGCP.Admin`);
  }
});

test("um papel legitimo continua valendo no meio de papeis irrelevantes", () => {
  const roles = ["Outro.App.Role", "PGCP.SuperUser", PGCP_ASSESSORIA, "mais.uma"];
  assert.equal(hasAppRole(req(roles), PGCP_ASSESSORIA), true);
  assert.equal(hasAppRole(req(roles), PGCP_ADMIN), false);
});

test("os valores das roles sao os do manifesto do App Registration", () => {
  // Estes literais precisam bater com o `value` do App Role no Entra. Mudar um
  // deles aqui sem mudar no manifesto tira o acesso de todo mundo em producao.
  assert.equal(PGCP_ASSESSORIA, "PGCP.Assessoria");
  assert.equal(PGCP_ADMIN, "PGCP.Admin");
});
