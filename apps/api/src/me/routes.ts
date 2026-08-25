import { Router, type Request, type Response } from "express";
import { recordAudit } from "../audit/service.js";
import { requireEntraAuth } from "../entra/middleware.js";
import type { AuthenticatedPrincipal } from "../entra/verify.js";
import {
  findUserByEntraIdentity,
  provisionUser,
  resolveEmail,
  type PgcpUser,
} from "../users/service.js";

export const meRouter = Router();

/**
 * Identidade do PGCP.
 *
 *   Entra ID   -> autentica a pessoa (tid + oid) e AUTORIZA o acesso ao app
 *   PostgreSQL -> define o usuario do PGCP (users.id)
 *
 * Quem controla QUEM pode entrar e o Entra, via "Atribuicao necessaria = Sim"
 * no Aplicativo Empresarial. Uma identidade que chega aqui com token valido ja
 * passou por esse filtro, por isso o provisionamento na primeira entrada (JIT)
 * nao afrouxa nada: a autorizacao mora no diretorio, onde ela pertence.
 */

/** Corpo devolvido no sucesso. */
function serialize(principal: AuthenticatedPrincipal, user: PgcpUser) {
  return {
    // Identidade INTERNA. E este id que o frontend usa como usuario da sessao e
    // que aparece em todas as FKs do sistema.
    id: user.id,
    name: user.name,
    email: user.email,
    upn: user.upn,
    jobTitle: user.jobTitle,
    userType: user.userType,
    isActive: user.isActive,
    // Identidade Microsoft: apenas o necessario para rastreabilidade.
    entraTenantId: principal.entraTenantId,
    entraObjectId: principal.entraObjectId,
    /*
     * App Roles desta pessoa, do claim `roles` do token.
     *
     * A tela usa para decidir o que MOSTRAR. Nao e controle de acesso: cada
     * rota protegida revalida o papel no servidor, e esconder botao e cortesia
     * com quem nao pode, nao barreira.
     */
    appRoles: principal.appRoles,
  };
}

/** Resposta unica para conta desativada. Decisao explicita do PGCP. */
async function denyInactive(res: Response, user: PgcpUser): Promise<void> {
  await recordAudit({
    actorUserId: user.id,
    actorName: user.name,
    action: "Acesso negado — conta desativada",
    entityType: "Autenticação",
    entityLabel: user.email,
    status: "failure",
  });

  res.status(403).json({
    error: "Sua conta está desativada no PGCP. Procure a Secretaria de Governança.",
    code: "user_inactive",
  });
}

/**
 * GET /me — resolve o usuario do PGCP, provisionando na primeira entrada.
 *
 * A busca usa EXCLUSIVAMENTE (tid, oid). E-mail, UPN, nome e `sub` sao
 * atributos: reconciliar por qualquer um deles permitiria que uma conta
 * reciclada no diretorio herdasse o historico de outra pessoa.
 *
 *   encontrado + ativo   -> 200
 *   encontrado + inativo -> 403 user_inactive   (JIT NUNCA reativa)
 *   nao encontrado       -> provisiona -> 200
 *   sem e-mail utilizavel-> 422 user_email_unavailable
 */
meRouter.get("/", requireEntraAuth, async (req: Request, res: Response) => {
  const principal = req.principal;
  if (!principal) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const resolution = await findUserByEntraIdentity(principal.entraTenantId, principal.entraObjectId);

    if (resolution.status === "inactive") {
      await denyInactive(res, resolution.user);
      return;
    }

    let user: PgcpUser;

    if (resolution.status === "ok") {
      user = resolution.user;
    } else {
      // --- Primeira entrada: provisionamento JIT --------------------------
      const email = resolveEmail(principal.email, principal.username);

      if (!email) {
        await recordAudit({
          actorUserId: null,
          actorName: principal.name ?? "(sem nome no token)",
          action: "Provisionamento recusado — sem e-mail utilizável",
          entityType: "Usuário",
          status: "failure",
        });

        res.status(422).json({
          error:
            "Sua conta foi autenticada, mas o token não traz um endereço de e-mail utilizável. Procure a Secretaria de Governança.",
          code: "user_email_unavailable",
        });
        return;
      }

      const { user: provisioned, created } = await provisionUser({
        entraTenantId: principal.entraTenantId,
        entraObjectId: principal.entraObjectId,
        // Sem `name` no token, o proprio e-mail serve de rotulo ate o Graph
        // trazer o nome de exibicao (Etapa 3).
        name: principal.name ?? email.email,
        email: email.email,
        upn: principal.username,
      });

      // Só audita quando uma linha foi REALMENTE criada. Corrida perdida cai
      // aqui com `created: false` e não gera registro duplicado.
      if (created) {
        await recordAudit({
          actorUserId: provisioned.id,
          actorName: provisioned.name,
          action: "Provisionamento automático na primeira entrada (JIT)",
          entityType: "Usuário",
          entityId: provisioned.id,
          // Registra a ORIGEM do e-mail, nunca claims completos nem token.
          entityLabel: `origem do e-mail: ${email.source}`,
          status: "success",
        });
      }

      // Uma corrida pode devolver linha preexistente e inativa.
      if (!provisioned.isActive) {
        await denyInactive(res, provisioned);
        return;
      }

      user = provisioned;
    }

    // Auditoria de acesso. Hoje `/me` e chamado uma vez por login; se passar a
    // ser consultado a cada navegacao, revisar para nao inflar a trilha.
    await recordAudit({
      actorUserId: user.id,
      actorName: user.name,
      action: "Autenticação corporativa",
      entityType: "Autenticação",
      entityLabel: user.email,
      status: "success",
    });

    res.json(serialize(principal, user));
  } catch (error) {
    console.error("[me] erro ao resolver usuário:", error);
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
  }
});
