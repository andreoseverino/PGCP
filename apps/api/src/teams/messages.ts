import { ConfidentialClientApplication } from "@azure/msal-node";
import type { Pool } from "pg";
import { recordAudit, type AuditEntry } from "../audit/service.js";
import { assertTimezoneSuportado, instanteParaHoraLocal } from "../calendar/mapper.js";
import pool from "../database.js";
import {
  GraphError,
  getGraphConfig,
  graphRequest,
  missingGraphConfig,
  type GraphConfig,
} from "../graph/client.js";
import { HttpError } from "../http-error.js";
import { urlHttpOpcional } from "../meetings/create.js";

/** Limite do contrato PGCP. O Graph nunca recebe texto sem teto. */
export const TEAMS_MESSAGE_MAX_LENGTH = 4000;

const GRAPH_OBO_SCOPE = "https://graph.microsoft.com/.default";
const REQUIRED_TEAMS_SCOPES = ["Chat.Create", "ChatMessage.Send"] as const;

/**
 * O MSAL devolve em `scopes` as permissoes validadas para o token. O Graph
 * pode representa-las qualificadas pelo recurso ou apenas pelo nome.
 */
export function hasRequiredTeamsDelegatedScopes(scopes: readonly string[]): boolean {
  const granted = new Set(
    scopes.map((scope) =>
      scope.trim().replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase(),
    ),
  );
  return REQUIRED_TEAMS_SCOPES.every((scope) => granted.has(scope.toLowerCase()));
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new HttpError(400, `${field} inválido.`);
  return value.toLowerCase();
}

export interface TeamsMessageInput {
  message: string;
}

/** Corpo fechado: destinatarios nunca sao aceitos do navegador. */
export function parseTeamsMessageInput(body: unknown): TeamsMessageInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da solicitação deve ser um objeto.");
  }

  const data = body as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (key !== "message") {
      throw new HttpError(400, `O campo '${key}' não é aceito neste endpoint.`);
    }
  }

  if (typeof data.message !== "string" || data.message.trim().length === 0) {
    throw new HttpError(400, "A mensagem não pode estar vazia.");
  }

  const message = data.message.trim();
  if (message.length > TEAMS_MESSAGE_MAX_LENGTH) {
    throw new HttpError(
      400,
      `A mensagem não pode exceder ${TEAMS_MESSAGE_MAX_LENGTH} caracteres.`,
    );
  }

  return { message };
}

/** O endpoint Chamar nao recebe texto nem destinatarios do navegador. */
export function assertEmptyTeamsCallInput(body: unknown): void {
  if (body === undefined) return;
  if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  ) return;
  throw new HttpError(400, "O botão Chamar não aceita conteúdo ou destinatários no corpo.");
}

interface AgendaMessageRow {
  meeting_title: string;
  meeting_start_at: Date;
  meeting_timezone: string;
  meeting_link: string | null;
  calendar_join_url: string | null;
  agenda_item_title: string;
  agenda_item_scheduled_start_time: string | null;
  agenda_item_duration_minutes: number | null;
  participant_id: string | null;
  participant_name: string | null;
  participant_type: "internal" | "external" | null;
  participant_tenant_id: string | null;
  participant_object_id: string | null;
  user_tenant_id: string | null;
  user_object_id: string | null;
}

export type ParticipantIdentityIssue =
  | "missing_entra_identity"
  | "conflicting_entra_identity";

export interface AgendaMessageParticipant {
  id: string;
  name: string;
  /** Nome confiável para saudação; `null` quando só existe o rótulo de fallback. */
  greetingName: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
  /** Papel exigido pelo Graph: convidado do tenant entra como `guest`. */
  teamsRole: "owner" | "guest";
  identityIssue?: ParticipantIdentityIssue;
}

export interface AgendaMessageContext {
  meetingId: string;
  meetingTitle: string;
  meetingStartAt: Date;
  meetingTimezone: string;
  meetingLink: string | null;
  calendarJoinUrl: string | null;
  agendaItemId: string;
  agendaItemTitle: string;
  agendaItemScheduledStartTime: string | null;
  agendaItemDurationMinutes: number | null;
  participants: AgendaMessageParticipant[];
}

