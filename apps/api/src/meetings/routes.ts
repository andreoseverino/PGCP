import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { findMeeting, listMeetings, parseListFilters } from "./service.js";
import { createMeeting, parseCreateInput } from "./create.js";
import { deleteMeeting } from "./delete.js";
import { postponeAgendaItem, resumeAgendaItem } from "./postpone.js";
import {
  CalendarPreconditionError,
  syncCalendarAfterMutationIfNeeded,
  syncMeetingCalendar,
} from "../calendar/service.js";
import { GraphError } from "../graph/client.js";
import { teamsMessageRateLimit } from "../security/limiters.js";
import {
  assertEmptyTeamsCallInput,
  parseTeamsMessageInput,
  sendAgendaItemTeamsCall,
  sendAgendaItemTeamsMessage,
  type TeamsMessageActor,
  type TeamsMessageResponse,
} from "../teams/messages.js";
import {
  aprovarPautas,
  enviarPautasParaValidacao,
  lerStatusDeValidacao,
  parseEmailDoAprovador,
} from "./agenda-validation.js";
import {
  clearMinutesHandler,
  getMinutesHandler,
  putMinutesHandler,
} from "../meeting-minutes/routes.js";
import { findMeetingMinutes } from "../meeting-minutes/service.js";
import { gerarPdfDaAta, nomeDoArquivoDaAta, PDF_CONTENT_TYPE } from "../meeting-minutes/pdf.js";
import {
  addAgendaItem,
  addAgendaItemParticipant,
  addParticipant,
  parseAgendaItemInput,
  parseAgendaItemParticipantInput,
  parseAgendaItemPatch,
  parseParticipantInput,
  parseReorderInput,
  parseUpdateInput,
  removeAgendaItem,
  removeAgendaItemParticipant,
  removeParticipant,
  reorderAgendaItems,
  updateAgendaItem,
  updateMeeting,
} from "./update.js";

export const meetingsRouter = Router();

/**
 * Reunioes — leitura e escrita.
 *
 * Autorizacao em camadas, a mesma de /directory e /users:
 *
 *   1. Entra "Atribuicao necessaria = Sim" -> quem obtem token
 *   2. requireEntraAuth                    -> token valido para esta API
 *   3. requireActivePgcpUser               -> existe em `users` e esta ativo
 *   4. requirePgcpAssessoria               -> App Role, so para MUTACAO
 *
 * LER e ESCREVER sao separados de proposito: qualquer usuario ativo le (ver
 * `meetings/visibility.ts` para a politica de leitura), e toda mutacao —
 * cabecalho, participantes, pautas, ordem, postergar/retomar, Ata e
 * sincronizacao de calendario — exige `PGCP.Assessoria`. Esconder o botao na
 * tela e cortesia; a barreira e esta.
 *
 * SEM AUDITORIA NA LEITURA: abrir uma tela nao e ato de governanca. Registrar
 * cada leitura encheria `audit_logs` de ruido e esconderia as acoes que
 * importam. A trilha comeca nos endpoints que alteram dado, e cada um grava a
 * propria entrada dentro da transacao do ato.
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
 * Devolve o nucleo da reuniao, participantes, pautas e o estado da integracao
 * de calendario.
 *
 * NAO devolve a Ata, embora persistida (migration 008): e documento com ciclo
 * proprio e volume proprio, servido por `GET /:id/minutes`. Embuti-la aqui
 * faria toda listagem de detalhe carregar texto longo que a maioria das telas
 * nao usa.
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
     * NADA SAI PARA A MICROSOFT AQUI.
     *
     * Criar reuniao e um ato INTERNO do PGCP. Ate a 5.5 esta rota chamava
     * `syncMeetingCalendar` logo apos o commit, e o convite chegava na caixa
     * dos participantes antes de existir uma unica pauta — corrigir a pauta
     * depois significava reenviar convite a executivos.
     *
     * Agora a reuniao nasce em preparacao. O convite e um ATO PROPRIO e
     * explicito (`POST /:id/calendar-sync`), liberado so depois que as pautas
     * forem aprovadas. A linha de integracao continua sendo criada na mesma
     * transacao da reuniao, em `pending`, com a `idempotency_key` que o envio
     * vai reusar.
     */
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
 * convite. Mutacao interna (FUP, Ata, pauta, status) nao liga a flag — e,
 * mesmo se ligasse, nao encontraria `stale` para agir.
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

