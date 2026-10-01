import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { anosDasAgendas, filtrarAgendasAnuais, filtrarPorOrgao, TODOS_OS_ORGAOS } from "./governance-filter";
import { reunioesDoAno, reunioesPorDia } from "./annual-calendar";
import { groupByStage, pipelineStage } from "./pipeline";
import { meetingFromApi, type ApiMeetingSummary } from "./meeting-adapters";

const orgao = (id: string, name: string) => ({ id, name, chairEntraObjectId: null, chairName: null });
const EXEC = orgao("exec", "Comitê Executivo");
const AUD = orgao("aud", "Comitê de Auditoria");
const FISCAL = orgao("fiscal", "Conselho Fiscal");

const reuniao = (id: string, startAt: string, body: ReturnType<typeof orgao>, extra: Partial<ApiMeetingSummary> = {}) =>
  meetingFromApi({
    id, title: id, description: null, governanceBody: body, organizer: null, startAt,
    endAt: new Date(Date.parse(startAt) + 3600_000).toISOString(), timezone: "America/Sao_Paulo",
    meetingLink: null, onlineMeetingProvider: "teamsForBusiness", modality: "online", physicalLocation: null,
    origin: "manual", annualAgendaId: null, calendarSyncStatus: "synced", status: "scheduled",
    agendaValidation: { status: "draft", sentAt: null, sentTo: null, approvedAt: null },
    recurrence: null, pendingRequirements: null, participantsCount: 0, agendaItemsCount: 0,
    createdAt: "", updatedAt: "", ...extra
  });

const reunioes = [
  reuniao("exec-0802", "2027-02-08T12:00:00Z", EXEC),
  reuniao("aud-0802", "2027-02-08T17:00:00Z", AUD),
  reuniao("exec-0310", "2027-03-10T12:00:00Z", EXEC, { origin: "annual_agenda", annualAgendaId: "aa", agendaItemsCount: 2 }),
  reuniao("aud-2026", "2026-11-10T12:00:00Z", AUD, { status: "done" })
];

// --- Calendário ----------------------------------------------------------

const calendario = (orgaoId: string, ano: number) => {
  const doAno = reunioesDoAno(filtrarPorOrgao(reunioes, orgaoId), ano);
  return { lista: doAno.map((m) => m.id), contador: doAno.length, dias: [...reunioesPorDia(doAno).keys()] };
};

test("Calendário: Todos mostra todas as reuniões do ano", () => {
  assert.deepEqual(calendario(TODOS_OS_ORGAOS, 2027), {
    lista: ["exec-0802", "aud-0802", "exec-0310"],
    contador: 3,
    dias: ["2027-02-08", "2027-03-10"]
  });
});

test("Calendário: órgão específico filtra lista, contador e dias destacados juntos", () => {
  assert.deepEqual(calendario("exec", 2027), { lista: ["exec-0802", "exec-0310"], contador: 2, dias: ["2027-02-08", "2027-03-10"] });
  // 08/02 continua destacado para Executivo e para Auditoria; some para Conselho Fiscal.
  assert.deepEqual(calendario("aud", 2027).dias, ["2027-02-08"]);
  assert.deepEqual(calendario("fiscal", 2027), { lista: [], contador: 0, dias: [] });
});

test("Calendário: troca de ano + filtro funcionam juntos", () => {
  assert.deepEqual(calendario("aud", 2026).lista, ["aud-2026"]);
  assert.deepEqual(calendario("exec", 2026).lista, []);
});

// --- Pipeline ------------------------------------------------------------

test("Pipeline: Todos x órgão, etapas preservadas", () => {
  const todos = groupByStage(filtrarPorOrgao(reunioes, TODOS_OS_ORGAOS));
  assert.equal(Object.values(todos).flat().length, 4);
  const exec = groupByStage(filtrarPorOrgao(reunioes, "exec"));
  assert.deepEqual(exec.scheduled.map((m) => m.id), ["exec-0802"]);
  assert.deepEqual(exec.preparing.map((m) => m.id), ["exec-0310"]);
  // O filtro não muda o status calculado de ninguém.
  for (const m of filtrarPorOrgao(reunioes, "exec")) {
    assert.equal(pipelineStage(m), pipelineStage(reunioes.find((r) => r.id === m.id)!));
  }
});

// --- Agenda Anual --------------------------------------------------------

const agendas = [
  { id: "a1", year: 2027, governanceBody: { id: "exec" } },
  { id: "a2", year: 2027, governanceBody: { id: "aud" } },
  { id: "a3", year: 2026, governanceBody: { id: "exec" } }
];

test("Agenda Anual: lista completa, por órgão e ano + órgão", () => {
  assert.deepEqual(filtrarAgendasAnuais(agendas, null, "").map((a) => a.id), ["a1", "a2", "a3"]);
  assert.deepEqual(filtrarAgendasAnuais(agendas, null, "exec").map((a) => a.id), ["a1", "a3"]);
  assert.deepEqual(filtrarAgendasAnuais(agendas, 2027, "exec").map((a) => a.id), ["a1"]);
  assert.deepEqual(filtrarAgendasAnuais(agendas, 2026, "aud"), []);
  assert.deepEqual(anosDasAgendas(agendas), [2027, 2026]);
});

/** Sem comentários: a varredura enxerga código, não prosa. */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("filtro único nas três telas; agenda específica sem filtro redundante", () => {
  for (const tela of ["CalendarView", "PipelineView", "AnnualAgendaView"]) {
    assert.match(codigo(`../components/${tela}.tsx`), /<GovernanceBodyFilter/, tela);
  }
  const anual = codigo("../components/AnnualAgendaView.tsx");
  const detalhe = anual.slice(anual.indexOf("function AgendaDetail("));
  assert.ok(!detalhe.includes("GovernanceBodyFilter"), "dentro da agenda o órgão já está definido");
  // Calendário: clique em reunião segue indo ao Pipeline.
  assert.match(codigo("../App.tsx"), /onMeetingClick=\{abrirNoPipeline\}/);
});

test("Agenda Anual histórica: órgão inativo continua filtrável; criação só com ativos", () => {
  const app = codigo("../App.tsx");
  const bloco = app.slice(app.indexOf("<AnnualAgendaView"), app.indexOf("/>", app.indexOf("<AnnualAgendaView")));
  assert.match(bloco, /governanceBodies=\{governanceBodies\}/, "lista/filtro recebe todos os órgãos");
  const anual = codigo("../components/AnnualAgendaView.tsx");
  assert.match(anual, /governanceBodies\.filter\(\(b\) => b\.isActive\)\.map/, "nova agenda só com ativos");
  // A regra pura não depende de o órgão estar ativo.
  assert.deepEqual(filtrarAgendasAnuais([{ year: 2025, governanceBody: { id: "inativo" } }], 2025, "inativo").length, 1);
});

test("Pipeline: um só filtro de órgão (o antigo de Categoria saiu do modo Lista)", () => {
  const lista = codigo("../components/MeetingsView.tsx");
  assert.ok(!/selectedCategory|availableCategories/.test(lista));
  assert.match(codigo("../components/PipelineView.tsx"), /renderList\(doOrgao\)/);
});
