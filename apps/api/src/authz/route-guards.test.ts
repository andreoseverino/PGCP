import assert from "node:assert/strict";
import { test } from "node:test";
import { requireEntraAuth } from "../entra/middleware.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requireAssessoriaOuAdmin, requirePgcpAdmin, requirePgcpAssessoria } from "./app-roles.js";
import { actionItemsRouter } from "../action-items/routes.js";
import { agendaTopicsRouter } from "../agenda-topics/routes.js";
import { auditLogsRouter } from "../audit/routes.js";
import { calendarRouter } from "../calendar/routes.js";
import { directoryRouter } from "../directory/routes.js";
import { governanceBodiesRouter } from "../governance-bodies/routes.js";
import { integrationsRouter } from "../integrations/routes.js";
import { meRouter } from "../me/routes.js";
import { meetingsRouter } from "../meetings/routes.js";
import { usersRouter } from "../users/routes.js";

/**
 * MATRIZ DE AUTORIZACAO POR ROTA.
 *
 * O que estes testes protegem nao e a logica de um guard — isso e
 * `app-roles.test.ts` — e sim a FIACAO: qual rota exige qual papel.
 *
 * A regressao real e esta: alguem acrescenta uma rota de mutacao e esquece o
 * middleware. A rota nasce aberta a qualquer usuario autenticado, nenhum teste
 * de unidade percebe, e o defeito so aparece em producao. Aqui a rota nova sem
 * guarda quebra a suite.
 *
 * A verificacao e por IDENTIDADE de funcao (`handle === requirePgcpAssessoria`),
 * nao por nome: os guards sao closures devolvidas por `requireAppRole`, entao
 * `fn.name` e vazio e comparar string nao funcionaria.
 *
 * Sem HTTP, sem banco, sem rede: apenas a pilha de middlewares que o Express
 * montou ao importar cada router.
 */

// --- introspeccao do Express -------------------------------------------------

interface CamadaExpress {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: unknown;
}

interface Rota {
  metodo: string;
  caminho: string;
  /** Todos os middlewares e handlers registrados para esta rota, em ordem. */
  handlers: unknown[];
}

function camadas(router: unknown): CamadaExpress[] {
  const pilha = (router as { stack?: CamadaExpress[] }).stack;
  assert.ok(Array.isArray(pilha), "router do Express deve expor `stack`");
  return pilha;
}

/** Rotas declaradas no router (nao inclui middleware de nivel de router). */
function rotasDe(router: unknown): Rota[] {
  const encontradas: Rota[] = [];
  for (const camada of camadas(router)) {
    if (!camada.route) continue;
    for (const metodo of Object.keys(camada.route.methods)) {
      encontradas.push({
        metodo: metodo.toUpperCase(),
        caminho: camada.route.path,
        handlers: camada.route.stack.map((s) => s.handle),
      });
    }
  }
  return encontradas;
}

/** Middlewares aplicados ao router inteiro via `router.use(...)`. */
function middlewaresDe(router: unknown): unknown[] {
  return camadas(router)
    .filter((camada) => !camada.route)
    .map((camada) => camada.handle);
}

const MUTANTES = ["POST", "PATCH", "PUT", "DELETE"];

const rotulo = (r: Rota): string => `${r.metodo} ${r.caminho}`;

/** Guards conhecidos do PGCP. Uma rota precisa de pelo menos um. */
const GUARDS = [
  requireEntraAuth,
  requireActivePgcpUser,
  requirePgcpAssessoria,
  requirePgcpAdmin,
  requireAssessoriaOuAdmin,
];

const ROUTERS: Array<[string, unknown]> = [
  ["meetings", meetingsRouter],
  ["agenda-topics", agendaTopicsRouter],
  ["action-items", actionItemsRouter],
  ["audit-logs", auditLogsRouter],
  ["calendar", calendarRouter],
  ["directory", directoryRouter],
  ["governance-bodies", governanceBodiesRouter],
  ["integrations", integrationsRouter],
  ["me", meRouter],
  ["users", usersRouter],
];

