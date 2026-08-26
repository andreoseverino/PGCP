import assert from "node:assert/strict";
import { test } from "node:test";
import type { JWTPayload } from "jose";
import type { EntraConfig } from "./config.js";
import { extractBearerToken, statusForFailure, validateClaims } from "./verify.js";

/**
 * Testes da FRONTEIRA DE AUTENTICACAO — a verificacao que mais importa acertar.
 *
 * Escopo deliberado: `validateClaims` e uma funcao PURA, entao roda sem token
 * real, sem rede, sem tenant e sem relogio. Nenhuma fixture aqui e um JWT
 * verdadeiro; sao objetos de claims montados a mao.
 *
 * DIVISAO DE RESPONSABILIDADE (ver o cabecalho de verify.ts):
 *
 *   jose.jwtVerify  -> assinatura, `iss`, `aud`, `exp`/`nbf`, RS256, JWKS
 *   validateClaims  -> `aud`, `tid`, `oid`, `azp`, `scp`
 *
 * Por isso NAO ha teste de assinatura nem de expiracao aqui: `exp` e `iss` sao
 * verificados pela biblioteca antes de `validateClaims` ser chamada, e
 * reimplementar essa checagem no teste provaria apenas que o teste sabe somar.
 * O `iss` esperado e derivado do tenant — coberto em `config.test.ts`.
 *
 * `aud` aparece nos DOIS lados de proposito: a reconferencia impede que um
 * token do Microsoft Graph seja aceito como credencial do PGCP.
 */

const CONFIG: EntraConfig = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  apiClientId: "22222222-2222-2222-2222-222222222222",
  spaClientId: "33333333-3333-3333-3333-333333333333",
  scopeName: "access_as_user",
  issuer: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
  metadataUrl:
    "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0/.well-known/openid-configuration",
};

const OID = "44444444-4444-4444-4444-444444444444";

/** Claims de um token legitimo. `over` sobrescreve um campo por vez. */
function claims(over: Record<string, unknown> = {}): JWTPayload {
  return {
    aud: CONFIG.apiClientId,
    tid: CONFIG.tenantId,
    oid: OID,
    azp: CONFIG.spaClientId,
    scp: CONFIG.scopeName,
    name: "Fulano de Tal",
    preferred_username: "fulano@empresa.exemplo",
    ...over,
  } as JWTPayload;
}

/** Codigo da recusa, ou `null` quando o token foi aceito. */
function recusa(payload: JWTPayload): string | null {
  const resultado = validateClaims(payload, CONFIG);
  return resultado.ok ? null : resultado.code;
}

// --- token valido ------------------------------------------------------------

test("aceita um token integro e extrai a identidade", () => {
  const resultado = validateClaims(claims(), CONFIG);

  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;

  assert.equal(resultado.principal.entraObjectId, OID);
  assert.equal(resultado.principal.name, "Fulano de Tal");
  assert.equal(resultado.principal.username, "fulano@empresa.exemplo");
  assert.deepEqual(resultado.principal.scopes, ["access_as_user"]);
  assert.deepEqual(resultado.principal.appRoles, []);
});

test("o tenant do principal vem da CONFIGURACAO, nunca do payload", () => {
  // Um token so chega aqui se `tid` ja bateu com o configurado. Registrar o
  // valor da config e o que garante que um payload nao redefina o tenant.
  const resultado = validateClaims(claims(), CONFIG);
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.equal(resultado.principal.entraTenantId, CONFIG.tenantId);
});

// --- aud ---------------------------------------------------------------------

test("aud: recusa audience de outra aplicacao, ausente ou em array", () => {
  assert.equal(recusa(claims()), null);
  assert.equal(recusa(claims({ aud: "outra-aplicacao" })), "wrong_audience");
  assert.equal(recusa(claims({ aud: undefined })), "wrong_audience");
  // Token do Graph nao pode virar credencial do PGCP.
  assert.equal(recusa(claims({ aud: "https://graph.microsoft.com" })), "wrong_audience");
  // Comparacao ESTRITA: `aud` como array nao e aceito, mesmo contendo o valor
  // certo. O jose ja validou o formato; aqui a exigencia e mais apertada.
  assert.equal(recusa(claims({ aud: [CONFIG.apiClientId] })), "wrong_audience");
});

// --- tid ---------------------------------------------------------------------

