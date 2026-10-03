import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { LIMITE_MAXIMO, LIMITE_PADRAO, palavrasDaBusca, parseFiltrosDeDocumentos } from "./service.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("filtros da biblioteca: query fechada e validada", () => {
  assert.deepEqual(parseFiltrosDeDocumentos({}), {
    q: undefined, governanceBodyId: undefined, meetingId: undefined, agendaItemId: undefined, topicId: undefined,
    annualAgendaId: undefined, authorUserId: undefined, year: undefined, month: undefined, type: undefined, source: undefined,
    dateFrom: undefined, dateTo: undefined, sort: "recentes", limit: LIMITE_PADRAO, offset: 0,
  });
  const pasta = parseFiltrosDeDocumentos({ year: "2026", month: "10" });
  assert.deepEqual([pasta.year, pasta.month], [2026, 10]);
  const f = parseFiltrosDeDocumentos({
    q: " Promoção ", governanceBodyId: ID.toUpperCase(), meetingId: ID, agendaItemId: ID, topicId: ID, annualAgendaId: ID,
    authorUserId: ID, type: "anexo", source: "user", dateFrom: "2026-01-01", dateTo: "2026-12-31", sort: "nome", limit: "10", offset: "20",
  });
  assert.deepEqual([f.q, f.governanceBodyId, f.agendaItemId, f.type, f.source, f.sort, f.limit, f.offset], ["Promoção", ID, ID, "anexo", "user", "nome", 10, 20]);
  for (const q of [
    { path: "../../etc/passwd" }, { objectKey: "meetings/x" }, { governanceBodyId: "1 OR 1=1" }, { type: "exe" }, { source: "s3" },
    { sort: "random" }, { dateFrom: "01/01/2026" }, { dateTo: "2026-13-45" }, { limit: String(LIMITE_MAXIMO + 1) },
    { offset: "-1" }, { q: "x".repeat(201) }, { month: "13" }, { month: "0" }, { year: "26" }, { year: "2026.5" }, { meetingId: ["a", "b"] }, { agendaItemId: "tema" },
  ]) {
    assert.throws(() => parseFiltrosDeDocumentos(q), HttpError, JSON.stringify(q));
  }
});

test("busca por palavras: todas precisam aparecer; minúsculas; sem duplicar; no máximo 8", () => {
  assert.deepEqual(palavrasDaBusca("Promoção  OUTUBRO pptx"), ["promoção", "outubro", "pptx"]);
  assert.deepEqual(palavrasDaBusca("a a b"), ["a", "b"]);
  assert.equal(palavrasDaBusca("1 2 3 4 5 6 7 8 9 10").length, 8);
  assert.deepEqual(palavrasDaBusca(undefined), []);
});

const fonte = (arq: string) => readFileSync(new URL(arq, import.meta.url), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("biblioteca: PostgreSQL é a fonte (nunca o bucket); anexos + Atas + Agenda vigente numa consulta", () => {
  const s = fonte("./service.ts");
  assert.match(s, /clausulaDeReuniaoVisivel\("m", espectador, bind\)/);
  assert.match(s, /FROM documents doc/);
  assert.match(s, /btrim\(mm\.content\) <> ''/, "Ata vazia não é documento");
  assert.match(s, /WHERE v\.withdrawn_at IS NULL/);
  assert.match(s, /v\.version = \(SELECT max\(v2\.version\)/, "uma linha por Agenda (a versão vigente)");
  // Tema = o DESTA reunião (meeting_agenda_items), não o da Biblioteca.
  assert.match(s, /LEFT JOIN meeting_agenda_items i ON i\.id = doc\.meeting_agenda_item_id AND i\.meeting_id = doc\.meeting_id/);
  assert.ok(!/ListObjects|listObjects|object_key AS|objectKey:/.test(semComentarios(s)), "não lista bucket nem devolve chave");
  assert.match(s, /count\(\*\) OVER \(\)/);
  assert.match(s, /d\.context_month = /, "pasta Mês = mês da reunião (mesmo critério da árvore)");
  assert.match(s, /replace\(\/\[\\\\%_\]\/g/, "curingas do LIKE escapados");
  // Upload: valida → S3 → metadado; falha no metadado remove o objeto (compensação).
  const up = s.slice(s.indexOf("export async function adicionarDocumentoDaReuniao"), s.indexOf("export async function lerDocumento"));
  const ordem = ["validarArquivo(", "exigirArmazenamento()", "armazenamento.gravar(", "INSERT INTO documents", "armazenamento.remover(chave)"];
  let anterior = -1;
  for (const passo of ordem) {
    const pos = up.indexOf(passo);
    assert.ok(pos > anterior, passo);
    anterior = pos;
  }
  assert.match(up, /i\.meeting_id = m\.id/, "tema precisa ser da mesma reunião");
  // Download: autoriza pelo contexto antes de ler o S3.
  const down = s.slice(s.indexOf("export async function lerDocumento"));
  assert.ok(down.indexOf("clausulaDeReuniaoVisivel") < down.indexOf("exigirArmazenamento().ler"));
});

test("rotas: listar/árvore/baixar com usuário ativo; upload só no Pipeline (Assessoria + guarda de liberação)", () => {
  const r = semComentarios(fonte("./routes.ts"));
  assert.match(r, /documentsRouter\.get\("\/", requireActivePgcpUser,/);
  assert.match(r, /documentsRouter\.get\("\/tree", requireActivePgcpUser,/);
  assert.match(r, /documentsRouter\.get<\{ id: string \}>\("\/:id\/download", requireActivePgcpUser,/);
  assert.match(r, /Content-Disposition", contentDisposition\(doc\.nome\)/);
  assert.match(r, /"Cache-Control", "private, no-store"/);
  assert.ok(!/\.post\(|\.put\(|\.patch\(|\.delete\(/.test(r), "a biblioteca não grava nem apaga");
  const m = fonte("../meetings/routes.ts");
  assert.match(m, /meetingsRouter\.post\("\/:id\/documents", requirePgcpAssessoria,/);
  assert.ok(m.indexOf('meetingsRouter.use("/:id", exigirLiberadaParaPipeline())') < m.indexOf('meetingsRouter.post("/:id/documents"'));
  assert.match(m, /express\.raw\(\{ type: "application\/octet-stream", limit: maximo \}\)/);
});

test("documento não some: tema/reunião com documento não são excluídos (antes do Outlook)", () => {
  const u = fonte("../meetings/update.ts");
  const remover = u.slice(u.indexOf("export async function removeAgendaItem("));
  assert.ok(remover.indexOf("contarDocumentos(client, { agendaItemId })") < remover.indexOf("DELETE FROM meeting_agenda_items"));
  const d = fonte("../meetings/delete.ts");
  assert.ok(d.indexOf("contarDocumentos(pool, { meetingId })") < d.indexOf("cancelarEventoOutlook("));
});