// --- rede de seguranca geral -------------------------------------------------

test("NENHUMA rota fica sem guarda de autenticacao", () => {
  const desprotegidas: string[] = [];

  for (const [nome, router] of ROUTERS) {
    const doRouter = middlewaresDe(router);
    // Guarda no proprio router protege todas as rotas dele por consequencia.
    if (doRouter.some((mw) => GUARDS.includes(mw as never))) continue;

    for (const rota of rotasDe(router)) {
      if (!rota.handlers.some((h) => GUARDS.includes(h as never))) {
        desprotegidas.push(`${nome}: ${rotulo(rota)}`);
      }
    }
  }

  assert.deepEqual(
    desprotegidas,
    [],
    `rota sem guarda de autenticacao (so /health e publico, e ele vive em server.ts):\n${desprotegidas.join("\n")}`,
  );
});

// --- /meetings ---------------------------------------------------------------

test("meetings: TODA mutacao exige PGCP.Assessoria", () => {
  const semGuarda = rotasDe(meetingsRouter)
    .filter((r) => MUTANTES.includes(r.metodo))
    .filter((r) => !r.handlers.includes(requirePgcpAssessoria))
    .map(rotulo);

  assert.deepEqual(semGuarda, [], `mutacao de reuniao sem PGCP.Assessoria: ${semGuarda.join(", ")}`);
  // Guarda contra a suite passar por nao existir mutacao nenhuma.
  assert.ok(rotasDe(meetingsRouter).filter((r) => MUTANTES.includes(r.metodo)).length >= 10);
});

test("meetings: leitura exige usuario ativo, e nao papel", () => {
  // Ler e corporativo (ver `meetings/visibility.ts`); escrever e da Assessoria.
  for (const rota of rotasDe(meetingsRouter).filter((r) => r.metodo === "GET")) {
    assert.ok(
      rota.handlers.includes(requireActivePgcpUser),
      `${rotulo(rota)} deveria exigir usuario ativo`,
    );
    assert.ok(
      !rota.handlers.includes(requirePgcpAssessoria),
      `${rotulo(rota)} nao deveria exigir papel para leitura`,
    );
  }
});

test("meetings: as rotas de maior risco estao individualmente protegidas", () => {
  const esperado: Array<[string, string]> = [
    ["POST", "/"],
    ["PATCH", "/:id"],
    ["POST", "/:id/participants"],
    // Rota sem consumidor na tela — a autorizacao dela e testada aqui de todo
    // jeito, porque a API a expoe independentemente do frontend.
    ["DELETE", "/:id/participants/:participantId"],
    ["POST", "/:id/agenda-items"],
    ["PATCH", "/:id/agenda-items/:agendaItemId"],
    ["DELETE", "/:id/agenda-items/:agendaItemId"],
    ["PUT", "/:id/agenda-items/order"],
    ["POST", "/:id/agenda-items/:agendaItemId/postpone"],
    ["POST", "/:id/agenda-items/:agendaItemId/resume"],
    // Alcanca o Exchange e reescreve o convite de terceiros.
    ["POST", "/:id/calendar-sync"],
    // Envia e-mail em nome de quem esta na sessao, com anexo.
    ["POST", "/:id/agenda-validation"],
    // Libera o envio do convite: quem pode marcar aprovado decide quando o
    // convite pode sair.
    ["POST", "/:id/agenda-approval"],
    ["PUT", "/:id/notes"],
    ["PUT", "/:id/minutes"],
    ["POST", "/:id/minutes/clear-by-secretariat"],
  ];

  const todas = rotasDe(meetingsRouter);
  for (const [metodo, caminho] of esperado) {
    const rota = todas.find((r) => r.metodo === metodo && r.caminho === caminho);
    assert.ok(rota, `rota ${metodo} ${caminho} deveria existir`);
    assert.ok(
      rota.handlers.includes(requirePgcpAssessoria),
      `${metodo} ${caminho} deveria exigir PGCP.Assessoria`,
    );
  }
});

