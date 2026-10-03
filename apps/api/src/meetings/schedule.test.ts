import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cronogramaDosTemas, tempoDaReuniao } from "./schedule.js";
import { problemasDeTempo } from "../annual-agendas/service.js";

/** Mesmos exemplos de `web/src/lib/agenda-schedule.test.ts`. */
const horarios = (ordem: string[], dur: Record<string, number | null>) =>
  cronogramaDosTemas("09:00", ordem.map((id) => ({ id, durationMinutes: dur[id]! }))).map((h) => `${h.id} ${h.inicio}–${h.fim}`);

test("cronograma: A20 B15 C25 a partir de 09:00; reordenado C A B", () => {
  const dur = { A: 20, B: 15, C: 25 };
  assert.deepEqual(horarios(["A", "B", "C"], dur), ["A 09:00–09:20", "B 09:20–09:35", "C 09:35–10:00"]);
  assert.deepEqual(horarios(["C", "A", "B"], dur), ["C 09:00–09:25", "A 09:25–09:45", "B 09:45–10:00"]);
});

test("tempo: 60/45 permitido, 60/60 permitido, 60/85 excede; sem duração conta à parte", () => {
  const t = (...d: Array<number | null>) => d.map((durationMinutes, i) => ({ id: String(i), durationMinutes }));
  assert.equal(tempoDaReuniao(60, t(20, 25)).disponivelMin, 15);
  assert.equal(tempoDaReuniao(60, t(30, 30)).excessoMin, 0);
  assert.equal(tempoDaReuniao(60, t(40, 45)).excessoMin, 25);
  assert.equal(tempoDaReuniao(60, t(20, null)).semDuracao, 1);
});

test("envio para aprovação: backend recusa excesso e tema sem duração, nomeando a reunião", () => {
  const r = (id: string) => ({ id, title: `Reunião ${id}`, start_at: new Date("2027-01-20T12:00:00Z"), end_at: new Date("2027-01-20T13:00:00Z") });
  const temas = [
    { meeting_id: "ok", id: "1", duration_minutes: 45 },
    { meeting_id: "igual", id: "2", duration_minutes: 60 },
    { meeting_id: "excede", id: "3", duration_minutes: 40 },
    { meeting_id: "excede", id: "4", duration_minutes: 45 },
    { meeting_id: "semdur", id: "5", duration_minutes: null },
  ];
  assert.deepEqual(problemasDeTempo([r("ok"), r("igual"), r("excede"), r("semdur")], temas), [
    '"Reunião excede" — excede em 25 min (reunião 60 min, temas 85 min)',
    '"Reunião semdur" — 1 tema(s) sem duração',
  ]);
  const fonte = readFileSync(new URL("../annual-agendas/service.ts", import.meta.url), "utf8");
  const envio = fonte.slice(fonte.indexOf("export async function solicitarAprovacao"), fonte.indexOf("export async function registrarAprovacao"));
  assert.ok(envio.indexOf("problemasDeTempo(") > 0 && envio.indexOf("problemasDeTempo(") < envio.indexOf("await enviar("), "valida antes do e-mail");
});
