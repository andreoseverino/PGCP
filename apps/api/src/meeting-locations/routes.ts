import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import {
  createMeetingLocation,
  listMeetingLocations,
  parseMeetingLocationInput,
  parseStatusInput,
  setMeetingLocationActive,
  updateMeetingLocation,
  type Ator,
} from "./service.js";

export const meetingLocationsRouter = Router();

/**
 * Locais de reuniao presencial (cadastro da Administracao, 038).
 *
 * Guarda no ROUTER: rota nova nasce protegida. `PGCP.Assessoria` OU
 * `PGCP.Admin` — a mesma politica dos cadastros funcionais; nenhuma App Role
 * nova. Sem DELETE: inativar preserva o historico. A lista de ATIVOS para o
 * agendamento e `GET /meetings/locations`.
 */
meetingLocationsRouter.use(requireAssessoriaOuAdmin);

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[meeting-locations] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request): Ator {
  const usuario = req.pgcpUser;
  if (!usuario) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { userId: usuario.id, name: usuario.name };
}

meetingLocationsRouter.get("/", async (_req, res) => {
  try {
    res.json({ locations: await listMeetingLocations() });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

meetingLocationsRouter.post("/", async (req, res) => {
  try {
    res.status(201).json({ location: await createMeetingLocation(parseMeetingLocationInput(req.body), atorDa(req)) });
  } catch (error) {
    sendError(res, error, "criar");
  }
});

meetingLocationsRouter.patch<{ id: string }>("/:id", async (req, res) => {
  try {
    res.json({ location: await updateMeetingLocation(req.params.id, parseMeetingLocationInput(req.body), atorDa(req)) });
  } catch (error) {
    sendError(res, error, "atualizar");
  }
});

meetingLocationsRouter.put<{ id: string }>("/:id/status", async (req, res) => {
  try {
    res.json({ location: await setMeetingLocationActive(req.params.id, parseStatusInput(req.body), atorDa(req)) });
  } catch (error) {
    sendError(res, error, "alterar status");
  }
});
