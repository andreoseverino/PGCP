import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { parseDirectoryPersonInput, parseDirectoryPersonPatch } from "./service.js";
import { findDirectoryUserById, GraphError, type GraphConfig } from "../graph/client.js";
import { directoryPeopleRouter } from "./routes.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";

const OID = "eeeeeeee-0000-4000-8000-000000000001";
const G = "11111111-1111-1111-1111-111111111111";
const T = "33333333-3333-3333-3333-333333333333";

test("vínculo de pessoa do diretório: só oid + classificações", () => {
  assert.deepEqual(parseDirectoryPersonInput({ entraObjectId: OID, governanceBodyIds: [G], topicIds: [T] }), {
    entraObjectId: OID,
    governanceBodyIds: [G],
    topicIds: [T],
  });
  assert.deepEqual(parseDirectoryPersonPatch({}), { governanceBodyIds: [], topicIds: [] });
});

test("mass assignment: nome, e-mail, tenant, usuário e App Role não vêm do corpo", () => {
  for (const campo of ["displayName", "email", "entraTenantId", "userId", "appRoles", "id"]) {
    assert.throws(() => parseDirectoryPersonInput({ entraObjectId: OID, [campo]: "x" }), HttpError, campo);
  }
  assert.throws(() => parseDirectoryPersonInput({ entraObjectId: "nao-uuid" }), HttpError);
  assert.throws(() => parseDirectoryPersonPatch({ entraObjectId: OID }), HttpError, "identidade não muda no PATCH");
});

test("Graph por id: 404 vira 'inexistente'; outra falha propaga (fail closed acima)", async () => {
  const config = { tenantId: "t", clientId: "c", clientSecret: "s", baseUrl: "https://graph" } as GraphConfig;
  let url = "";
  const achado = await findDirectoryUserById(config, OID, async (_c, u) => {
    url = u;
    return { id: OID, displayName: "João", mail: "joao@empresa.com", userPrincipalName: null, jobTitle: null, userType: "Member", accountEnabled: true };
  });
  assert.equal(achado?.displayName, "João");
  assert.match(url, new RegExp(`^/users/${OID}\\?\\$select=`));
  assert.equal(await findDirectoryUserById(config, OID, async () => { throw new GraphError("x", "Request_ResourceNotFound", 404); }), null);
  await assert.rejects(findDirectoryUserById(config, OID, async () => { throw new GraphError("x", "throttled", 429); }));
});

test("autorização no ROUTER (Assessoria ou Admin)", () => {
  const pilha = (directoryPeopleRouter as unknown as { stack: Array<{ route?: unknown; handle: unknown }> }).stack;
  assert.ok(pilha.filter((c) => !c.route).map((c) => c.handle).includes(requireAssessoriaOuAdmin));
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("pessoa do diretório não vira usuário, externo nem ganha App Role", () => {
  const s = codigo("./service.ts");
  assert.ok(!/INSERT INTO users|UPDATE users|external_participants|app_role|appRoles/i.test(s));
  // Identidade e nome vêm do Graph (lookup) e o tenant do token do ator.
  assert.match(s, /await lookup\(entraObjectId\)/);
  assert.match(s, /confirmarNoDiretorio\(input\.entraObjectId, lookup\)/);
  assert.match(s, /ator\.entraTenantId/);
});
