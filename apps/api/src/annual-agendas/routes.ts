import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { GraphError } from "../graph/client.js";
import { parseParticipantInput, type MeetingActor } from "../meetings/create.js";
import { PDF_CONTENT_TYPE } from "../agenda-pdf/document.js";
import {
  addAnnualAgendaItem,
  aprovarAgendaAnual,
  alterarTema,
  associarReuniao,
  desassociarReuniao,
  marcarReuniaoPreparada,
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
  reserveAnnualAgenda,
  updateAnnualAgenda,
  updateAnnualAgendaItem,
} from "./service.js";

export const annualAgendasRouter = Router();

/**
 * Agenda Anual.
 *
 * Mesma autorizacao em camadas de /meetings: leitura para qualquer usuario
 * PGCP ativo; TODA mutacao — inclusive reservar (que cria eventos no Outlook de
 * terceiros) — exige `PGCP.Assessoria`. Esconder botao na tela e cortesia; a
 * barreira e esta.
 *
 * APROVACAO DIRETA desde 10/2026 (sem e-mail): `POST /:id/approval` aprova e
 * trava a agenda; envio e retirada respondem 410. Documento oficial da versao
 * aprovada em `/:id/document`.
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
 * DOCUMENTO OFICIAL da versão aprovada — sai do snapshot gravado (028), não do
 * estado atual. Mesma política de leitura do PDF de prévia.
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
 * Reserva as datas: cria as reunioes e envia os convites Outlook/Teams.
 * Idempotente — ver `reserveAnnualAgenda`.
 */
annualAgendasRouter.post("/:id/reserve", requirePgcpAssessoria, mutacao("reservar agendas", (req, ator) =>
  reserveAnnualAgenda(req.params.id as string, parseReserveInput(req.body), ator),
));

/**
 * APROVAÇÃO DIRETA (10/2026): marca aprovada, grava a versão e trava a agenda.
 * Corpo vazio — não há destinatário nem e-mail.
 */
annualAgendasRouter.post("/:id/approval", requirePgcpAssessoria, mutacao("aprovar Agenda Anual", (req, ator) => {
  const chaves = Object.keys((req.body ?? {}) as Record<string, unknown>);
  if (chaves.length > 0) throw new HttpError(400, `O campo '${chaves[0]}' não pode ser informado aqui.`);
  return aprovarAgendaAnual(req.params.id as string, ator);
}));

/**
 * ENVIO POR E-MAIL e RETIRADA não existem mais (10/2026). As rotas respondem
 * 410 com mensagem clara a um cliente antigo, em vez de 404 genérico.
 */
const envioRemovido = (_req: Request, res: Response) => {
  res.status(410).json({
    error: "A Agenda Anual não é mais enviada por e-mail. Use “Marcar como aprovada”.",
    code: "annual_agenda_approval_removed",
  });
};
annualAgendasRouter.post("/:id/approval-request", requirePgcpAssessoria, envioRemovido);
annualAgendasRouter.post("/:id/withdraw", requirePgcpAssessoria, envioRemovido);

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

/**
 * PUT /:id/meetings/:meetingId/prepared  { prepared: boolean }
 *
 * Marca "Preparada" (043): só sinalização para a equipe. Sem efeito em
 * status, versão, convite ou edição.
 */
annualAgendasRouter.put("/:id/meetings/:meetingId/prepared", requirePgcpAssessoria, mutacao("marcar reunião preparada", (req, ator) => {
  const corpo = (req.body ?? {}) as Record<string, unknown>;
  for (const chave of Object.keys(corpo)) {
    if (chave !== "prepared") throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
  }
  return marcarReuniaoPreparada(req.params.id as string, req.params.meetingId as string, corpo.prepared, ator);
}));

annualAgendasRouter.delete("/:id/meetings/:meetingId", requirePgcpAssessoria, mutacao("desassociar reunião", (req, ator) =>
  desassociarReuniao(req.params.id as string, req.params.meetingId as string, ator),
));

/**
 * PAUTAS e TEMAS pela Agenda Anual: conferem pertença e delegam às MESMAS
 * funções de `/meetings` (mesmas tabelas e regras). O Pipeline usa
 * `/meetings/...` diretamente.
 */
const conteudo = (
  contexto: string,
  operacao: (req: Request, ator: MeetingActor, meetingId: string) => Promise<unknown>,
) =>
  mutacao(contexto, (req, ator) =>
    editarConteudoPelaAgenda(req.params.id as string, req.params.meetingId as string, ator, (meetingId) =>
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
 * Participantes DA REUNIÃO pela Agenda — mesmas funções e regras da aba
 * Participantes do Pipeline.
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
