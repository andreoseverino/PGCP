import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  agendaTopicToStandalone,
  buildTopicPayload,
  payloadDoTemaFuturo,
  problemaDoTemaFuturo,
  rotuloDoMes,
  TEMA_FUTURO_VAZIO,
  type ApiAgendaTopic
} from "./agenda-topic-adapters";

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("tema futuro: validação, payload e rótulo do mês", () => {
  assert.equal(problemaDoTemaFuturo(TEMA_FUTURO_VAZIO, "pt"), null, "desmarcado não exige nada");
  assert.match(problemaDoTemaFuturo({ ativo: true, mes: "", comiteId: "g1" }, "pt")!, /mês\/ano/);
  assert.match(problemaDoTemaFuturo({ ativo: true, mes: "2027-03", comiteId: "" }, "pt")!, /comitê previsto/);
  assert.equal(problemaDoTemaFuturo({ ativo: true, mes: "2027-03", comiteId: "g1" }, "pt"), null);

  assert.deepEqual(payloadDoTemaFuturo({ ativo: true, mes: "2027-03", comiteId: "g1" }), {
    isFuture: true, expectedMonth: "2027-03", expectedGovernanceBodyId: "g1"
  });
  // Desmarcar limpa os dois campos (o servidor exige vazio em tema regular).
  assert.deepEqual(payloadDoTemaFuturo({ ativo: false, mes: "2027-03", comiteId: "g1" }), {
    isFuture: false, expectedMonth: null, expectedGovernanceBodyId: null
  });
  // Sem o bloco no formulário, o payload não mexe no tema futuro.
  assert.ok(!("isFuture" in buildTopicPayload({ title: "x" })));
  assert.equal(buildTopicPayload({ title: "x", futuro: { ativo: true, mes: "2027-03", comiteId: "g1" } }).expectedMonth, "2027-03");
  assert.equal(rotuloDoMes("2027-03", "pt"), "Março/2027");
  assert.equal(rotuloDoMes(null, "pt"), "");
});

test("tema futuro: leitura da API vira campos da Biblioteca", () => {
  const api = {
    id: "t1", title: "Plano", description: null, estimatedDurationMinutes: 30, generatesActionItem: false,
    responsible: null, type: null, nature: null, governanceBody: null, ownerUserId: null, isCircularTheme: false,
    isFuture: true, expectedMonth: "2027-03", expectedGovernanceBody: { id: "g1", name: "Comitê de Pessoas" },
    source: null, isAutomaticCopy: false, linkedMeetingsCount: 0, participantsCount: 0,
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z"
  } as ApiAgendaTopic;
  const t = agendaTopicToStandalone(api);
  assert.equal(t.isFuture, true);
  assert.equal(t.expectedMonth, "2027-03");
  assert.equal(t.expectedGovernanceBodyName, "Comitê de Pessoas");
});

test("tema futuro nas telas: abas da Biblioteca e o bloco nos três lugares de criação", () => {
  const biblioteca = codigo("../components/UnlinkedAgendasView.tsx");
  assert.ok(biblioteca.includes('"Temas Regulares"') && biblioteca.includes('"Temas Futuros"'));
  assert.match(biblioteca, /\(aba === "futuros"\) !== \(agenda\.isFuture === true\)/);
  for (const arq of ["../components/UnlinkedAgendasView.tsx", "../components/AnnualTemaModal.tsx"]) {
    assert.match(codigo(arq), /<TemaFuturoFields/, arq);
  }
  // Detalhe da reunião usa o MESMO modal de tema da Agenda Anual (com o bloco).
  assert.match(codigo("../components/MeetingDetailView.tsx"), /<AnnualTemaModal/);
  // Tema futuro criado na reunião NÃO entra nela: vai pelo cadastro da Biblioteca.
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  assert.match(card, /dados\.futuro\?\.ativo\) \{\s*await createAgendaTopic\(/);
  const detalhe = codigo("../components/MeetingDetailView.tsx");
  assert.match(detalhe, /modalTema\.modo === "novo" && dados\.futuro\?\.ativo\) \{\s*await createAgendaTopic\(/);
  // Campos só aparecem com a caixa marcada.
  assert.match(codigo("../components/TemaFuturoFields.tsx"), /\{value\.ativo && \(/);
});
