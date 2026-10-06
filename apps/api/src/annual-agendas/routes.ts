import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { GraphError } from "../graph/client.js";
import { parseParticipantInput, type MeetingActor } from "../meetings/create.js";
import { PDF_CONTENT_TYPE } from "../agenda-pdf/document.js";
import {
  addAnnualAgendaItem,
  alterarTema,
  associarReuniao,
  desassociarReuniao,
  editarConteudoPelaAgenda,
  excluirPauta,
  excluirTema,
  gerarDocumentoDaVersao,
  parsePautaDaAgenda,
  desvincularParticipanteDoTema,
  criarTemaNaReuniao,
  parseNovoTemaDaAgenda,
  parseAnoDaVisao,
  parseOrdemDaAgenda,
  parseParticipanteDoTema,
  reordenarTemas,
  vincularParticipanteAoTema,
  incluirParticipanteNaReuniao,
  removerParticipanteDaReuniao,
  parseTemaPatchDaAgenda,
  renomearPauta,
  retirarDaAprovacao,
  visaoAnual,
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
  reunioesCongeladasParaCalendario,
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

/**
 * Visão anual: reuniões do Calendário do ano agrupadas por órgão, com a Agenda
 * Anual formal quando existir. Somente leitura; declarada antes de "/:id".
 */
annualAgendasRouter.get("/overview", requireActivePgcpUser, async (req, res) => {
  try {
    res.json(await visaoAnual(parseAnoDaVisao(req.query.year)));
  } catch (error) {
    sendError(res, error, "visão anual");
  }
});

/**
 * Reuniões CONGELADAS de toda Agenda Anual aprovada — para o Calendário
 * exibir a versão aprovada em vez da reunião ao vivo. Somente leitura;
 * declarada antes de "/:id".
 */
annualAgendasRouter.get("/frozen-calendar", requireActivePgcpUser, async (_req, res) => {
  try {
    res.json({ meetings: await reunioesCongeladasParaCalendario() });
  } catch (error) {
    sendError(res, error, "reuniões congeladas do calendário");
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

/**
 * DOCUMENTO da versão enviada/aprovada — sai do snapshot gravado (028), não
 * do estado atual. Mesma política de leitura do PDF de prévia.
 */
annualAgendasRouter.get<{ id: string }>("/:id/document", requireActivePgcpUser, async (req, res) => {
  try {
    const { pdf, nome } = await gerarDocumentoDaVersao(req.params.id);
    res.setHeader("Content-Type", PDF_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
    res.send(pdf);
  } catch (error) {
    sendError(res, error, "gerar documento da versão");
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

/** Volta explicitamente de "enviada" para "em elaboração" (versão fica no histórico). */
annualAgendasRouter.post("/:id/withdraw", requirePgcpAssessoria, mutacao("retirar da aprovação", (req, ator) =>
  retirarDaAprovacao(req.params.id as string, ator),
));

/**
 * REUNIÕES DO CALENDÁRIO NA AGENDA. Associar só grava `meetings.annual_agenda_id`:
 * mesma reunião, mesmo evento Outlook/Teams, nenhum convite novo.
 */
annualAgendasRouter.post("/:id/meetings", requirePgcpAssessoria, mutacao("associar reunião", (req, ator) => {
  const corpo = (req.body ?? {}) as Record<string, unknown>;
  for (const chave of Object.keys(corpo)) {
    if (chave !== "meetingId") throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
  }
  return associarReuniao(req.params.id as string, corpo.meetingId, ator);
}));

annualAgendasRouter.delete("/:id/meetings/:meetingId", requirePgcpAssessoria, mutacao("desassociar reunião", (req, ator) =>
  desassociarReuniao(req.params.id as string, req.params.meetingId as string, ator),
));

/**
 * PAUTAS e TEMAS pela Agenda Anual: conferem pertença + "em elaboração" e
 * delegam às MESMAS funções de `/meetings` (mesmas tabelas e regras). O
 * Pipeline usa `/meetings/...` diretamente e não é bloqueado pela aprovação.
 */
const conteudo = (
  contexto: string,
  operacao: (req: Request, ator: MeetingActor, meetingId: string) => Promise<unknown>,
) =>
  mutacao(contexto, (req, ator) =>
    editarConteudoPelaAgenda(req.params.id as string, req.params.meetingId as string, (meetingId) =>
      operacao(req, ator, meetingId),
    ),
  );

annualAgendasRouter.patch("/:id/meetings/:meetingId/agendas/:agendaId", requirePgcpAssessoria, conteudo("renomear pauta", (req, ator, m) =>
  renomearPauta(m, req.params.agendaId as string, parsePautaDaAgenda(req.body), ator),
));

annualAgendasRouter.delete("/:id/meetings/:meetingId/agendas/:agendaId", requirePgcpAssessoria, conteudo("excluir pauta", (req, ator, m) =>
  excluirPauta(m, req.params.agendaId as string, ator),
));

annualAgendasRouter.patch("/:id/meetings/:meetingId/agenda-items/:itemId", requirePgcpAssessoria, conteudo("alterar tema", (req, ator, m) =>
  alterarTema(m, req.params.itemId as string, parseTemaPatchDaAgenda(req.body), ator),
));

annualAgendasRouter.delete("/:id/meetings/:meetingId/agenda-items/:itemId", requirePgcpAssessoria, conteudo("remover tema", (req, ator, m) =>
  excluirTema(m, req.params.itemId as string, ator),
));

/** Ordem dos temas (arrastar e soltar). Horários recalculados no servidor. */
annualAgendasRouter.put("/:id/meetings/:meetingId/agenda-items/order", requirePgcpAssessoria, conteudo("reordenar temas", (req, ator, m) =>
  reordenarTemas(m, parseOrdemDaAgenda(req.body), ator),
));

/**
 * Participantes DA REUNIÃO pela Agenda (em elaboração): antes da aprovação o
 * Pipeline não opera a reunião, então incluir/remover pessoas acontece aqui —
 * mesmas funções e regras da aba Participantes do Pipeline.
 */
annualAgendasRouter.post("/:id/meetings/:meetingId/participants", requirePgcpAssessoria, conteudo("incluir participante na reunião", (req, ator, m) =>
  incluirParticipanteNaReuniao(m, parseParticipantInput(req.body), ator),
));

annualAgendasRouter.delete("/:id/meetings/:meetingId/participants/:participantId", requirePgcpAssessoria, conteudo("remover participante da reunião", (req, ator, m) =>
  removerParticipanteDaReuniao(m, req.params.participantId as string, ator),
));

/** Participantes DO TEMA (mesmas regras do Pipeline: vincular adiciona à reunião se preciso). */
annualAgendasRouter.post("/:id/meetings/:meetingId/agenda-items/:itemId/participants", requirePgcpAssessoria, conteudo("vincular participante ao tema", (req, ator, m) =>
  vincularParticipanteAoTema(m, req.params.itemId as string, parseParticipanteDoTema(req.body), ator),
));

annualAgendasRouter.delete("/:id/meetings/:meetingId/agenda-items/:itemId/participants/:participantId", requirePgcpAssessoria, conteudo("desvincular participante do tema", (req, ator, m) =>
  desvincularParticipanteDoTema(m, req.params.itemId as string, req.params.participantId as string, ator),
));

/**
 * "+ Novo tema" / "Adicionar da Biblioteca": cria o TEMA direto na reunião.
 * Sem pauta, o servidor cria a pauta padrão na mesma transação (agenda travada).
 */
annualAgendasRouter.post("/:id/meetings/:meetingId/temas", requirePgcpAssessoria, conteudo("criar tema", (req, ator, m) =>
  criarTemaNaReuniao(m, parseNovoTemaDaAgenda(req.body), ator),
));
