import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requirePgcpAssessoria } from "../authz/app-roles.js";
import { assertValidId, findMeeting, listMeetings, parseListFilters } from "./service.js";
import { createMeeting, parseCreateInput } from "./create.js";
import { deleteMeeting, recusarMutacaoEmReuniaoCancelada } from "./delete.js";
import { postponeAgendaItem, resumeAgendaItem } from "./postpone.js";
import {
  CalendarPreconditionError,
  syncCalendarAfterMutationIfNeeded,
  syncMeetingCalendar,
} from "../calendar/service.js";
import { GraphError } from "../graph/client.js";
import { calendarExportRateLimit, teamsMessageRateLimit } from "../security/limiters.js";
import { exportarCalendario, parseFiltrosDeExportacao } from "./export.js";
import { diferencasDaVersaoPorId, gerarPdfDaVersao, listarVersoesDaReuniao } from "./versions.js";
import { podeVisualizarReuniao, type EspectadorPgcp } from "./visibility.js";
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
  parseEmailDoAprovador,
} from "./agenda-validation.js";
import { addAgenda, parseAgendaInput, removeAgenda, updateAgenda } from "./agendas.js";
import { listActiveMeetingLocations } from "../meeting-locations/service.js";
import {
  clearMinutesHandler,
  getMinutesHandler,
  putMinutesHandler,
} from "../meeting-minutes/routes.js";
import { findMeetingMinutes } from "../meeting-minutes/service.js";
import express from "express";
import { adicionarDocumentoDaReuniao } from "../documents/service.js";
import { tamanhoMaximo, descreverTamanho } from "../documents/file-rules.js";
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

/*
 * SEM GUARDA DE "LIBERAÇÃO PARA O PIPELINE" (10/2026): a Agenda Anual não tem
 * mais aprovação, e a reunião vinculada a ela é operada no Pipeline desde o
 * agendamento. A barreira de mutação é a App Role, em cada rota.
 *
 * Reunião CANCELADA (036) é somente leitura: guarda única, antes das rotas.
 */
meetingsRouter.use("/:id", recusarMutacaoEmReuniaoCancelada());

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
 * GET /meetings/locations
 *
 * Locais ATIVOS do cadastro (038) para escolher na reuniao presencial: nome e
 * endereco, sem observacao interna nem status. Inativos nao aparecem (a
 * reuniao que ja usa um local inativo mostra a propria copia). Registrada
 * ANTES de `/:id` para "locations" nao ser lido como identificador.
 */
meetingsRouter.get("/locations", requireActivePgcpUser, async (_req: Request, res: Response) => {
  try {
    res.json({ locations: await listActiveMeetingLocations() });
  } catch (error) {
    sendError(res, error, "listar locais");
  }
});

function espectadorDa(req: Request): EspectadorPgcp {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { userId: usuario.id, entraTenantId: principal.entraTenantId, entraObjectId: principal.entraObjectId ?? null };
}

/**
 * GET /meetings/export?format=pdf|xlsx[&dateFrom&dateTo&governanceBodyId]
 *
 * Exporta o CALENDÁRIO filtrado. Leitura: mesma política do Calendário
 * (usuário ativo + `visibility.ts`); o servidor decide o que entra no arquivo
 * (sem descrição, sem e-mail — ver `export.ts`). Registrada ANTES de `/:id`.
 * Nome do arquivo montado no servidor, só ASCII.
 */
