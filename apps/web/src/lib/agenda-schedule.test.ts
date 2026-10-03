import assert from "node:assert/strict";
import { test } from "node:test";
import { cronogramaDosTemas, tempoDaReuniao } from "./agenda-schedule";

/** Mesmos exemplos de `api/src/meetings/schedule.test.ts`. */
const horarios = (ordem: string[], dur: Record<string, number | null>) =>
  cronogramaDosTemas("09:00", ordem.map((id) => ({ id, durationMinutes: dur[id]! }))).map((h) => `${h.id} ${h.inicio}–${h.fim}`);

test("cronograma: A20 B15 C25 a partir de 09:00; reordenado C A B", () => {
  const dur = { A: 20, B: 15, C: 25 };
  assert.deepEqual(horarios(["A", "B", "C"], dur), ["A 09:00–09:20", "B 09:20–09:35", "C 09:35–10:00"]);
  assert.deepEqual(horarios(["C", "A", "B"], dur), ["C 09:00–09:25", "A 09:25–09:45", "B 09:45–10:00"]);
});

test("tempo: abaixo, exato, acima; tema sem duração é contado, não vira 0 em silêncio", () => {
  const t = (...d: Array<number | null>) => d.map((durationMinutes, i) => ({ id: String(i), durationMinutes }));
  assert.deepEqual(tempoDaReuniao(60, t(20, 25)), { reuniaoMin: 60, temasMin: 45, semDuracao: 0, excessoMin: 0, disponivelMin: 15 });
  assert.equal(tempoDaReuniao(60, t(30, 30)).excessoMin, 0);
  assert.deepEqual(tempoDaReuniao(60, t(40, 45)), { reuniaoMin: 60, temasMin: 85, semDuracao: 0, excessoMin: 25, disponivelMin: 0 });
  assert.equal(tempoDaReuniao(60, t(20, null)).semDuracao, 1);
  assert.deepEqual(cronogramaDosTemas("09:00", t(20, null, 10)).map((h) => h.fim), ["09:20", null, "09:30"]);
});