/** Contrato HTTP compartilhado pelos dois envios delegados ao Teams. */
function teamsOperation(
  context: string,
  execute: (
    req: Request,
    actor: TeamsMessageActor,
    token: string,
  ) => Promise<TeamsMessageResponse>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const baseActor = atorDa(req);
    const principal = req.principal;
    const token = req.entraAccessToken;
    if (!baseActor || !principal || !token) {
      res.status(500).json({ error: "Erro interno ao resolver a credencial da sessão." });
      return;
    }

    try {
      const result = await execute(
        req,
        { ...baseActor, entraObjectId: principal.entraObjectId },
        token,
      );
      if (result.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
      }
      res.json(result);
    } catch (error) {
      if (error instanceof GraphError) {
        if (error.retryAfterSeconds !== undefined) {
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        }
        res.status(error.status ?? 502).json({ error: error.message, code: error.code });
        return;
      }
      sendError(res, error, context);
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
 * Participantes POR PAUTA (Opção A). Vincular alguém que ainda não está na
 * reunião o ADICIONA à reunião (mesmo caminho da aba Participantes). Remover da
 * pauta REMOVE a pessoa da reunião inteira (cascade tira os demais vínculos).
 * Ambas exigem `PGCP.Assessoria`.
 */
meetingsRouter.post("/:id/agenda-items/:agendaItemId/participants", requirePgcpAssessoria, mutacao("vincular participante à pauta", (req, ator) =>
  addAgendaItemParticipant(req.params.id as string, req.params.agendaItemId as string, parseAgendaItemParticipantInput(req.body), ator),
));

meetingsRouter.delete("/:id/agenda-items/:agendaItemId/participants/:participantId", requirePgcpAssessoria, mutacao("desvincular participante da pauta", (req, ator) =>
  removeAgendaItemParticipant(req.params.id as string, req.params.agendaItemId as string, req.params.participantId as string, ator),
));

/**
 * Mensagem individual no Teams para os participantes reais da pauta.
 *
 * O corpo leva somente o texto. Reuniao, pauta, destinatarios e identidade do
 * remetente sao resolvidos no servidor; o token recebido pela API e trocado por
 * um token Graph delegado via OBO e nunca sai desta requisicao.
 */
meetingsRouter.post(
  "/:id/agenda-items/:agendaItemId/teams-message",
  requirePgcpAssessoria,
  teamsMessageRateLimit,
  teamsOperation("enviar mensagem no Teams", (req, actor, token) =>
    sendAgendaItemTeamsMessage(
      req.params.id as string,
      req.params.agendaItemId as string,
      parseTeamsMessageInput(req.body),
      actor,
      token,
    ),
  ),
);

/**
 * Chamada operacional da pauta. O navegador nao informa texto nem pessoas: a
 * API monta a mensagem e resolve os participantes pela mesma relacao do envio
 * manual, preservando IDOR, OBO, sucesso parcial, auditoria e rate limiting.
 */
meetingsRouter.post(
  "/:id/agenda-items/:agendaItemId/teams-call",
  requirePgcpAssessoria,
  teamsMessageRateLimit,
  teamsOperation("chamar participantes no Teams", (req, actor, token) => {
    assertEmptyTeamsCallInput(req.body);
    return sendAgendaItemTeamsCall(
      req.params.id as string,
      req.params.agendaItemId as string,
      actor,
      token,
    );
  }),
);

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
 * Sincroniza a reuniao com o calendario externo.
 *
 * EXPLICITA, e nao automatica dentro do POST /meetings: PostgreSQL e Graph nao
 * compartilham transacao, e esconder a chamada distribuida dentro da criacao
 * faria a reuniao parecer ter falhado quando so o calendario falhou. A reuniao
 * commita primeiro; o convite e um segundo ato, com resultado proprio.
 *
 * Idempotente: reenviar cria no maximo um evento. Ver `syncMeetingCalendar`.
 *
 * EXIGE `PGCP.Assessoria`, como toda mutacao daqui: disparar sincronizacao
 * alcanca o Exchange e reescreve o convite de terceiros.
 */
meetingsRouter.post("/:id/calendar-sync", requirePgcpAssessoria, async (req, res) => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    /*
     * PRE-CONDICAO NO BACKEND, nao so na tela.
     *
     * Esconder o botao enquanto a pauta nao foi aprovada e cortesia; a barreira
     * e esta. Enviar convite e IRREVERSIVEL para terceiros — o e-mail entra na
     * caixa de executivos e cancelar depois custa mais do que nunca ter
     * enviado. Por isso a checagem vem antes de qualquer chamada ao Graph.
     */
    const validacao = await lerStatusDeValidacao(req.params.id as string);
    if (validacao !== "approved") {
      res.status(409).json({
        error:
          validacao === "sent"
            ? "As pautas foram enviadas para validação, mas ainda não foram marcadas como aprovadas. O convite só pode ser enviado após a aprovação."
            : "As pautas ainda não foram validadas. Envie-as para validação e registre a aprovação antes de enviar o convite.",
        code: "agenda_not_approved",
        agendaValidationStatus: validacao,
      });
      return;
    }

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

/**
 * DELETE /meetings/:id
 *
 * Apaga a reuniao, participantes, pautas vinculadas, Anotacoes, Ata e a
 * integracao de calendario local (cascata das FKs — ver `delete.ts`). Os temas
 * na Biblioteca e os FUPs sobrevivem, so perdendo o vinculo de origem.
 *
 * EXIGE `PGCP.Assessoria` — a mesma barreira de toda mutacao aqui. Se a
 * reuniao ja tinha convite real no Outlook, tenta cancela-lo primeiro
 * (melhor esforco: falha no Graph nao impede a exclusao local).
 */
meetingsRouter.delete<{ id: string }>("/:id", requirePgcpAssessoria, async (req, res) => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    await deleteMeeting(req.params.id, { id: usuario.id, name: usuario.name });
    res.status(204).end();
  } catch (error) {
    sendError(res, error, "excluir");
  }
});

/**
 * Ata da reuniao. Documento formal, com ciclo proprio.
 *
 * O saneamento e POST porque e um ATO da Secretaria, nao a edicao de um campo:
 * ator, data e status sao definidos pelo servidor.
 *
 * NAO HA ROTA DE ASSINATURA. O modelo de dominio existe em
 * `meeting-minutes/signature.ts` (migrations 009 e 010), mas nenhuma operacao
 * dele esta exposta: assinar so podera ser afirmado a partir de evidencia
 * externa real, e aceitar a confirmacao do navegador seria assinatura falsa.
 */
/**
 * VALIDACAO DE PAUTAS — o passo entre preparar e convidar.
 *
 * `POST /:id/agenda-validation` gera o .pdf, envia ao aprovador pela caixa de
 * QUEM ESTA NA SESSAO (Graph delegado, On-Behalf-Of) e marca `sent`. O
 * aprovador nao precisa ter conta no PGCP.
 *
 * `POST /:id/agenda-approval` registra que a validacao voltou aprovada. E um
 * ato humano da Secretaria: nao existe leitura automatica de resposta de
 * e-mail, e afirmar aprovacao sem evidencia seria o mesmo erro da assinatura
 * ficticia que a 4.10 removeu.
 *
 * Ambas exigem `PGCP.Assessoria`, como toda mutacao de reuniao.
 */
meetingsRouter.post("/:id/agenda-validation", requirePgcpAssessoria, async (req, res) => {
  const ator = atorDa(req);
  const token = req.entraAccessToken;
  if (!ator || !token) {
    // A cadeia de middleware garante os dois; falhar alto se ela mudar.
    res.status(500).json({ error: "Erro interno ao resolver a credencial da sessão." });
    return;
  }

  try {
    const email = parseEmailDoAprovador((req.body as Record<string, unknown> | undefined)?.approverEmail);
    const resultado = await enviarPautasParaValidacao(
      req.params.id as string,
      email,
      { userId: ator.userId, name: ator.name },
      token,
    );
    res.json({ ...resultado, meeting: await findMeeting(req.params.id as string) });
  } catch (error) {
    if (error instanceof GraphError) {
      // Falha do Graph (consentimento ausente, throttling, caixa sem licenca)
      // atravessa com o codigo dela — a pessoa precisa saber o que corrigir.
      res.status(error.status ?? 502).json({ error: error.message, code: error.code });
      return;
    }
    sendError(res, error, "enviar pautas para validação");
  }
});

meetingsRouter.post("/:id/agenda-approval", requirePgcpAssessoria, async (req, res) => {
  const ator = atorDa(req);
  if (!ator) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const resultado = await aprovarPautas(req.params.id as string, {
      userId: ator.userId,
      name: ator.name,
    });
    res.json({ ...resultado, meeting: await findMeeting(req.params.id as string) });
  } catch (error) {
    sendError(res, error, "aprovar pautas");
  }
});

