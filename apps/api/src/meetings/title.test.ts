import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { horaLocal, montarTituloDaReuniao, parseTipoDeSessao, preposicaoDoOrgao } from "./title.js";
import { parseCreateInput } from "./create.js";
import { parseUpdateInput } from "./update.js";

/** Mesmos exemplos de `web/src/lib/meeting-title.test.ts`. */
const EXEMPLOS = [
  ["2027-03-17T12:00:00Z", "Comitê de Riscos", "extraordinary", "in_person", "09:00 | Cielo | Reunião Extraordinária do Comitê de Riscos (PRESENCIAL)"],
  ["2027-03-17T13:30:00Z", "Diretoria Executiva", "ordinary", "online", "10:30 | Cielo | Reunião Ordinária da Diretoria Executiva (VIDEOCONFERÊNCIA)"],
  ["2027-03-17T17:00:00Z", "Assembleia Geral", "ordinary", "in_person", "14:00 | Cielo | Reunião Ordinária da Assembleia Geral (PRESENCIAL)"],
  ["2027-03-17T11:00:00Z", "Conselho de Administração", "extraordinary", "online", "08:00 | Cielo | Reunião Extraordinária do Conselho de Administração (VIDEOCONFERÊNCIA)"],
] as const;

test("título padronizado: hora | Cielo | Reunião {tipo} do/da {órgão} ({formato})", () => {
  for (const [startAt, orgao, tipo, modalidade, esperado] of EXEMPLOS) {
    assert.equal(montarTituloDaReuniao({ startAt, timezone: "America/Sao_Paulo", orgao, tipo, modalidade }), esperado);
  }
});

test("hora no fuso da reunião; preposição pelo órgão; tipo validado", () => {
  assert.equal(horaLocal("2027-01-01T02:00:00Z", "America/Sao_Paulo"), "23:00");
  assert.equal(horaLocal("2027-01-01T03:00:00Z", "America/Sao_Paulo"), "00:00");
  assert.deepEqual(["Comitê de Pessoas", "Conselho Fiscal", "Diretoria", "Assembleia", "Comissão de Ética"].map(preposicaoDoOrgao), ["do", "do", "da", "da", "da"]);
  assert.equal(parseTipoDeSessao("ordinary"), "ordinary");
  for (const ruim of ["Ordinária", "", null, 1]) assert.throws(() => parseTipoDeSessao(ruim), HttpError);
});

test("criação: com tipo o título é do servidor (corpo não manda título); sem tipo, título livre", () => {
  const base = {
    governanceBodyId: "11111111-1111-1111-1111-111111111111",
    startAt: "2027-03-17T12:00:00Z", endAt: "2027-03-17T13:00:00Z", timezone: "America/Sao_Paulo",
    participants: [], agendaItems: [],
  };
  assert.equal(parseCreateInput({ ...base, sessionType: "extraordinary" }).sessionType, "extraordinary");
  assert.throws(() => parseCreateInput({ ...base, sessionType: "ordinary", title: "Qualquer" }), /gerado automaticamente/);
  assert.equal(parseCreateInput({ ...base, title: "Livre" }).title, "Livre");
  assert.throws(() => parseCreateInput(base), HttpError, "sem tipo e sem título");
  assert.equal(parseUpdateInput({ sessionType: "ordinary" }).sessionType, "ordinary");
});

test("edição: título recomposto com os valores finais; título manual recusado com tipo", () => {
  const fonte = readFileSync(new URL("./update.ts", import.meta.url), "utf8");
  assert.match(fonte, /input\.title !== undefined && \(input\.sessionType \?\? atual\.rows\[0\]!\.session_type\)/);
  assert.match(fonte, /const recomposto = await recomporTituloPadronizado\(client, meetingId\);/);
  assert.match(fonte, /camposAlterados\.push\("title"\)/, "título novo desatualiza o convite");
  const criar = readFileSync(new URL("./create.ts", import.meta.url), "utf8");
  assert.match(criar, /const titulo = input\.sessionType\s*\? montarTituloDaReuniao\(/);
});
