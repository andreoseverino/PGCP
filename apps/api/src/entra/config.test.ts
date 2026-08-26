import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SCOPE_NAME, getEntraConfig, missingAuthConfig } from "./config.js";

/**
 * Testes da CONFIGURACAO do Entra.
 *
 * Valem como cobertura do `iss`: o emissor aceito nao e uma variavel de
 * ambiente, e sim DERIVADO do tenant. Quem valida `iss` de fato e o
 * `jose.jwtVerify`, que recebe `config.issuer` — entao errar a derivacao aqui
 * significaria aceitar tokens do tenant errado la, sem que nenhuma outra
 * checagem percebesse.
 *
 * `getEntraConfig` le `process.env` a cada chamada (de proposito, para o
 * `tsx watch` enxergar mudanca de .env). Cada teste monta o ambiente que
 * precisa e restaura ao terminar — sem estado compartilhado entre testes.
 */

const VARIAVEIS = [
  "ENTRA_TENANT_ID",
  "ENTRA_API_CLIENT_ID",
  "ENTRA_SPA_CLIENT_ID",
  "ENTRA_API_SCOPE_NAME",
] as const;

const TENANT = "11111111-1111-1111-1111-111111111111";

/**
 * Roda `acao` com EXATAMENTE o ambiente informado nas variaveis do Entra, e
 * devolve o `process.env` ao estado anterior — inclusive quando a acao falha.
 */
function comAmbiente(env: Partial<Record<(typeof VARIAVEIS)[number], string>>, acao: () => void): void {
  const anterior = new Map(VARIAVEIS.map((nome) => [nome, process.env[nome]]));
  try {
    for (const nome of VARIAVEIS) {
      const valor = env[nome];
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
    acao();
  } finally {
    for (const [nome, valor] of anterior) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
}

const COMPLETO = {
  ENTRA_TENANT_ID: TENANT,
  ENTRA_API_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  ENTRA_SPA_CLIENT_ID: "33333333-3333-3333-3333-333333333333",
};

test("deriva o issuer v2.0 do tenant, nunca de variavel solta", () => {
  comAmbiente(COMPLETO, () => {
    const config = getEntraConfig();
    assert.ok(config, "configuracao completa deve resolver");
    assert.equal(config.issuer, `https://login.microsoftonline.com/${TENANT}/v2.0`);
    assert.equal(
      config.metadataUrl,
      `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
    );
  });
});

test("o issuer acompanha o tenant: trocar de tenant troca o emissor aceito", () => {
  const outro = "99999999-9999-9999-9999-999999999999";
  comAmbiente({ ...COMPLETO, ENTRA_TENANT_ID: outro }, () => {
    const config = getEntraConfig();
    assert.ok(config);
    assert.equal(config.issuer, `https://login.microsoftonline.com/${outro}/v2.0`);
    assert.ok(!config.issuer.includes(TENANT), "o tenant antigo nao pode sobrar no issuer");
  });
});

test("o issuer e o do endpoint v2.0, nao o do v1 (sts.windows.net)", () => {
  // A API fixa requestedAccessTokenVersion=2; aceitar o emissor v1 abriria uma
  // segunda forma de emissao que o resto da validacao nao espera.
  comAmbiente(COMPLETO, () => {
    const config = getEntraConfig();
    assert.ok(config);
    assert.ok(config.issuer.endsWith("/v2.0"));
    assert.ok(!config.issuer.includes("sts.windows.net"));
  });
});

test("sem variavel obrigatoria nao ha configuracao — e a falta e nomeada", () => {
  for (const ausente of ["ENTRA_TENANT_ID", "ENTRA_API_CLIENT_ID", "ENTRA_SPA_CLIENT_ID"] as const) {
    const parcial = { ...COMPLETO, [ausente]: undefined };
    comAmbiente(parcial, () => {
      assert.equal(getEntraConfig(), null, `sem ${ausente} a config deve ser null`);
      assert.deepEqual(missingAuthConfig(), [ausente]);
    });
  }
});

test("variavel so com espaco conta como ausente", () => {
  comAmbiente({ ...COMPLETO, ENTRA_TENANT_ID: "   " }, () => {
    assert.equal(getEntraConfig(), null);
    assert.deepEqual(missingAuthConfig(), ["ENTRA_TENANT_ID"]);
  });
});

test("missingAuthConfig devolve apenas NOMES, nunca valores", () => {
  comAmbiente({}, () => {
    const faltando = missingAuthConfig();
    assert.deepEqual(faltando, [
      "ENTRA_TENANT_ID",
      "ENTRA_API_CLIENT_ID",
      "ENTRA_SPA_CLIENT_ID",
    ]);
    // O segredo da API nunca entra nesta lista: validar token nao exige secret.
    assert.ok(!faltando.includes("ENTRA_API_CLIENT_SECRET" as never));
  });
});

test("o escopo tem valor de fabrica e pode ser sobrescrito", () => {
  comAmbiente(COMPLETO, () => {
    assert.equal(getEntraConfig()?.scopeName, DEFAULT_SCOPE_NAME);
    assert.equal(DEFAULT_SCOPE_NAME, "access_as_user");
  });
  comAmbiente({ ...COMPLETO, ENTRA_API_SCOPE_NAME: "outro_escopo" }, () => {
    assert.equal(getEntraConfig()?.scopeName, "outro_escopo");
  });
});

test("os dois client ids sao distintos e nao se confundem", () => {
  // Trocar um pelo outro faz TODO token ser rejeitado: um vira `aud`, o outro
  // vira `azp`. O teste fixa qual variavel alimenta qual campo.
  comAmbiente(COMPLETO, () => {
    const config = getEntraConfig();
    assert.ok(config);
    assert.equal(config.apiClientId, COMPLETO.ENTRA_API_CLIENT_ID);
    assert.equal(config.spaClientId, COMPLETO.ENTRA_SPA_CLIENT_ID);
    assert.notEqual(config.apiClientId, config.spaClientId);
  });
});
