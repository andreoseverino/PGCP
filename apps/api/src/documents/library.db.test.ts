import "../env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pool from "../database.js";
import { favoritarDocumento, listarDocumentos, parseFiltrosDeDocumentos, resumoDoArmazenamento } from "./service.js";

/**
 * Integração SOMENTE LEITURA com o PostgreSQL local: o SQL novo da Biblioteca
 * (formato, favoritos, Z–A, armazenamento) roda de verdade. Nada é gravado.
 */
let semBanco: string | false = false;
let userId = "";
try {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE is_active LIMIT 1");
  const { rows: t } = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'document_favorites'");
  if (!rows[0]) semBanco = "sem usuário ativo";
  else if (t.length === 0) semBanco = "migration 037 não aplicada";
  else userId = rows[0].id;
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

const espectador = () => ({ userId, entraTenantId: "00000000-0000-4000-8000-000000000000", entraObjectId: null });

test("integração: filtros novos executam e respeitam o recorte", { skip: semBanco }, async () => {
  const todos = await listarDocumentos(parseFiltrosDeDocumentos({}), espectador());
  for (const d of todos.documents) {
    assert.equal(typeof d.favorite, "boolean");
    assert.ok(["pdf", "documento", "planilha", "apresentacao", "imagem", "video", "outros"].includes(d.format));
  }
  const pdfs = await listarDocumentos(parseFiltrosDeDocumentos({ format: "pdf" }), espectador());
  assert.ok(pdfs.documents.every((d) => d.format === "pdf"));
  assert.ok(pdfs.total <= todos.total);
  const favoritos = await listarDocumentos(parseFiltrosDeDocumentos({ favorites: "true" }), espectador());
  assert.ok(favoritos.documents.every((d) => d.favorite));
  const az = await listarDocumentos(parseFiltrosDeDocumentos({ sort: "nome" }), espectador());
  const za = await listarDocumentos(parseFiltrosDeDocumentos({ sort: "nome_desc" }), espectador());
  assert.equal(za.total, az.total);
  // Z–A: cada nome >= o seguinte, pela collation do PRÓPRIO banco.
  for (let i = 1; i < za.documents.length; i++) {
    const { rows } = await pool.query<{ ok: boolean }>("SELECT $1::text >= $2::text AS ok", [za.documents[i - 1]!.name, za.documents[i]!.name]);
    assert.ok(rows[0]!.ok, `${za.documents[i - 1]!.name} >= ${za.documents[i]!.name}`);
  }
  const arm = await resumoDoArmazenamento(espectador());
  assert.equal(arm.documents, todos.total);
  assert.equal(arm.attachments + arm.generated, arm.documents);
  assert.equal(arm.byFormat.reduce((s, f) => s + f.documents, 0), arm.documents);
});

test("integração: favoritar documento inexistente/fora do alcance = 404 (nada gravado)", { skip: semBanco }, async () => {
  const antes = (await pool.query("SELECT count(*)::int AS n FROM document_favorites")).rows[0].n;
  await assert.rejects(
    favoritarDocumento("doc:99999999-9999-4999-8999-999999999999", espectador()),
    (e: unknown) => (e as { status?: number }).status === 404,
  );
  const depois = (await pool.query("SELECT count(*)::int AS n FROM document_favorites")).rows[0].n;
  assert.equal(depois, antes);
});