meetingsRouter.get("/export", requireActivePgcpUser, calendarExportRateLimit, async (req: Request, res: Response) => {
  try {
    const filtros = parseFiltrosDeExportacao(req.query as Record<string, unknown>);
    const arquivo = await exportarCalendario(filtros, espectadorDa(req));
    res.setHeader("Content-Type", arquivo.tipo);
    res.setHeader("Content-Disposition", `attachment; filename="${arquivo.nome}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(arquivo.conteudo);
  } catch (error) {
    sendError(res, error, "exportar calendário");
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
     * NADA SAI PARA A MICROSOFT DENTRO DESTA ROTA.
     *
     * A reuniao commita aqui; o convite Outlook/Teams e o passo seguinte,
     * `POST /:id/calendar-sync`, que a tela do Calendario dispara logo depois
     * (025: agendar = reservar a agenda, sem esperar pautas). Continuam dois
     * atos com resultado proprio: falha do Graph nao pode parecer falha da
     * reuniao. A linha de integracao nasce na mesma transacao, em `pending`,
     * com a `idempotency_key` que o envio reusa.
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

/**
 * PAUTAS (025) — agrupadores de temas: Reuniao -> Pauta -> Tema.
 * Excluir pauta com temas responde 409. Ver `agendas.ts`.
 */
meetingsRouter.post("/:id/agendas", requirePgcpAssessoria, mutacao("criar pauta", (req, ator) =>
  addAgenda(req.params.id as string, parseAgendaInput(req.body), ator),
));

meetingsRouter.patch("/:id/agendas/:agendaId", requirePgcpAssessoria, mutacao("renomear pauta", (req, ator) =>
  updateAgenda(req.params.id as string, req.params.agendaId as string, parseAgendaInput(req.body), ator),
));

meetingsRouter.delete("/:id/agendas/:agendaId", requirePgcpAssessoria, mutacao("excluir pauta", (req, ator) =>
  removeAgenda(req.params.id as string, req.params.agendaId as string, ator),
));

/** TEMAS da reuniao (`agenda-items`, nome tecnico anterior a 025). */
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
 * Sincroniza a reuniao com o calendario externo (cria ou atualiza o evento).
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
     * SEM PRE-CONDICAO DE PAUTA APROVADA (025).
     *
     * Regra de produto: agendar RESERVA a agenda de executivos de baixa
     * disponibilidade — pela Agenda Anual e pelo Calendario, antes de existir
     * pauta. Desde 10/2026 a aprovacao das pautas tambem nao e exigida para
     * INICIAR a reuniao (`meeting-start.ts`): so o convite.
     *
     * O que continua barrando: papel (`PGCP.Assessoria`), pre-condicoes do
     * convite (organizador Microsoft, participantes com endereco — 422) e a
     * idempotencia de `syncMeetingCalendar` (no maximo um evento por reuniao).
     */
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
 * DELETE /meetings/:id — CANCELAMENTO LÓGICO (036). Nada é apagado: a reunião
 * sai dos fluxos ativos e vira histórico (versões, PDFs, documentos, Ata,
 * trilha). Depois do commit local, cancela o evento do Outlook/Teams; falha no
 * Graph deixa `calendarCancellation: "pending"` e repetir a chamada retenta.
 *
 * 200 com o resultado (antes era 204 sem corpo). EXIGE `PGCP.Assessoria`.
 */
meetingsRouter.delete<{ id: string }>("/:id", requirePgcpAssessoria, async (req, res) => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    res.json(await deleteMeeting(req.params.id, { id: usuario.id, name: usuario.name }));
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
 * VALIDACAO DE PAUTAS — passo OPCIONAL desde 10/2026: nada no fluxo depende
 * dele (iniciar exige so o convite). Mantido como estava ate decisao futura.
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

/**
 * POST /:id/documents — anexo da reunião (ou do tema DESTA reunião, via
 * `?agendaItemId=`). Corpo = bytes do arquivo (`application/octet-stream`);
 * nome e descrição em cabeçalho (URL-encoded). `PGCP.Assessoria`, como em toda
 * mutação.
 * Validação, S3 e metadado: `documents/service.ts`.
 */
meetingsRouter.post("/:id/documents", requirePgcpAssessoria, async (req: Request, res: Response) => {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }
  const maximo = tamanhoMaximo();
  try {
    if (!req.is("application/octet-stream")) {
      throw new HttpError(415, "Envie o arquivo como application/octet-stream.");
    }
    const conteudo = await new Promise<Buffer>((resolver, rejeitar) => {
      express.raw({ type: "application/octet-stream", limit: maximo })(req, res, (erro?: unknown) => {
        if ((erro as { type?: string } | undefined)?.type === "entity.too.large") {
          rejeitar(new HttpError(413, `O arquivo excede o tamanho máximo de ${descreverTamanho(maximo)}.`));
        } else if (erro) {
          rejeitar(new HttpError(400, "Não foi possível ler o arquivo enviado."));
        } else {
          resolver(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
        }
      });
    });
    const cabecalho = (nome: string) => {
      const v = req.get(nome);
      if (v === undefined) return undefined;
      try {
        return decodeURIComponent(v);
      } catch {
        throw new HttpError(400, `Cabeçalho ${nome} inválido.`);
      }
    };
    for (const chave of Object.keys(req.query)) {
      if (chave !== "agendaItemId") throw new HttpError(400, `O parâmetro '${chave}' não é suportado.`);
    }
    const documento = await adicionarDocumentoDaReuniao(
      req.params.id as string,
      {
        nome: cabecalho("X-Document-Filename"),
        descricao: cabecalho("X-Document-Description"),
        agendaItemId: req.query.agendaItemId,
        conteudo,
      },
      { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId },
    );
    res.status(201).json({ document: documento });
  } catch (error) {
    sendError(res, error, "adicionar documento");
  }
});

/**
 * VERSÕES da reunião (034): lista e PDF de cada uma. Leitura, mesma política
 * do detalhe (usuário ativo + `visibility.ts`; reunião invisível = 404). A
 * versão é buscada pelo par (reunião, versão): id de versão de OUTRA reunião
 * responde 404 — sem IDOR.
 */
meetingsRouter.get("/:id/versions", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const meetingId = req.params.id as string;
    assertValidId(meetingId); // 400 antes de ir ao banco
    if (!(await podeVisualizarReuniao(meetingId, espectadorDa(req)))) throw new HttpError(404, "Reunião não encontrada.");
    res.json({ versions: await listarVersoesDaReuniao(meetingId) });
  } catch (error) {
    sendError(res, error, "listar versões");
  }
});

meetingsRouter.get("/:id/versions/:versionId/pdf", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const meetingId = req.params.id as string;
    assertValidId(meetingId); // 400 antes de ir ao banco
    if (!(await podeVisualizarReuniao(meetingId, espectadorDa(req)))) throw new HttpError(404, "Reunião não encontrada.");
    const { pdf, nome } = await gerarPdfDaVersao(meetingId, req.params.versionId as string);
    res.setHeader("Content-Type", PDF_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(pdf);
  } catch (error) {
    sendError(res, error, "gerar PDF da versão");
  }
});

meetingsRouter.get("/:id/versions/:versionId/changes", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const meetingId = req.params.id as string;
    assertValidId(meetingId); // 400 antes de ir ao banco
    if (!(await podeVisualizarReuniao(meetingId, espectadorDa(req)))) throw new HttpError(404, "Reunião não encontrada.");
    res.json(await diferencasDaVersaoPorId(meetingId, req.params.versionId as string));
  } catch (error) {
    sendError(res, error, "obter o que mudou na versão");
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
