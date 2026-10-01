import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { readFileSync } from "node:fs";
import {
  exigirForaDoDiretorio,
  MSG_EMAIL_CORPORATIVO,
  MSG_VALIDACAO_INDISPONIVEL,
  parseExternalParticipantInput,
  parsePhone,
} from "./service.js";
import { findDirectoryUsersByEmail, odataString, type GraphConfig } from "../graph/client.js";
import { parseParticipantInput } from "../meetings/create.js";
import { externalParticipantsRouter } from "./routes.js";
import { requireAssessoriaOuAdmin, requirePgcpAssessoria } from "../authz/app-roles.js";

/** Participantes externos (026) — regras puras, sem banco e sem Graph. */

const valido = {
  fullName: "  Maria   Souza ",
  email: "maria@parceiro.com.br",
  phone: "+55 (11) 91234-5678",
};

test("criação válida; órgão colegiado opcional; nome normalizado", () => {
  const input = parseExternalParticipantInput(valido);
  assert.deepEqual(input, {
    fullName: "Maria Souza",
    email: "maria@parceiro.com.br",
    phone: "+55 (11) 91234-5678",
    governanceBodyId: null,
  });
  const comOrgao = parseExternalParticipantInput({ ...valido, governanceBodyId: "11111111-1111-1111-1111-111111111111" });
  assert.equal(comOrgao.governanceBodyId, "11111111-1111-1111-1111-111111111111");
});

test("nome, e-mail e telefone são obrigatórios", () => {
  for (const campo of ["fullName", "email", "phone"] as const) {
    assert.throws(() => parseExternalParticipantInput({ ...valido, [campo]: "" }), HttpError, campo);
    const sem = { ...valido } as Record<string, unknown>;
    delete sem[campo];
    assert.throws(() => parseExternalParticipantInput(sem), HttpError, campo);
  }
  assert.throws(() => parseExternalParticipantInput({ ...valido, fullName: "x".repeat(201) }), HttpError);
});

test("órgão colegiado inválido é recusado (texto livre não vira órgão)", () => {
  assert.throws(() => parseExternalParticipantInput({ ...valido, governanceBodyId: "Comitê X" }), HttpError);
});

test("e-mail: um endereço, sem separador nem injeção", () => {
  for (const ruim of ["maria", "a@b", "a@b.com, c@d.com", "a b@c.com", "a@b.com\r\nBcc: x@y.com"]) {
    assert.throws(() => parseExternalParticipantInput({ ...valido, email: ruim }), HttpError, ruim);
  }
});

test("telefone é texto: preserva DDI/DDD e formatação; recusa letras", () => {
  assert.equal(parsePhone("+55 (21)  3333-4444"), "+55 (21) 3333-4444");
  assert.equal(parsePhone("011 3333 4444"), "011 3333 4444", "zero à esquerda preservado");
  assert.throws(() => parsePhone("ramal abc"), HttpError);
  assert.throws(() => parsePhone("1234"), HttpError, "curto demais");
  assert.throws(() => parsePhone("1".repeat(31)), HttpError);
});

test("mass assignment: identidade Entra, usuário, origem e id não vêm do corpo", () => {
  for (const campo of ["id", "origin", "entraObjectId", "entraTenantId", "userId", "appRoles", "createdByUserId"]) {
    assert.throws(() => parseExternalParticipantInput({ ...valido, [campo]: "x" }), HttpError, campo);
  }
});

test("participante externo em reunião: só nome + e-mail, sem identidade Entra", () => {
  const p = parseParticipantInput({ displayName: "Maria Souza", email: "maria@parceiro.com.br", participantType: "external" });
  assert.equal(p.entraObjectId, undefined);
  assert.equal(p.userId, undefined);
  assert.equal(p.participantType, "external");
});

test("checagem no diretório: filtro exato por mail/UPN, literal OData escapado", async () => {
  let urlChamada = "";
  const config = { tenantId: "t", clientId: "c", clientSecret: "s", baseUrl: "https://graph" } as GraphConfig;
  const achados = await findDirectoryUsersByEmail(config, "o'brien@empresa.com", async (_c, url) => {
    urlChamada = decodeURIComponent(url);
    return { value: [{ id: "x", displayName: "O'Brien", mail: "o'brien@empresa.com", userPrincipalName: null, jobTitle: null, userType: "Member", accountEnabled: true }] };
  });
  assert.equal(achados.length, 1);
  assert.match(urlChamada, /mail eq 'o''brien@empresa\.com' or userPrincipalName eq 'o''brien@empresa\.com'/);
  assert.equal(odataString("a'b"), "'a''b'");
});

test("autorização no ROUTER: Assessoria ou Admin; usuário comum recebe 403 em toda rota", () => {
  const pilha = (externalParticipantsRouter as unknown as { stack: Array<{ route?: unknown; handle: unknown }> }).stack;
  const doRouter = pilha.filter((c) => !c.route).map((c) => c.handle);
  assert.ok(doRouter.includes(requireAssessoriaOuAdmin), "guarda deve estar no router inteiro");
  assert.ok(!doRouter.includes(requirePgcpAssessoria), "não restringe além da política dos cadastros");
  const rotas = pilha.filter((c) => c.route).length;
  assert.ok(rotas >= 4, "GET, POST, PATCH, DELETE");
});

test("validação no Entra: e-mail corporativo recusado com mensagem simples", () => {
  assert.throws(() => exigirForaDoDiretorio("found"), (e: HttpError) => e.status === 409 && e.message === MSG_EMAIL_CORPORATIVO);
});

test("FAIL CLOSED: Graph indisponível impede o cadastro (503), sem detalhe interno", () => {
  assert.throws(
    () => exigirForaDoDiretorio("unavailable"),
    (e: HttpError) => e.status === 503 && e.message === MSG_VALIDACAO_INDISPONIVEL && !/graph|tenant|token/i.test(e.message),
  );
  assert.doesNotThrow(() => exigirForaDoDiretorio("clear"));
});

/** Sem comentários: a varredura enxerga código, não prosa. */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("API administrativa trabalha só com registros locais: não busca nem lista o Entra", () => {
  const servico = codigo("./service.ts");
  const rotas = codigo("./routes.ts");
  assert.ok(!/searchDirectoryUsers|\/directory\//.test(servico + rotas), "sem busca de diretório");
  // Listagem lê só a tabela local.
  const FIM = "\n}\n";
  const listar = servico.slice(servico.indexOf("export async function listExternalParticipants"));
  assert.match(listar.slice(0, listar.indexOf(FIM)), /SELECT/);
  assert.ok(!/graph|Directory/i.test(listar.slice(0, listar.indexOf(FIM))), "listagem não consulta o Graph");
  // O diretório só aparece na checagem de integridade, que não devolve dados.
  assert.equal((servico.match(/findDirectoryUsersByEmail\(/g) ?? []).length, 1);
});

test("participante externo não recebe acesso: nada grava em users nem concede papel", () => {
  const servico = codigo("./service.ts");
  assert.ok(!/INSERT INTO users|UPDATE users|appRoles|app_role/i.test(servico));
});
