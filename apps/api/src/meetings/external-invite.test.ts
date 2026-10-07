import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { montarAttendees } from "../calendar/mapper.js";

/**
 * Participante EXTERNO do Comitê/Mesa (grupo do órgão, 027/031): entra na
 * reunião como `meeting_participants` comum (participant_type 'external',
 * nome + e-mail, sem identidade Microsoft) e é convidado pelo e-mail.
 */

test("externo (sem Entra, sem conta PGCP) vira attendee do convite pelo e-mail", () => {
  const { attendees, semEndereco } = montarAttendees([
    { participantId: "p1", displayName: "Zé Parceiro", email: "ze@parceiro.com", userPrincipalName: null, userId: null, entraTenantId: null, entraObjectId: null },
    { participantId: "p2", displayName: "Ana Interna", email: "ana@cielo.com.br", userPrincipalName: null, userId: "u", entraTenantId: "t", entraObjectId: "o" },
  ]);
  assert.deepEqual(semEndereco, []);
  assert.deepEqual(attendees.map((a) => a.emailAddress.address), ["ze@parceiro.com", "ana@cielo.com.br"]);
});

test("grupo do órgão inclui o externo como participante 'external' — nunca como usuário", () => {
  const fonte = readFileSync(new URL("./agenda-item-participants.ts", import.meta.url), "utf8");
  assert.match(fonte, /m\.externo\s*\?\s*\{ displayName: m\.nome, email: m\.email \?\? undefined, participantType: "external" \}/);
  // Nenhum caminho de participante/externo provisiona `users` (só o login JIT faz isso).
  for (const arq of ["./agenda-item-participants.ts", "../external-participants/service.ts", "../participants/groups.ts", "../governance-bodies/service.ts"]) {
    assert.ok(!/INSERT INTO users/i.test(readFileSync(new URL(arq, import.meta.url), "utf8")), arq);
  }
});
