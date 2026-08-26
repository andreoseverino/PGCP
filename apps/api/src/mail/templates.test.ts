import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import {
  ASSUNTO_MAX,
  CORPO_MAX,
  parseTemplateInput,
  renderizarTemplate,
  type VariaveisDoTemplate,
} from "./templates.js";
import { parseEmailDoAprovador } from "../meetings/agenda-validation.js";

/**
 * Testes da entrada configuravel pela administracao e do endereco do aprovador.
 *
 * Sao os dois campos deste fluxo que uma pessoa digita e que saem do PGCP
 * dentro de um e-mail — por isso concentram a validacao.
 */

const VARIAVEIS: VariaveisDoTemplate = {
  nome_reuniao: "Comitê Executivo",
  data_reuniao: "12 de março de 2026",
  solicitante: "Ana Souza",
  quantidade_pautas: "3",
};

// --- modelo de e-mail --------------------------------------------------------

test("aceita assunto e corpo validos", () => {
  const input = parseTemplateInput({ subject: "  Validação  ", body: "  Olá,\n\nsegue.  " });
  assert.equal(input.subject, "Validação", "trim aplicado");
  assert.equal(input.body, "Olá,\n\nsegue.");
});

test("recusa campo fora do contrato (mass assignment)", () => {
  // O cliente nao escolhe a chave do modelo nem quem o alterou.
  for (const extra of ["key", "updatedByUserId", "updated_at", "id"]) {
    assert.throws(
      () => parseTemplateInput({ subject: "a", body: "b", [extra]: "x" }),
      HttpError,
      `deveria recusar '${extra}'`,
    );
  }
});

test("recusa vazio, ausente e tipo errado", () => {
  for (const corpo of [
    { subject: "", body: "b" },
    { subject: "   ", body: "b" },
    { subject: "a", body: "" },
    { subject: "a" },
    { body: "b" },
    { subject: 1, body: "b" },
    { subject: "a", body: ["b"] },
    null,
    "texto",
    ["a"],
  ]) {
    assert.throws(() => parseTemplateInput(corpo), HttpError);
  }
});

test("assunto NAO aceita quebra de linha — injecao de cabecalho de e-mail", () => {
  // Um assunto com CR/LF permitiria forjar cabecalho em qualquer consumidor que
  // monte MIME por concatenacao. O Graph nao seria vulneravel, mas o valor fica
  // salvo e pode alimentar outro caminho depois.
  assert.throws(() => parseTemplateInput({ subject: "a\nBcc: x@y.com", body: "b" }), HttpError);
  assert.throws(() => parseTemplateInput({ subject: "a\rBcc: x@y.com", body: "b" }), HttpError);
});

test("corpo aceita quebra de linha, mas nenhum outro controle", () => {
  assert.doesNotThrow(() => parseTemplateInput({ subject: "a", body: "linha1\nlinha2\r\nlinha3" }));
  assert.throws(() => parseTemplateInput({ subject: "a", body: "texto\u0000nulo" }), HttpError);
  assert.throws(() => parseTemplateInput({ subject: "a", body: "texto\u0007sino" }), HttpError);
});

test("respeita os tetos de tamanho", () => {
  assert.doesNotThrow(() => parseTemplateInput({ subject: "a".repeat(ASSUNTO_MAX), body: "b" }));
  assert.throws(() => parseTemplateInput({ subject: "a".repeat(ASSUNTO_MAX + 1), body: "b" }), HttpError);
  assert.doesNotThrow(() => parseTemplateInput({ subject: "a", body: "b".repeat(CORPO_MAX) }));
  assert.throws(() => parseTemplateInput({ subject: "a", body: "b".repeat(CORPO_MAX + 1) }), HttpError);
});

test("marcacao no modelo continua texto, nao vira HTML", () => {
  // O envio usa contentType "text"; aqui so confirmamos que nada e removido
  // nem interpretado na entrada — o texto chega ao destinatario literal.
  const input = parseTemplateInput({ subject: "a", body: "<script>alert(1)</script> & <b>x</b>" });
  assert.equal(input.body, "<script>alert(1)</script> & <b>x</b>");
});

