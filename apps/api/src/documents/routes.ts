import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import type { EspectadorPgcp } from "../meetings/visibility.js";
import { contentDisposition } from "./file-rules.js";
import { arvoreDeDocumentos, lerDocumento, listarDocumentos, parseFiltrosDeDocumentos } from "./service.js";

export const documentsRouter = Router();

/**
 * Documentos — biblioteca central. Leitura: usuário PGCP ativo, com a política
 * de leitura de reunião/Agenda Anual (o servidor decide; o órgão do contexto
 * global é só filtro). O upload fica em `POST /meetings/:id/documents` (Pipeline,
 * `PGCP.Assessoria`, reunião liberada). Nenhuma URL do S3 nem chave de objeto
 * sai daqui: o download passa pela API, que autoriza pelo contexto.
 */

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[documents] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function espectadorDa(req: Request): EspectadorPgcp {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { userId: usuario.id, entraTenantId: principal.entraTenantId, entraObjectId: principal.entraObjectId ?? null };
}

documentsRouter.get("/", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    res.json(await listarDocumentos(parseFiltrosDeDocumentos(req.query as Record<string, unknown>), espectadorDa(req)));
  } catch (error) {
    sendError(res, error, "listar");
  }
});

/** Pastas visuais Órgão → Ano → (Agenda Anual | Mês → Reunião), dos metadados. */
documentsRouter.get("/tree", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const { governanceBodyId, ...resto } = req.query as Record<string, unknown>;
    if (Object.keys(resto).length > 0) throw new HttpError(400, "Filtro não suportado.");
    const filtro = parseFiltrosDeDocumentos(governanceBodyId === undefined ? {} : { governanceBodyId }).governanceBodyId;
    res.json(await arvoreDeDocumentos(espectadorDa(req), filtro));
  } catch (error) {
    sendError(res, error, "árvore");
  }
});

/** Download de ANEXO: autoriza pelo contexto, lê do S3 e entrega com cabeçalhos seguros. */
documentsRouter.get<{ id: string }>("/:id/download", requireActivePgcpUser, async (req, res) => {
  try {
    const doc = await lerDocumento(req.params.id, espectadorDa(req));
    res.setHeader("Content-Type", doc.mime);
    res.setHeader("Content-Length", String(doc.conteudo.length));
    res.setHeader("Content-Disposition", contentDisposition(doc.nome));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(doc.conteudo);
  } catch (error) {
    sendError(res, error, "baixar");
  }
});
