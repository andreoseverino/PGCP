import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { listarDocumentos, parseFiltrosDeDocumentos } from "./service.js";

export const documentsRouter = Router();

/**
 * GET /documents — biblioteca central (só LISTA). Mesma política de leitura de
 * reuniões e Agenda Anual: usuário PGCP ativo. O download fica nas rotas de
 * origem (Ata, Agenda Anual), com a autorização delas; nenhum caminho de
 * arquivo é aceito ou devolvido. Sem upload: o PGCP ainda não tem storage.
 */
documentsRouter.get("/", requireActivePgcpUser, async (req: Request, res: Response) => {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  try {
    const filtros = parseFiltrosDeDocumentos(req.query as Record<string, unknown>);
    res.json(
      await listarDocumentos(filtros, {
        userId: usuario.id,
        entraTenantId: principal.entraTenantId,
        entraObjectId: principal.entraObjectId ?? null,
      }),
    );
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("[documents] listar:", error);
    res.status(500).json({ error: "Erro interno ao processar a solicitação." });
  }
});
