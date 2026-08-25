import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { findMeeting, listMeetings, parseListFilters } from "./service.js";
import { createMeeting, parseCreateInput } from "./create.js";
import { postponeAgendaItem, resumeAgendaItem } from "./postpone.js";
import {
  CalendarPreconditionError,
  syncCalendarAfterMutationIfNeeded,
  syncMeetingCalendar,
} from "../calendar/service.js";
import { getNotesHandler, putNotesHandler } from "../meeting-notes/routes.js";
import {
  clearMinutesHandler,
  getMinutesHandler,
  putMinutesHandler,
} from "../meeting-minutes/routes.js";
import {
  addAgendaItem,
  addParticipant,
  parseAgendaItemInput,
  parseAgendaItemPatch,
  parseParticipantInput,
  parseReorderInput,
  parseUpdateInput,
  removeAgendaItem,
  removeParticipant,
  reorderAgendaItems,
  updateAgendaItem,
  updateMeeting,
} from "./update.js";

export const meetingsRouter = Router();

/**
 * Reunioes — SOMENTE LEITURA.
 *
 * Leitura e criacao. Nao existem PATCH nem DELETE ainda.
 *
 * O frontend continua criando e editando reuniao no estado local: o POST daqui
 * existe para provar que a criacao inteira — reuniao, participantes, pautas e
 * trilha — cabe numa unica transacao. A troca da fonte de escrita e etapa
 * propria.
 *
 * Autorizacao em camadas, a mesma de /directory e /users:
 *
 *   1. Entra "Atribuicao necessaria = Sim" -> quem obtem token
 *   2. requireEntraAuth                    -> token valido para esta API
 *   3. requireActivePgcpUser               -> existe em `users` e esta ativo
 *
 * Nao ha papel funcional no modelo, entao qualquer usuario ativo le. Quando
 * houver RBAC, o filtro entra aqui.
 *
 * SEM AUDITORIA: abrir uma tela nao e ato de governanca. Registrar cada leitura
 * encheria `audit_logs` de ruido e esconderia as acoes que importam. A trilha
 * comeca nos endpoints que alteram dado.
 */