test("tid: recusa outro tenant, ausente, vazio ou de tipo errado", () => {
  assert.equal(recusa(claims({ tid: "99999999-9999-9999-9999-999999999999" })), "wrong_tenant");
  assert.equal(recusa(claims({ tid: undefined })), "wrong_tenant");
  assert.equal(recusa(claims({ tid: "" })), "wrong_tenant");
  assert.equal(recusa(claims({ tid: "   " })), "wrong_tenant");
  assert.equal(recusa(claims({ tid: 11111111 })), "wrong_tenant");
  assert.equal(recusa(claims({ tid: [CONFIG.tenantId] })), "wrong_tenant");
});

// --- oid ---------------------------------------------------------------------

test("oid: sem identificador estavel, nao ha identidade", () => {
  assert.equal(recusa(claims({ oid: undefined })), "missing_object_id");
  assert.equal(recusa(claims({ oid: "" })), "missing_object_id");
  assert.equal(recusa(claims({ oid: "   " })), "missing_object_id");
  assert.equal(recusa(claims({ oid: 42 })), "missing_object_id");
});

// --- azp ---------------------------------------------------------------------

test("azp: somente o SPA do PGCP pode obter token para esta API", () => {
  assert.equal(recusa(claims({ azp: "outro-cliente" })), "unauthorized_client");
  assert.equal(recusa(claims({ azp: undefined })), "unauthorized_client");
  assert.equal(recusa(claims({ azp: "" })), "unauthorized_client");
  // O client id da propria API nao serve como `azp`: sao registros distintos.
  assert.equal(recusa(claims({ azp: CONFIG.apiClientId })), "unauthorized_client");
});

// --- scp ---------------------------------------------------------------------

test("scp: exige o escopo delegado, inclusive entre varios", () => {
  assert.equal(recusa(claims({ scp: "access_as_user" })), null);
  assert.equal(recusa(claims({ scp: "openid profile access_as_user email" })), null);
  assert.equal(recusa(claims({ scp: "openid profile" })), "insufficient_scope");
  assert.equal(recusa(claims({ scp: undefined })), "insufficient_scope");
  assert.equal(recusa(claims({ scp: "" })), "insufficient_scope");
});

test("scp: prefixo ou sufixo nao satisfaz o escopo exigido", () => {
  assert.equal(recusa(claims({ scp: "access_as_user_admin" })), "insufficient_scope");
  assert.equal(recusa(claims({ scp: "not_access_as_user" })), "insufficient_scope");
  // Caixa diferente e outro escopo.
  assert.equal(recusa(claims({ scp: "ACCESS_AS_USER" })), "insufficient_scope");
});

test("scp malformado: array em vez de string nao concede escopo", () => {
  // `scp` chega do Entra como string separada por espaco. Um array — de um
  // emissor diferente ou de um token forjado — nao pode virar escopo valido.
  assert.equal(recusa(claims({ scp: ["access_as_user"] })), "insufficient_scope");
  assert.equal(recusa(claims({ scp: 1 })), "insufficient_scope");
  assert.equal(recusa(claims({ scp: { access_as_user: true } })), "insufficient_scope");
});

// --- roles -------------------------------------------------------------------

test("roles: ausencia e legitima e nao impede a autenticacao", () => {
  // Usuario sem papel continua entrando: le o conteudo corporativo e cuida dos
  // proprios FUPs. Papel governa o que ele PODE FAZER, nao se ele entra.
  const resultado = validateClaims(claims({ roles: undefined }), CONFIG);
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.deepEqual(resultado.principal.appRoles, []);
});

test("roles: le o array e descarta entradas que nao sao string util", () => {
  const resultado = validateClaims(
    claims({ roles: ["PGCP.Admin", "", "PGCP.Assessoria", 7, null, { a: 1 }] }),
    CONFIG,
  );
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.deepEqual(resultado.principal.appRoles, ["PGCP.Admin", "PGCP.Assessoria"]);
});

test("roles malformado: string em vez de array nao concede papel nenhum", () => {
  const resultado = validateClaims(claims({ roles: "PGCP.Admin" }), CONFIG);
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.deepEqual(resultado.principal.appRoles, [], "string solta nao vira papel");
});

// --- defeitos combinados -----------------------------------------------------

