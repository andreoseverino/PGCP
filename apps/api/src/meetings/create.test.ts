import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import {
  parseAgendaItemInput,
  parseCreateInput,
  parseOrganizerInput,
  parseParticipantInput,
  urlHttpOpcional,
} from "./create.js";
import { parseAgendaItemPatch } from "./update.js";

/**
 * Testes de segurança da leitura do corpo de criação de reunião.
 *
 * Cobrem casos NEGATIVOS e tentativas de bypass — o que o contrato tem de
 * recusar, não só o que aceita. Rodam sem banco e sem rede: são funções puras.
 */

// --- meetingLink: barreira de XSS armazenado ---------------------------------

test("urlHttpOpcional aceita http e https", () => {
  assert.equal(urlHttpOpcional("https://teams.microsoft.com/l/x", "meetingLink"), "https://teams.microsoft.com/l/x");
  assert.equal(urlHttpOpcional("http://exemplo.com", "meetingLink"), "http://exemplo.com");
});

test("urlHttpOpcional recusa javascript: e data: (XSS via href)", () => {
  for (const perigoso of [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "  javascript:alert(1)  ",
  ]) {
    assert.throws(() => urlHttpOpcional(perigoso, "meetingLink"), HttpError, `deveria recusar: ${perigoso}`);
  }
});

test("urlHttpOpcional trata ausência como undefined, não erro", () => {
  assert.equal(urlHttpOpcional(undefined, "meetingLink"), undefined);
  assert.equal(urlHttpOpcional(null, "meetingLink"), undefined);
  assert.equal(urlHttpOpcional("   ", "meetingLink"), undefined);
});

test("parseCreateInput recusa meetingLink com esquema perigoso", () => {
  assert.throws(
    () =>
      parseCreateInput({
        governanceBodyId: "11111111-1111-1111-1111-111111111111",
        title: "Reunião",
        startAt: "2026-01-01T10:00:00Z",
        endAt: "2026-01-01T11:00:00Z",
        timezone: "America/Sao_Paulo",
        meetingLink: "javascript:alert(1)",
        participants: [],
        agendaItems: [],
      }),
    HttpError,
  );
});

// --- mass assignment: campos que o servidor define, não o cliente ------------

test("parseParticipantInput recusa entraTenantId vindo do corpo", () => {
  assert.throws(
    () => parseParticipantInput({ displayName: "Fulano", entraTenantId: "outro-tenant" }),
    HttpError,
  );
});

test("parseOrganizerInput recusa userId e entraTenantId vindos do corpo", () => {
  assert.throws(
    () => parseOrganizerInput({ entraObjectId: "22222222-2222-2222-2222-222222222222", userId: "x" }),
    HttpError,
  );
  assert.throws(
    () => parseOrganizerInput({ entraObjectId: "22222222-2222-2222-2222-222222222222", entraTenantId: "x" }),
    HttpError,
  );
});

// --- Tema circular (isCircularTheme): create + patch --------------------------

test("parseAgendaItemInput aceita isCircularTheme boolean e ausência (default)", () => {
  assert.equal(parseAgendaItemInput({ title: "P", isCircularTheme: true }).isCircularTheme, true);
  assert.equal(parseAgendaItemInput({ title: "P", isCircularTheme: false }).isCircularTheme, false);
  // Ausente => undefined (o INSERT aplica o default false do banco).
  assert.equal(parseAgendaItemInput({ title: "P" }).isCircularTheme, undefined);
});

test("parseAgendaItemInput recusa isCircularTheme não-boolean (string/número/objeto)", () => {
  for (const v of ["true", "sim", 1, 0, {}, [], "false"]) {
    assert.throws(() => parseAgendaItemInput({ title: "P", isCircularTheme: v }), HttpError, `deveria recusar: ${JSON.stringify(v)}`);
  }
});

test("parseAgendaItemPatch aceita isCircularTheme boolean (false→true e true→false)", () => {
  assert.equal(parseAgendaItemPatch({ isCircularTheme: true }).isCircularTheme, true);
  assert.equal(parseAgendaItemPatch({ isCircularTheme: false }).isCircularTheme, false);
});

test("parseAgendaItemPatch recusa isCircularTheme não-boolean e mantém allowlist", () => {
  for (const v of ["true", 1, 0, {}, "false"]) {
    assert.throws(() => parseAgendaItemPatch({ isCircularTheme: v }), HttpError);
  }
  // Mass assignment continua bloqueado: campo fora da allowlist é recusado.
  assert.throws(() => parseAgendaItemPatch({ position: 3 }), HttpError);
  assert.throws(() => parseAgendaItemPatch({ agendaTopicId: "x" }), HttpError);
});

// --- Ficha cadastral 019 (tipo/natureza/descrição/FUP): create + patch --------

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("parseAgendaItemInput aceita tipo/natureza/descrição/FUP válidos", () => {
  const r = parseAgendaItemInput({
    title: "P",
    agendaTopicTypeId: UUID_A,
    agendaTopicNatureId: UUID_A,
    description: "  objetivo do debate  ",
    generatesActionItem: true,
  });
  assert.equal(r.agendaTopicTypeId, UUID_A);
  assert.equal(r.agendaTopicNatureId, UUID_A);
  assert.equal(r.description, "objetivo do debate");
  assert.equal(r.generatesActionItem, true);
  // Ausentes => undefined (o INSERT herda do tema no vínculo, ou aplica default).
  const vazio = parseAgendaItemInput({ title: "P" });
  assert.equal(vazio.agendaTopicTypeId, undefined);
  assert.equal(vazio.description, undefined);
  assert.equal(vazio.generatesActionItem, undefined);
});

test("parseAgendaItemInput recusa tipo/natureza não-UUID e FUP não-boolean", () => {
  assert.throws(() => parseAgendaItemInput({ title: "P", agendaTopicTypeId: "nope" }), HttpError);
  assert.throws(() => parseAgendaItemInput({ title: "P", agendaTopicNatureId: 123 }), HttpError);
  for (const v of ["true", 1, {}, "sim"]) {
    assert.throws(() => parseAgendaItemInput({ title: "P", generatesActionItem: v }), HttpError);
  }
});

test("parseAgendaItemPatch aceita a ficha e permite limpar (null) tipo/natureza/descrição", () => {
  assert.equal(parseAgendaItemPatch({ agendaTopicTypeId: UUID_A }).agendaTopicTypeId, UUID_A);
  assert.equal(parseAgendaItemPatch({ agendaTopicTypeId: null }).agendaTopicTypeId, null);
  assert.equal(parseAgendaItemPatch({ agendaTopicNatureId: null }).agendaTopicNatureId, null);
  assert.equal(parseAgendaItemPatch({ description: null }).description, null);
  assert.equal(parseAgendaItemPatch({ description: "x" }).description, "x");
  assert.equal(parseAgendaItemPatch({ generatesActionItem: false }).generatesActionItem, false);
});

test("parseAgendaItemPatch recusa ficha inválida e mantém allowlist", () => {
  assert.throws(() => parseAgendaItemPatch({ agendaTopicTypeId: "nope" }), HttpError);
  assert.throws(() => parseAgendaItemPatch({ generatesActionItem: "true" }), HttpError);
  // Mass assignment: campo fora da allowlist recusado (nomes de coluna crus).
  assert.throws(() => parseAgendaItemPatch({ agenda_topic_type_id: UUID_A }), HttpError);
  assert.throws(() => parseAgendaItemPatch({ meeting_id: UUID_A }), HttpError);
});