function sendError(res: Response, error: unknown, context: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error(`[meetings] ${context}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

/**
 * GET /meetings
 *
 * Filtros opcionais: governanceBodyId, status, dateFrom, dateTo, limit.
 * `dateFrom`/`dateTo` recortam pelo dia LOCAL da reuniao, no fuso dela — ver a
 * justificativa em service.ts.
 *
 * Banco vazio devolve `{ meetings: [], count: 0 }` com 200. Lista vazia e
 * resposta correta, nao erro e nao motivo para inventar dado.
 */
meetingsRouter.get("/", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const filters = parseListFilters(req.query as Record<string, unknown>);
    const meetings = await listMeetings(filters);

    res.json({
      meetings,
      count: meetings.length,
      limit: filters.limit,
      /** Havia possivelmente mais reunioes do que o teto permitiu trazer. */
      truncated: meetings.length === filters.limit,
    });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

/**
 * GET /meetings/:id
 *
 * Devolve o nucleo da reuniao mais participantes e pautas — as duas secoes que
 * a migration 003 tornou representaveis sem perda.
 *
 * NAO devolve, porque nao ha dado persistido: anotacoes, ata, assinaturas,
 * progresso da agenda, FUPs vinculados e apresentadores pessoa. Devolver essas
 * secoes vazias sugeriria que estao vazias no banco, quando na verdade elas
 * ainda vivem no navegador. Elas entram quando forem migradas.
 */
meetingsRouter.get<{ id: string }>("/:id", requireActivePgcpUser, async (req, res) => {
  try {
    res.json(await findMeeting(req.params.id));
  } catch (error) {
    sendError(res, error, "consultar");
  }
});

/**
 * POST /meetings
 *
 * Cria reuniao, participantes, pautas e a entrada de auditoria numa unica
 * transacao. Responde 201 com exatamente o mesmo corpo de GET /meetings/:id.
 *
 * EXIGE `PGCP.Assessoria`. Cadastrar reuniao e capacidade da Assessoria, nao
 * de todo usuario autenticado; esconder o botao na tela e cortesia, nao
 * controle de acesso.
 *
 * TRES IDENTIDADES, NAO UMA:
 *   created_by  = o ator do token, sempre
 *   organizer   = quem o corpo indicar, ou o ator quando nao indicar
 *   attendees   = a lista de participantes
 *
 * O corpo pode escolher o ORGANIZADOR, mas nunca o ator, nunca o tenant e
 * nunca `created_by`: esses vem do token ja validado.
 */
meetingsRouter.post("/", requirePgcpAssessoria, async (req: Request, res: Response) => {
  const usuario = req.pgcpUser;
  const principal = req.principal;

  if (!usuario || !principal) {
    // requireActivePgcpUser garante os dois; a checagem existe para o
    // TypeScript e para falhar alto caso a cadeia de middleware mude.
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const input = parseCreateInput(req.body);
    const ator = {
      userId: usuario.id,
      name: usuario.name,
      entraTenantId: principal.entraTenantId,
    };
    const criada = await createMeeting(input, ator);

    /*
     * SINCRONIZACAO INICIAL — depois do COMMIT, nunca dentro dele.
     *
     * Toda reuniao do PGCP e um evento do Outlook com reuniao do Teams, entao
     * criar a reuniao e pedir o evento sao um gesto so para quem usa. Mas o
     * PostgreSQL e o Graph nao compartilham transacao: a chamada acontece com a
     * reuniao JA gravada.
     *
     * FALHA DA MICROSOFT NAO APAGA REUNIAO. `syncMeetingCalendar` ja registra
     * `failed` com mensagem sanitizada e a trilha da falha; aqui o erro e
     * engolido de proposito para o 201 continuar valendo — a reuniao existe, e
     * o que faltou foi o convite, com botao proprio para tentar de novo.
     *
     * O retry reusa a MESMA `idempotency_key` gravada na criacao, entao repetir
     * nunca cria um segundo evento.
     */
    try {
      await syncMeetingCalendar(criada.id, { id: ator.userId, name: ator.name });
    } catch {
      /*
       * Engolido de proposito, e SEMPRE aguardado antes de seguir: a leitura
       * abaixo precisa acontecer depois que o resultado — sucesso ou falha — ja
       * esta gravado, senao o 201 devolveria um estado que envelheceu no
       * caminho. `syncMeetingCalendar` ja gravou `failed`, a mensagem
       * sanitizada e a trilha da falha.
       */
    }

    // Relido: o corpo precisa dizer em que estado a projecao ficou, e quem sabe
    // isso e o banco depois da tentativa — nao a resposta da criacao.
    res.status(201).json(await findMeeting(criada.id));
  } catch (error) {
    sendError(res, error, "criar");
  }
});

/**
 * Resolve o ator a partir do token. `requireActivePgcpUser` garante os dois
 * campos; a checagem existe para o TypeScript e para falhar alto se a cadeia
 * de middleware mudar.
 */
function atorDa(req: Request): { userId: string; name: string; entraTenantId: string } | null {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) return null;
  return { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

/**
 * Envolve um handler mutante: resolve o ator, executa e responde com o detalhe
 * relido do banco. Toda mutacao devolve o MESMO corpo de GET /meetings/:id, o
 * que dispensa o cliente de adivinhar o estado resultante.
 *
 * `sincroniza` liga a reprojecao automatica no Outlook DEPOIS do commit. Nao e
 * "sincronizar sempre": o helper so age se a mutacao tiver deixado a integracao
 * `stale`, o que por definicao acontece apenas quando o que mudou aparece no
 * convite. Mutacao interna (FUP, Anotacoes, Ata, pauta, status) nao liga a
 * flag — e, mesmo se ligasse, nao encontraria `stale` para agir.
 */
function mutacao(
  contexto: string,
  executar: (req: Request, ator: { userId: string; name: string; entraTenantId: string }) => Promise<unknown>,
  opcoes: { sincroniza?: boolean } = {},
) {
  return async (req: Request, res: Response): Promise<void> => {
    const ator = atorDa(req);
    if (!ator) {
      res.status(500).json({ error: "Erro interno ao resolver a identidade." });
      return;
    }
    try {
      const resultado = await executar(req, ator);

      if (!opcoes.sincroniza) {
        res.json(resultado);
        return;
      }

      /*
       * A mutacao ja commitou — o `await` acima garante isso. A chamada externa
       * acontece aqui fora, e o corpo da resposta e relido depois dela para a
       * tela receber o estado final da projecao sem precisar de um GET extra.
       *
       * Falha nao muda o status HTTP: o PostgreSQL gravou, e a edicao ocorreu.
       */
      const meetingId = req.params.id as string;
      await syncCalendarAfterMutationIfNeeded(meetingId, { id: ator.userId, name: ator.name });
      res.json(await findMeeting(meetingId));
    } catch (error) {
      sendError(res, error, contexto);
    }
  };
}

/**
 * PATCH /meetings/:id — cabecalho e status formal.
 *
 * NAO altera participantes nem pautas: cada um tem endpoint proprio, para os
 * UUIDs das linhas filhas nunca serem recriados.
 */
/*
 * As TRES mutacoes que atravessam a fronteira do convite: cabecalho (titulo,
 * descricao, horario, fuso, local, link) e a lista de participantes. Sao as
 * unicas que `CAMPOS_QUE_DESATUALIZAM` e `marcarComoDesatualizada` reconhecem —
 * por isso sao as unicas com `sincroniza`.
 */
meetingsRouter.patch("/:id", requirePgcpAssessoria, mutacao("atualizar", (req, ator) =>
  updateMeeting(req.params.id as string, parseUpdateInput(req.body), ator),
  { sincroniza: true },
));

meetingsRouter.post("/:id/participants", requirePgcpAssessoria, mutacao("adicionar participante", (req, ator) =>
  addParticipant(req.params.id as string, parseParticipantInput(req.body), ator),
  { sincroniza: true },
));

meetingsRouter.delete("/:id/participants/:participantId", requirePgcpAssessoria, mutacao("remover participante", (req, ator) =>
  removeParticipant(req.params.id as string, req.params.participantId as string, ator),
  { sincroniza: true },
));

meetingsRouter.post("/:id/agenda-items", requirePgcpAssessoria, mutacao("adicionar pauta", (req, ator) =>
  addAgendaItem(req.params.id as string, parseAgendaItemInput(req.body), ator),
));

meetingsRouter.patch("/:id/agenda-items/:agendaItemId", requirePgcpAssessoria, mutacao("atualizar pauta", (req, ator) =>
  updateAgendaItem(req.params.id as string, req.params.agendaItemId as string, parseAgendaItemPatch(req.body), ator),
));

meetingsRouter.delete("/:id/agenda-items/:agendaItemId", requirePgcpAssessoria, mutacao("remover pauta", (req, ator) =>
  removeAgendaItem(req.params.id as string, req.params.agendaItemId as string, ator),
));

/**
 * Reordenacao em UMA transacao, com a lista completa de ids.
 * Nao recria as pautas: apenas reescreve `position`.
 */
meetingsRouter.put("/:id/agenda-items/order", requirePgcpAssessoria, mutacao("reordenar pautas", (req, ator) =>
  reorderAgendaItems(req.params.id as string, parseReorderInput(req.body), ator),
));

/**
 * Operacoes de DOMINIO. Coordenam o estado da pauta e a copia na Biblioteca numa
 * transacao so — duas chamadas do navegador nao seriam atomicas.
 *
 * Postergar e idempotente: repetir nao cria segunda copia. Retomar localiza a
 * copia SOMENTE pela procedencia estrutural, nunca por titulo.
 */
meetingsRouter.post("/:id/agenda-items/:agendaItemId/postpone", requirePgcpAssessoria, mutacao("postergar pauta", (req, ator) =>
  postponeAgendaItem(req.params.id as string, req.params.agendaItemId as string, ator),
));

meetingsRouter.post("/:id/agenda-items/:agendaItemId/resume", requirePgcpAssessoria, mutacao("retomar pauta", (req, ator) =>
  resumeAgendaItem(req.params.id as string, req.params.agendaItemId as string, ator),
));

/**
 * Anotacoes da reuniao. Documento operacional, distinto da Ata — que tem ciclo
 * formal proprio e nao e tocada aqui. O `meetingId` vem da rota, nunca do corpo.
 */
meetingsRouter.get("/:id/notes", requireActivePgcpUser, getNotesHandler);
meetingsRouter.put("/:id/notes", requirePgcpAssessoria, putNotesHandler);

/**
 * Ata da reuniao. Documento formal, distinto das anotacoes.
 *
 * O saneamento e POST porque e um ATO da Secretaria, nao a edicao de um campo:
 * ator, data e status sao definidos pelo servidor.
 *
 * Nao ha rota de assinatura — nao existe assinatura real nesta onda.
 */
/**
 * Sincroniza a reuniao com o calendario externo.
 *
 * EXPLICITA, e nao automatica dentro do POST /meetings: PostgreSQL e Graph nao
 * compartilham transacao, e esconder a chamada distribuida dentro da criacao
 * faria a reuniao parecer ter falhado quando so o calendario falhou. A reuniao
 * commita primeiro; o convite e um segundo ato, com resultado proprio.
 *
 * Idempotente: reenviar cria no maximo um evento. Ver `syncMeetingCalendar`.
 *
 * AUTORIZACAO PENDENTE: hoje qualquer usuario ativo pode disparar. Sincronizar e
 * reprocessar sincronizacao estao na lista de operacoes que exigirao RBAC.
 */
meetingsRouter.post("/:id/calendar-sync", requirePgcpAssessoria, async (req, res) => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    res.json(await syncMeetingCalendar(req.params.id as string, { id: usuario.id, name: usuario.name }));
  } catch (error) {
    if (error instanceof CalendarPreconditionError) {
      // A lista de quem ficou sem endereco vai junto: a pessoa precisa saber
      // QUEM corrigir, nao apenas que algo faltou.
      res.status(422).json({
        error: error.message,
        code: error.falha.code,
        ...(error.falha.participants ? { participants: error.falha.participants } : {}),
      });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("[meetings] sincronizar calendário:", error);
    res.status(502).json({ error: "Não foi possível sincronizar com o calendário." });
  }
});

meetingsRouter.get("/:id/minutes", requireActivePgcpUser, getMinutesHandler);
meetingsRouter.put("/:id/minutes", requirePgcpAssessoria, putMinutesHandler);
meetingsRouter.post("/:id/minutes/clear-by-secretariat", requirePgcpAssessoria, clearMinutesHandler);
