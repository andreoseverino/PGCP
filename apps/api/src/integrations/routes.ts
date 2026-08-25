import { Router, type Request, type Response } from "express";
import { requirePgcpAdmin } from "../authz/app-roles.js";
import { integrationTestRateLimit } from "../security/limiters.js";
import { logSecurityEvent, safeRoute } from "../security/security-log.js";
import { getIntegrationStatus, listIntegrationStatus, testIntegration } from "./status.js";

export const integrationsRouter = Router();

/*
 * PAINEL INTERNO, NAO PAGINA PUBLICA.
 *
 * Segredo nunca sai daqui — `status.ts` devolve `configured: true/false` para
 * variavel marcada como secreta. Mas o que sai para quem NAO se autenticou
 * ainda e topologia: host, porta, nome do banco, usuario da aplicacao, tenant e
 * client ids. Reconhecimento gratuito.
 *
 * `POST /:id/test` e pior que leitura: dispara verificacao real (consulta o
 * banco, alcanca a rede) e grava a ultima checagem. Acao anonima.
 *
 * Guarda no ROUTER, nao rota a rota: rota nova nasce protegida por
 * consequencia, e esquecer o middleware deixa de ser possivel.
 *
 * `PGCP.Admin`, nao `PGCP.Assessoria`: consultar topologia e disparar teste e
 * administracao da PLATAFORMA. Quem opera reunioes nao precisa disto.
 *
 * `/health` NAO passa por aqui e continua publico — e ele que responde a
 * monitoracao.
 */
integrationsRouter.use(requirePgcpAdmin);

type IdParam = { id: string };

/**
 * Rotas do painel Configuracoes -> Integracoes.
 *
 * Nenhuma resposta carrega segredo: `status.ts` monta o payload a partir do
 * catalogo, e variaveis marcadas como secretas viram apenas um booleano.
 */

/** Catalogo completo com o estado atual de cada integracao. */
integrationsRouter.get("/", (_req: Request, res: Response) => {
  res.json({ environment: process.env.NODE_ENV ?? "development", integrations: listIntegrationStatus() });
});

integrationsRouter.get<IdParam>("/:id/status", (req, res) => {
  const status = getIntegrationStatus(req.params.id);
  if (!status) {
    res.status(404).json({ error: "Integração não encontrada." });
    return;
  }
  res.json(status);
});

/**
 * Executa a verificacao real. POST porque a chamada tem efeito: consulta o
 * recurso externo e grava o resultado como ultima verificacao.
 */
integrationsRouter.post<IdParam>("/:id/test", integrationTestRateLimit, async (req, res) => {
  try {
    // Evento de seguranca: teste de integracao dispara acesso a rede/host
    // externo. O `id` e um rotulo do catalogo (nao dado sensivel).
    logSecurityEvent({
      type: "integration_test",
      message: "Teste de integração disparado.",
      requestId: req.id,
      principalOid: req.principal?.entraObjectId ?? null,
      route: safeRoute(req.method, req.originalUrl),
      detail: { integration: req.params.id },
    });

    const status = await testIntegration(req.params.id);
    if (!status) {
      res.status(404).json({ error: "Integração não encontrada." });
      return;
    }
    res.json(status);
  } catch (error) {
    console.error("[integrations] erro ao testar:", error);
    res.status(500).json({ error: "Erro interno ao verificar a integração." });
  }
});
