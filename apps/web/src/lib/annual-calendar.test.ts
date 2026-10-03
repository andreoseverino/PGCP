import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dataSugerida, mesesDoAno, reunioesDoAno, reunioesPorDia, rotuloCurto } from "./annual-calendar";
import { meetingFromApi, type ApiMeetingSummary } from "./meeting-adapters";
import { buildNewMeetingPayload } from "./new-meeting";

const reuniao = (id: string, startAt: string, extra: Partial<ApiMeetingSummary> = {}) =>
  meetingFromApi({
    id,
    title: `Reunião ${id}`,
    description: null,
    governanceBody: { id: "g1", name: "Comitê Executivo", chairEntraObjectId: null, chairName: null },
    organizer: null,
    startAt,
    endAt: new Date(Date.parse(startAt) + 2 * 3600_000).toISOString(),
    timezone: "America/Sao_Paulo",
    meetingLink: null,
    onlineMeetingProvider: "teamsForBusiness",
    modality: "online",
    physicalLocation: null,
    origin: "manual",
    annualAgendaId: null,
    calendarSyncStatus: "synced",
    status: "scheduled",
    agendaValidation: { status: "draft", sentAt: null, sentTo: null, approvedAt: null },
    recurrence: null,
    pendingRequirements: null,
    participantsCount: 0,
    agendaItemsCount: 0,
    createdAt: "",
    updatedAt: "",
    ...extra
  });

const lista = [
  reuniao("c", "2026-03-17T12:00:00Z"),
  reuniao("a", "2026-01-20T12:00:00Z", { origin: "annual_agenda", annualAgendaId: "aa" }),
  reuniao("b", "2026-02-17T17:00:00Z"),
  reuniao("x", "2027-01-19T12:00:00Z"),
  // 01/01/2027 01h UTC = 31/12/2026 22h em São Paulo: pertence a 2026.
  reuniao("d", "2027-01-01T01:00:00Z")
];

test("renderiza os 12 meses, com dias corretos (inclusive bissexto)", () => {
  const meses = mesesDoAno(2028);
  assert.equal(meses.length, 12);
  assert.equal(meses[1]!.dias.filter(Boolean).length, 29);
  assert.equal(meses[0]!.dias.filter(Boolean).length, 31);
  // 01/01/2026 é quinta-feira: 4 espaços antes (D S T Q).
  assert.equal(mesesDoAno(2026)[0]!.dias.findIndex(Boolean), 4);
});

test("filtro por ano, contador e ordem cronológica — manual e Agenda Anual juntas", () => {
  const de2026 = reunioesDoAno(lista, 2026);
  assert.deepEqual(de2026.map((m) => m.id), ["a", "b", "c", "d"]);
  assert.equal(de2026.length, 4, "contador reflete só o ano");
  assert.ok(de2026.some((m) => m.origin === "annual_agenda"));
  assert.ok(de2026.some((m) => m.origin === "manual"));
});

test("mudança de ano troca a lista e o contador", () => {
  assert.deepEqual(reunioesDoAno(lista, 2027).map((m) => m.id), ["x"]);
  assert.equal(reunioesDoAno(lista, 2025).length, 0);
});

test("dias com reunião são indicados; rótulo compacto da lista", () => {
  const porDia = reunioesPorDia(reunioesDoAno(lista, 2026));
  assert.equal(porDia.get("2026-01-20")!.length, 1);
  assert.equal(porDia.has("2026-01-21"), false);
  assert.equal(rotuloCurto("2026-01-20", "pt"), "20 JAN");
  assert.equal(rotuloCurto("2026-02-17", "pt"), "17 FEV");
});

test("data sugerida para Nova reunião acompanha o ano exibido", () => {
  assert.equal(dataSugerida(2027, "2026-09-30", null), "2027-01-02");
  assert.equal(dataSugerida(2026, "2026-09-30", null), "2026-09-30");
  assert.equal(dataSugerida(2026, "2026-09-30", "2026-03-17"), "2026-03-17");
});

test("criação pelo Calendário continua sem Pauta/Tema", () => {
  const payload = buildNewMeetingPayload({
    sessionType: "ordinary",
    date: dataSugerida(2027, "2026-09-30", null),
    startTime: "09:00",
    endTime: "11:00",
    timezone: "America/Sao_Paulo",
    governanceBodyId: "g",
    modality: "online",
    physicalLocationKey: "",
    participants: []
  });
  assert.deepEqual(payload.agendaItems, []);
});

/** Fiação sem DOM: o projeto não tem render de React em teste. */
function fonte(caminho: string): string {
  // Sem comentários: a varredura enxerga código, não prosa.
  return readFileSync(new URL(caminho, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

test("clique em reunião no Calendário navega ao Pipeline (mesmo detalhe)", () => {
  const app = fonte("../App.tsx");
  const bloco = app.slice(app.indexOf("<CalendarView"), app.indexOf("/>", app.indexOf("<CalendarView")));
  assert.match(bloco, /onMeetingClick=\{abrirNoPipeline\}/);
  const fn = app.slice(app.indexOf("const abrirNoPipeline"), app.indexOf("};", app.indexOf("const abrirNoPipeline")));
  assert.match(fn, /setActiveTab\("pipeline"\)/);
  assert.match(fn, /openMeeting\(meet\)/);
  assert.ok(!fonte("../components/CalendarView.tsx").includes("updateMeeting"), "Calendário não edita reunião");
});

test("Nova reunião existe no Calendário e em nenhuma outra tela", () => {
  assert.match(fonte("../components/CalendarView.tsx"), /onNewMeeting\(dataSugerida/);
  const app = fonte("../App.tsx");
  assert.equal(app.split("setNewMeetingDate(date)").length - 1, 1, "só o Calendário abre o modal");
  for (const tela of ["DashboardView", "MeetingsView", "PipelineView", "AnnualAgendaView"]) {
    assert.ok(!/Nova reuni[aã]o|New meeting/i.test(fonte(`../components/${tela}.tsx`)), tela);
  }
});