// --- variaveis ---------------------------------------------------------------

test("substitui as variaveis suportadas", () => {
  const texto = renderizarTemplate(
    "{{solicitante}} pede validação de {{nome_reuniao}} em {{data_reuniao}} ({{quantidade_pautas}} pautas)",
    VARIAVEIS,
  );
  assert.equal(texto, "Ana Souza pede validação de Comitê Executivo em 12 de março de 2026 (3 pautas)");
});

test("tolera espaco dentro das chaves e repeticao", () => {
  assert.equal(renderizarTemplate("{{ nome_reuniao }}", VARIAVEIS), "Comitê Executivo");
  assert.equal(
    renderizarTemplate("{{nome_reuniao}} / {{nome_reuniao}}", VARIAVEIS),
    "Comitê Executivo / Comitê Executivo",
  );
});

test("variavel desconhecida permanece LITERAL", () => {
  // Some-la em silencio esconderia o erro de digitacao de quem editou.
  assert.equal(renderizarTemplate("{{inexistente}}", VARIAVEIS), "{{inexistente}}");
  assert.equal(renderizarTemplate("{{senha}} {{token}}", VARIAVEIS), "{{senha}} {{token}}");
});

test("substituicao e de UMA passada: valor com chaves nao e reexpandido", () => {
  // Uma reuniao chamada "{{solicitante}}" nao pode virar o nome de quem enviou.
  const hostil: VariaveisDoTemplate = { ...VARIAVEIS, nome_reuniao: "{{solicitante}}" };
  assert.equal(renderizarTemplate("{{nome_reuniao}}", hostil), "{{solicitante}}");
});

test("texto sem variavel nenhuma passa intacto", () => {
  assert.equal(renderizarTemplate("Olá, segue em anexo.", VARIAVEIS), "Olá, segue em anexo.");
});

// --- e-mail do aprovador -----------------------------------------------------

test("aceita enderecos corporativos comuns", () => {
  for (const email of [
    "aprovador@cielo.com.br",
    "nome.sobrenome@empresa.com",
    "nome+tag@empresa.co.uk",
    "  espaco@empresa.com  ",
  ]) {
    assert.equal(parseEmailDoAprovador(email), email.trim());
  }
});

test("recusa endereco malformado", () => {
  for (const email of [
    "",
    "   ",
    "semarroba.com",
    "@empresa.com",
    "nome@",
    "nome@empresa",
    "nome@@empresa.com",
    "nome@.com",
    "nome@empresa..com",
    ".nome@empresa.com",
    "nome@empresa.com.",
    "nome@empresa.c",
  ]) {
    assert.throws(
      () => parseEmailDoAprovador(email),
      HttpError,
      `deveria recusar: ${JSON.stringify(email)}`,
    );
  }
});

test("recusa multiplos destinatarios e formato com nome", () => {
  // Separador viraria envio para gente que ninguem escolheu.
  for (const email of [
    "a@x.com,b@y.com",
    "a@x.com;b@y.com",
    "a@x.com b@y.com",
    '"Fulano" <a@x.com>',
    "Fulano <a@x.com>",
  ]) {
    assert.throws(() => parseEmailDoAprovador(email), HttpError, `deveria recusar: ${email}`);
  }
});

test("recusa controle no endereco e tipo errado", () => {
  assert.throws(() => parseEmailDoAprovador("a@x.com\nBcc: c@z.com"), HttpError);
  assert.throws(() => parseEmailDoAprovador("a@x.com\u0000"), HttpError);
  for (const valor of [null, undefined, 42, {}, ["a@x.com"]]) {
    assert.throws(() => parseEmailDoAprovador(valor), HttpError);
  }
});

test("recusa endereco absurdamente longo", () => {
  assert.throws(() => parseEmailDoAprovador(`${"a".repeat(250)}@empresa.com`), HttpError);
});