test("NENHUMA combinacao de defeitos e aceita", () => {
  /*
   * A propriedade de seguranca e esta: um token com qualquer subconjunto de
   * defeitos e recusado. Nao importa QUAL codigo volta primeiro — isso e
   * consequencia da ordem dos `if`, e reordena-los nao afrouxa nada.
   *
   * Testar o codigo especifico de cada defeito ISOLADO ja e feito acima, e ali
   * ele importa: o cliente distingue 401 de 403 pelo codigo. Aqui, com varios
   * defeitos ao mesmo tempo, o que precisa valer e so "recusado".
   */
  const defeitos: Array<[string, Record<string, unknown>]> = [
    ["aud", { aud: "outra-aplicacao" }],
    ["tid", { tid: "99999999-9999-9999-9999-999999999999" }],
    ["oid", { oid: undefined }],
    ["azp", { azp: "outro-cliente" }],
    ["scp", { scp: "openid profile" }],
  ];

  const CODIGOS_CONHECIDOS = [
    "wrong_audience",
    "wrong_tenant",
    "missing_object_id",
    "unauthorized_client",
    "insufficient_scope",
  ];

  // Percorre as 31 combinacoes nao vazias dos defeitos acima.
  let combinacoes = 0;
  for (let mascara = 1; mascara < 1 << defeitos.length; mascara++) {
    const aplicados: string[] = [];
    let payload: Record<string, unknown> = {};

    defeitos.forEach(([nome, defeito], indice) => {
      if (mascara & (1 << indice)) {
        aplicados.push(nome);
        payload = { ...payload, ...defeito };
      }
    });

    const resultado = validateClaims(claims(payload), CONFIG);
    const combinacao = aplicados.join("+");

    assert.equal(resultado.ok, false, `token defeituoso em ${combinacao} deveria ser recusado`);
    if (resultado.ok) continue;
    assert.ok(
      CODIGOS_CONHECIDOS.includes(resultado.code),
      `${combinacao} devolveu codigo inesperado: ${resultado.code}`,
    );
    assert.ok(resultado.message.length > 0, `${combinacao} deveria ter mensagem para o cliente`);
    combinacoes++;
  }

  assert.equal(combinacoes, 31, "todas as combinacoes de defeito foram exercitadas");
});

test("so o token integro passa: mexer em UM claim ja recusa", () => {
  // Contraprova do teste acima — sem ela, um `validateClaims` que recusasse
  // tudo passaria nos dois.
  assert.equal(validateClaims(claims(), CONFIG).ok, true);
});

// --- statusForFailure --------------------------------------------------------

test("statusForFailure separa 401 (quem e voce) de 403 (voce nao pode)", () => {
  // 403 = autenticado, porem nao autorizado. Confundir com 401 mandaria a
  // pessoa tentar login de novo, sem efeito nenhum.
  assert.equal(statusForFailure("unauthorized_client"), 403);
  assert.equal(statusForFailure("insufficient_scope"), 403);
  // 503 = a instalacao nao consegue autenticar ninguem.
  assert.equal(statusForFailure("not_configured"), 503);
  for (const codigo of [
    "missing_token",
    "malformed_token",
    "invalid_token",
    "wrong_audience",
    "wrong_tenant",
    "missing_object_id",
  ] as const) {
    assert.equal(statusForFailure(codigo), 401, `${codigo} deve ser 401`);
  }
});

// --- extractBearerToken ------------------------------------------------------

test("extractBearerToken aceita o esquema sem diferenciar caixa (RFC 7235)", () => {
  assert.equal(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearerToken("bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearerToken("BEARER abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearerToken("  Bearer   abc.def.ghi  "), "abc.def.ghi");
});

test("extractBearerToken distingue credencial ausente de malformada", () => {
  const codigo = (header: string | undefined): string | null => {
    const r = extractBearerToken(header);
    return typeof r === "string" ? null : r.code;
  };

  // Ausente -> o cliente nem tentou.
  assert.equal(codigo(undefined), "missing_token");
  assert.equal(codigo(""), "missing_token");
  assert.equal(codigo("   "), "missing_token");

  // Malformado -> o cliente tentou e errou o contrato.
  assert.equal(codigo("abc.def.ghi"), "malformed_token", "sem esquema");
  assert.equal(codigo("Basic dXNlcjpwYXNz"), "malformed_token", "esquema errado");
  assert.equal(codigo("Bearer"), "malformed_token", "sem token");
  assert.equal(codigo("Bearer a b"), "malformed_token", "tres partes");
});
