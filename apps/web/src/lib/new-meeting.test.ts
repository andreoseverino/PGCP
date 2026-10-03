import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNewMeetingPayload, MODALITY_DISCLAIMER, validateNewMeeting, type NewMeetingForm } from "./new-meeting";

const form = (extra: Partial<NewMeetingForm> = {}): NewMeetingForm => ({
  sessionType: "ordinary",
  date: "2027-01-20",
  startTime: "09:00",
  endTime: "11:00",
  timezone: "America/Sao_Paulo",
  governanceBodyId: "11111111-1111-1111-1111-111111111111",
  modality: "online",
  physicalLocationKey: "",
  participants: [
    { name: "Pessoa", role: "Convidado", confirmed: false, entraObjectId: "22222222-2222-2222-2222-222222222222", email: "p@empresa.com" }
  ],
  ...extra
});

test("criação sem pauta: o payload nunca leva temas", () => {
  const payload = buildNewMeetingPayload(form());
  assert.deepEqual(payload.agendaItems, []);
});

test("online: modalidade online, sem local físico no payload", () => {
  assert.equal(validateNewMeeting(form(), "pt"), null);
  const payload = buildNewMeetingPayload(form({ physicalLocationKey: "sede-matriz" }));
  assert.equal(payload.modality, "online");
  assert.equal("physicalLocationKey" in payload, false, "online não envia local (a API recusaria)");
});

test("presencial exige local; com local, envia a chave do catálogo", () => {
  assert.match(validateNewMeeting(form({ modality: "in_person" }), "pt") ?? "", /local físico/);
  const payload = buildNewMeetingPayload(form({ modality: "in_person", physicalLocationKey: "sede-leopoldo" }));
  assert.equal(payload.modality, "in_person");
  assert.equal(payload.physicalLocationKey, "sede-leopoldo");
});

test("payload correto: instantes no fuso da reunião, órgão e participantes", () => {
  const payload = buildNewMeetingPayload(form());
  assert.equal(payload.startAt, "2027-01-20T12:00:00.000Z");
  assert.equal(payload.endAt, "2027-01-20T14:00:00.000Z");
  assert.equal(payload.timezone, "America/Sao_Paulo");
  assert.equal(payload.governanceBodyId, "11111111-1111-1111-1111-111111111111");
  assert.equal(payload.participants[0]!.entraObjectId, "22222222-2222-2222-2222-222222222222");
  assert.equal(payload.participants[0]!.email, "p@empresa.com");
  // O servidor define status, origem e Teams — o navegador não afirma.
  for (const campo of ["status", "origin", "onlineMeetingProvider"]) {
    assert.equal(campo in payload, false, `${campo} não pode sair do navegador`);
  }
});

test("validação básica: tipo, horário coerente e órgão", () => {
  assert.match(validateNewMeeting(form({ sessionType: "" }), "pt") ?? "", /Ordinária ou Extraordinária/);
  assert.ok(validateNewMeeting(form({ endTime: "08:00" }), "pt"));
  assert.ok(validateNewMeeting(form({ governanceBodyId: "" }), "pt"));
});

test("aviso de modalidade menciona Teams e contingência", () => {
  assert.match(MODALITY_DISCLAIMER.pt, /Microsoft Teams/);
  assert.match(MODALITY_DISCLAIMER.pt, /contingência/);
});
