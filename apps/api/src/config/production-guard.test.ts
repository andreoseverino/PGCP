import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeProductionConfig, collectProductionConfigIssues } from "./production-guard.js";

/**
 * Testes do fail-fast de producao. Cobrem: fora de producao nada dispara;
 * config de producao segura passa; combinacoes perigosas sao recusadas.
 */

const PROD_SEGURO = {
  NODE_ENV: "production",
  ENTRA_TENANT_ID: "t",
  ENTRA_API_CLIENT_ID: "a",
  ENTRA_SPA_CLIENT_ID: "s",
  CORS_ORIGIN: "https://pgcp.example.com",
  DB_SSL: "true",
};

test("fora de producao nunca acusa problema", () => {
  assert.deepEqual(collectProductionConfigIssues({ NODE_ENV: "development" }), []);
  assert.deepEqual(collectProductionConfigIssues({}), []);
  // Mesmo com config perigosa, dev nao dispara.
  assert.deepEqual(
    collectProductionConfigIssues({ NODE_ENV: "development", DB_SSL: "false", CORS_ORIGIN: "*" }),
    [],
  );
});

test("producao segura nao acusa problema", () => {
  assert.deepEqual(collectProductionConfigIssues(PROD_SEGURO), []);
  assert.doesNotThrow(() => assertSafeProductionConfig(PROD_SEGURO));
});

test("recusa Entra ausente em producao", () => {
  const issues = collectProductionConfigIssues({ ...PROD_SEGURO, ENTRA_TENANT_ID: undefined });
  assert.ok(issues.some((i) => i.includes("ENTRA_TENANT_ID")));
});

test("recusa CORS com localhost, http e curinga em producao", () => {
  assert.ok(
    collectProductionConfigIssues({ ...PROD_SEGURO, CORS_ORIGIN: "http://localhost:3000" }).length > 0,
  );
  assert.ok(
    collectProductionConfigIssues({ ...PROD_SEGURO, CORS_ORIGIN: "http://pgcp.example.com" }).some((i) =>
      i.includes("http://"),
    ),
  );
  assert.ok(
    collectProductionConfigIssues({ ...PROD_SEGURO, CORS_ORIGIN: "*" }).some((i) => i.includes('"*"')),
  );
  assert.ok(collectProductionConfigIssues({ ...PROD_SEGURO, CORS_ORIGIN: undefined }).length > 0);
});

test("recusa banco sem TLS em producao", () => {
  const issues = collectProductionConfigIssues({ ...PROD_SEGURO, DB_SSL: "false" });
  assert.ok(issues.some((i) => i.includes("DB_SSL")));
});

test("assertSafeProductionConfig lanca em producao insegura", () => {
  assert.throws(
    () => assertSafeProductionConfig({ ...PROD_SEGURO, DB_SSL: "false", CORS_ORIGIN: "*" }),
    /Configuracao insegura para producao/,
  );
});
