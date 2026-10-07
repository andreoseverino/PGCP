import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import {
  consultarReunioesParaExportacao,
  descreverPeriodo,
  gerarPdfDoCalendario,
  gerarXlsxDoCalendario,
  linhaDaExportacao,
  nomeDoArquivoDaExportacao,
  parseFiltrosDeExportacao,
  type ReuniaoExportada,
} from "./export.js";
import { letraDaColuna, serialDaData } from "../reports/xlsx.js";
import { nomeDeArquivo } from "../reports/report-pdf.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { meetingsRouter } from "./routes.js";

const ID = "11111111-1111-4111-8111-111111111111";

const reuniao = (sobrescrever: Partial<ReuniaoExportada> = {}): ReuniaoExportada => ({
  id: ID,
  titulo: "=HYPERLINK(\"http://evil\") Reunião do Comitê",
  orgao: "Comitê Executivo",
  inicio: new Date("2027-01-01T01:30:00Z"), // 31/12/2026 22:30 em São Paulo
  fim: new Date("2027-01-01T03:00:00Z"),
  fuso: "America/Sao_Paulo",
  status: "scheduled",
  tipo: "ordinary",
  modalidade: "online",
  local: null,
  origem: "manual",
  convite: "synced",
  participantes: ["Ana", "Zé Externo"],
  externos: 1,
  temas: 3,
  ...sobrescrever,
});

/** Lê as entradas de um ZIP (só o necessário para conferir o .xlsx). */
function lerZip(buf: Buffer): Map<string, string> {
  const arquivos = new Map<string, string>();
  const fim = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const total = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  for (let i = 0; i < total; i++) {
    const tamanho = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + nomeLen).toString("utf8");
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    arquivos.set(nome, inflateRawSync(buf.subarray(inicio, inicio + tamanho)).toString("utf8"));
    p += 46 + nomeLen + extra + comentario;
  }
  return arquivos;
}

test("filtros: formato obrigatório, query fechada, datas validadas pelo mesmo parser da listagem", () => {
  assert.deepEqual(parseFiltrosDeExportacao({ format: "pdf" }), { formato: "pdf", governanceBodyId: undefined, dateFrom: undefined, dateTo: undefined });
  assert.deepEqual(parseFiltrosDeExportacao({ format: "xlsx", dateFrom: "2026-01-01", dateTo: "2026-12-31", governanceBodyId: ID }), {
    formato: "xlsx", governanceBodyId: ID, dateFrom: "2026-01-01", dateTo: "2026-12-31",
  });
  for (const q of [
    {}, { format: "csv" }, { format: "pdf", status: "done" }, { format: "pdf", limit: "5" }, { format: "pdf", dateFrom: "2026-02-30" },
    { format: "pdf", dateFrom: "2026-12-31", dateTo: "2026-01-01" }, { format: "pdf", governanceBodyId: "1 OR 1=1" }, { format: ["pdf", "xlsx"] },
  ]) {
    assert.throws(() => parseFiltrosDeExportacao(q as Record<string, unknown>), HttpError, JSON.stringify(q));
  }
});

test("linha: data/hora no fuso DA REUNIÃO; sem e-mail e sem descrição", () => {
  const l = linhaDaExportacao(reuniao());
  assert.deepEqual([l.data, l.inicio, l.fim, l.status, l.tipo, l.convite, l.origem], ["31/12/2026", "22:30", "00:00", "Agendada", "Ordinária", "Enviado", "Calendário"]);
  assert.equal(l.participantes, "Ana; Zé Externo");
  assert.ok(!JSON.stringify(l).includes("@"));
  assert.equal(descreverPeriodo({}), "Todo o calendário");
  assert.equal(descreverPeriodo({ dateFrom: "2026-01-01", dateTo: "2026-03-31" }), "01/01/2026 a 31/03/2026");
});

test("Excel: .xlsx válido, cabeçalho, filtro automático, data/hora numéricas e texto nunca vira fórmula", () => {
  const xlsx = gerarXlsxDoCalendario([reuniao(), reuniao({ titulo: "Segunda", inicio: new Date("2027-02-10T12:00:00Z"), fim: new Date("2027-02-10T13:00:00Z") })]);
  assert.equal(xlsx.subarray(0, 2).toString(), "PK");
  const zip = lerZip(xlsx);
  for (const parte of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(zip.has(parte), parte);
  }
  const folha = zip.get("xl/worksheets/sheet1.xml")!;
  assert.match(folha, /<autoFilter ref="A1:P3"\/>/);
  assert.match(folha, /Órgão de Governança/);
  assert.match(folha, /<c r="A2" s="2"><v>46387<\/v><\/c>/, "31/12/2026 como data do Excel");
  assert.match(folha, /<c r="B2" s="3"><v>0\.9375<\/v><\/c>/, "22:30 como hora");
  assert.ok(!/<f>/.test(folha), "nenhuma fórmula");
  assert.match(folha, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/evil&quot;\) Reunião/);
  assert.equal(serialDaData({ ano: 2026, mes: 12, dia: 31 }), 46387);
  assert.deepEqual([letraDaColuna(0), letraDaColuna(25), letraDaColuna(26)], ["A", "Z", "AA"]);
});

