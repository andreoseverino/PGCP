import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PhysicalLocation } from "../types";
import {
  LOCAL_VAZIO,
  enderecoCompleto,
  formatarCep,
  locationLabel,
  opcoesDeLocal,
  paraPayload,
  rotuloDaOpcao,
  validateMeetingLocation,
  type MeetingLocation
} from "./meeting-locations-rules";

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const local = (id: string, name: string, extra: Partial<PhysicalLocation> = {}): PhysicalLocation => ({
  id,
  name,
  street: "Av. Paulista",
  number: "1000",
  complement: null,
  neighborhood: null,
  city: "São Paulo",
  state: "SP",
  postalCode: "01310100",
  ...extra
});

test("Locais: validação espelha a API (obrigatórios, UF, CEP sem consulta externa)", () => {
  const ok = { ...LOCAL_VAZIO, name: "Sede", street: "Av. Paulista", number: "1000", city: "São Paulo", state: "SP", postalCode: "01310-100" };
  assert.equal(validateMeetingLocation(ok, "pt"), null);
  for (const campo of ["name", "street", "number", "city", "state", "postalCode"] as const) {
    assert.ok(validateMeetingLocation({ ...ok, [campo]: "" }, "pt"), campo);
  }
  assert.ok(validateMeetingLocation({ ...ok, state: "XX" }, "pt"));
  assert.ok(validateMeetingLocation({ ...ok, postalCode: "1310-100" }, "pt"));
  assert.equal(validateMeetingLocation({ ...ok, postalCode: "01310100", state: "sp" }, "pt"), null);
});

test("Locais: rótulos distinguem nomes parecidos; endereço só com o que existe", () => {
  const a = local("a", "Sede Centro");
  const b = local("b", "Sede Centro", { street: "Rua Augusta", number: "50", city: "Campinas" });
  assert.notEqual(rotuloDaOpcao(a), rotuloDaOpcao(b));
  assert.equal(rotuloDaOpcao(a), "Sede Centro — Av. Paulista, 1000 · São Paulo/SP");
  assert.equal(enderecoCompleto(a), "Av. Paulista, 1000 — São Paulo/SP, CEP 01310-100");
  const importado = local("c", "Sede Matriz", { street: null, number: null, city: null, state: null, postalCode: null });
  assert.equal(locationLabel(importado), "Sede Matriz");
  assert.equal(formatarCep("01310100"), "01310-100");
});

test("Locais: seletor mostra só ATIVOS + o local atual da reunião (marcado) quando inativo", () => {
  const ativos = [local("a", "A"), local("b", "B")];
  assert.deepEqual(opcoesDeLocal(ativos, null).map((o) => [o.local.id, o.atual]), [["a", false], ["b", false]]);
  assert.deepEqual(opcoesDeLocal(ativos, ativos[0]).map((o) => o.local.id), ["a", "b"], "sem duplicar");
  const inativo = local("x", "Antigo");
  assert.deepEqual(opcoesDeLocal(ativos, inativo).map((o) => [o.local.id, o.atual]), [["x", true], ["a", false], ["b", false]]);
});

test("Locais: formulário de edição volta com CEP formatado e opcionais vazios", () => {
  const l: MeetingLocation = { ...local("a", "A"), notes: null, isActive: true, meetingsCount: 0, createdAt: "", updatedAt: "" };
  assert.deepEqual(paraPayload(l), {
    name: "A", street: "Av. Paulista", number: "1000", complement: "", neighborhood: "",
    city: "São Paulo", state: "SP", postalCode: "01310-100", notes: ""
  });
});

test("Locais (tela): aba após Participantes; sem exclusão; ativar/inativar; texto sem HTML cru", () => {
  const admin = codigo("../components/AdministrationView.tsx");
  assert.ok(admin.indexOf('"Participantes"') < admin.indexOf('"Locais"'), "Locais depois de Participantes");
  assert.match(admin, /<LocationsPanel language=\{language\} \/>/);
  const tela = codigo("../components/LocationsPanel.tsx");
  assert.ok(!/delete|Trash2|Excluir|Remover/i.test(tela), "sem exclusão física");
  assert.match(tela, /setMeetingLocationActive\(l\.id, !l\.isActive\)/);
  assert.ok(!/dangerouslySetInnerHTML|<iframe|maps\.google|viacep|geocod/i.test(tela), "sem mapa nem API de CEP");
  for (const rotulo of ['"Nome"', '"Endereço"', '"Cidade/UF"', '"Ativo"', '"Inativo"', '"Editar"', '"Inativar"', '"Ativar"']) {
    assert.ok(tela.includes(rotulo), rotulo);
  }
});

test("Locais (cliente): rotas do cadastro; agendamento usa id, nunca chave do catálogo antigo", () => {
  const cliente = codigo("./meeting-locations.ts");
  assert.match(cliente, /"\/meeting-locations"/);
  assert.match(cliente, /\/status`, json\("PUT", \{ isActive \}\)/);
  const campos = codigo("../components/MeetingInviteFields.tsx");
  assert.match(campos, /opcoesDeLocal\(ativos, currentLocation\)/);
  assert.ok(!/sede-matriz|sede-leopoldo|physicalLocationKey/.test(campos));
  assert.ok(!/physicalLocationKey/.test(codigo("./new-meeting.ts") + codigo("./edit-meeting.ts") + codigo("./meetings.ts")));
});
