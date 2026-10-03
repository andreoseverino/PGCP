import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { LIMITE_MAXIMO, LIMITE_PADRAO, parseFiltrosDeDocumentos } from "./service.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("filtros da biblioteca: query fechada e validada", () => {
  assert.deepEqual(parseFiltrosDeDocumentos({}), {
    q: undefined, governanceBodyId: undefined, meetingId: undefined, topicId: undefined, authorUserId: undefined,
    type: undefined, dateFrom: undefined, dateTo: undefined, sort: "recentes", limit: LIMITE_PADRAO, offset: 0,
  });
  const f = parseFiltrosDeDocumentos({
    q: " Promoção ", governanceBodyId: ID.toUpperCase(), meetingId: ID, topicId: ID, authorUserId: ID,
    type: "ata", dateFrom: "2026-01-01", dateTo: "2026-12-31", sort: "nome", limit: "10", offset: "20",
  });
  assert.deepEqual([f.q, f.governanceBodyId, f.type, f.sort, f.limit, f.offset], ["Promoção", ID, "ata", "nome", 10, 20]);
  for (const q of [
    { path: "../../etc/passwd" }, { file: "x" }, { governanceBodyId: "1 OR 1=1" }, { type: "exe" }, { sort: "random" },
    { dateFrom: "01/01/2026" }, { dateTo: "2026-13-45" }, { limit: String(LIMITE_MAXIMO + 1) }, { offset: "-1" },
    { q: "x".repeat(201) }, { meetingId: ["a", "b"] },
  ]) {
    assert.throws(() => parseFiltrosDeDocumentos(q), HttpError, JSON.stringify(q));
  }
});

const fonte = (arq: string) => readFileSync(new URL(arq, import.meta.url), "utf8");

test("biblioteca: só documentos que o PGCP já persiste, sem cópia nem caminho de arquivo", () => {
  const s = fonte("./service.ts");
  // Leitura herda a política de reunião; prévia da Agenda não é documento.
  assert.match(s, /clausulaDeReuniaoVisivel\("m", espectador, bind\)/);
  assert.match(s, /WHERE v\.withdrawn_at IS NULL/);
  assert.match(s, /v\.version = \(SELECT max\(v2\.version\)/, "uma linha por Agenda (a versão vigente)");
  assert.match(s, /btrim\(mm\.content\) <> ''/, "Ata vazia não é documento");
  assert.ok(!/INSERT INTO|UPDATE \w+ SET|DELETE FROM|bytea|readFile|createReadStream|path\.join/.test(s.replace(/\/\*[\s\S]*?\*\//g, "")));
  // Uma consulta (CTE + paginação), nada de consulta por documento.
  assert.equal((s.match(/pool\.query/g) ?? []).length, 1);
  assert.match(s, /count\(\*\) OVER \(\)/);
  // Tema = tratado NA reunião do documento (não se inventa documento de tema).
  assert.match(s, /i\.agenda_topic_id = /);
  // Busca textual escapa curingas do LIKE.
  assert.match(s, /replace\(\/\[\\\\%_\]\/g/);
  const r = fonte("./routes.ts");
  assert.match(r, /documentsRouter\.get\("\/", requireActivePgcpUser,/);
  assert.ok(!/\.post\(|\.put\(|\.patch\(|\.delete\(|multer|upload/i.test(r.replace(/\/\*[\s\S]*?\*\//g, "")), "sem upload nesta versão");
});