type QueryExecutor = Pick<Pool, "query">;

function identityPair(
  tenantId: string | null,
  objectId: string | null,
): { tenantId: string; objectId: string } | "invalid" | null {
  if (!tenantId && !objectId) return null;
  if (!tenantId || !objectId) return "invalid";
  return { tenantId: tenantId.toLowerCase(), objectId: objectId.toLowerCase() };
}

function participantFromRow(row: AgendaMessageRow): AgendaMessageParticipant {
  const direct = identityPair(row.participant_tenant_id, row.participant_object_id);
  const fromUser = identityPair(row.user_tenant_id, row.user_object_id);
  const greetingName = row.participant_name?.trim() || null;
  const base = {
    id: row.participant_id!,
    name: greetingName ?? "Participante",
    greetingName,
    teamsRole: row.participant_type === "external" ? "guest" as const : "owner" as const,
  };

  if (direct === "invalid" || fromUser === "invalid") {
    return { ...base, entraTenantId: null, entraObjectId: null, identityIssue: "conflicting_entra_identity" };
  }

  if (direct && fromUser && (direct.tenantId !== fromUser.tenantId || direct.objectId !== fromUser.objectId)) {
    return { ...base, entraTenantId: null, entraObjectId: null, identityIssue: "conflicting_entra_identity" };
  }

  const identity = direct ?? fromUser;
  if (!identity) {
    return { ...base, entraTenantId: null, entraObjectId: null, identityIssue: "missing_entra_identity" };
  }

  return {
    ...base,
    entraTenantId: identity.tenantId,
    entraObjectId: identity.objectId,
  };
}

/**
 * Resolve reuniao, pauta e participantes em uma consulta.
 *
 * O JOIN pauta->reuniao e o JOIN vinculo->participante impedem IDOR e evitam
 * uma lista de destinatarios controlada pelo cliente. Identidade Microsoft vem
 * do par forte tenant+oid; nome e apenas rotulo de exibicao.
 */
export async function loadAgendaMessageContext(
  meetingIdInput: string,
  agendaItemIdInput: string,
  executor: QueryExecutor = pool,
): Promise<AgendaMessageContext> {
  const meetingId = assertUuid(meetingIdInput, "Identificador da reunião");
  const agendaItemId = assertUuid(agendaItemIdInput, "Identificador da pauta");

  const { rows } = await executor.query<AgendaMessageRow>(
    `SELECT m.title AS meeting_title,
            m.start_at AS meeting_start_at,
            m.timezone AS meeting_timezone,
            m.meeting_link,
            mci.join_url AS calendar_join_url,
            ai.title AS agenda_item_title,
            ai.scheduled_start_time AS agenda_item_scheduled_start_time,
            ai.duration_minutes AS agenda_item_duration_minutes,
            mp.id AS participant_id,
            COALESCE(NULLIF(btrim(mp.display_name), ''), u.name) AS participant_name,
            mp.participant_type,
            mp.entra_tenant_id AS participant_tenant_id,
            mp.entra_object_id AS participant_object_id,
            u.entra_tenant_id AS user_tenant_id,
            u.entra_object_id AS user_object_id
       FROM meetings m
       JOIN meeting_agenda_items ai
         ON ai.meeting_id = m.id
       LEFT JOIN meeting_calendar_integrations mci
         ON mci.meeting_id = m.id
        AND mci.provider = 'outlook'
       LEFT JOIN meeting_agenda_item_participants aip
         ON aip.meeting_agenda_item_id = ai.id
       LEFT JOIN meeting_participants mp
         ON mp.id = aip.meeting_participant_id
        AND mp.meeting_id = m.id
       LEFT JOIN users u
         ON u.id = mp.user_id
      WHERE m.id = $1
        AND ai.id = $2
      ORDER BY participant_name NULLS LAST, mp.id`,
    [meetingId, agendaItemId],
  );

  if (rows.length === 0) {
    throw new HttpError(404, "Pauta não encontrada nesta reunião.");
  }

  return {
    meetingId,
    meetingTitle: rows[0]!.meeting_title,
    meetingStartAt: rows[0]!.meeting_start_at,
    meetingTimezone: rows[0]!.meeting_timezone,
    meetingLink: rows[0]!.meeting_link,
    calendarJoinUrl: rows[0]!.calendar_join_url,
    agendaItemId,
    agendaItemTitle: rows[0]!.agenda_item_title,
    agendaItemScheduledStartTime: rows[0]!.agenda_item_scheduled_start_time,
    agendaItemDurationMinutes: rows[0]!.agenda_item_duration_minutes,
    participants: rows
      .filter((row) => row.participant_id !== null)
      .map(participantFromRow),
  };
}

