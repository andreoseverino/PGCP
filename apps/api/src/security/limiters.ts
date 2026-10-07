import { createRateLimiter } from "./rate-limit.js";

/**
 * Limites por principal das rotas que tocam recurso compartilhado ou caro.
 *
 * Os valores NAO sao arbitrarios — cada um sai do uso legitimo esperado, com
 * folga para o pico humano e aperto contra abuso/enumeracao:
 *
 *  directory-search  Busca de pessoas no Graph (cota do TENANT). E typeahead
 *                    com debounce no cliente (~1 req a cada 300ms). 40/10s da
 *                    ~4 req/s por pessoa — sobra para quem digita rapido e ainda
 *                    corta varredura roteirizada do diretorio. Protege a cota
 *                    compartilhada do Graph.
 *
 *  own-calendar      GET /calendar/me — le a agenda propria via Graph (OBO),
 *                    carregada ao abrir a tela. 30/10s por pessoa cobre trocas
 *                    de intervalo e recarga sem permitir marteladas no Graph.
 *
 *  integration-test  POST /integrations/:id/test — so Admin, dispara probe de
 *                    rede (banco, OIDC, Graph, DocuSign). Caro e externo. 10/60s
 *                    por admin permite conferir as integracoes sem virar
 *                    ferramenta de varredura contra hosts externos.
 *
 *  teams-message     POST de mensagem por pauta. Cada destinatario implica
 *                    criar/localizar um chat e enviar uma mensagem; 10/min por
 *                    pessoa cobre uso humano e protege a cota compartilhada.
 *
 *  calendar-export   GET /meetings/export — gera PDF/Excel do calendario no
 *                    servidor (CPU e memoria). 10/min por pessoa cobre exportar,
 *                    ajustar o periodo e exportar de novo; corta extracao em
 *                    massa roteirizada.
 */

export const directorySearchRateLimit = createRateLimiter({
  name: "directory-search",
  windowMs: 10_000,
  max: 40,
});

export const ownCalendarRateLimit = createRateLimiter({
  name: "own-calendar",
  windowMs: 10_000,
  max: 30,
});

export const integrationTestRateLimit = createRateLimiter({
  name: "integration-test",
  windowMs: 60_000,
  max: 10,
});

export const calendarExportRateLimit = createRateLimiter({
  name: "calendar-export",
  windowMs: 60_000,
  max: 10,
});

export const teamsMessageRateLimit = createRateLimiter({
  name: "teams-message",
  windowMs: 60_000,
  max: 10,
});
