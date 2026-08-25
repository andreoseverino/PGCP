import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { createRateLimiter } from "./rate-limit.js";

/**
 * Testes do rate limiting por principal. Cobrem chamada normal, estouro,
 * isolamento entre usuarios, cabecalhos e recuperacao apos a janela.
 *
 * Sem HTTP real: fabricamos req/res minimos e um relogio injetado.
 */

interface FakeResult {
  headers: Record<string, string>;
  statusCode: number | null;
  body: unknown;
  passou: boolean;
}

function rodar(
  middleware: ReturnType<typeof createRateLimiter>,
  principalOid: string | null,
  ip = "10.0.0.1",
): FakeResult {
  const headers: Record<string, string> = {};
  const resultado: FakeResult = { headers, statusCode: null, body: undefined, passou: false };

  const req = {
    method: "GET",
    originalUrl: "/directory/users?q=abc",
    ip,
    principal: principalOid ? { entraObjectId: principalOid } : undefined,
  } as unknown as Request;

  const res = {
    setHeader(nome: string, valor: string) {
      headers[nome] = valor;
    },
    status(codigo: number) {
      resultado.statusCode = codigo;
      return this;
    },
    json(corpo: unknown) {
      resultado.body = corpo;
      return this;
    },
  } as unknown as Response;

  middleware(req, res, () => {
    resultado.passou = true;
  });

  return resultado;
}

test("permite chamadas dentro do limite e conta o restante", () => {
  const limiter = createRateLimiter({ name: "t", windowMs: 1000, max: 3, now: () => 0 });

  const r1 = rodar(limiter, "user-a");
  const r2 = rodar(limiter, "user-a");
  const r3 = rodar(limiter, "user-a");

  assert.equal(r1.passou, true);
  assert.equal(r2.passou, true);
  assert.equal(r3.passou, true);
  assert.equal(r1.headers["RateLimit-Limit"], "3");
  assert.equal(r1.headers["RateLimit-Remaining"], "2");
  assert.equal(r3.headers["RateLimit-Remaining"], "0");
});

test("bloqueia ao exceder com 429, code e Retry-After", () => {
  const limiter = createRateLimiter({ name: "t", windowMs: 1000, max: 2, now: () => 0 });

  rodar(limiter, "user-a");
  rodar(limiter, "user-a");
  const excedeu = rodar(limiter, "user-a");

  assert.equal(excedeu.passou, false);
  assert.equal(excedeu.statusCode, 429);
  assert.deepEqual(excedeu.body, {
    error: "Muitas requisições em pouco tempo. Aguarde alguns instantes e tente novamente.",
    code: "rate_limited",
  });
  assert.ok(excedeu.headers["Retry-After"], "Retry-After presente");
  assert.equal(excedeu.headers["RateLimit-Remaining"], "0");
});

test("isola o limite entre principais diferentes (por oid, nao por IP)", () => {
  const limiter = createRateLimiter({ name: "t", windowMs: 1000, max: 1, now: () => 0 });

  // Mesmo IP, oids diferentes: cada um tem o proprio balde.
  const a1 = rodar(limiter, "user-a", "10.0.0.9");
  const a2 = rodar(limiter, "user-a", "10.0.0.9");
  const b1 = rodar(limiter, "user-b", "10.0.0.9");

  assert.equal(a1.passou, true);
  assert.equal(a2.passou, false, "segundo do user-a e bloqueado");
  assert.equal(b1.passou, true, "user-b nao e afetado pelo user-a");
});

test("recupera depois que a janela expira", () => {
  let clock = 0;
  const limiter = createRateLimiter({ name: "t", windowMs: 1000, max: 1, now: () => clock });

  const primeiro = rodar(limiter, "user-a");
  const bloqueado = rodar(limiter, "user-a");
  assert.equal(primeiro.passou, true);
  assert.equal(bloqueado.passou, false);

  // Avanca o relogio para alem do reset da janela.
  clock = 1001;
  const aposJanela = rodar(limiter, "user-a");
  assert.equal(aposJanela.passou, true, "nova janela permite de novo");
  assert.equal(aposJanela.headers["RateLimit-Remaining"], "0");
});
