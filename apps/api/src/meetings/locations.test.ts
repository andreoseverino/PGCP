import assert from "node:assert/strict";
import { test } from "node:test";
import {
  descreverLocalFisico,
  encontrarLocalFisico,
  lerEnderecosConfigurados,
  listarLocaisFisicos,
  localFisicoExiste,
} from "./locations.js";

test("catálogo tem Sede Matriz e Sede Leopoldo, sem endereço quando não configurado", () => {
  const locais = listarLocaisFisicos(undefined);
  assert.deepEqual(
    locais.map((l) => [l.id, l.name]),
    [
      ["sede-matriz", "Sede Matriz"],
      ["sede-leopoldo", "Sede Leopoldo"],
    ],
  );
  for (const local of locais) {
    assert.equal(local.address, null, "endereço não pode ser inventado");
    assert.equal(local.city, null);
  }
});

test("endereço vem somente da configuração", () => {
  const local = encontrarLocalFisico(
    "sede-leopoldo",
    JSON.stringify({ "sede-leopoldo": { address: "Av. Configurada, 1", city: "X", state: "Y" } }),
  );
  assert.equal(local?.address, "Av. Configurada, 1");
  assert.equal(descreverLocalFisico(local!), "Sede Leopoldo — Av. Configurada, 1, X/Y");
});

test("configuração inválida é ignorada sem derrubar a criação", () => {
  assert.equal(lerEnderecosConfigurados("{nao-e-json").size, 0);
  assert.equal(lerEnderecosConfigurados("[1,2]").size, 0);
  // chave fora do catálogo não cria local novo
  assert.equal(lerEnderecosConfigurados(JSON.stringify({ outra: { address: "x" } })).size, 0);
  // tipo errado e caractere de controle viram null
  const m = lerEnderecosConfigurados(JSON.stringify({ "sede-matriz": { address: 42, city: "a\u0000b" } }));
  assert.equal(m.get("sede-matriz")?.address, null);
  assert.equal(m.get("sede-matriz")?.city, null);
});

test("chave desconhecida não é local válido", () => {
  assert.equal(localFisicoExiste("sede-matriz"), true);
  assert.equal(localFisicoExiste("Rua Qualquer, 123"), false);
  assert.equal(encontrarLocalFisico("inexistente"), null);
});
