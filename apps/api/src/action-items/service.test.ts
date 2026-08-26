import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { ACTION_ITEMS_LIMIT_MAX, parseListFilters } from "./service.js";

/**
 * IDOR / escalacao horizontal na LEITURA de FUP.
 *
 * `parseListFilters` decide o universo visivel de uma consulta. O ataque que
 * ela precisa impedir e simples: mandar na query string um espectador
 * diferente do dono do token e passar a enxergar os FUPs de outra pessoa.
 *
 * A regra que estes testes protegem: `viewer` e `assignedTo` vem SEMPRE do
 * token ja validado. Nenhum parametro da query string os escolhe, os amplia ou
 * os desliga.
 *
 * Funcao pura — sem banco, sem HTTP.
 */

const EU = {
  userId: "11111111-1111-1111-1111-111111111111",
  entraTenantId: "22222222-2222-2222-2222-222222222222",
  entraObjectId: "33333333-3333-3333-3333-333333333333",
};

const OUTRA_PESSOA = {
  userId: "99999999-9999-9999-9999-999999999999",
  entraTenantId: "88888888-8888-8888-8888-888888888888",
  entraObjectId: "77777777-7777-7777-7777-777777777777",
};

test("o espectador e sempre o dono do token", () => {
  assert.deepEqual(parseListFilters({}, EU).viewer, EU);
});

test("query string NAO consegue trocar o espectador por outra pessoa", () => {
  // Cada chave abaixo e uma tentativa plausivel de se passar por outro usuario.
  const hostil = {
    viewer: OUTRA_PESSOA,
    userId: OUTRA_PESSOA.userId,
    entraObjectId: OUTRA_PESSOA.entraObjectId,
    entraTenantId: OUTRA_PESSOA.entraTenantId,
    assignedTo: OUTRA_PESSOA.userId,
    assignedToUserId: OUTRA_PESSOA.userId,
    assigneeUserId: OUTRA_PESSOA.userId,
    actorUserId: OUTRA_PESSOA.userId,
    principal: OUTRA_PESSOA,
  };

  const filtros = parseListFilters(hostil as Record<string, unknown>, EU);

  assert.deepEqual(filtros.viewer, EU, "o espectador continua sendo o do token");
  assert.notDeepEqual(filtros.viewer, OUTRA_PESSOA);
  // Nenhuma dessas chaves pode ter virado filtro de responsavel.
  assert.equal(filtros.assignedTo, undefined);
});

test("assignedToMe se resolve pelo token, nunca por um id recebido", () => {
  const filtros = parseListFilters(
    { assignedToMe: "true", assignedTo: OUTRA_PESSOA.userId } as Record<string, unknown>,
    EU,
  );

  // "me" e quem o token diz que e — mesmo com outro id na query.
  assert.deepEqual(filtros.assignedTo, EU);
  assert.deepEqual(filtros.viewer, EU);
});

test("assignedToMe=false nao vira filtro pela pessoa errada — apenas nao filtra", () => {
  const filtros = parseListFilters({ assignedToMe: "false" }, EU);
  assert.equal(filtros.assignedTo, undefined);
  assert.deepEqual(filtros.viewer, EU, "desligar o filtro nao amplia o universo visivel");
});

test("assignedToMe recusa valor que nao seja 'true' ou 'false'", () => {
  for (const valor of ["1", "yes", "TRUE", "sim"]) {
    assert.throws(
      () => parseListFilters({ assignedToMe: valor }, EU),
      HttpError,
      `assignedToMe=${JSON.stringify(valor)} deveria ser recusado`,
    );
  }
});

test("assignedToMe vazio conta como nao informado e falha FECHADO", () => {
  // `?assignedToMe=` chega como string vazia e e tratado como ausencia. O que
  // importa para seguranca e que isso NAO atribui o filtro a ninguem: o
  // universo continua recortado pelo `viewer` do token.
  const filtros = parseListFilters({ assignedToMe: "   " }, EU);
  assert.equal(filtros.assignedTo, undefined);
  assert.deepEqual(filtros.viewer, EU);
});

test("parametro repetido (array) e recusado, nao silenciosamente coagido", () => {
  // Query string aceita `?status=open&status=completed`, que chega como array.
  // Coagir para string esconderia a ambiguidade em vez de recusa-la.
  for (const campo of ["status", "meetingId", "assignedToMe", "overdue", "limit"]) {
    assert.throws(
      () => parseListFilters({ [campo]: ["a", "b"] }, EU),
      HttpError,
      `${campo} repetido deveria ser recusado`,
    );
  }
});

test("meetingId malformado responde 400, sem chegar ao banco", () => {
  // Recusar cedo evita que texto arbitrario alcance a consulta.
  for (const id of ["nao-e-uuid", "1 OR 1=1", "../../etc/passwd", "%00"]) {
    const erro = (() => {
      try {
        parseListFilters({ meetingId: id }, EU);
        return null;
      } catch (e) {
        return e;
      }
    })();
    assert.ok(erro instanceof HttpError, `${id} deveria lancar HttpError`);
    assert.equal(erro.status, 400, `${id} deveria ser 400`);
  }
});

test("status aceita apenas o vocabulario do dominio", () => {
  assert.equal(parseListFilters({ status: "open" }, EU).status, "open");
  assert.equal(parseListFilters({ status: "completed" }, EU).status, "completed");
  assert.equal(parseListFilters({ status: "cancelled" }, EU).status, "cancelled");
  for (const invalido of ["deleted", "OPEN", "aberto", "'; DROP TABLE action_items; --"]) {
    assert.throws(() => parseListFilters({ status: invalido }, EU), HttpError);
  }
});

test("limit tem teto: nao da para pedir a base inteira numa consulta", () => {
  assert.equal(parseListFilters({ limit: "10" }, EU).limit, 10);
  assert.equal(parseListFilters({ limit: String(ACTION_ITEMS_LIMIT_MAX) }, EU).limit, ACTION_ITEMS_LIMIT_MAX);

  for (const excessivo of [String(ACTION_ITEMS_LIMIT_MAX + 1), "999999", "0", "-1", "1.5", "abc", "1e9"]) {
    assert.throws(
      () => parseListFilters({ limit: excessivo }, EU),
      HttpError,
      `limit=${excessivo} deveria ser recusado`,
    );
  }
});

test("sem filtros, o limite padrao ja e aplicado", () => {
  const filtros = parseListFilters({}, EU);
  assert.ok(filtros.limit > 0 && filtros.limit <= ACTION_ITEMS_LIMIT_MAX);
});
