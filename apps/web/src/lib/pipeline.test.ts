import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByStage, originLabel, pipelineStage, temasPorPauta } from "./pipeline";
import { meetingFromApi, type ApiMeetingSummary } from "./meeting-adapters";

const resumo = (extra: Partial<ApiMeetingSummary> = {}): ApiMeetingSummary => ({
  id: "m1",
  title: "Comitê",
  description: null,
  governanceBody: { id: "g1", name: "Comitê Executivo", chairEntraObjectId: null, chairName: null },
  organizer: null,
  startAt: "2027-01-20T12:00:00Z",
  endAt: "2027-01-20T14:00:00Z",
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
  participantsCount: 3,
  agendaItemsCount: 0,
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  ...extra
});

test("reunião manual e reunião da Agenda Anual aparecem no Pipeline", () => {
  const manual = meetingFromApi(resumo({ id: "a", origin: "manual" }));
  const anual = meetingFromApi(resumo({ id: "b", origin: "annual_agenda", annualAgendaId: "aa1" }));
  const grupos = groupByStage([manual, anual]);
  assert.deepEqual(grupos.scheduled.map((m) => m.id).sort(), ["a", "b"]);
  assert.equal(anual.origin, "annual_agenda");
  assert.equal(originLabel(anual.origin, "pt"), "Agenda Anual");
  assert.equal(originLabel(manual.origin, "pt"), "Calendário");
});

test("etapas derivadas dos estados existentes, sem status novo", () => {
  const etapa = (extra: Partial<ApiMeetingSummary>) => pipelineStage(meetingFromApi(resumo(extra)));
  assert.equal(etapa({}), "scheduled");
  assert.equal(etapa({ agendaItemsCount: 2 }), "preparing");
  assert.equal(
    etapa({ agendaValidation: { status: "sent", sentAt: "x", sentTo: "a@b.co", approvedAt: null } }),
    "preparing"
  );
  assert.equal(
    etapa({ agendaItemsCount: 2, agendaValidation: { status: "approved", sentAt: "x", sentTo: "a@b.co", approvedAt: "y" } }),
    "ready"
  );
  assert.equal(etapa({ status: "in_progress" }), "ready");
  assert.equal(etapa({ status: "done" }), "done");
  assert.equal(etapa({ status: "closed" }), "done");
});

test("resumo legado sem campos novos continua legível (online, manual)", () => {
  const legado = { ...resumo() } as Partial<ApiMeetingSummary>;
  delete legado.modality;
  delete legado.origin;
  const m = meetingFromApi(legado as ApiMeetingSummary);
  assert.equal(m.modality, "online");
  assert.equal(m.origin, "manual");
});

test("Reunião -> Pauta -> Tema: temas agrupados pela pauta, soltos ao final", () => {
  const agendas = [
    { id: "p2", title: "Auditoria", position: 2 },
    { id: "p1", title: "Finanças", position: 1 }
  ];
  const tema = (id: string, agendaId?: string) => ({ id, title: id, time: "", duration: "", author: "", agendaId });
  const grupos = temasPorPauta(agendas, [tema("t1", "p1"), tema("t2", "p2"), tema("t3"), tema("t4", "p1")]);
  assert.deepEqual(
    grupos.map((g) => [g.agenda?.title ?? null, g.temas.map((t) => t.id)]),
    [
      ["Finanças", ["t1", "t4"]],
      ["Auditoria", ["t2"]],
      [null, ["t3"]]
    ]
  );
});

test("tema apontando para pauta desconhecida não some: vai para 'sem pauta'", () => {
  const grupos = temasPorPauta([], [{ id: "t1", title: "x", time: "", duration: "", author: "", agendaId: "outra" }]);
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0]!.agenda, null);
});
