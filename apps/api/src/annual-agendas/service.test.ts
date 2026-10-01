import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import {
  anoLocal,
  assertDentroDoAno,
  itensAReservar,
  parseAnnualAgendaInput,
  parseAnnualAgendaItemInput,
  parseAnnualAgendaPatch,
  parseReserveInput,
  podeEnviarParaAprovacao,
  podeRegistrarAprovacao,
} from "./service.js";
import { gerarPdfDaAgendaAnual, linhaDaReuniao, nomeDoArquivoDaAgendaAnual } from "./pdf.js";

/**
 * Agenda Anual — regras puras. Sem banco e sem Graph.
 */

const BODY = "11111111-1111-1111-1111-111111111111";

test("criação: órgão, ano e título; nada além disso", () => {
  assert.deepEqual(parseAnnualAgendaInput({ governanceBodyId: BODY, year: 2027, title: " Comitê " }), {
    governanceBodyId: BODY,
    year: 2027,
    title: "Comitê",
  });
  assert.throws(() => parseAnnualAgendaInput({ governanceBodyId: BODY, year: "2027", title: "x" }), HttpError);
  assert.throws(() => parseAnnualAgendaInput({ governanceBodyId: BODY, year: 1999, title: "x" }), HttpError);
  // mass assignment: status/criador vêm do servidor
  assert.throws(
    () => parseAnnualAgendaInput({ governanceBodyId: BODY, year: 2027, title: "x", status: "approved" }),
    HttpError,
  );
  assert.throws(() => parseAnnualAgendaPatch({ title: "x", year: 2030 }), HttpError);
});

test("reunião planejada: horário coerente e fuso IANA", () => {
  const item = parseAnnualAgendaItemInput({
    title: "Janeiro",
    startAt: "2027-01-20T12:00:00Z",
    endAt: "2027-01-20T14:00:00Z",
  });
  assert.equal(item.timezone, "America/Sao_Paulo");
  assert.throws(
    () => parseAnnualAgendaItemInput({ title: "x", startAt: "2027-01-20T12:00:00Z", endAt: "2027-01-20T11:00:00Z" }),
    HttpError,
  );
  assert.throws(
    () => parseAnnualAgendaItemInput({ title: "x", startAt: "2027-01-20T12:00:00Z", endAt: "2027-01-20T14:00:00Z", timezone: "BRT" }),
    HttpError,
  );
  assert.throws(
    () => parseAnnualAgendaItemInput({ title: "x", startAt: "2027-01-20T12:00:00Z", endAt: "2027-01-20T14:00:00Z", meetingId: BODY }),
    HttpError,
    "meeting_id é do servidor",
  );
});

test("data precisa estar no ano da agenda, no fuso da reunião", () => {
  // 31/12/2026 22h em São Paulo = 01/01/2027 01h UTC: continua 2026.
  assert.equal(anoLocal("2027-01-01T01:00:00Z", "America/Sao_Paulo"), 2026);
  const item = parseAnnualAgendaItemInput({
    title: "Dezembro",
    startAt: "2027-01-01T01:00:00Z",
    endAt: "2027-01-01T02:00:00Z",
  });
  assert.doesNotThrow(() => assertDentroDoAno(item, 2026));
  assert.throws(() => assertDentroDoAno(item, 2027), HttpError);
});

test("reserva: presencial exige local; participantes validados como no Calendário", () => {
  assert.throws(() => parseReserveInput({ modality: "in_person" }), HttpError);
  const reserva = parseReserveInput({
    modality: "in_person",
    physicalLocationKey: "sede-matriz",
    participants: [{ entraObjectId: "33333333-3333-3333-3333-333333333333", displayName: "Pessoa" }],
  });
  assert.equal(reserva.physicalLocationKey, "sede-matriz");
  assert.equal(reserva.participants.length, 1);
  assert.throws(
    () => parseReserveInput({ modality: "online", participants: [{ displayName: "x", entraTenantId: BODY }] }),
    HttpError,
    "tenant nunca vem do corpo",
  );
  assert.throws(() => parseReserveInput({ modality: "online", annualAgendaId: BODY }), HttpError);
});

test("reservar de novo não duplica: só datas sem reunião viram reunião", () => {
  const itens = [
    { id: "a", meetingId: "m1" },
    { id: "b", meetingId: null },
    { id: "c", meetingId: "m2" },
    { id: "d", meetingId: null },
  ];
  assert.deepEqual(itensAReservar(itens).map((i) => i.id), ["b", "d"]);
  // Segunda chamada, depois de reservar tudo: nada a criar.
  assert.deepEqual(itensAReservar(itens.map((i) => ({ ...i, meetingId: i.meetingId ?? "novo" }))), []);
});

test("aprovação é independente da reserva e não pula etapas", () => {
  assert.equal(podeEnviarParaAprovacao("draft"), true);
  assert.equal(podeEnviarParaAprovacao("pending_approval"), true);
  assert.equal(podeEnviarParaAprovacao("approved"), false);
  assert.equal(podeRegistrarAprovacao("draft"), false, "aprovação sem pedido não tem lastro");
  assert.equal(podeRegistrarAprovacao("pending_approval"), true);
  assert.equal(podeRegistrarAprovacao("approved"), true, "idempotente");
});

test("PDF: linha no fuso da reunião e indicação de reserva", () => {
  const linha = linhaDaReuniao({
    titulo: "Reunião de Janeiro",
    inicioEm: "2027-01-20T12:00:00Z",
    fimEm: "2027-01-20T14:00:00Z",
    fuso: "America/Sao_Paulo",
    reservada: true,
  });
  assert.equal(linha.mes, "Janeiro");
  assert.equal(linha.horario, "09:00 – 11:00");
  assert.equal(linha.reserva, "Reservada");
});

test("PDF da Agenda Anual é gerado (vazio e com reuniões)", async () => {
  for (const n of [0, 12]) {
    const pdf = await gerarPdfDaAgendaAnual({
      titulo: "Comitê Executivo",
      ano: 2027,
      orgao: "Comitê Executivo",
      status: "pending_approval",
      emitidoEm: "2026-09-30T12:00:00Z",
      reunioes: Array.from({ length: n }, (_, i) => ({
        titulo: `Reunião ${i + 1}`,
        inicioEm: new Date(Date.UTC(2027, i, 20, 12)).toISOString(),
        fimEm: new Date(Date.UTC(2027, i, 20, 14)).toISOString(),
        fuso: "America/Sao_Paulo",
        reservada: i % 2 === 0,
      })),
    });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 500);
  }
  assert.equal(nomeDoArquivoDaAgendaAnual("Comitê / Executivo", 2027), "agenda-anual-2027-Comite-Executivo.pdf");
});
