import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatCurrentDateTime, millisecondsUntilNextMinute } from "./current-datetime";

/**
 * O relógio do cabeçalho da Visão Geral não pode discordar da data usada pelas
 * reuniões. Por isso ele resolve o momento pelo mesmo caminho
 * (`instantToLocal` + `DEFAULT_TIMEZONE`), e é isso que se afirma aqui: o
 * instante UTC de 28/08 às 23:30 em São Paulo ainda é dia 28, não 29.
 */

// --- formato pt-BR -----------------------------------------------------------

test("formata dia da semana, data por extenso e hora em pt-BR", () => {
  // 2026-08-28T13:16:00Z = sexta-feira, 28/08/2026 10:16 em America/Sao_Paulo.
  assert.equal(
    formatCurrentDateTime(new Date("2026-08-28T13:16:00.000Z"), "pt"),
    "Sexta-feira, 28 de agosto de 2026 • 10:16"
  );
});

test("primeira letra do dia da semana vem maiúscula", () => {
  const texto = formatCurrentDateTime(new Date("2026-08-28T13:16:00.000Z"), "pt");
  assert.match(texto, /^[A-ZÀ-Ý]/);
});

test("hora é 24h com dois dígitos, inclusive na virada da meia-noite", () => {
  // 03:05Z = 00:05 em São Paulo (UTC-3).
  assert.equal(
    formatCurrentDateTime(new Date("2026-08-29T03:05:00.000Z"), "pt"),
    "Sábado, 29 de agosto de 2026 • 00:05"
  );
});

// --- fuso: uma regra só ------------------------------------------------------

test("usa o fuso das reuniões, não UTC: 23:30 de 28/08 em SP não vira dia 29", () => {
  // 2026-08-29T02:30:00Z já é dia 29 em UTC, mas ainda é 23:30 do dia 28 em SP.
  assert.equal(
    formatCurrentDateTime(new Date("2026-08-29T02:30:00.000Z"), "pt"),
    "Sexta-feira, 28 de agosto de 2026 • 23:30"
  );
});

test("en-US recebe o mesmo instante com o mesmo fuso", () => {
  assert.equal(
    formatCurrentDateTime(new Date("2026-08-28T13:16:00.000Z"), "en"),
    "Friday, August 28, 2026 • 10:16"
  );
});

// --- cadência do relógio -----------------------------------------------------

test("espera até a virada do minuto, nunca zero e nunca mais que um minuto", () => {
  assert.equal(millisecondsUntilNextMinute(new Date("2026-08-28T13:16:00.000Z")), 60_000);
  assert.equal(millisecondsUntilNextMinute(new Date("2026-08-28T13:16:30.000Z")), 30_000);
  assert.equal(millisecondsUntilNextMinute(new Date("2026-08-28T13:16:59.500Z")), 500);

  for (const segundos of [0, 1, 17, 43, 59]) {
    const ms = millisecondsUntilNextMinute(new Date(`2026-08-28T13:16:${String(segundos).padStart(2, "0")}.000Z`));
    assert.ok(ms > 0 && ms <= 60_000, `esperado (0, 60000], recebido ${ms}`);
  }
});

// --- cleanup do timer --------------------------------------------------------

test("o componente limpa o timer no unmount", () => {
  /*
   * O efeito do relógio vive no JSX, que este runner não monta (`--test` roda
   * só `*.test.ts`). O que dá para provar sem React é que o efeito devolve uma
   * função de limpeza que desarma timeout e interval — a ausência disso é o
   * defeito clássico de relógio em componente.
   */
  const fonte = readFileSync(new URL("../components/DashboardView.tsx", import.meta.url), "utf8")
    // Comentários fora antes de varrer: um `clearInterval` citado em prosa não
    // é código executado.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const efeito = fonte.match(/useEffect\(\(\) => \{[\s\S]*?millisecondsUntilNextMinute[\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(efeito, "efeito do relógio não encontrado em DashboardView.tsx");
  assert.match(efeito[0], /return \(\) => \{/);
  assert.match(efeito[0], /clearTimeout\(/);
  assert.match(efeito[0], /clearInterval\(/);
});
