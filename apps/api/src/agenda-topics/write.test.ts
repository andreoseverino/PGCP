import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { parseAgendaTopicInput } from "./write.js";

/**
 * Contrato de escrita da Biblioteca (`agenda_topics`) para o PADRÃO de tema
 * circular. Funções puras: sem banco, sem rede.
 *
 * O eixo é distinto do efetivo da reunião (`meeting_agenda_items`, testado em
 * meetings/create.test.ts): aqui é só o valor-padrão que será copiado no vínculo.
 */

test("parseAgendaTopicInput aceita isCircularTheme boolean e ausência (default)", () => {
  assert.equal(parseAgendaTopicInput({ title: "P", isCircularTheme: true }).isCircularTheme, true);
  assert.equal(parseAgendaTopicInput({ title: "P", isCircularTheme: false }).isCircularTheme, false);
  // Ausente => undefined (o INSERT aplica o default false da coluna).
  assert.equal(parseAgendaTopicInput({ title: "P" }).isCircularTheme, undefined);
});

test("parseAgendaTopicInput recusa isCircularTheme não-boolean (string/número/objeto)", () => {
  for (const v of ["true", "sim", 1, 0, {}, [], "false"]) {
    assert.throws(
      () => parseAgendaTopicInput({ title: "P", isCircularTheme: v }),
      HttpError,
      `deveria recusar: ${JSON.stringify(v)}`,
    );
  }
});

test("parseAgendaTopicInput (parcial) aceita só isCircularTheme, true e false", () => {
  assert.equal(parseAgendaTopicInput({ isCircularTheme: true }, true).isCircularTheme, true);
  assert.equal(parseAgendaTopicInput({ isCircularTheme: false }, true).isCircularTheme, false);
});

test("parseAgendaTopicInput mantém allowlist fechada (mass assignment bloqueado)", () => {
  // Campo desconhecido é RECUSADO, não ignorado — inclusive junto do novo campo.
  assert.throws(
    () => parseAgendaTopicInput({ title: "P", isCircularTheme: true, sourceMeetingId: "x" }),
    HttpError,
  );
  assert.throws(() => parseAgendaTopicInput({ title: "P", ownerUserId: "x" }), HttpError);
});
