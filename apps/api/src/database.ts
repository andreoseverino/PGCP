import { Pool } from "pg";

/**
 * Pool de conexoes com PostgreSQL.
 *
 * Depende apenas das variaveis DB_*, sem nada especifico do mecanismo de
 * provisionamento: funciona igual com o container local, com uma instalacao
 * nativa ou com um PostgreSQL gerenciado.
 */
const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === "true",
  // Evita que o health check fique pendurado quando o banco esta fora do ar.
  connectionTimeoutMillis: 5000,
});

// Erros em conexoes ociosas do pool sao emitidos aqui; sem este listener o
// processo cairia com uncaught exception se o banco reiniciasse.
pool.on("error", (error) => {
  console.error("Erro inesperado no pool do PostgreSQL:", error.message);
});

/**
 * Descreve o erro para log. Trata AggregateError porque o Node agrupa as
 * tentativas de IPv6 e IPv4 nele, e nesse caso `message` vem vazia.
 */
function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join("; ");
  }
  if (error instanceof Error) {
    const { code } = error as NodeJS.ErrnoException;
    return [code, error.message].filter(Boolean).join(" ");
  }
  return String(error);
}

/** Executa `SELECT 1` para confirmar que o banco responde. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    console.error("Falha ao conectar no PostgreSQL:", describeError(error));
    return false;
  }
}

export default pool;
