import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarDayState } from "./calendar-day-style";

/**
 * O defeito que isto trava: "hoje" era apenas `font-black underline` no número
 * e desaparecia sob o mapa de calor e sob o anel de seleção. A regra agora é
 * que os dois estados usam CANAIS diferentes — borda para hoje, anel para
 * seleção — e por isso nunca se anulam.
 */

const HOJE = "2026-08-28";

// --- hoje sobrevive à seleção de outro dia -----------------------------------

test("selecionar o dia 15 não apaga a marca do dia 28", () => {
  const quinze = calendarDayState({
    dateStr: "2026-08-15",
    todayStr: HOJE,
    selectedDayStr: "2026-08-15",
    meetingCount: 0
  });
  const vinteOito = calendarDayState({
    dateStr: HOJE,
    todayStr: HOJE,
    selectedDayStr: "2026-08-15",
    meetingCount: 0
  });

  assert.equal(quinze.isSelected, true);
  assert.equal(quinze.isToday, false);

  assert.equal(vinteOito.isToday, true);
  assert.equal(vinteOito.isSelected, false);
  assert.match(vinteOito.className, /border-2 border-\[#00658d\]/);
});

test("hoje continua marcado mesmo quando tem reuniões e outro dia está selecionado", () => {
  for (const quantidade of [0, 1, 2, 3, 9]) {
    const estado = calendarDayState({
      dateStr: HOJE,
      todayStr: HOJE,
      selectedDayStr: "2026-08-15",
      meetingCount: quantidade
    });
    assert.match(
      estado.className,
      /border-2 border-\[#00658d\]/,
      `mapa de calor com ${quantidade} reuniões engoliu a marca de hoje`
    );
  }
});

// --- seleção continua funcionando -------------------------------------------

test("dia selecionado ganha anel; sem reunião o anel é neutro, com reunião é azul", () => {
  const semReuniao = calendarDayState({
    dateStr: "2026-08-15",
    todayStr: HOJE,
    selectedDayStr: "2026-08-15",
    meetingCount: 0
  });
  assert.match(semReuniao.className, /ring-2 ring-slate-400/);
  assert.match(semReuniao.className, /bg-slate-100/);

  const comReuniao = calendarDayState({
    dateStr: "2026-08-15",
    todayStr: HOJE,
    selectedDayStr: "2026-08-15",
    meetingCount: 2
  });
  assert.match(comReuniao.className, /ring-2 ring-blue-500/);
  assert.match(comReuniao.className, /bg-blue-100/);
});

test("dia não selecionado não recebe anel", () => {
  const estado = calendarDayState({
    dateStr: "2026-08-15",
    todayStr: HOJE,
    selectedDayStr: null,
    meetingCount: 1
  });
  assert.equal(estado.isSelected, false);
  assert.doesNotMatch(estado.className, /ring-2/);
});

// --- hoje selecionado: os dois estados juntos --------------------------------

test("hoje selecionado mostra borda de hoje E anel de seleção", () => {
  const estado = calendarDayState({
    dateStr: HOJE,
    todayStr: HOJE,
    selectedDayStr: HOJE,
    meetingCount: 1
  });
  assert.equal(estado.isToday, true);
  assert.equal(estado.isSelected, true);
  assert.match(estado.className, /border-2 border-\[#00658d\]/);
  assert.match(estado.className, /ring-2 ring-blue-500/);
});

// --- mapa de calor preservado ------------------------------------------------

test("o mapa de calor por volume de reuniões não mudou", () => {
  const classeDe = (meetingCount: number) =>
    calendarDayState({ dateStr: "2026-08-10", todayStr: HOJE, selectedDayStr: null, meetingCount })
      .className;

  assert.match(classeDe(0), /text-slate-600/);
  assert.match(classeDe(1), /bg-blue-50/);
  assert.match(classeDe(2), /bg-blue-100/);
  assert.match(classeDe(3), /bg-blue-300/);
  assert.match(classeDe(4), /bg-blue-600/);
  assert.match(classeDe(12), /bg-blue-600/);
});

test("dia comum não recebe borda visível", () => {
  const estado = calendarDayState({
    dateStr: "2026-08-10",
    todayStr: HOJE,
    selectedDayStr: null,
    meetingCount: 0
  });
  assert.match(estado.className, /border border-transparent/);
});

// --- hoje preenchido ---------------------------------------------------------

test("hoje: quadrado preenchido na cor institucional, com ou sem reunião", () => {
  for (const meetingCount of [0, 1, 4]) {
    const estado = calendarDayState({ dateStr: HOJE, todayStr: HOJE, selectedDayStr: null, meetingCount });
    assert.match(estado.className, /bg-\[#00658d\] text-white/);
    assert.doesNotMatch(estado.className, /bg-blue-|bg-slate-100/, "fundo do mapa de calor não vale para hoje");
  }
  // Os outros dias continuam no mapa de calor.
  const outro = calendarDayState({ dateStr: "2026-08-10", todayStr: HOJE, selectedDayStr: null, meetingCount: 1 });
  assert.doesNotMatch(outro.className, /bg-\[#00658d\]/);
});