export interface AgendaCallContent {
  message: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  meetingLink: string;
}

function meetingAccessLink(context: AgendaMessageContext): string {
  for (const candidate of [context.calendarJoinUrl, context.meetingLink]) {
    try {
      const valid = urlHttpOpcional(candidate, "link da reunião");
      if (valid) return valid;
    } catch {
      // Dado legado invalido nao vira link na mensagem; tenta o fallback.
    }
  }
  throw new HttpError(
    422,
    "A reunião ainda não possui link de acesso disponível. Sincronize o convite e tente novamente.",
  );
}

function clockFromMinutes(total: number): string {
  const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

/** Escapa texto dinâmico antes de inseri-lo no template HTML controlado. */
export function escapeTeamsHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildAgendaCallHtml(
  context: AgendaMessageContext,
  details: Pick<AgendaCallContent, "date" | "startTime" | "endTime" | "durationMinutes" | "meetingLink">,
  participantName: string | null,
): string {
  const name = participantName?.trim();
  const greeting = name ? `Olá, ${escapeTeamsHtml(name)}.` : "Olá.";
  const durationLabel = details.durationMinutes === 1
    ? "1 minuto"
    : `${details.durationMinutes} minutos`;

  const message = [
    "<strong>PGCP — Chamada para pauta</strong><br><br>",
    `${greeting}<br><br>`,
    "<strong>Prepare-se. A sua pauta começará em breve.</strong><br><br>",
    `<strong>Reunião:</strong> ${escapeTeamsHtml(context.meetingTitle)}<br>`,
    `<strong>Pauta:</strong> ${escapeTeamsHtml(context.agendaItemTitle)}<br>`,
    `<strong>Data:</strong> ${details.date}<br>`,
    `<strong>Horário:</strong> ${details.startTime} às ${details.endTime}<br>`,
    `<strong>Duração:</strong> ${durationLabel}<br><br>`,
    `<a href="${escapeTeamsHtml(details.meetingLink)}"><strong>Entrar na reunião pelo Microsoft Teams</strong></a>`,
  ].join("");

  if (message.length > TEAMS_MESSAGE_MAX_LENGTH) {
    throw new HttpError(422, "Os dados da pauta excedem o limite da mensagem do Teams.");
  }

  return message;
}

/** Monta a chamada exclusivamente com dados oficiais ja persistidos no PGCP. */
export function buildAgendaCallContent(
  context: AgendaMessageContext,
  participantName: string | null = null,
): AgendaCallContent {
  const scheduled = context.agendaItemScheduledStartTime?.trim();
  const match = scheduled?.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) {
    throw new HttpError(422, "A pauta ainda não possui horário programado para a chamada.");
  }

  const durationMinutes = context.agendaItemDurationMinutes;
  if (durationMinutes === null || !Number.isInteger(durationMinutes) || durationMinutes < 0) {
    throw new HttpError(422, "A pauta ainda não possui duração definida para a chamada.");
  }

  const timezone = assertTimezoneSuportado(context.meetingTimezone);
  const localDate = instanteParaHoraLocal(context.meetingStartAt, timezone).slice(0, 10);
  const [year, month, day] = localDate.split("-");
  const date = `${day}/${month}/${year}`;
  const startTime = `${match[1]}:${match[2]}`;
  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endTime = clockFromMinutes(startMinutes + durationMinutes);
  const meetingLink = meetingAccessLink(context);
  const details = { date, startTime, endTime, durationMinutes, meetingLink };
  const message = buildAgendaCallHtml(context, details, participantName);

  return { message, ...details };
}

