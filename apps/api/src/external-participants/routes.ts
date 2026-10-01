import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import {
  createExternalParticipant,
  deleteExternalParticipant,
  listExternalParticipants,
  parseExternalParticipantInput,
  updateExternalParticipant,
  type Ator,
} from "./service.js";

export const externalParticipantsRouter = Router();

/**
 * Participantes externos (cadastro local, fora do Entra).
 *
 * Guarda no ROUTER: rota nova nasce protegida. `PGCP.Assessoria` OU
 * `PGCP.Admin` — a mesma politica dos cadastros funcionais do Painel de
 * Administracao; nenhuma App Role nova. Leitura inclusa: a lista expoe
 * e-mail e telefone de terceiros.
 */
externalParticipantsRouter.use(requireAssessoriaOuAdmin);

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[external-participants] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request): Ator {
  const usuario = req.pgcpUser;
  if (!usuario) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { userId: usuario.id, name: usuario.name };
}

externalParticipantsRouter.get("/", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ participants: await listExternalParticipants(q) });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

externalParticipantsRouter.post("/", async (req, res) => {
  try {
    res.status(201).json(await createExternalParticipant(parseExternalParticipantInput(req.body), atorDa(req)));
  } catch (error) {
    sendError(res, error, "criar");
  }
});

externalParticipantsRouter.patch<{ id: string }>("/:id", async (req, res) => {
  try {
    res.json(await updateExternalParticipant(req.params.id, parseExternalParticipantInput(req.body), atorDa(req)));
  } catch (error) {
    sendError(res, error, "atualizar");
  }
});

externalParticipantsRouter.delete<{ id: string }>("/:id", async (req, res) => {
  try {
    await deleteExternalParticipant(req.params.id, atorDa(req));
    res.status(204).end();
  } catch (error) {
    sendError(res, error, "remover");
  }
});
