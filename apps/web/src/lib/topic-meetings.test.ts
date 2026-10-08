import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  alternarTodasVisiveis,
  consultaDaExportacaoDoTema,
  dataEHorario,
  ehFutura,
  filtrarReunioes,
  idsParaExportar,
  rotuloDoStatus,
  type ReuniaoDoTema
} from "./topic-meetings-rules";

const AGORA = new Date("2026-10-08T12:00:00Z");

const reuniao = (id: string, extra: Partial<ReuniaoDoTema> = {}): ReuniaoDoTema => ({
  meetingId: id,
  title: "Reunião Ordinária",
  startAt: "2026-11-10T13:00:00Z",
  endAt: "2026-11-10T15:00:00Z",
  timezone: "America/Sao_Paulo",
  governanceBody: "Diretoria Executiva",
  status: "scheduled",
  cancelled: false,
  sessionType: "ordinary",
  modality: "online",
  location: null,
  executionStatus: "pending",
  participantsCount: 3,
  ...extra
});

const futura = reuniao("a");
const passada = reuniao("b", {
  title: "Comitê de Auditoria — Fechamento",
  governanceBody: "Comitê de Auditoria",
  startAt: "2026-03-02T13:00:00Z",
  endAt: "2026-03-02T14:00:00Z",
  status: "done",
  executionStatus: "completed",
  modality: "in_person",
  location: "Sala 3 — Sede"
});
const cancelada = reuniao("c", { cancelled: true, startAt: "2026-05-01T13:00:00Z", endAt: "2026-05-01T14:00:00Z" });
const todas = [futura, passada, cancelada];

test("data e horário no fuso da reunião", () => {
  assert.deepEqual(dataEHorario(futura), { data: "10/11/2026", horario: "10:00–12:00" });
});

test("futura x passada pelo fim da reunião; cancelada tem rótulo próprio", () => {
  assert.equal(ehFutura(futura, AGORA), true);
  assert.equal(ehFutura(passada, AGORA), false);
  assert.equal(rotuloDoStatus(cancelada, "pt"), "Cancelada");
  assert.equal(rotuloDoStatus(passada, "pt"), "Realizada");
});

test("busca: sem acento/caixa, vários termos, sobre o que a linha mostra", () => {
  const ids = (busca: string, recorte: "todas" | "futuras" | "passadas" = "todas") =>
    filtrarReunioes(todas, busca, recorte, "pt", AGORA).map((r) => r.meetingId);
  assert.deepEqual(ids(""), ["a", "b", "c"]);
  assert.deepEqual(ids("COMITE auditoria"), ["b"]);
  assert.deepEqual(ids("sala 3"), ["b"]);
  assert.deepEqual(ids("presencial"), ["b"]);
  assert.deepEqual(ids("concluido"), ["b"]);
  assert.deepEqual(ids("cancelada"), ["c"]);
  assert.deepEqual(ids("10/11/2026"), ["a"]);
  assert.deepEqual(ids("", "futuras"), ["a"]);
  assert.deepEqual(ids("", "passadas"), ["b", "c"]);
  assert.deepEqual(ids("diretoria", "passadas"), ["c"]);
});

test("exportação: seleção > lista filtrada > tudo (servidor)", () => {
  assert.equal(idsParaExportar(todas, todas, new Set()), undefined);
  assert.deepEqual(idsParaExportar(todas, [passada], new Set()), ["b"]);
  assert.deepEqual(idsParaExportar(todas, [passada], new Set(["c", "a"])), ["a", "c"]);
  assert.equal(consultaDaExportacaoDoTema("pdf"), "format=pdf");
  assert.equal(consultaDaExportacaoDoTema("xlsx", ["a", "b"]), "format=xlsx&meetingIds=a%2Cb");
});

test("selecionar todas age sobre as visíveis e alterna", () => {
  const marcadas = alternarTodasVisiveis(new Set(["c"]), [futura, passada]);
  assert.deepEqual([...marcadas].sort(), ["a", "b", "c"]);
  assert.deepEqual([...alternarTodasVisiveis(marcadas, [futura, passada])], ["c"]);
});

test("o selo de reuniões do card abre o modal, que usa ModalShell", () => {
  const sem = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const view = sem("../components/UnlinkedAgendasView.tsx");
  assert.match(view, /<TopicMeetingsModal\b/);
  assert.match(view, /onClick=\{\(\) => setTemaDasReunioes\(agenda\)\}/);
  const modal = sem("../components/TopicMeetingsModal.tsx");
  assert.match(modal, /<ModalShell\b/);
  // Clicar numa reunião (fora da seleção) fecha o modal e abre o detalhe.
  assert.match(modal, /onClose\(\);\s*onOpenMeeting\(r\.meetingId\);/);
  assert.match(view, /onOpenMeeting=\{onOpenMeeting\}/);
  assert.match(sem("../App.tsx"), /<UnlinkedAgendasView[\s\S]*?onOpenMeeting=\{\(meetingId\) => void openMeetingById\(meetingId\)\}/);
});
