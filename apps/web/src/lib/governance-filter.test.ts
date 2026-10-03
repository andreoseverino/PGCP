import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filtrarPorOrgao } from "./governance-filter";
import { TODOS } from "./governance-context";
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
  assert.deepEqual(calendario(TODOS, 2027), {
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
  const todos = groupByStage(filtrarPorOrgao(reunioes, TODOS));
  assert.equal(Object.values(todos).flat().length, 4);
  const exec = groupByStage(filtrarPorOrgao(reunioes, "exec"));
  assert.deepEqual(exec.scheduled.map((m) => m.id), ["exec-0802"]);
  assert.deepEqual(exec.preparing.map((m) => m.id), ["exec-0310"]);
  // O filtro não muda o status calculado de ninguém.
  for (const m of filtrarPorOrgao(reunioes, "exec")) {
    assert.equal(pipelineStage(m), pipelineStage(reunioes.find((r) => r.id === m.id)!));
  }
});

/** Sem comentários: a varredura enxerga código, não prosa. */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("contexto global: um seletor no cabeçalho; telas sem filtro de órgão próprio", () => {
  const app = codigo("../App.tsx");
  // Um seletor por cabeçalho (desktop e barra mobile), ambos sobre o mesmo estado.
  assert.equal((app.match(/<GovernanceBodyFilter/g) ?? []).length, 2, "seletor só nos cabeçalhos");
  assert.equal((app.match(/onChange=\{mudarOrgaoContexto\}/g) ?? []).length, 2);
  for (const tela of ["CalendarView", "PipelineView", "AnnualAgendaView", "DashboardView"]) {
    const fonte = codigo(`../components/${tela}.tsx`);
    assert.ok(!fonte.includes("<GovernanceBodyFilter"), `${tela} não duplica o filtro`);
    assert.match(fonte, /orgaoContexto/, `${tela} lê o contexto global`);
  }
  for (const tela of ["DashboardView", "CalendarView", "AnnualAgendaView", "PipelineView"]) {
    const bloco = app.slice(app.indexOf(`<${tela}`), app.indexOf("/>", app.indexOf(`<${tela}`)));
    assert.match(bloco, /orgaoContexto=\{orgaoContexto\}/, `${tela} recebe o contexto`);
  }
  // Agenda específica: sem filtro redundante. Calendário: clique segue ao Pipeline.
  const anual = codigo("../components/AnnualAgendaView.tsx");
  assert.ok(!anual.slice(anual.indexOf("function AgendaDetail(")).includes("orgaoContexto"));
  assert.match(app, /onMeetingClick=\{abrirNoPipeline\}/);
});

test("Agenda Anual: preparar só com órgão ativo", () => {
  const anual = codigo("../components/AnnualAgendaView.tsx");
  // Agenda só nasce por "Preparar Agenda Anual", e só para órgão ativo.
  assert.match(anual, /canManage && grupo\.governanceBody\.isActive/, "preparar só com ativos");
});

test("Pipeline: um só filtro de órgão (o antigo de Categoria saiu do modo Lista)", () => {
  const lista = codigo("../components/MeetingsView.tsx");
  assert.ok(!/selectedCategory|availableCategories/.test(lista));
  assert.match(codigo("../components/PipelineView.tsx"), /renderList\(doOrgao\)/);
});
