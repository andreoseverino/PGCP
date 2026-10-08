import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { LIMITE_MAXIMO, LIMITE_PADRAO, palavrasDaBusca, parseFiltrosDeDocumentos } from "./service.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("filtros da biblioteca: query fechada e validada", () => {
  assert.deepEqual(parseFiltrosDeDocumentos({}), {
    q: undefined, governanceBodyId: undefined, meetingId: undefined, agendaItemId: undefined, topicId: undefined,
    annualAgendaId: undefined, authorUserId: undefined, year: undefined, month: undefined, day: undefined, type: undefined, source: undefined,
    format: undefined, favorites: undefined,
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
    { offset: "-1" }, { q: "x".repeat(201) }, { month: "13" }, { month: "0" }, { day: "32" }, { day: "0" }, { year: "26" }, { year: "2026.5" }, { meetingId: ["a", "b"] }, { agendaItemId: "tema" },
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
  // A biblioteca não grava nem apaga DOCUMENTO: a única escrita é o FAVORITO
  // (preferência pessoal, 037). Regex cobre `.put(` e `.put<...>(`.
  const escritas = [...r.matchAll(/documentsRouter\.(post|put|patch|delete)(?:<[^>]*>)?\("([^"]+)"/g)].map((x) => `${x[1]} ${x[2]}`);
  assert.deepEqual(escritas.sort(), ["delete /:id/favorite", "put /:id/favorite"]);
  const m = fonte("../meetings/routes.ts");
  assert.match(m, /meetingsRouter\.post\("\/:id\/documents", requirePgcpAssessoria,/);
  // Sem aprovação da Agenda Anual (10/2026): nenhuma guarda de "liberação" antes do upload.
  assert.ok(!m.includes("exigirLiberadaParaPipeline"));
  assert.match(m, /express\.raw\(\{ type: "application\/octet-stream", limit: maximo \}\)/);
});

test("documento não some: tema/reunião com documento não são excluídos (antes do Outlook)", () => {
  const u = fonte("../meetings/update.ts");
  const remover = u.slice(u.indexOf("export async function removeAgendaItem("));
  assert.ok(remover.indexOf("contarDocumentos(client, { agendaItemId })") < remover.indexOf("DELETE FROM meeting_agenda_items"));
  // Excluir reunião é CANCELAMENTO LÓGICO (036): nada é apagado, documentos ficam no histórico.
  const d = semComentarios(fonte("../meetings/delete.ts"));
  assert.ok(!/DELETE FROM meetings/.test(d));
  assert.match(fonte("../../migrations/033_documents.sql"), /meeting_id\s+uuid\s+REFERENCES meetings \(id\) ON DELETE RESTRICT/);
});

test("formato: derivado da extensão (mesma fonte do MIME); filtro e ordenação Z–A validados", async () => {
  const { formatoDaExtensao, FORMATOS } = await import("./service.js");
  assert.deepEqual(
    ["pdf", "DOCX", "xlsx", "pptx", "png", "mp4", "zip", null].map(formatoDaExtensao),
    ["pdf", "documento", "planilha", "apresentacao", "imagem", "video", "outros", "outros"],
  );
  assert.equal(parseFiltrosDeDocumentos({ format: "planilha" }).format, "planilha");
  assert.equal(parseFiltrosDeDocumentos({ favorites: "true" }).favorites, true);
  assert.equal(parseFiltrosDeDocumentos({ sort: "nome_desc" }).sort, "nome_desc");
  for (const q of [{ format: "exe" }, { format: "pdf' OR 1=1" }, { favorites: "false" }, { favorites: "1" }, { sort: "nome_asc" }]) {
    assert.throws(() => parseFiltrosDeDocumentos(q), HttpError, JSON.stringify(q));
  }
  assert.ok(FORMATOS.includes("outros"));
  // Extensões vão ao SQL como parâmetro (lista fechada), nunca concatenadas.
  const s = semComentarios(fonte("./service.ts"));
  assert.match(s, /d\.extension = ANY\(\$\{bind\(EXTENSOES_DO_FORMATO\[formato\]\)\}::text\[\]\)/);
});

test("favoritos: preferência pessoal; só favorita o que a pessoa VÊ; lista recortada pela visibilidade", async () => {
  const { parseChaveDoDocumento } = await import("./service.js");
  assert.equal(parseChaveDoDocumento(`doc:${ID.toUpperCase()}`), `doc:${ID}`);
  for (const ruim of ["doc:x", `outra:${ID}`, `doc:${ID}; DROP TABLE x`, "../etc", ID]) {
    assert.throws(() => parseChaveDoDocumento(ruim), HttpError, ruim);
  }
  const s = semComentarios(fonte("./service.ts"));
  const fav = s.slice(s.indexOf("export async function favoritarDocumento"), s.indexOf("export async function desfavoritarDocumento"));
  // Visibilidade (mesma CTE da Biblioteca) ANTES de gravar; fora do alcance = 404.
  assert.ok(fav.indexOf("clausulaDeReuniaoVisivel") < fav.indexOf("INSERT INTO document_favorites"));
  assert.match(fav, /throw new HttpError\(404, "Documento não encontrado\."\)/);
  // Lista de favoritos: só de quem pede, e sempre dentro da CTE de visibilidade.
  assert.match(s, /f\.user_id = \$\{bind\(espectador\.userId\)\} AND f\.document_key = d\.id/);
  const desfav = s.slice(s.indexOf("export async function desfavoritarDocumento"));
  assert.match(desfav, /WHERE user_id = \$1 AND document_key = \$2/);
  const r = semComentarios(fonte("./routes.ts"));
  assert.match(r, /documentsRouter\.put<\{ id: string \}>\("\/:id\/favorite", requireActivePgcpUser,/);
  assert.match(r, /documentsRouter\.get\("\/storage", requireActivePgcpUser,/);
});

test("armazenamento: só dados reais (contagens e bytes dos anexos visíveis), sem quota", () => {
  const s = semComentarios(fonte("./service.ts"));
  const arm = s.slice(s.indexOf("export async function resumoDoArmazenamento"), s.indexOf("const CHAVE_DO_DOCUMENTO"));
  assert.match(arm, /cteDosDocumentos\(visivel\)/);
  assert.ok(!/quota|limite|capacity|GB/i.test(arm));
});
