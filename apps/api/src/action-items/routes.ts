import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { PGCP_ASSESSORIA, hasAppRole } from "../authz/app-roles.js";
import { findActionItem, listActionItems, parseListFilters } from "./service.js";
import { createActionItem, parseActionItemInput, updateActionItem } from "./write.js";

export const actionItemsRouter = Router();

/**
 * FUP — acoes de acompanhamento.
 *
 * SEM DELETE. Excluir uma acao de governanca apaga o registro de que ela
 * existiu, e o modelo ainda nao tem papel funcional que diga quem pode fazer
 * isso. `cancelled` ja esta no CHECK e cobre "esta acao nao vai acontecer"
 * preservando o historico — encerrar e diferente de nunca ter existido.
 */

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[action-items] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request) {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) return null;
  return { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

/**
 * Espectador e permissões, SEMPRE do token já validado.
 *
 * Nada disso vem do corpo ou da query string: quem é "eu" e o que "eu" posso
 * não são parâmetros que o cliente escolhe.
 */
function espectadorDa(req: Request) {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) return null;
  return {
    viewer: {
      userId: usuario.id,
      entraTenantId: principal.entraTenantId,
      entraObjectId: principal.entraObjectId,
    },
    permissoes: {
      isAssessoria: hasAppRole(req, PGCP_ASSESSORIA),
      entraObjectId: principal.entraObjectId,
    },
  };
}

actionItemsRouter.get("/", requireActivePgcpUser, async (req: Request, res: Response) => {
  const ator = atorDa(req);
  const principal = req.principal;
  if (!ator || !principal) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const filtros = parseListFilters(req.query as Record<string, unknown>, {
      userId: ator.userId,
      entraTenantId: principal.entraTenantId,
      entraObjectId: principal.entraObjectId,
    });
    const actionItems = await listActionItems(filtros);
    res.json({ actionItems, count: actionItems.length, limit: filtros.limit });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

actionItemsRouter.get("/:id", requireActivePgcpUser, async (req, res) => {
  const contexto = espectadorDa(req);
  if (!contexto) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  try {
    // Mesma regra da lista: invisível responde 404, e não "403 existe mas não é seu".
    res.json(await findActionItem(req.params.id as string, contexto.viewer));
  } catch (error) {
    sendError(res, error, "consultar");
  }
});

actionItemsRouter.post("/", requireActivePgcpUser, async (req: Request, res: Response) => {
  const ator = atorDa(req);
  if (!ator) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  try {
    res.status(201).json(await createActionItem(parseActionItemInput(req.body), ator));
  } catch (error) {
    sendError(res, error, "criar");
  }
});

/**
 * PATCH parcial: concluir, reabrir, trocar prazo ou responsavel.
 *
 * Parcial de proposito — marcar como concluido nao pode obrigar a reenviar
 * titulo, origem e responsavel, porque um reenvio incompleto apagaria campos
 * que ninguem pediu para mudar.
 */
actionItemsRouter.patch("/:id", requireActivePgcpUser, async (req, res) => {
  const ator = atorDa(req);
  if (!ator) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  try {
    const contexto = espectadorDa(req);
    if (!contexto) {
      res.status(500).json({ error: "Erro interno ao resolver a identidade." });
      return;
    }
    res.json(
      await updateActionItem(
        req.params.id as string,
        parseActionItemInput(req.body, true),
        ator,
        contexto.permissoes,
      ),
    );
  } catch (error) {
    sendError(res, error, "atualizar");
  }
});
