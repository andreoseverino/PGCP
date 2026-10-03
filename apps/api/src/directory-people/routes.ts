import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import {
  deleteDirectoryPerson,
  listDirectoryPeople,
  parseDirectoryPersonInput,
  parseDirectoryPersonPatch,
  updateDirectoryPerson,
  upsertDirectoryPerson,
  type Ator,
} from "./service.js";

export const directoryPeopleRouter = Router();

/**
 * Pessoas do diretório com classificação (órgãos/temas) no PGCP.
 *
 * Guarda no ROUTER, mesma política de Administração → Participantes:
 * `PGCP.Assessoria` OU `PGCP.Admin`. Lista só quem foi vinculado, nunca o
 * tenant. Classificação não é autorização.
 */
directoryPeopleRouter.use(requireAssessoriaOuAdmin);

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[directory-people] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request): Ator {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

directoryPeopleRouter.get("/", async (req, res) => {
  try {
    res.json({ people: await listDirectoryPeople(atorDa(req).entraTenantId) });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

directoryPeopleRouter.post("/", async (req, res) => {
  try {
    res.json({ person: await upsertDirectoryPerson(parseDirectoryPersonInput(req.body), atorDa(req)) });
  } catch (error) {
    sendError(res, error, "vincular");
  }
});

directoryPeopleRouter.patch<{ id: string }>("/:id", async (req, res) => {
  try {
    res.json({ person: await updateDirectoryPerson(req.params.id, parseDirectoryPersonPatch(req.body), atorDa(req)) });
  } catch (error) {
    sendError(res, error, "atualizar");
  }
});

directoryPeopleRouter.delete<{ id: string }>("/:id", async (req, res) => {
  try {
    await deleteDirectoryPerson(req.params.id, atorDa(req));
    res.status(204).end();
  } catch (error) {
    sendError(res, error, "remover");
  }
});
