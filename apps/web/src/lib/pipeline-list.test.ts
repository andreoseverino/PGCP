import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pendenciasDaReuniao } from "./pipeline-list";
import { meetingFromApi, type ApiMeetingSummary } from "./meeting-adapters";

const resumo = (extra: Partial<ApiMeetingSummary> = {}): ApiMeetingSummary => ({
  id: "m1", title: "Comitê", description: null,
  governanceBody: { id: "g1", name: "Comitê Executivo", chairEntraObjectId: null, chairName: null },
  organizer: null, startAt: "2026-10-20T12:00:00Z", endAt: "2026-10-20T14:00:00Z", timezone: "America/Sao_Paulo",
  meetingLink: null, onlineMeetingProvider: "teamsForBusiness", modality: "online", physicalLocation: null, origin: "manual",
  annualAgendaId: null, calendarSyncStatus: "synced", status: "scheduled",
  agendaValidation: { status: "draft", sentAt: null, sentTo: null, approvedAt: null },
  recurrence: null, pendingRequirements: null, participantsCount: 3, agendaItemsCount: 2,
  createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", ...extra
});

test("Pipeline (lista): só alerta o que o servidor permite determinar", () => {
  const ok = meetingFromApi(resumo({ agendaItemsWithoutDuration: 0, documentsCount: 4 }));
  assert.deepEqual(pendenciasDaReuniao(ok), []);
  assert.equal(ok.documentsCount, 4);
  assert.equal(meetingFromApi(resumo()).documentsCount, 0, "API antiga: zero, sem quebrar");

  const falhou = meetingFromApi(resumo({ calendarSyncStatus: "failed", agendaItemsWithoutDuration: 2 }));
  assert.deepEqual(pendenciasDaReuniao(falhou).map((p) => [p.tipo, p.texto, p.grave]), [
    ["convite_falhou", "Convite falhou", true],
    ["tema_sem_duracao", "2 temas sem duração", false]
  ]);
  const realizada = meetingFromApi(resumo({ status: "done", minutesStatus: "draft", calendarSyncStatus: "stale" }));
  assert.deepEqual(pendenciasDaReuniao(realizada).map((p) => p.tipo), ["convite_desatualizado", "ata_pendente"]);
  const fechada = meetingFromApi(resumo({ status: "done", minutesStatus: "approved" }));
  assert.deepEqual(pendenciasDaReuniao(fechada), []);
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("Pipeline (tela): visual da Agenda Anual; clique abre o detalhe; pendências e excluir no cartão", () => {
  const p = codigo("../components/PipelineView.tsx");
  assert.match(p, /grid-cols-1 lg:grid-cols-\[260px_minmax\(0,1fr\)\]/, "ano + órgãos à esquerda");
  assert.match(p, /onClick=\{\(\) => onOpenMeeting\(m\)\}/);
  // Só reuniões da versão APROVADA da Agenda Anual (calculado no servidor).
  assert.match(p, /m\.approvedInAnnualAgenda === true/);
  assert.match(p, /pendenciasDaReuniao\(m, language\)/);
  assert.match(p, /\{canSchedule && \([\s\S]*?e\.stopPropagation\(\);\s*onDeleteMeeting\(m\.id\)/, "excluir não abre o detalhe");
  assert.ok(!/Pipeline2|"Teste"/.test(p));
  const app = codigo("../App.tsx");
  assert.match(app, /case "pipeline":\s*return \(\s*<PipelineView/);
  assert.match(app, /onDeleteMeeting=\{handleDeleteMeeting\}/);
  assert.ok(!/pipeline2|Pipeline2|MeetingsView/.test(app));
  assert.ok(!/pipeline2/.test(codigo("../components/Sidebar.tsx")));
});
