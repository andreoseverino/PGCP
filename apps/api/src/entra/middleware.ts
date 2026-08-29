import type { NextFunction, Request, Response } from "express";
import { logSecurityEvent, safeRoute } from "../security/security-log.js";
import { recordSuccessfulAuth } from "./auth-events.js";
import { getEntraConfig, missingAuthConfig } from "./config.js";
import {
  extractBearerToken,
  statusForFailure,
  verifyAccessToken,
  type AuthenticatedPrincipal,
} from "./verify.js";

/** Principal disponivel para as rotas protegidas. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: AuthenticatedPrincipal;
      /**
       * Token de acesso recebido, exclusivamente para trocas On-Behalf-Of.
       * NUNCA logar, devolver ou persistir.
       */
      entraAccessToken?: string;
    }
  }
}

/**
 * Exige access token valido emitido pelo Entra ID para a API do PGCP.
 *
 * Ordem das checagens e deliberada:
 *
 *   1. formato do header  -> 401. Contrato do cliente, independe de configuracao.
 *   2. configuracao       -> 503. Nao ha como autenticar ninguem.
 *   3. assinatura/claims  -> 401 ou 403.
 *
 * Header antes de configuracao para que uma requisicao sem credencial receba a
 * resposta correta (401) mesmo num ambiente ainda sem Entra configurado — e para
 * que a ausencia de configuracao nao seja revelada a quem nem enviou token.
 */
export async function requireEntraAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const extracted = extractBearerToken(req.headers.authorization);

  if (typeof extracted !== "string") {
    const status = statusForFailure(extracted.code);
    // Credencial ausente ou malformada: registra a tentativa sem autorizacao.
    logSecurityEvent({
      type: "unauthorized",
      message: "Requisição sem credencial válida.",
      requestId: req.id,
      route: safeRoute(req.method, req.originalUrl),
      status,
      code: extracted.code,
    });
    res.status(status).json({ error: extracted.message, code: extracted.code });
    return;
  }

  const config = getEntraConfig();
  if (!config) {
    const missing = missingAuthConfig();
    console.warn("[entra] autenticacao indisponivel; variaveis ausentes:", missing.join(", "));
    res.status(503).json({
      error: "Autenticação não configurada nesta instalação.",
      code: "not_configured",
      // Apenas NOMES de variaveis. Nenhum valor.
      missing,
    });
    return;
  }

  const result = await verifyAccessToken(extracted, config);

  if (!result.ok) {
    const status = statusForFailure(result.code);
    // Evento de seguranca: credencial recusada. So o CODIGO da falha — nunca o
    // token, nunca partes dele.
    logSecurityEvent({
      type: status === 403 ? "forbidden" : "invalid_token",
      message: "Autenticação recusada.",
      requestId: req.id,
      route: safeRoute(req.method, req.originalUrl),
      status,
      code: result.code,
    });
    res.status(status).json({ error: result.message, code: result.code });
    return;
  }

  // Evidencia para o painel: um token foi efetivamente aceito por esta API.
  recordSuccessfulAuth();

  req.principal = result.principal;
  /*
   * Token BRUTO guardado apenas na requisicao para os fluxos On-Behalf-Of
   * (calendario proprio, e-mail e mensagens Teams).
   *
   * Nunca vai para log, nunca para resposta, nunca para o banco. Morre com a
   * requisicao.
   */
  req.entraAccessToken = extracted;
  next();
}
