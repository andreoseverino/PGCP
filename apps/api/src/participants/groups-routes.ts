import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import type { Ator } from "../directory-people/service.js";
import {
  adicionarAoGrupoDoOrgao,
  listarGruposDeOrgao,
  listarMembrosDoOrgao,
  parseNovoMembro,
  removerDoGrupoDoOrgao,
} from "./groups.js";

export const participationGroupsRouter = Router();

/**
 * Grupos de participação por ÓRGÃO COLEGIADO (Administração → Participantes).
 * Mesma política de Administração → Participantes: `PGCP.Assessoria` OU
 * `PGCP.Admin`, no ROUTER. Pertencer a um grupo NÃO dá acesso ao PGCP.
 */
participationGroupsRouter.use(requireAssessoriaOuAdmin);

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[participation-groups] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request): Ator {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

participationGroupsRouter.get("/governance-bodies", async (req, res) => {
  try {
    res.json({ groups: await listarGruposDeOrgao(atorDa(req).entraTenantId) });
  } catch (error) {
    sendError(res, error, "listar grupos");
  }
});

participationGroupsRouter.get<{ id: string }>("/governance-bodies/:id/members", async (req, res) => {
  try {
    res.json({ members: await listarMembrosDoOrgao(req.params.id, atorDa(req).entraTenantId) });
  } catch (error) {
    sendError(res, error, "listar membros");
  }
});

participationGroupsRouter.post<{ id: string }>("/governance-bodies/:id/members", async (req, res) => {
  try {
    res.status(201).json(await adicionarAoGrupoDoOrgao(req.params.id, parseNovoMembro(req.body), atorDa(req)));
  } catch (error) {
    sendError(res, error, "adicionar ao grupo");
  }
});

participationGroupsRouter.delete<{ id: string; memberId: string }>("/governance-bodies/:id/members/:memberId", async (req, res) => {
  try {
    res.json({ members: await removerDoGrupoDoOrgao(req.params.id, req.params.memberId, atorDa(req)) });
  } catch (error) {
    sendError(res, error, "remover do grupo");
  }
});
