import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ajustarTermino, aoTrocarHora, aoTrocarMinuto, combinarHorario, decomporHorario, ehHorarioValido, horaDisponivel,
  HORAS, MINUTOS, opcoesDeHorario
} from "./time-options";
import { buildNewMeetingPayload, validateNewMeeting, type NewMeetingForm } from "./new-meeting";

test("opções em passos de 5 minutos, formato HH:mm, 00:00 a 23:55", () => {
  const todas = opcoesDeHorario();
  assert.equal(todas.length, 288);
  assert.equal(todas[0], "00:00");
  assert.equal(todas.at(-1), "23:55");
  for (const h of ["09:00", "09:05", "09:10"]) assert.ok(todas.includes(h), h);
  for (const h of ["09:01", "09:02", "09:03", "09:04"]) assert.ok(!todas.includes(h), h);
  assert.ok(todas.every((h) => /^\d{2}:\d{2}$/.test(h) && Number(h.slice(3)) % 5 === 0));
});

test("término: só depois do início", () => {
  const depois = opcoesDeHorario("09:00");
  assert.equal(depois[0], "09:05");
  assert.ok(!depois.includes("09:00") && !depois.includes("08:55"));
  assert.deepEqual(opcoesDeHorario("23:55"), []);
});

test("trocar o início: término válido fica; inválido acompanha mantendo a duração", () => {
  assert.equal(ajustarTermino("09:00", "11:00", "10:00"), "11:00", "ainda válido: não mexe");
  assert.equal(ajustarTermino("09:00", "11:00", "11:30"), "13:30", "duração de 2h mantida");
  assert.equal(ajustarTermino("09:00", "11:00", "22:30"), "22:35", "duração não cabe: próximo horário");
  assert.equal(ajustarTermino("09:00", "11:00", "23:55"), "", "sem término possível no dia");
});

test("validação: horário fora do passo é recusado; fluxo envia os mesmos instantes", () => {
  const form = (startTime: string, endTime: string): NewMeetingForm => ({
    sessionType: "ordinary", date: "2027-01-20", startTime, endTime, timezone: "America/Sao_Paulo",
    governanceBodyId: "g", modality: "online", physicalLocationKey: "", participants: []
  });
  assert.equal(ehHorarioValido("09:05"), true);
  assert.equal(ehHorarioValido("09:03"), false);
  assert.match(validateNewMeeting(form("09:03", "10:00"), "pt") ?? "", /5 minutos/);
  assert.match(validateNewMeeting(form("10:00", "09:00"), "pt") ?? "", /término/);
  assert.equal(validateNewMeeting(form("09:00", "11:00"), "pt"), null);
  const payload = buildNewMeetingPayload(form("09:00", "11:00"));
  assert.equal(payload.startAt, "2027-01-20T12:00:00.000Z");
  assert.equal(payload.endAt, "2027-01-20T14:00:00.000Z");
});

test("Nova reunião: sem input type=time; Início/Término com o seletor do PGCP", () => {
  const modal = readFileSync(new URL("../components/NewMeetingModal.tsx", import.meta.url), "utf8");
  assert.ok(!/type="time"/.test(modal));
  assert.match(modal, /<TimeSelect\s+id="nmStart"/);
  assert.match(modal, /<TimeSelect id="nmEnd" value=\{endTime\} options=\{opcoesDeHorario\(startTime\)\}/);
  const seletor = readFileSync(new URL("../components/TimeSelect.tsx", import.meta.url), "utf8");
  assert.match(seletor, /role="listbox"/);
  assert.match(seletor, /e\.key === "Escape"/);
  assert.match(seletor, /addEventListener\("mousedown", fora\)/);
});

test("colunas: horas 00–23 e minutos só de 5 em 5", () => {
  assert.equal(HORAS.length, 24);
  assert.deepEqual([HORAS[0], HORAS[9], HORAS[23]], ["00", "09", "23"]);
  assert.deepEqual(MINUTOS, ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"]);
  for (const m of ["01", "02", "03", "04", "07"]) assert.ok(!MINUTOS.includes(m), m);
});

test("09 + 35 = 09:35; valor inicial decomposto; HH:mm preservado", () => {
  assert.equal(combinarHorario("09", "35"), "09:35");
  assert.deepEqual(decomporHorario("09:35"), { hora: "09", minuto: "35" });
  assert.equal(decomporHorario("09:03"), null, "minuto fora do passo não é aceito");
  assert.equal(decomporHorario(""), null);
});

test("trocar só a hora ou só o minuto", () => {
  const todos = opcoesDeHorario();
  assert.equal(aoTrocarHora("09:00", "10", todos), "10:00");
  assert.equal(aoTrocarMinuto("10:00", "25", todos), "10:25");
  assert.equal(aoTrocarHora("10:25", "14", todos), "14:25", "mantém o minuto");
  assert.equal(aoTrocarMinuto("09:00", "03", todos), null, "minuto fora do passo recusado");
});

test("Término: combinações até o Início ficam indisponíveis", () => {
  const depois = opcoesDeHorario("09:00");
  assert.equal(horaDisponivel("08", depois), false);
  assert.equal(horaDisponivel("09", depois), true);
  assert.equal(aoTrocarMinuto("09:30", "00", depois), null, "09:00 não pode");
  assert.equal(aoTrocarHora("11:00", "09", depois), "09:05", "hora do início: primeiro minuto válido");
  assert.equal(aoTrocarHora("11:00", "08", depois), null, "hora antes do início: indisponível");
});

test("seletor: duas colunas (Hora/Minuto), centralizadas; campo fechado mostra HH:mm", () => {
  const seletor = readFileSync(new URL("../components/TimeSelect.tsx", import.meta.url), "utf8");
  assert.match(seletor, /"HORA", HORAS/);
  assert.match(seletor, /"MINUTO",\s*MINUTOS/);
  assert.match(seletor, /grid grid-cols-2/);
  assert.match(seletor, /items-center justify-center/);
  assert.match(seletor, /\{value \|\| </, "fechado: o próprio valor HH:mm");
  assert.ok(!/opcoesDeHorario\(\)\.map|options\.map\(\(hhmm/.test(seletor), "não renderiza 288 linhas");
});
