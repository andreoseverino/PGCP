import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { parseAgendaItemInput, parseCreateInput } from "./create.js";
import { parseAgendaItemPatch, parseUpdateInput, resolverModalidadeDoPatch } from "./update.js";
import { parseAgendaInput } from "./agendas.js";

/**
 * Agendamento simples (025): modalidade, local físico, e Reunião -> Pauta -> Tema.
 * Funções puras — sem banco e sem rede.
 */

const corpo = (extra: Record<string, unknown> = {}) => ({
  governanceBodyId: "11111111-1111-1111-1111-111111111111",
  title: "Comitê Executivo",
  startAt: "2027-01-20T12:00:00Z",
  endAt: "2027-01-20T14:00:00Z",
  timezone: "America/Sao_Paulo",
  participants: [],
  ...extra,
});

// --- criação sem pauta/tema ---------------------------------------------------

test("criação sem pautas nem temas é válida", () => {
  const input = parseCreateInput(corpo());
  assert.deepEqual(input.agendaItems, []);
  assert.equal(input.modality, "online");
});

test("criação online: sem local físico obrigatório", () => {
  const input = parseCreateInput(corpo({ modality: "online" }));
  assert.equal(input.modality, "online");
  assert.equal(input.physicalLocationKey, undefined);
});

test("criação presencial exige local físico", () => {
  assert.throws(() => parseCreateInput(corpo({ modality: "in_person" })), HttpError);
  const input = parseCreateInput(corpo({ modality: "in_person", physicalLocationKey: "sede-matriz" }));
  assert.equal(input.modality, "in_person");
  assert.equal(input.physicalLocationKey, "sede-matriz");
});

test("local físico só do catálogo — endereço livre é recusado", () => {
  assert.throws(
    () => parseCreateInput(corpo({ modality: "in_person", physicalLocationKey: "Rua Inventada, 1" })),
    HttpError,
  );
});

test("online com local físico é recusado (não descartado em silêncio)", () => {
  assert.throws(
    () => parseCreateInput(corpo({ modality: "online", physicalLocationKey: "sede-matriz" })),
    HttpError,
  );
});

test("não existe modalidade híbrida", () => {
  assert.throws(() => parseCreateInput(corpo({ modality: "hybrid" })), HttpError);
  assert.throws(() => parseCreateInput(corpo({ modality: "hibrida" })), HttpError);
});

test("origem da reunião não vem do corpo (mass assignment)", () => {
  // `origin`/`annualAgendaId` não existem no contrato: são ignorados, nunca
  // viram dado — quem define a origem é o servidor.
  const input = parseCreateInput(corpo({ origin: "annual_agenda", annualAgendaId: "x" })) as unknown as Record<string, unknown>;
  assert.equal(input.origin, undefined);
  assert.equal(input.annualAgendaId, undefined);
});

// --- PATCH de modalidade ------------------------------------------------------

test("PATCH aceita modalidade/local e recusa local fora do catálogo", () => {
  assert.deepEqual(parseUpdateInput({ modality: "in_person", physicalLocationKey: "sede-leopoldo" }), {
    modality: "in_person",
    physicalLocationKey: "sede-leopoldo",
  });
  assert.throws(() => parseUpdateInput({ physicalLocationKey: "qualquer" }), HttpError);
  assert.throws(() => parseUpdateInput({ modality: "hybrid" }), HttpError);
});

test("PATCH: trocar para online limpa o local; presencial sem local é recusado", () => {
  assert.deepEqual(
    resolverModalidadeDoPatch({ modality: "in_person", physicalLocationKey: "sede-matriz" }, { modality: "online" }),
    { modality: "online", physicalLocationKey: null },
  );
  assert.throws(
    () => resolverModalidadeDoPatch({ modality: "online", physicalLocationKey: null }, { modality: "in_person" }),
    HttpError,
  );
  assert.deepEqual(
    resolverModalidadeDoPatch({ modality: "in_person", physicalLocationKey: "sede-matriz" }, { physicalLocationKey: "sede-leopoldo" }),
    { modality: "in_person", physicalLocationKey: "sede-leopoldo" },
  );
});

// --- Pauta -> Tema --------------------------------------------------------------

test("Pauta: só título, sem campos extras", () => {
  assert.deepEqual(parseAgendaInput({ title: "  Finanças " }), { title: "Finanças" });
  assert.throws(() => parseAgendaInput({ title: "" }), HttpError);
  assert.throws(() => parseAgendaInput({ title: "Finanças", meetingId: "outra" }), HttpError);
  // Não existe nível intermediário ("bloco") entre Pauta e Tema.
  assert.throws(() => parseAgendaInput({ title: "Finanças", parentId: "x" }), HttpError);
});

test("Tema aponta para uma Pauta por UUID", () => {
  const id = "22222222-2222-2222-2222-222222222222";
  assert.equal(parseAgendaItemInput({ title: "Resultado do trimestre", agendaId: id }).agendaId, id);
  assert.throws(() => parseAgendaItemInput({ title: "x", agendaId: "nao-uuid" }), HttpError);
  assert.deepEqual(parseAgendaItemPatch({ agendaId: id }), { agendaId: id });
  assert.deepEqual(parseAgendaItemPatch({ agendaId: null }), { agendaId: null });
  assert.throws(() => parseAgendaItemPatch({ agendaId: 42 }), HttpError);
});