test("meetings: Anotacoes e Ata sao legiveis por usuario ativo e escritas pela Assessoria", () => {
  const todas = rotasDe(meetingsRouter);
  for (const caminho of ["/:id/notes", "/:id/minutes"]) {
    const leitura = todas.find((r) => r.metodo === "GET" && r.caminho === caminho);
    assert.ok(leitura, `GET ${caminho} deveria existir`);
    assert.ok(leitura.handlers.includes(requireActivePgcpUser));
    assert.ok(!leitura.handlers.includes(requirePgcpAssessoria));
  }
});

// --- /integrations -----------------------------------------------------------

test("integrations: PGCP.Admin no ROUTER, entao rota nova nasce protegida", () => {
  // A guarda estar no router (e nao rota a rota) e o que torna impossivel
  // esquecer o middleware numa rota futura.
  assert.ok(
    middlewaresDe(integrationsRouter).includes(requirePgcpAdmin),
    "integrationsRouter deveria aplicar requirePgcpAdmin a todo o router",
  );
  assert.ok(rotasDe(integrationsRouter).length >= 3, "o painel tem rotas");

  // O modelo de e-mail vive sob o mesmo router e herda a guarda: quem opera
  // reunioes USA o texto que sai em nome do PGCP, mas nao o edita.
  const modelo = rotasDe(integrationsRouter).filter((r) => r.caminho.includes("email-templates"));
  assert.ok(modelo.length >= 2, "leitura e escrita do modelo de e-mail existem");
  assert.ok(
    modelo.some((r) => r.metodo === "PATCH"),
    "edicao do modelo existe e esta sob PGCP.Admin",
  );
  // E nao pode exigir apenas Assessoria: administrar a plataforma e outra coisa.
  for (const rota of rotasDe(integrationsRouter)) {
    assert.ok(
      !rota.handlers.includes(requirePgcpAssessoria),
      `${rotulo(rota)} nao deveria aceitar Assessoria`,
    );
  }
});

// --- /audit-logs -------------------------------------------------------------

test("audit-logs: somente leitura, restrita a PGCP.Admin", () => {
  const rotas = rotasDe(auditLogsRouter);

  const mutacoes = rotas.filter((r) => MUTANTES.includes(r.metodo)).map(rotulo);
  assert.deepEqual(
    mutacoes,
    [],
    "audit_logs e append-only: nao pode existir rota que edite ou limpe a trilha",
  );

  for (const rota of rotas) {
    assert.ok(rota.handlers.includes(requirePgcpAdmin), `${rotulo(rota)} deveria exigir PGCP.Admin`);
  }
  assert.ok(rotas.length >= 1);
});

// --- /users ------------------------------------------------------------------

test("users: a lista de usuarios do PGCP e administrativa", () => {
  const rotas = rotasDe(usersRouter);
  assert.ok(rotas.length >= 1);
  for (const rota of rotas) {
    assert.ok(rota.handlers.includes(requirePgcpAdmin), `${rotulo(rota)} deveria exigir PGCP.Admin`);
  }
});

// --- /governance-bodies e taxonomias -----------------------------------------

test("cadastros funcionais aceitam Assessoria OU Admin — a unica sobreposicao", () => {
  // Orgaos de governanca, tipos e naturezas de pauta: vocabulario do trabalho
  // da Assessoria e cadastro da plataforma ao mesmo tempo. Fora daqui, uma role
  // nao substitui a outra.
  assert.ok(middlewaresDe(governanceBodiesRouter).includes(requireActivePgcpUser));

  for (const rota of rotasDe(governanceBodiesRouter).filter((r) => MUTANTES.includes(r.metodo))) {
    assert.ok(
      rota.handlers.includes(requireAssessoriaOuAdmin),
      `${rotulo(rota)} deveria aceitar Assessoria ou Admin`,
    );
  }

  const taxonomia = rotasDe(agendaTopicsRouter).filter(
    (r) => r.caminho.startsWith("/taxonomy") && MUTANTES.includes(r.metodo),
  );
  assert.ok(taxonomia.length >= 3, "taxonomia tem POST, PATCH e DELETE");
  for (const rota of taxonomia) {
    assert.ok(
      rota.handlers.includes(requireAssessoriaOuAdmin),
      `${rotulo(rota)} deveria aceitar Assessoria ou Admin`,
    );
  }
});

