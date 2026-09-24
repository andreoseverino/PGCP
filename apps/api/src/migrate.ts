import "./env.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * Runner de migrations.
 *
 * Aplica os arquivos .sql de apps/api/migrations em ordem alfabetica, uma unica
 * vez cada, registrando o que ja foi aplicado em `schema_migrations`.
 * Cada migration roda na propria transacao: falha faz ROLLBACK e o schema nao
 * fica pela metade.
 *
 * O caminho resolve igual rodando por `tsx src/` ou por `node dist/`, porque
 * ambos ficam um nivel abaixo da raiz do pacote.
 *
 * CREDENCIAL SEPARADA DO RUNTIME. Migration cria e altera estrutura e concede
 * privilegios — trabalho do papel DONO (`pcgp_admin`), nunca do papel de runtime
 * (`pcgp_app`), que e propositalmente sem DDL. Por isso este runner tem pool
 * PROPRIO, com `DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD`. O fallback para
 * `DB_USER`/`DB_PASSWORD` preserva o setup minimo de desenvolvedor (um usuario
 * so); em producao as duas credenciais sao distintas.
 */
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_MIGRATION_USER ?? process.env.DB_USER,
  password: process.env.DB_MIGRATION_PASSWORD ?? process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === "true",
  connectionTimeoutMillis: 5000,
});

/** Chave arbitraria e fixa para o advisory lock deste runner. */
const LOCK_KEY = 4_150_723_001;

async function main(): Promise<void> {
  const client = await pool.connect();

  try {
    // Evidencia de QUEM aplica as migrations. Deve ser o papel de migration
    // (pcgp_admin), nunca o de runtime.
    const { rows: quem } = await client.query<{ user: string }>("SELECT current_user AS user");
    console.log(`Migrations aplicadas como: ${quem[0]!.user}`);

    // Impede que duas execucoes simultaneas apliquem a mesma migration.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log(`Nenhum arquivo .sql em ${migrationsDir}`);
      return;
    }

    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(rows.map((row) => row.version));

    let appliedNow = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = ${file} (ja aplicada)`);
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} falhou e foi revertida: ${message}`);
      }

      console.log(`  + ${file} aplicada`);
      appliedNow++;
    }

    console.log(
      appliedNow === 0
        ? "Nenhuma migration pendente."
        : `${appliedNow} migration(s) aplicada(s).`,
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {
      // Conexao ja pode ter caido; o lock e liberado ao encerrar a sessao.
    });
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