let oboClient: ConfidentialClientApplication | null = null;
let oboClientKey = "";

function getOboClient(config: GraphConfig): ConfidentialClientApplication {
  const key = `${config.tenantId}:${config.clientId}`;
  if (!oboClient || oboClientKey !== key) {
    oboClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        clientSecret: config.clientSecret,
      },
    });
    oboClientKey = key;
  }
  return oboClient;
}

export interface DelegatedTeamsContext {
  config: GraphConfig;
  accessToken: string;
}

/** Troca o token destinado a API PGCP por um token Graph delegado. */
async function acquireDelegatedTeamsContext(userToken: string): Promise<DelegatedTeamsContext> {
  const config = getGraphConfig();
  if (!config) {
    throw new HttpError(
      503,
      `Integração com o Microsoft Graph não configurada. Faltam: ${missingGraphConfig().join(", ")}.`,
    );
  }

  try {
    const result = await getOboClient(config).acquireTokenOnBehalfOf({
      oboAssertion: userToken,
      scopes: [GRAPH_OBO_SCOPE],
    });
    if (!result?.accessToken) {
      throw new GraphError("O Entra ID não devolveu token delegado.", "no_obo_token");
    }
    if (!hasRequiredTeamsDelegatedScopes(result.scopes)) {
      throw new GraphError(
        "O token delegado não contém as permissões necessárias para mensagens no Teams.",
        "obo_insufficient_scope",
        403,
      );
    }
    return { config, accessToken: result.accessToken };
  } catch (error) {
    if (error instanceof GraphError || error instanceof HttpError) throw error;

    const detail = error instanceof Error ? error.message : String(error);
    // Nunca inclui assertion, access token ou segredo.
    console.error("[teams] falha na troca On-Behalf-Of:", detail);

    if (/AADSTS65001|consent/i.test(detail)) {
      throw new GraphError(
        "A sessão não pôde usar as permissões delegadas do Teams. Entre novamente e tente outra vez.",
        "consent_required",
        403,
      );
    }
    if (/AADSTS500131|AADSTS50013|assertion|AADSTS50076|interaction_required/i.test(detail)) {
      throw new GraphError(
        "A credencial da sessão não foi aceita na troca de token. Entre novamente.",
        "invalid_assertion",
        401,
      );
    }
    throw new GraphError(
      "Não foi possível obter autorização para enviar a mensagem no Teams.",
      "obo_error",
      502,
    );
  }
}

export type TeamsGraphRequest = typeof graphRequest;

/** Cria/localiza o chat 1:1 e envia texto manual ou o HTML fixo do Chamar. */
export async function sendOneToOneTeamsMessage(
  delegated: DelegatedTeamsContext,
  senderObjectId: string,
  recipientObjectId: string,
  message: string,
  recipientRole: "owner" | "guest" = "owner",
  contentType: "text" | "html" = "text",
  request: TeamsGraphRequest = graphRequest,
): Promise<void> {
  const bind = (objectId: string) =>
    `https://graph.microsoft.com/v1.0/users('${objectId}')`;

  const chat = await request<{ id?: string }>(delegated.config, "/chats", {
    method: "POST",
    accessToken: delegated.accessToken,
    body: {
      chatType: "oneOnOne",
      members: [
        {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": bind(senderObjectId),
        },
        {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: [recipientRole],
          "user@odata.bind": bind(recipientObjectId),
        },
      ],
    },
  });

  if (!chat?.id) {
    throw new GraphError("O Graph não devolveu o identificador do chat.", "chat_id_missing", 502);
  }

  await request<void>(delegated.config, `/chats/${encodeURIComponent(chat.id)}/messages`, {
    method: "POST",
    accessToken: delegated.accessToken,
    body: {
      body: {
        contentType,
        content: message,
      },
    },
  });
}

export type TeamsDeliveryCode =
  | ParticipantIdentityIssue
  | "different_tenant"
  | "same_as_sender"
  | "unauthorized"
  | "forbidden"
  | "throttled"
  | "not_found"
  | "graph_unavailable"
  | "delivery_failed";

