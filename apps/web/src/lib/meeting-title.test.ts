import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { montarTituloDaReuniao, preposicaoDoOrgao, previaDoTitulo } from "./meeting-title";
import { buildNewMeetingPayload } from "./new-meeting";

/** Mesmos exemplos de `api/src/meetings/title.test.ts` (hora já local). */
const EXEMPLOS = [
  ["09:00", "Comitê de Riscos", "extraordinary", "in_person", "09:00 | Cielo | Reunião Extraordinária do Comitê de Riscos (PRESENCIAL)"],
  ["10:30", "Diretoria Executiva", "ordinary", "online", "10:30 | Cielo | Reunião Ordinária da Diretoria Executiva (VIDEOCONFERÊNCIA)"],
  ["14:00", "Assembleia Geral", "ordinary", "in_person", "14:00 | Cielo | Reunião Ordinária da Assembleia Geral (PRESENCIAL)"],
  ["08:00", "Conselho de Administração", "extraordinary", "online", "08:00 | Cielo | Reunião Extraordinária do Conselho de Administração (VIDEOCONFERÊNCIA)"]
] as const;

test("prévia do título = padrão do servidor", () => {
  for (const [startTime, orgao, tipo, modalidade, esperado] of EXEMPLOS) {
    assert.equal(montarTituloDaReuniao({ startTime, orgao, tipo, modalidade }), esperado);
  }
  assert.equal(preposicaoDoOrgao("Comissão de Ética"), "da");
  assert.equal(previaDoTitulo({ startTime: "09:00", orgao: "Comitê", tipo: "", modalidade: "online" }), null);
});

test("Nova reunião manda o tipo e NUNCA o título", () => {
  const payload = buildNewMeetingPayload({
    sessionType: "extraordinary", date: "2027-03-17", startTime: "09:00", endTime: "10:00",
    timezone: "America/Sao_Paulo", governanceBodyId: "g", modality: "in_person", physicalLocationId: "sede-matriz", participants: []
  });
  assert.equal(payload.sessionType, "extraordinary");
  assert.equal("title" in payload, false);
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("telas: sem campo de título digitável com tipo; formato Presencial/Videoconferência", () => {
  const modal = codigo("../components/NewMeetingModal.tsx");
  assert.ok(!/id="nmTitle"/.test(modal), "sem input de título");
  assert.match(modal, /id="nmType"/);
  assert.match(modal, /id="nmTitlePreview"/);
  const campos = codigo("../components/MeetingInviteFields.tsx");
  assert.match(campos, /"Videoconferência"/);
  // Edição (Pipeline e Calendário): um só modal; com tipo, só o tipo vai ao servidor.
  assert.match(codigo("../components/MeetingDetailView.tsx"), /<EditMeetingModal/);
  const edicao = codigo("./edit-meeting.ts");
  assert.match(edicao, /if \(f\.sessionType\) \{\s*if \(f\.sessionType !== base\.sessionType\) patch\.sessionType = f\.sessionType;\s*\} else if/);
  // A reserva por datas planejadas saiu da Agenda Anual; o título padronizado nasce no Calendário.
  assert.ok(!/reserveAnnualAgenda/.test(codigo("../components/AnnualAgendaView.tsx")));
});
