import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { meetingFromApi, type ApiMeetingSummary } from "./meeting-adapters";

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("contrato: cancelamento lógico chega à tela (ausente = ativa)", () => {
  const base = { id: "m", title: "t", description: null, governanceBody: { id: "g", name: "G", chairEntraObjectId: null, chairName: null },
    organizer: null, startAt: "2026-10-20T12:00:00Z", endAt: "2026-10-20T13:00:00Z", timezone: "America/Sao_Paulo",
    meetingLink: null, onlineMeetingProvider: "teamsForBusiness", modality: "online", physicalLocation: null, origin: "manual",
    annualAgendaId: null, calendarSyncStatus: "synced", status: "scheduled",
    agendaValidation: { status: "draft", sentAt: null, sentTo: null, approvedAt: null }, recurrence: null, pendingRequirements: null,
    participantsCount: 0, agendaItemsCount: 0, createdAt: "", updatedAt: "" } as unknown as ApiMeetingSummary;
  assert.equal(meetingFromApi(base).cancelledAt, null);
  assert.equal(meetingFromApi({ ...base, cancelledAt: "2026-10-06T12:00:00Z" }).cancelledAt, "2026-10-06T12:00:00Z");
});

test("reunião cancelada: somente leitura na tela, aviso de histórico, exclusão explica o cancelamento", () => {
  const app = codigo("../App.tsx");
  assert.match(app, /canSchedule=\{usuarioPodeAgendar && !selectedMeeting\.cancelledAt\}/);
  assert.match(app, /resultado\.calendarCancellation === "pending"/);
  assert.ok(app.includes("Versões, documentos, Ata e auditoria ficam preservados como histórico"));
  const detalhe = codigo("../components/MeetingDetailView.tsx");
  assert.match(detalhe, /\{meeting\.cancelledAt && \(/);
});
