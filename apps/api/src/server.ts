import "./env.js";
import express from "express";
import { assertSafeProductionConfig } from "./config/production-guard.js";
import { requestId } from "./security/request-id.js";
import { logSecurityEvent, safeRoute } from "./security/security-log.js";
import { checkDatabaseConnection } from "./database.js";
import { governanceBodiesRouter, jsonErrorHandler } from "./governance-bodies/routes.js";
import { integrationsRouter } from "./integrations/routes.js";
import { meRouter } from "./me/routes.js";
import { meetingsRouter } from "./meetings/routes.js";
import { agendaTopicsRouter } from "./agenda-topics/routes.js";
import { actionItemsRouter } from "./action-items/routes.js";
import { calendarRouter } from "./calendar/routes.js";
import { directoryRouter } from "./directory/routes.js";
import { usersRouter } from "./users/routes.js";
import { auditLogsRouter } from "./audit/routes.js";

/*
 * FAIL-FAST antes de qualquer coisa. Em producao, configuracao perigosa
 * (Entra ausente, CORS de dev, banco sem TLS) aborta a inicializacao em vez de
 * subir a API insegura. Fora de producao, no-op.
 */
assertSafeProductionConfig();

const app = express();
const port = Number(process.env.PORT ?? 3333);

/*
 * Nao anunciar o servidor de aplicacao. `X-Powered-By: Express` e
 * reconhecimento gratuito: diz a versao da stack a quem procura CVE conhecido.
 */
app.disable("x-powered-by");

/*
 * Correlation id primeiro: todo log e todo cabecalho de resposta ja saem com o
 * `X-Request-Id`, permitindo rastrear a requisicao entre componentes.
 */
app.use(requestId);

/*
 * Cabecalhos de seguranca em TODA resposta, inclusive erro e 404.
 *
 * A API devolve JSON, nao HTML, mas os tres abaixo custam nada e fecham vetores
 * reais: `nosniff` impede o navegador de tratar uma resposta como script;
 * `X-Frame-Options: DENY` recusa embutir a API em iframe; `Referrer-Policy`
 * evita vazar a URL (com querystring) para terceiros. HSTS fica a cargo do
 * proxy TLS de producao — a API roda atras dele.
 */
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Origem do frontend em desenvolvimento. Lista explicita, nunca "*".
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    // `Authorization` e obrigatorio: sem ele o preflight bloqueia toda chamada
    // autenticada. A origem continua restrita a allowlist acima — nunca "*".
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json());
app.use(jsonErrorHandler);

app.get("/health", async (_req, res) => {
  const databaseConnected = await checkDatabaseConnection();

  // Nenhum dado de conexao (host, usuario, senha) e exposto na resposta.
  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "degraded",
    database: databaseConnected ? "connected" : "disconnected",
  });
});

app.use("/governance-bodies", governanceBodiesRouter);

/**
 * Painel de Integracoes. PROTEGIDO por `PGCP.Admin` — a guarda esta no proprio
 * router, nao rota a rota, entao rota nova nasce protegida por consequencia.
 *
 * Nenhuma resposta carrega valor de variavel secreta: variavel marcada como
 * secreta vira apenas `configured: true/false`. O que a guarda protege e a
 * TOPOLOGIA (host, porta, banco, tenant, client ids) e o disparo de verificacao
 * real em `POST /:id/test`, que alcanca rede e host externo.
 *
 * `/health` NAO passa por aqui e continua publico — e ele que responde a
 * monitoracao.
 */
app.use("/integrations", integrationsRouter);

/** Protegido: exige access token do Entra destinado a esta API. */
app.use("/me", meRouter);

/** Protegido: exige, alem do token, usuario do PGCP existente e ativo. */
app.use("/directory", directoryRouter);

/** Usuarios do PGCP (PostgreSQL). Distinto de /directory, que e o Graph. */
app.use("/users", usersRouter);

/**
 * Reunioes — leitura e escrita, com o PostgreSQL como unica fonte.
 *
 * Leitura exige usuario ativo; toda mutacao exige `PGCP.Assessoria`. Aqui
 * tambem ficam as sub-rotas de Anotacoes e Ata, montadas em `meetings/routes`
 * para que o `meetingId` venha SEMPRE do caminho e nunca do corpo.
 */
app.use("/meetings", meetingsRouter);

/**
 * Biblioteca de pautas reutilizaveis. Distinta de /meetings: aqui a pauta nao
 * tem contexto de reuniao. O vinculo entre as duas e
 * `meeting_agenda_items.agenda_topic_id`.
 */
app.use("/agenda-topics", agendaTopicsRouter);

/**
 * FUP. Atraso NAO e coluna: `due_date` e a unica data persistida, e "vencido"
 * sai da comparacao com current_date na leitura.
 */
app.use("/action-items", actionItemsRouter);

/**
 * Meu Calendario. Leitura da agenda do PROPRIO usuario, por On-Behalf-Of.
 *
 * Aberto a qualquer usuario ativo: ver a propria agenda nao e privilegio. Quem
 * AGENDA e controlado pelo App Role `PGCP.Assessoria`, em /meetings.
 */
app.use("/calendar", calendarRouter);

/**
 * Trilha corporativa. Somente leitura, restrita a `PGCP.Admin`.
 *
 * Escrita nao passa por rota: cada operacao de dominio grava a propria trilha
 * na transacao do ato. `audit_logs` e append-only.
 */
app.use("/audit-logs", auditLogsRouter);

/*
 * Rota inexistente -> 404 JSON, no formato das demais respostas de erro.
 *
 * Sem isto, o Express devolve uma pagina HTML padrao ("Cannot GET /x"), que
 * quebra o contrato do cliente (que espera JSON) e denuncia a stack.
 */
app.use((_req, res) => {
  res.status(404).json({ error: "Recurso não encontrado.", code: "not_found" });
});

/*
 * Handler de erro FINAL — assinatura de 4 argumentos, registrado por ultimo.
 *
 * Captura o que os try/catch das rotas nao pegam: erro de decodificacao de path
 * (`/meetings/%`), throw sincrono inesperado, falha em middleware. Sem ele, o
 * finalhandler do Express serializa a EXCECAO — com stack e caminho absoluto do
 * arquivo no disco — direto para o cliente. Aqui o detalhe fica no log do
 * servidor e o cliente recebe texto generico.
 *
 * A `Response` pode ja ter comecado a ser enviada; nesse caso delega ao handler
 * padrao, que encerra a conexao sem tentar reescrever o cabecalho.
 */
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(
    `[server] erro nao tratado (req ${req.id ?? "-"}):`,
    error instanceof Error ? error.stack ?? error.message : error,
  );
  // Evento de seguranca sem stack nem dado sensivel — so o tipo e o correlation
  // id, que casa com a stack completa no log do servidor.
  logSecurityEvent({
    type: "unexpected_error",
    message: "Erro inesperado na API.",
    requestId: req.id,
    principalOid: req.principal?.entraObjectId ?? null,
    route: safeRoute(req.method, req.originalUrl),
    status: 500,
    code: "internal_error",
  });
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: "Erro interno ao processar a solicitação.", code: "internal_error" });
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
