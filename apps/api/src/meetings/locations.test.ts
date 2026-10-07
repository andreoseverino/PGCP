import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  descreverLocalFisico,
  enderecoDoLocal,
  formatarCep,
  lerLocalDaReuniao,
  type LocalFisico,
} from "./locations.js";

const COMPLETO: LocalFisico = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Sede Centro",
  street: "Av. Paulista",
  number: "1000",
  complement: "10º andar",
  neighborhood: "Bela Vista",
  city: "São Paulo",
  state: "SP",
  postalCode: "01310100",
};

test("cópia do local: endereço completo em uma linha, CEP formatado", () => {
  assert.equal(
    descreverLocalFisico(COMPLETO),
    "Sede Centro — Av. Paulista, 1000, 10º andar — Bela Vista, São Paulo/SP, CEP 01310-100",
  );
  assert.equal(formatarCep("01310100"), "01310-100");
  assert.equal(formatarCep(null), null);
});

test("só o que existe: opcionais ausentes não viram texto, local sem endereço leva só o nome", () => {
  const minimo = { ...COMPLETO, complement: null, neighborhood: null };
  assert.equal(enderecoDoLocal(minimo), "Av. Paulista, 1000 — São Paulo/SP, CEP 01310-100");
  const importado = lerLocalDaReuniao({ id: COMPLETO.id, name: "Sede Matriz" })!;
  assert.equal(descreverLocalFisico(importado), "Sede Matriz");
  assert.equal(enderecoDoLocal(importado), null);
});

test("leitura defensiva da cópia gravada (jsonb)", () => {
  assert.equal(lerLocalDaReuniao(null), null);
  assert.equal(lerLocalDaReuniao("Sede"), null);
  assert.equal(lerLocalDaReuniao([]), null);
  assert.equal(lerLocalDaReuniao({ name: "Sem id" }), null);
  const lido = lerLocalDaReuniao({ ...COMPLETO, street: 42, extra: "<script>" })!;
  assert.equal(lido.street, null, "tipo errado vira null");
  assert.ok(!("extra" in lido), "campos fora do formato não passam");
});

test("catálogo fixo e variável de ambiente da 025 deixaram de existir", () => {
  const fonte = readFileSync(new URL("./locations.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(!/sede-matriz|sede-leopoldo|process\.env/.test(fonte));
});
