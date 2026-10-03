import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  aplicarFiltrosDaLista,
  CHAVE_DO_MODO,
  FILTROS_DA_LISTA_VAZIOS,
  lembrarModoDoPipeline,
  modoInicialDoPipeline,
  pendenciasDaReuniao
} from "./pipeline-list";
import { meetingFromApi, type ApiMeetingSummary } from "./meeting-adapters";

function armazenamento(inicial: Record<string, string> = {}) {
  const dados = new Map(Object.entries(inicial));
  return {
    dados,
    getItem: (k: string) => dados.get(k) ?? null,
    setItem: (k: string, v: string) => void dados.set(k, v)
  };
}

test("Pipeline: Lista é o padrão; a última escolha fica salva; storage quebrado cai na Lista", () => {
  assert.equal(modoInicialDoPipeline(armazenamento()), "list");
  assert.equal(modoInicialDoPipeline(null), "list");
  assert.equal(modoInicialDoPipeline(armazenamento({ [CHAVE_DO_MODO]: "board" })), "board");
  assert.equal(modoInicialDoPipeline(armazenamento({ [CHAVE_DO_MODO]: "lixo" })), "list");
  const s = armazenamento();
  lembrarModoDoPipeline("board", s);
  assert.equal(s.dados.get(CHAVE_DO_MODO), "board");
  const quebrado = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); } };
  assert.equal(modoInicialDoPipeline(quebrado), "list");
  assert.doesNotThrow(() => lembrarModoDoPipeline("list", quebrado));
});

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

test("Pipeline (lista): período, com pendências e convite com falha", () => {
  const a = { ...meetingFromApi(resumo({ id: "a", startAt: "2026-10-05T12:00:00Z" })) };
  const b = { ...meetingFromApi(resumo({ id: "b", startAt: "2026-10-20T12:00:00Z", calendarSyncStatus: "failed" })) };
  const c = { ...meetingFromApi(resumo({ id: "c", startAt: "2026-11-02T12:00:00Z", agendaItemsWithoutDuration: 1 })) };
  const ids = (f: Partial<typeof FILTROS_DA_LISTA_VAZIOS>) => aplicarFiltrosDaLista([a, b, c], { ...FILTROS_DA_LISTA_VAZIOS, ...f }).map((m) => m.id);
  assert.deepEqual(ids({}), ["a", "b", "c"]);
  assert.deepEqual(ids({ de: "2026-10-10", ate: "2026-10-31" }), ["b"]);
  assert.deepEqual(ids({ comPendencias: true }), ["b", "c"]);
  assert.deepEqual(ids({ conviteComFalha: true }), ["b"]);
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("Pipeline (tela): Lista padrão e primeira; Quadro mantido; colunas operacionais", () => {
  const p = codigo("../components/PipelineView.tsx");
  assert.match(p, /useState<ModoDoPipeline>\(\(\) => modoInicialDoPipeline\(\)\)/);
  assert.match(p, /lembrarModoDoPipeline\(novo\)/);
  assert.ok(p.indexOf('["list", List') < p.indexOf('["board", Columns3'), "Lista antes de Quadro");
  assert.match(p, /groupByStage\(filtradas\)/, "Quadro continua");
  const l = codigo("../components/MeetingsView.tsx");
  const colunas = ["t.colDate", "t.colMeeting", '"Órgão"', "t.colStatus", '"Temas"', "t.colExpected", '"Pendências"', '"Documentos"', "t.colActions"];
  const thead = l.slice(l.indexOf("<thead>"), l.indexOf("</thead>"));
  const pos = colunas.map((c) => thead.indexOf(c));
  assert.ok(pos.every((x, i) => x > 0 && (i === 0 || x > pos[i - 1]!)), `ordem das colunas: ${pos}`);
  assert.match(l, /pendenciasDaReuniao\(meet, language\)/);
  assert.match(l, /meet\.documentsCount \?\? 0/);
  for (const f of ['"Com pendências"', '"Convite com falha"', 'aria-label={language === "en" ? "From" : "De"}']) assert.ok(l.includes(f), f);
  assert.ok(!/getAgendaProgress/.test(l), "sem % local (não é dado do servidor)");
});
