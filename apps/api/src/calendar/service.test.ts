import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphConfig } from "../graph/client.js";
import type { ParticipanteParaConvite } from "./mapper.js";
import { resolverEnderecosCorporativosDosParticipantes } from "./service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OID = "22222222-2222-4222-8222-222222222222";

const config: GraphConfig = {
  tenantId: TENANT,
  clientId: "33333333-3333-4333-8333-333333333333",
  clientSecret: "não-usado",
  baseUrl: "https://graph.microsoft.com/v1.0",
};

const participante = (
  sobrescritas: Partial<ParticipanteParaConvite> = {},
): ParticipanteParaConvite => ({
  participantId: "44444444-4444-4444-8444-444444444444",
  displayName: "Pessoa corporativa",
  email: null,
  userPrincipalName: null,
  userId: null,
  entraTenantId: TENANT,
  entraObjectId: OID,
  ...sobrescritas,
});

test("endereço local válido não faz consulta adicional ao Graph", async () => {
  let chamadas = 0;
  const resultado = await resolverEnderecosCorporativosDosParticipantes(
    [participante({ email: "pessoa@empresa.com" })],
    config,
    async () => {
      chamadas += 1;
      return new Map();
    },
  );

  assert.equal(chamadas, 0);
  assert.equal(resultado[0]?.email, "pessoa@empresa.com");
});

test("responsável com tenant+OID e sem snapshot é resolvido pelo Graph", async () => {
  let oidsConsultados: readonly string[] = [];
  const resultado = await resolverEnderecosCorporativosDosParticipantes(
    [participante()],
    config,
    async (_config, objectIds) => {
      oidsConsultados = objectIds;
      return new Map([
        [
          OID.toLowerCase(),
          { id: OID, mail: null, userPrincipalName: "responsavel@empresa.com" },
        ],
      ]);
    },
  );

  assert.deepEqual(oidsConsultados, [OID]);
  assert.equal(resultado[0]?.email, null);
  assert.equal(resultado[0]?.userPrincipalName, "responsavel@empresa.com");
  assert.equal(resultado[0]?.entraObjectId, OID, "a identidade forte é preservada");
});

test("tenant diferente nunca é consultado nem cruzado", async () => {
  let chamadas = 0;
  const original = participante({ entraTenantId: "55555555-5555-4555-8555-555555555555" });
  const resultado = await resolverEnderecosCorporativosDosParticipantes(
    [original],
    config,
    async () => {
      chamadas += 1;
      return new Map();
    },
  );

  assert.equal(chamadas, 0);
  assert.deepEqual(resultado, [original]);
});

test("OIDs repetidos são consultados uma vez e participantes não são duplicados", async () => {
  let oidsConsultados: readonly string[] = [];
  const participantes = [
    participante(),
    participante({ participantId: "66666666-6666-4666-8666-666666666666" }),
  ];

  const resultado = await resolverEnderecosCorporativosDosParticipantes(
    participantes,
    config,
    async (_config, objectIds) => {
      oidsConsultados = objectIds;
      return new Map([[OID.toLowerCase(), { id: OID, mail: "pessoa@empresa.com", userPrincipalName: null }]]);
    },
  );

  assert.deepEqual(oidsConsultados, [OID]);
  assert.equal(resultado.length, 2);
  assert.ok(resultado.every((item) => item.email === "pessoa@empresa.com"));
});

test("OID não encontrado permanece como falha controlável, sem endereço inventado", async () => {
  const resultado = await resolverEnderecosCorporativosDosParticipantes(
    [participante()],
    config,
    async () => new Map(),
  );

  assert.equal(resultado[0]?.email, null);
  assert.equal(resultado[0]?.userPrincipalName, null);
});
