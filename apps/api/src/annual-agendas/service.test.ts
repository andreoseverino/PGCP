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
} from "./service.js";
import { cabecalhoDaReuniao, gerarPdfDaAgendaAnual, nomeDoArquivoDaAgendaAnual } from "./pdf.js";

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
    physicalLocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    participants: [{ entraObjectId: "33333333-3333-3333-3333-333333333333", displayName: "Pessoa" }],
  });
  assert.equal(reserva.physicalLocationId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  // Chave do catálogo antigo (025) não é mais aceita.
  assert.throws(() => parseReserveInput({ modality: "in_person", physicalLocationKey: "sede-matriz" }), HttpError);
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

test("aprovação removida: envio, registro e retirada respondem 410 (com papel exigido)", async () => {
  const { annualAgendasRouter } = await import("./routes.js");
  const { requirePgcpAssessoria } = await import("../authz/app-roles.js");
  const pilha = (annualAgendasRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
  }).stack;
  for (const caminho of ["/:id/approval-request", "/:id/approval", "/:id/withdraw"]) {
    const rota = pilha.find((c) => c.route?.path === caminho && c.route.methods.post)?.route;
    assert.ok(rota, caminho);
    assert.ok(rota.stack.some((s) => s.handle === requirePgcpAssessoria), `${caminho}: papel`);
    let codigo = 0;
    let corpo: { code?: string } = {};
    const res = { status(c: number) { codigo = c; return this; }, json(b: { code?: string }) { corpo = b; return this; } };
    rota.stack.at(-1)!.handle({}, res);
    assert.equal(codigo, 410, caminho);
    assert.equal(corpo.code, "annual_agenda_approval_removed");
  }
  assert.ok(!pilha.some((c) => c.route?.path === "/frozen-calendar"), "calendário congelado removido");
});

test("PDF: reunião no fuso DA REUNIÃO; aviso de reserva só para data planejada (legado)", () => {
  const base = {
    titulo: " Reunião  de Janeiro ",
    inicioEm: "2027-01-20T12:00:00Z",
    fimEm: "2027-01-20T14:00:00Z",
    fuso: "America/Sao_Paulo",
    reservada: true,
  };
  const c = cabecalhoDaReuniao(base);
  assert.deepEqual([c.dia, c.mesAno, c.semana, c.titulo, c.horario, c.aviso], ["20", "JAN 2027", "Quarta-feira", "Reunião de Janeiro", "09:00–11:00", null]);
  // 22h de 31/12 em São Paulo já é 01/01 em UTC: vale o fuso da reunião, não o da máquina.
  assert.equal(cabecalhoDaReuniao({ ...base, inicioEm: "2027-01-01T01:00:00Z", fimEm: "2027-01-01T02:00:00Z" }).dia, "31");
  assert.match(cabecalhoDaReuniao({ ...base, reservada: false }).aviso!, /Data planejada/);
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
