import type { NextFunction, Request, Response } from "express";
import { requireEntraAuth } from "../entra/middleware.js";
import { findUserByEntraIdentity, type PgcpUser } from "./service.js";

/** Usuario do PGCP resolvido para a requisicao. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      pgcpUser?: PgcpUser;
    }
  }
}

/**
 * Exige um usuario do PGCP existente e ATIVO.
 *
 * Nao e um sistema de permissoes novo: usa exatamente os fatos de autorizacao
 * que ja existem, em camadas —
 *
 *   1. Entra "Atribuicao necessaria = Sim"  -> quem obtem token
 *   2. `requireEntraAuth`                   -> token valido (aud, azp, scp, tid)
 *   3. aqui                                 -> existe em `users` e esta ativo
 *
 * `requireEntraAuth` sozinho NAO basta: ele aprova o token de alguem desativado
 * no PGCP, porque desativar aqui e decisao nossa e nao se reflete no diretorio.
 *
 * NAO faz JIT. Provisionar e ato de login, e acontece em `GET /me`. Uma rota de
 * consulta nao pode criar usuario como efeito colateral.
 */
export async function requireActivePgcpUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireEntraAuth(req, res, async () => {
    const principal = req.principal;
    if (!principal) {
      res.status(500).json({ error: "Erro interno ao resolver a identidade." });
      return;
    }

    try {
      const resolution = await findUserByEntraIdentity(principal.entraTenantId, principal.entraObjectId);

      if (resolution.status === "not_provisioned") {
        res.status(403).json({
          error: "Sua conta não está habilitada no PGCP. Entre na aplicação uma vez antes de usar este recurso.",
          code: "user_not_provisioned",
        });
        return;
      }

      if (resolution.status === "inactive") {
        res.status(403).json({
          error: "Sua conta está desativada no PGCP. Procure a Secretaria de Governança.",
          code: "user_inactive",
        });
        return;
      }

      req.pgcpUser = resolution.user;
      next();
    } catch (error) {
      console.error("[auth] erro ao resolver usuário do PGCP:", error);
      res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    }
  });
}