test("PDF do calendário: completo, vazio e muitas linhas", async () => {
  for (const lista of [[], [reuniao()], Array.from({ length: 80 }, (_, i) => reuniao({ titulo: `Reunião ${i}` }))]) {
    const pdf = await gerarPdfDoCalendario(lista, { periodo: "Todo o calendário", orgao: null });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }
});

test("nome do arquivo: montado no servidor, só ASCII, sem separador de caminho", () => {
  assert.equal(nomeDoArquivoDaExportacao({ formato: "pdf" }), "calendario-pgcp-completo.pdf");
  assert.equal(nomeDoArquivoDaExportacao({ formato: "xlsx", dateFrom: "2026-01-01", dateTo: "2026-06-30" }), "calendario-pgcp-2026-01-01-a-2026-06-30.xlsx");
  assert.equal(nomeDeArquivo(["../../etc/passwd", 'a"b\r\nc'], "pdf"), "etc-passwd-a-b-c.pdf");
});

test("rotas: exportar e versões são LEITURA (usuário ativo, sem papel); /export antes de /:id", () => {
  const pilha = (meetingsRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack;
  const rota = (caminho: string) => pilha.find((c) => c.route?.path === caminho && c.route.methods.get)!.route!;
  for (const caminho of ["/export", "/:id/versions", "/:id/versions/:versionId/pdf"]) {
    const handlers = rota(caminho).stack.map((s) => s.handle);
    assert.ok(handlers.includes(requireActivePgcpUser), caminho);
    assert.ok(!handlers.includes(requirePgcpAssessoria), caminho);
  }
  const ordem = pilha.map((c) => c.route?.path);
  assert.ok(ordem.indexOf("/export") < ordem.indexOf("/:id"));
  const fonte = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.match(fonte, /get\("\/export", requireActivePgcpUser, calendarExportRateLimit,/);
  // IDOR: a versão só é lida pelo par (reunião, versão).
  assert.match(readFileSync(new URL("./versions.ts", import.meta.url), "utf8"), /WHERE v\.id = \$2 AND v\.meeting_id = \$1/);
});

// Integração: o filtro chega ao SQL de verdade (banco local; pulado sem banco).
let semBanco: string | false = false;
try {
  await pool.query("SELECT 1");
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
// Registrado DEPOIS do await de topo: senão o hook roda antes deste teste.
after(() => pool.end());

test("integração: o conjunto exportado respeita período e órgão", { skip: semBanco }, async () => {
  const espectador = { userId: ID, entraTenantId: ID, entraObjectId: null };
  const todas = await consultarReunioesParaExportacao({ formato: "pdf" }, espectador);
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM meetings");
  assert.equal(todas.length, Math.min(rows[0]!.n, 2000), "sem período = calendário completo");
  const nenhuma = await consultarReunioesParaExportacao({ formato: "xlsx", dateFrom: "1990-01-01", dateTo: "1990-01-31" }, espectador);
  assert.equal(nenhuma.length, 0);
  if (todas[0]) {
    const alvo = todas[0];
    const dia = new Intl.DateTimeFormat("en-CA", { timeZone: alvo.fuso }).format(alvo.inicio);
    const doDia = await consultarReunioesParaExportacao({ formato: "pdf", dateFrom: dia, dateTo: dia }, espectador);
    assert.ok(doDia.some((r) => r.id === alvo.id));
    assert.ok(doDia.every((r) => new Intl.DateTimeFormat("en-CA", { timeZone: r.fuso }).format(r.inicio) === dia));
    const { rows: g } = await pool.query<{ governance_body_id: string }>("SELECT governance_body_id FROM meetings WHERE id = $1", [alvo.id]);
    const doOrgao = await consultarReunioesParaExportacao({ formato: "pdf", governanceBodyId: g[0]!.governance_body_id }, espectador);
    assert.ok(doOrgao.length >= 1 && doOrgao.every((r) => r.orgao === alvo.orgao));
  }
});
