import assert from "node:assert/strict";
import { test } from "node:test";
import {
  montarAttendees,
  resolverEnderecoCorporativo,
  type ParticipanteParaConvite,
} from "./mapper.js";

test("endereço corporativo usa mail válido", () => {
  assert.equal(
    resolverEnderecoCorporativo(" pessoa@empresa.com ", null),
    "pessoa@empresa.com",
  );
});

test("endereço corporativo usa UPN quando mail está vazio", () => {
  assert.equal(
    resolverEnderecoCorporativo(null, "pessoa@tenant.onmicrosoft.com"),
    "pessoa@tenant.onmicrosoft.com",
  );
});

test("mail tem prioridade determinística sobre UPN", () => {
  assert.equal(
    resolverEnderecoCorporativo("caixa@empresa.com", "login@empresa.com"),
    "caixa@empresa.com",
  );
});

test("mail inválido não impede fallback para UPN válido", () => {
  assert.equal(
    resolverEnderecoCorporativo("sem-endereco", "login@empresa.com"),
    "login@empresa.com",
  );
});

test("mail e UPN indisponíveis não produzem endereço falso", () => {
  assert.equal(resolverEnderecoCorporativo(null, null), null);
  assert.equal(resolverEnderecoCorporativo("inválido", "também-inválido"), null);
});

const participante = (
  id: string,
  email: string | null,
  userPrincipalName: string | null,
): ParticipanteParaConvite => ({
  participantId: id,
  displayName: `Participante ${id}`,
  email,
  userPrincipalName,
  userId: null,
  entraTenantId: "11111111-1111-4111-8111-111111111111",
  entraObjectId: id,
});

test("attendee do Outlook utiliza o endereço corporativo resolvido", () => {
  const resultado = montarAttendees([
    participante("22222222-2222-4222-8222-222222222222", null, "login@empresa.com"),
  ]);

  assert.deepEqual(resultado.semEndereco, []);
  assert.equal(resultado.attendees[0]?.emailAddress.address, "login@empresa.com");
});

test("attendees não duplicam o mesmo endereço", () => {
  const resultado = montarAttendees([
    participante("22222222-2222-4222-8222-222222222222", "pessoa@empresa.com", null),
    participante("33333333-3333-4333-8333-333333333333", null, "PESSOA@empresa.com"),
  ]);

  assert.equal(resultado.attendees.length, 1);
  assert.deepEqual(resultado.semEndereco, []);
});
