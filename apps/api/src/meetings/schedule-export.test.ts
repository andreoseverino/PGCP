import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import type { ReuniaoExportada } from "./export.js";
import { gerarPdfDoCronograma, gradeDoCronograma, MESES, parseFiltrosDoCronograma } from "./schedule-export.js";

const reuniao = (orgao: string, inicioIso: string, extra: Partial<ReuniaoExportada> = {}): ReuniaoExportada => ({
  id: inicioIso,
  titulo: "Reunião",
  orgao,
  inicio: new Date(inicioIso),
  fim: new Date(new Date(inicioIso).getTime() + 3_600_000),
  fuso: "America/Sao_Paulo",
  status: "scheduled",
  tipo: "ordinary",
  modalidade: "online",
  local: null,
  origem: "manual",
  convite: null,
  participantes: [],
  externos: 0,
  temas: 0,
  ...extra,
});

test("cronograma: grade órgão × mês no dia LOCAL da reunião; extraordinária marcada; ordem alfabética", () => {
  const grade = gradeDoCronograma(
    [
      reuniao("Comitê de Pessoas", "2026-10-03T11:00:00Z"),
      reuniao("Assembleia Geral", "2026-10-07T19:00:00Z"),
      reuniao("Comitê de Pessoas", "2026-03-10T12:00:00Z", { tipo: "extraordinary" }),
      // 01/01/2027 01:30Z = 31/12/2026 22:30 em São Paulo: conta em DEZ/2026.
      reuniao("Assembleia Geral", "2027-01-01T01:30:00Z"),
      // Fora do ano local: ignorada.
      reuniao("Assembleia Geral", "2026-01-01T02:00:00Z"),
    ],
    2026,
  );
  assert.deepEqual(grade.map((l) => l.orgao), ["Assembleia Geral", "Comitê de Pessoas"]);
  const [assembleia, pessoas] = grade;
  assert.equal(assembleia!.meses.length, 12);
  assert.deepEqual(assembleia!.meses[9], ["07 · 16:00"]);
  assert.deepEqual(assembleia!.meses[11], ["31 · 22:30"]);
  assert.equal(assembleia!.total, 2);
  assert.deepEqual(pessoas!.meses[2], ["10 · 09:00 (E)"]);
  assert.deepEqual(pessoas!.meses[9], ["03 · 08:00"]);
  assert.equal(MESES[9], "OUT");
});

test("cronograma: parâmetros fechados; ano obrigatório", () => {
  assert.deepEqual(parseFiltrosDoCronograma({ year: "2026" }), { ano: 2026, governanceBodyId: undefined });
  for (const q of [{}, { year: "26" }, { year: "abc" }, { year: "2026", format: "xlsx" }, { year: "2026", governanceBodyId: "x" }]) {
    assert.throws(() => parseFiltrosDoCronograma(q), HttpError, JSON.stringify(q));
  }
});

test("cronograma: gera PDF (inclusive sem reuniões)", async () => {
  for (const linhas of [gradeDoCronograma([reuniao("Comitê", "2026-05-05T12:00:00Z")], 2026), []]) {
    const pdf = await gerarPdfDoCronograma(linhas, { ano: 2026, orgao: null });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }
});

test("cronograma: rota de leitura registrada antes de /:id, com papel de usuário ativo e limite", async () => {
  const { meetingsRouter } = await import("./routes.js");
  const { requireActivePgcpUser } = await import("../users/middleware.js");
  const pilha = (meetingsRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
  }).stack;
  const i = pilha.findIndex((c) => c.route?.path === "/export/schedule" && c.route.methods.get);
  const j = pilha.findIndex((c) => c.route?.path === "/:id" && c.route.methods.get);
  assert.ok(i >= 0 && (j < 0 || i < j));
  assert.ok(pilha[i]!.route!.stack.some((s) => s.handle === requireActivePgcpUser));
});

test("Pipeline: reunião só conta como aprovada se estiver no SNAPSHOT da versão aprovada da Agenda Anual", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  assert.match(fonte, /v\.annual_agenda_id = m\.annual_agenda_id\s*AND v\.approved_at IS NOT NULL\s*AND v\.snapshot -> 'reunioes' @> jsonb_build_array\(jsonb_build_object\('meetingId', m\.id::text\)\)/);
  assert.match(fonte, /approvedInAnnualAgenda: row\.approved_in_annual_agenda === true/);
});

test("dossiê da reunião: rota de leitura (usuário ativo + limite) e seções completas no PDF", async () => {
  const { readFileSync } = await import("node:fs");
  const { meetingsRouter } = await import("./routes.js");
  const { requireActivePgcpUser } = await import("../users/middleware.js");
  const pilha = (meetingsRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
  }).stack;
  const rota = pilha.find((c) => c.route?.path === "/:id/export/pdf" && c.route.methods.get)?.route;
  assert.ok(rota);
  assert.ok(rota.stack.some((s) => s.handle === requireActivePgcpUser));
  const fonte = readFileSync(new URL("./meeting-export.ts", import.meta.url), "utf8");
  for (const s of ["Resumo executivo", "Descrição", "Participantes (", "Pauta: ", "Documentos anexados (", "FUP — acompanhamentos (", "Ata, aprovação das pautas e convite", "Histórico de versões ("]) {
    assert.ok(fonte.includes(s), s);
  }
  // Leitura pela mesma política do detalhe.
  assert.match(fonte, /const d = await findMeeting\(meetingId\)/);
});

test("trocar organizador: cancela na caixa antiga ANTES de gravar; envia pela nova DEPOIS do COMMIT; só Assessoria", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("./organizer-change.ts", import.meta.url), "utf8");
  const ordem = ["cancelarEventoNoGraph(antes.organizer_entra_object_id", 'client.query("BEGIN")', "UPDATE meetings", "idempotency_key = gen_random_uuid()", "versionarReuniaoSeMudou(client", "recordAuditIn(client", 'client.query("COMMIT")', "syncMeetingCalendar(meetingId"];
  const pos = ordem.map((t) => fonte.indexOf(t));
  assert.ok(pos.every((p) => p >= 0), String(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  const { parseTrocaDeOrganizador } = await import("./organizer-change.js");
  assert.throws(() => parseTrocaDeOrganizador({ organizer: { displayName: "x" } }));
  assert.throws(() => parseTrocaDeOrganizador({ organizer: { entraObjectId: "11111111-1111-4111-8111-111111111111", displayName: "A" }, outro: 1 }));
  const { meetingsRouter } = await import("./routes.js");
  const { requirePgcpAssessoria } = await import("../authz/app-roles.js");
  const rota = (meetingsRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack
    .find((c) => c.route?.path === "/:id/organizer" && c.route.methods.put)?.route;
  assert.ok(rota && rota.stack.some((s) => s.handle === requirePgcpAssessoria));
});