export interface TeamsDeliveryResult {
  participantId: string;
  participantName: string;
  status: "sent" | "failed";
  code?: TeamsDeliveryCode;
  retryAfterSeconds?: number;
}

export interface TeamsMessageResponse {
  meetingId: string;
  agendaItemId: string;
  total: number;
  sent: number;
  failed: number;
  results: TeamsDeliveryResult[];
  retryAfterSeconds?: number;
}

export interface TeamsMessageActor {
  userId: string;
  name: string;
  entraTenantId: string;
  entraObjectId: string;
}

interface TeamsMessageDependencies {
  loadContext: typeof loadAgendaMessageContext;
  acquireDelegated: (userToken: string) => Promise<DelegatedTeamsContext>;
  sendOneToOne: typeof sendOneToOneTeamsMessage;
  audit: (entry: AuditEntry) => Promise<void>;
}

type TeamsMessagePurpose = "manual" | "agenda_call";

const defaultDependencies: TeamsMessageDependencies = {
  loadContext: loadAgendaMessageContext,
  acquireDelegated: acquireDelegatedTeamsContext,
  sendOneToOne: sendOneToOneTeamsMessage,
  audit: recordAudit,
};

function safeDeliveryFailure(error: unknown): {
  code: TeamsDeliveryCode;
  retryAfterSeconds?: number;
} {
  if (error instanceof GraphError) {
    if (error.status === 401) return { code: "unauthorized" };
    if (error.status === 403) return { code: "forbidden" };
    if (error.status === 404) return { code: "not_found" };
    if (error.status === 429) return { code: "throttled", retryAfterSeconds: error.retryAfterSeconds };
    if (error.status && error.status >= 500) return { code: "graph_unavailable" };
  }
  return { code: "delivery_failed" };
}

function auditEntry(
  context: AgendaMessageContext,
  actor: TeamsMessageActor,
  participant: AgendaMessageParticipant,
  status: "success" | "failure",
  purpose: TeamsMessagePurpose,
  callContent?: AgendaCallContent,
): AuditEntry {
  const isCall = purpose === "agenda_call";
  return {
    actorUserId: actor.userId,
    actorName: actor.name,
    action: isCall
      ? status === "success" ? "Chamada Teams enviada" : "Falha na chamada Teams"
      : status === "success" ? "Mensagem Teams enviada" : "Falha no envio de mensagem Teams",
    entityType: "meeting_agenda_item",
    entityId: context.agendaItemId,
    // Metadados suficientes para localizar reuniao, pauta e destinatario. O
    // conteudo da mensagem deliberadamente nao entra na trilha.
    entityLabel:
      `${context.meetingTitle} — ${context.agendaItemTitle} — ${participant.name}` +
      (isCall && callContent ? ` — ${callContent.date} ${callContent.startTime}` : ""),
    status,
  };
}

/**
 * Envia individualmente, preservando sucessos quando outro destinatario falha.
 */