meetingsRouter.get("/:id/minutes", requireActivePgcpUser, getMinutesHandler);
meetingsRouter.put("/:id/minutes", requirePgcpAssessoria, putMinutesHandler);
meetingsRouter.post("/:id/minutes/clear-by-secretariat", requirePgcpAssessoria, clearMinutesHandler);

/**
 * GET /:id/minutes/pdf
 *
 * Baixa a Ata como PDF — nunca .txt. Mesma politica de leitura de
 * `GET /:id/minutes`: qualquer usuario ativo baixa, so a Assessoria grava.
 *
 * Gera em memoria a cada chamada; nao ha cache. A Ata muda por autosave e um
 * PDF desatualizado seria pior do que a espera de gerar de novo.
 */
meetingsRouter.get("/:id/minutes/pdf", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const meetingId = req.params.id as string;
    const [reuniao, ata] = await Promise.all([
      findMeeting(meetingId),
      findMeetingMinutes(meetingId),
    ]);

    const pdf = await gerarPdfDaAta({
      titulo: reuniao.title,
      orgao: reuniao.governanceBody.name,
      inicioEm: reuniao.startAt,
      fimEm: reuniao.endAt,
      fuso: reuniao.timezone,
      conteudo: ata.content,
    });

    res.setHeader("Content-Type", PDF_CONTENT_TYPE);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${nomeDoArquivoDaAta(reuniao.title)}"`,
    );
    res.send(pdf);
  } catch (error) {
    sendError(res, error, "gerar PDF da Ata");
  }
});