// --- /agenda-topics (Biblioteca) ---------------------------------------------

test("biblioteca de pautas: aberta a usuario ativo, por decisao documentada", () => {
  /*
   * POLITICA ATUAL, NAO DESCUIDO. O cabecalho de `agenda-topics/routes.ts` diz:
   * "Autorizacao: o padrao existente (requireEntraAuth -> requireActivePgcpUser).
   * Nenhum RBAC novo."
   *
   * Pauta da Biblioteca nao tem contexto de reuniao — propor uma nao e conduzir
   * a governanca. As pautas DE REUNIAO (`/meetings/:id/agenda-items`) exigem
   * `PGCP.Assessoria`, e isso e testado acima.
   *
   * Este teste FIXA a politica: se alguem passar a exigir papel aqui, que seja
   * decisao deliberada e nao efeito colateral.
   */
  const daBiblioteca = rotasDe(agendaTopicsRouter).filter(
    (r) => !r.caminho.startsWith("/taxonomy") && MUTANTES.includes(r.metodo),
  );
  assert.ok(daBiblioteca.length >= 5, "a Biblioteca tem mutacoes");

  for (const rota of daBiblioteca) {
    assert.ok(rota.handlers.includes(requireActivePgcpUser), `${rotulo(rota)} exige usuario ativo`);
    assert.ok(
      !rota.handlers.includes(requirePgcpAssessoria),
      `${rotulo(rota)}: exigir Assessoria aqui seria MUDANCA de politica`,
    );
  }
});

// --- /action-items (FUP) -----------------------------------------------------

test("FUP: qualquer usuario ativo opera, e a posse e revalidada no service", () => {
  // Nao ha papel na rota de proposito: o dono do FUP mexe no proprio FUP. Quem
  // decide se ESTE FUP e seu e `updateActionItem`, por identidade.
  const rotas = rotasDe(actionItemsRouter);
  assert.ok(rotas.length >= 4);
  for (const rota of rotas) {
    assert.ok(rota.handlers.includes(requireActivePgcpUser), `${rotulo(rota)} exige usuario ativo`);
  }
});

test("FUP: nao existe rota de exclusao", () => {
  // Excluir apagaria o registro de que a acao existiu. `cancelled` cobre
  // "nao vai acontecer" preservando o historico.
  const exclusoes = rotasDe(actionItemsRouter).filter((r) => r.metodo === "DELETE").map(rotulo);
  assert.deepEqual(exclusoes, [], "FUP e SEM DELETE por decisao de governanca");
});

// --- /me, /directory, /calendar ----------------------------------------------

test("me: exige token valido, mas nao usuario ja provisionado", () => {
  // `/me` e onde o provisionamento JIT acontece; exigir usuario existente aqui
  // impediria a primeira entrada de qualquer pessoa.
  const rotas = rotasDe(meRouter);
  assert.ok(rotas.length >= 1);
  for (const rota of rotas) {
    assert.ok(rota.handlers.includes(requireEntraAuth), `${rotulo(rota)} exige token do Entra`);
    assert.ok(
      !rota.handlers.includes(requireActivePgcpUser),
      `${rotulo(rota)} nao pode exigir usuario ja provisionado`,
    );
  }
});

test("directory e calendar: usuario ativo, sem papel, e somente leitura", () => {
  for (const [nome, router] of [
    ["directory", directoryRouter],
    ["calendar", calendarRouter],
  ] as const) {
    const rotas = rotasDe(router);
    assert.ok(rotas.length >= 1, `${nome} tem rota`);
    for (const rota of rotas) {
      assert.equal(rota.metodo, "GET", `${nome}: ${rotulo(rota)} deveria ser somente leitura`);
      assert.ok(
        rota.handlers.includes(requireActivePgcpUser),
        `${nome}: ${rotulo(rota)} exige usuario ativo`,
      );
    }
  }
});