async function deliverAgendaItemTeamsMessage(
  context: AgendaMessageContext,
  input: TeamsMessageInput,
  actor: TeamsMessageActor,
  userToken: string,
  deps: TeamsMessageDependencies,
  purpose: TeamsMessagePurpose,
  callContent?: AgendaCallContent,
): Promise<TeamsMessageResponse> {
  const results: TeamsDeliveryResult[] = [];

  if (context.participants.length === 0) {
    return {
      meetingId: context.meetingId,
      agendaItemId: context.agendaItemId,
      total: 0,
      sent: 0,
      failed: 0,
      results,
    };
  }

  const delegated = await deps.acquireDelegated(userToken);
  let throttled = false;
  let throttledRetryAfterSeconds: number | undefined;

  for (const participant of context.participants) {
    let preconditionCode: TeamsDeliveryCode | undefined = participant.identityIssue;
    if (!preconditionCode && participant.entraTenantId !== actor.entraTenantId.toLowerCase()) {
      preconditionCode = "different_tenant";
    }
    if (!preconditionCode && participant.entraObjectId === actor.entraObjectId.toLowerCase()) {
      preconditionCode = "same_as_sender";
    }

    if (preconditionCode || !participant.entraObjectId) {
      results.push({
        participantId: participant.id,
        participantName: participant.name,
        status: "failed",
        code: preconditionCode ?? "missing_entra_identity",
      });
      await deps.audit(auditEntry(context, actor, participant, "failure", purpose, callContent));
      continue;
    }

    if (throttled) {
      results.push({
        participantId: participant.id,
        participantName: participant.name,
        status: "failed",
        code: "throttled",
        ...(throttledRetryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: throttledRetryAfterSeconds }),
      });
      await deps.audit(auditEntry(context, actor, participant, "failure", purpose, callContent));
      continue;
    }

    try {
      const contentType = purpose === "agenda_call" ? "html" : "text";
      const message = purpose === "agenda_call" && callContent
        ? buildAgendaCallHtml(context, callContent, participant.greetingName)
        : input.message;
      await deps.sendOneToOne(
        delegated,
        actor.entraObjectId,
        participant.entraObjectId,
        message,
        participant.teamsRole,
        contentType,
      );
      results.push({
        participantId: participant.id,
        participantName: participant.name,
        status: "sent",
      });
      await deps.audit(auditEntry(context, actor, participant, "success", purpose, callContent));
    } catch (error) {
      const failure = safeDeliveryFailure(error);
      if (failure.code === "throttled") {
        // Retry-After vale para a dependencia compartilhada. Nao martelar o
        // Graph com os destinatarios restantes e parte de respeitar o throttle.
        throttled = true;
        throttledRetryAfterSeconds = failure.retryAfterSeconds;
      }
      results.push({
        participantId: participant.id,
        participantName: participant.name,
        status: "failed",
        ...failure,
      });
      await deps.audit(auditEntry(context, actor, participant, "failure", purpose, callContent));
    }
  }

  const sent = results.filter((result) => result.status === "sent").length;
  const retryAfterSeconds = results.reduce<number | undefined>(
    (largest, result) =>
      result.retryAfterSeconds === undefined
        ? largest
        : Math.max(largest ?? 0, result.retryAfterSeconds),
    undefined,
  );

  return {
    meetingId: context.meetingId,
    agendaItemId: context.agendaItemId,
    total: results.length,
    sent,
    failed: results.length - sent,
    results,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** Envio manual: o texto vem do corpo fechado; todo o restante vem do banco. */
export async function sendAgendaItemTeamsMessage(
  meetingId: string,
  agendaItemId: string,
  input: TeamsMessageInput,
  actor: TeamsMessageActor,
  userToken: string,
  dependencies: Partial<TeamsMessageDependencies> = {},
): Promise<TeamsMessageResponse> {
  const deps = { ...defaultDependencies, ...dependencies };
  const context = await deps.loadContext(meetingId, agendaItemId);
  return deliverAgendaItemTeamsMessage(context, input, actor, userToken, deps, "manual");
}

/**
 * Botao Chamar: usa os mesmos destinatarios, OBO, Graph, falhas e auditoria do
 * envio manual, mas o texto e composto somente com dados oficiais da pauta.
 */
export async function sendAgendaItemTeamsCall(
  meetingId: string,
  agendaItemId: string,
  actor: TeamsMessageActor,
  userToken: string,
  dependencies: Partial<TeamsMessageDependencies> = {},
): Promise<TeamsMessageResponse> {
  const deps = { ...defaultDependencies, ...dependencies };
  const context = await deps.loadContext(meetingId, agendaItemId);

  // Sem destinatarios nao ha motivo para exigir link nem adquirir token Graph.
  if (context.participants.length === 0) {
    return deliverAgendaItemTeamsMessage(
      context,
      { message: "" },
      actor,
      userToken,
      deps,
      "agenda_call",
    );
  }

  const callContent = buildAgendaCallContent(context);
  return deliverAgendaItemTeamsMessage(
    context,
    { message: callContent.message },
    actor,
    userToken,
    deps,
    "agenda_call",
    callContent,
  );
}
