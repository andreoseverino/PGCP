/**
 * Fail-fast de configuracao perigosa em PRODUCAO.
 *
 * Filosofia: e melhor a API NAO SUBIR do que subir insegura. Em producao,
 * combinacoes claramente perigosas viram erro fatal na inicializacao, com
 * mensagem clara do que corrigir — em vez de um servidor de pe que aceita
 * requisicao sem a protecao que se espera dele.
 *
 * So age quando `NODE_ENV=production`. Em desenvolvimento nada disto dispara: o
 * dev roda sem TLS, com CORS para localhost e, as vezes, sem Entra configurado —
 * tudo legitimo fora de producao.
 *
 * A funcao central e PURA (recebe o ambiente), para ser testavel sem process.
 */

export interface EnvLike {
  [key: string]: string | undefined;
}

function definido(valor: string | undefined): boolean {
  return typeof valor === "string" && valor.trim().length > 0;
}

/**
 * Lista os problemas de configuracao perigosos para producao. Vazia = seguro.
 *
 * NAO age fora de producao: chamadores decidem, mas a lista so e populada
 * quando `NODE_ENV=production`.
 */
export function collectProductionConfigIssues(env: EnvLike): string[] {
  if ((env.NODE_ENV ?? "").trim() !== "production") return [];

  const problemas: string[] = [];

  // 1. Entra precisa estar configurado: sem ele, toda rota protegida responde
  //    503 e a aplicacao nao autentica ninguem — nao pode ir a producao assim.
  for (const nome of ["ENTRA_TENANT_ID", "ENTRA_API_CLIENT_ID", "ENTRA_SPA_CLIENT_ID"]) {
    if (!definido(env[nome])) {
      problemas.push(`${nome} ausente: autenticacao Entra e obrigatoria em producao.`);
    }
  }

  // 2. CORS nao pode cair no default de desenvolvimento nem liberar localhost.
  const cors = env.CORS_ORIGIN;
  if (!definido(cors)) {
    problemas.push(
      "CORS_ORIGIN ausente: em producao a origem do frontend deve ser explicita (o default e localhost).",
    );
  } else {
    const origens = cors!.split(",").map((o) => o.trim().toLowerCase());
    if (origens.some((o) => o.includes("localhost") || o.includes("127.0.0.1"))) {
      problemas.push("CORS_ORIGIN contem localhost/127.0.0.1 em producao.");
    }
    if (origens.some((o) => o === "*")) {
      problemas.push('CORS_ORIGIN nao pode ser "*" em producao.');
    }
    if (origens.some((o) => o.startsWith("http://"))) {
      problemas.push("CORS_ORIGIN usa http:// (sem TLS) em producao; use https://.");
    }
  }

  // 3. TLS no banco: sem isso, credencial e dado trafegam em claro.
  if ((env.DB_SSL ?? "").trim() !== "true") {
    problemas.push("DB_SSL diferente de 'true' em producao: a conexao com o PostgreSQL deve exigir TLS.");
  }

  // 4. Documentos: o unico armazenamento e o AWS S3 (bucket privado). Sem ele,
  //    upload/download nao funcionam e nao existe armazenamento local de reserva.
  for (const nome of ["PGCP_DOCUMENTS_BUCKET", "AWS_REGION"]) {
    if (!definido(env[nome])) {
      problemas.push(`${nome} ausente: o armazenamento de documentos (AWS S3) e obrigatorio em producao.`);
    }
  }

  return problemas;
}

/**
 * Aborta a inicializacao quando ha configuracao perigosa em producao.
 *
 * Lanca — o chamador (server.ts) deixa o processo cair com codigo != 0, para o
 * orquestrador nao considerar a instancia saudavel.
 */
export function assertSafeProductionConfig(env: EnvLike = process.env): void {
  const problemas = collectProductionConfigIssues(env);
  if (problemas.length === 0) return;

  const detalhe = problemas.map((p) => `  - ${p}`).join("\n");
  // Nenhum valor de variavel e impresso — apenas o nome e o motivo.
  throw new Error(
    `Configuracao insegura para producao. A API nao vai subir ate corrigir:\n${detalhe}`,
  );
}
