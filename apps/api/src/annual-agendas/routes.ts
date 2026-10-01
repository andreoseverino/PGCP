import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { GraphError } from "../graph/client.js";
import type { MeetingActor } from "../meetings/create.js";
import { PDF_CONTENT_TYPE } from "../agenda-pdf/document.js";
import {
  addAnnualAgendaItem,
  createAnnualAgenda,
  deleteAnnualAgenda,
  deleteAnnualAgendaItem,
  findAnnualAgenda,
  gerarPdf,
  listAnnualAgendas,
  parseAnnualAgendaInput,
  parseAnnualAgendaItemInput,
  parseAnnualAgendaPatch,
  parseReserveInput,
  registrarAprovacao,
  reserveAnnualAgenda,
  solicitarAprovacao,
  updateAnnualAgenda,
  updateAnnualAgendaItem,
} from "./service.js";

export const annualAgendasRouter = Router();

/**
 * Agenda Anual.
 *
 * Mesma autorizacao em camadas de /meetings: leitura para qualquer usuario
 * PGCP ativo; TODA mutacao — inclusive reservar (que cria eventos no Outlook de
 * terceiros) e enviar para aprovacao (e-mail em nome de quem esta na sessao) —
 * exige `PGCP.Assessoria`. Esconder botao na tela e cortesia; a barreira e esta.
 */

function sendError(res: Response, error: unknown, context: string): void {
  if (error instanceof GraphError) {
    res.status(error.status ?? 502).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[annual-agendas] ${context}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request): MeetingActor | null {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) return null;
  return { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

function mutacao(contexto: string, executar: (req: Request, ator: MeetingActor) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    const ator = atorDa(req);
    if (!ator) {
      res.status(500).json({ error: "Erro interno ao resolver a identidade." });
      return;
    }
    try {
      res.json(await executar(req, ator));
    } catch (error) {
      sendError(res, error, contexto);
    }
  };
}

annualAgendasRouter.get("/", requireActivePgcpUser, async (_req, res) => {
  try {
    res.json({ annualAgendas: await listAnnualAgendas() });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

annualAgendasRouter.get<{ id: string }>("/:id", requireActivePgcpUser, async (req, res) => {
  try {
    res.json(await findAnnualAgenda(req.params.id));
  } catch (error) {
    sendError(res, error, "consultar");
  }
});

/** PDF corporativo da programacao. Mesma politica de leitura. */
annualAgendasRouter.get<{ id: string }>("/:id/pdf", requireActivePgcpUser, async (req, res) => {
  try {
    const { pdf, nome } = await gerarPdf(req.params.id);
    res.setHeader("Content-Type", PDF_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
    res.send(pdf);
  } catch (error) {
    sendError(res, error, "gerar PDF");
  }
});

annualAgendasRouter.post("/", requirePgcpAssessoria, async (req: Request, res: Response) => {
  const ator = atorDa(req);
  if (!ator) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  try {
    res.status(201).json(await createAnnualAgenda(parseAnnualAgendaInput(req.body), ator));
  } catch (error) {
    sendError(res, error, "criar");
  }
});

annualAgendasRouter.patch("/:id", requirePgcpAssessoria, mutacao("renomear", (req, ator) =>
  updateAnnualAgenda(req.params.id as string, parseAnnualAgendaPatch(req.body), ator),
));

annualAgendasRouter.delete<{ id: string }>("/:id", requirePgcpAssessoria, async (req, res) => {
  const ator = atorDa(req);
  if (!ator) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  try {
    await deleteAnnualAgenda(req.params.id, ator);
    res.status(204).end();
  } catch (error) {
    sendError(res, error, "excluir");
  }
});

annualAgendasRouter.post("/:id/items", requirePgcpAssessoria, mutacao("planejar reunião", (req, ator) =>
  addAnnualAgendaItem(req.params.id as string, parseAnnualAgendaItemInput(req.body), ator),
));

annualAgendasRouter.patch("/:id/items/:itemId", requirePgcpAssessoria, mutacao("alterar reunião planejada", (req, ator) =>
  updateAnnualAgendaItem(
    req.params.id as string,
    req.params.itemId as string,
    parseAnnualAgendaItemInput(req.body),
    ator,
  ),
));

annualAgendasRouter.delete("/:id/items/:itemId", requirePgcpAssessoria, mutacao("remover reunião planejada", (req, ator) =>
  deleteAnnualAgendaItem(req.params.id as string, req.params.itemId as string, ator),
));

/**
 * Reserva as datas: cria as reunioes e envia os convites Outlook/Teams, SEM
 * esperar a aprovacao da agenda. Idempotente — ver `reserveAnnualAgenda`.
 */
annualAgendasRouter.post("/:id/reserve", requirePgcpAssessoria, mutacao("reservar agendas", (req, ator) =>
  reserveAnnualAgenda(req.params.id as string, parseReserveInput(req.body), ator),
));

/** Envia o PDF ao aprovador pela caixa de quem esta na sessao (OBO). */
annualAgendasRouter.post("/:id/approval-request", requirePgcpAssessoria, async (req: Request, res: Response) => {
  const ator = atorDa(req);
  const token = req.entraAccessToken;
  if (!ator || !token) {
    res.status(500).json({ error: "Erro interno ao resolver a credencial da sessão." });
    return;
  }
  try {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    for (const chave of Object.keys(corpo)) {
      if (chave !== "approverEmail") throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
    }
    res.json(await solicitarAprovacao(req.params.id as string, corpo.approverEmail, ator, token));
  } catch (error) {
    sendError(res, error, "enviar para aprovação");
  }
});

annualAgendasRouter.post("/:id/approval", requirePgcpAssessoria, mutacao("registrar aprovação", (req, ator) =>
  registrarAprovacao(req.params.id as string, ator),
));
