import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OPCOES_DE_RECORRENCIA, recorrenciaParaApi, rotuloDaRecorrencia } from "./topic-recurrence";
import { buildTopicPayload } from "./agenda-topic-adapters";

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("recorrência do tema: mesmas opções da reunião; vazio = não se repete (null na API)", () => {
  assert.deepEqual(OPCOES_DE_RECORRENCIA.map((o) => o.pt), ["Não se repete", "Semanal", "Quinzenal", "Mensal", "Trimestral"]);
  assert.equal(recorrenciaParaApi(""), null);
  assert.equal(recorrenciaParaApi("monthly"), "monthly");
  assert.equal(recorrenciaParaApi("Mensal"), null, "valor fora da lista não vai ao servidor");
  assert.equal(rotuloDaRecorrencia("quarterly", "pt"), "Trimestral");
  assert.equal(rotuloDaRecorrencia(null, "pt"), "Não se repete");
});

test("Biblioteca: recorrência vai no corpo do tema só quando o formulário informou", () => {
  assert.equal(buildTopicPayload({ title: "T", recurrence: "weekly" }).recurrence, "weekly");
  assert.equal(buildTopicPayload({ title: "T", recurrence: null }).recurrence, null);
  assert.ok(!("recurrence" in buildTopicPayload({ title: "T" })));
});

test("os três formulários de tema têm o campo Recorrência (Agenda Anual, Pipeline, Biblioteca)", () => {
  const anual = codigo("../components/AnnualTemaModal.tsx");
  assert.match(anual, /id="annualTemaRecorrencia"/);
  assert.match(anual, /recurrence: recorrenciaParaApi\(recorrencia\)/);
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  assert.equal((card.match(/recurrence: dados\.recurrence/g) ?? []).length, 2, "criar e editar pela Agenda Anual");
  const pipeline = codigo("../components/MeetingDetailView.tsx");
  assert.match(pipeline, /id="editTemaRecorrencia"/);
  assert.match(pipeline, /recurrence: recorrenciaParaApi\(editRecorrencia\)/);
  const biblioteca = codigo("../components/UnlinkedAgendasView.tsx");
  assert.match(biblioteca, /id="agendaRecorrenciaInput"/);
});
