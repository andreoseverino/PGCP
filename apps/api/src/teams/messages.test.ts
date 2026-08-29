import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Pool } from "pg";
import type { AuditEntry } from "../audit/service.js";
import { GraphError } from "../graph/client.js";
import { HttpError } from "../http-error.js";
import {
  TEAMS_MESSAGE_MAX_LENGTH,
  assertEmptyTeamsCallInput,
  buildAgendaCallContent,
  hasRequiredTeamsDelegatedScopes,
  loadAgendaMessageContext,
  parseTeamsMessageInput,
  sendAgendaItemTeamsCall,
  sendAgendaItemTeamsMessage,
  sendOneToOneTeamsMessage,
  type AgendaMessageContext,
  type DelegatedTeamsContext,
  type TeamsGraphRequest,
} from "./messages.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const AGENDA_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const SENDER_OID = "44444444-4444-4444-8444-444444444444";
const MARIA_OID = "55555555-5555-4555-8555-555555555555";
const JOAO_OID = "66666666-6666-4666-8666-666666666666";
const CARLOS_OID = "77777777-7777-4777-8777-777777777777";

const ACTOR = {
  userId: "88888888-8888-4888-8888-888888888888",
  name: "André",
  entraTenantId: TENANT_ID,
  entraObjectId: SENDER_OID,
};

const DELEGATED: DelegatedTeamsContext = {
  config: {
    tenantId: TENANT_ID,
    clientId: "99999999-9999-4999-8999-999999999999",
    clientSecret: "test-only-secret",
    baseUrl: "https://graph.microsoft.com/v1.0",
  },
  accessToken: "test-only-delegated-token",
};

function context(
  participants: AgendaMessageContext["participants"],
): AgendaMessageContext {
  return {
    meetingId: MEETING_ID,
    meetingTitle: "Reunião de orçamento",
    meetingStartAt: new Date("2026-08-28T12:00:00.000Z"),
    meetingTimezone: "America/Sao_Paulo",
    meetingLink: "https://teams.example/legacy-meeting",
    calendarJoinUrl: "https://teams.microsoft.com/l/meetup-join/real-meeting",
    agendaItemId: AGENDA_ID,
    agendaItemTitle: "Aprovação do orçamento",
    agendaItemScheduledStartTime: "10:15:00",
    agendaItemDurationMinutes: 30,
    participants,
  };
}

function participant(id: string, name: string, objectId: string) {
  return {
    id,
    name,
    greetingName: name,
    entraTenantId: TENANT_ID,
    entraObjectId: objectId,
    teamsRole: "owner" as const,
  };
}

function dependencies(
  ctx: AgendaMessageContext,
  send: (
    recipientObjectId: string,
    message: string,
    contentType: "text" | "html",
  ) => Promise<void>,
  audits: AuditEntry[] = [],
) {
  return {
    loadContext: async () => ctx,
    acquireDelegated: async (token: string) => {
      assert.equal(token, "api-user-token");
      return DELEGATED;
    },
    sendOneToOne: async (
      delegated: DelegatedTeamsContext,
      senderObjectId: string,
      recipientObjectId: string,
      message: string,
      _recipientRole?: "owner" | "guest",
      contentType: "text" | "html" = "text",
    ) => {
      assert.equal(delegated, DELEGATED);
      assert.equal(senderObjectId, SENDER_OID);
      await send(recipientObjectId, message, contentType);
    },
    audit: async (entry: AuditEntry) => {
      audits.push(entry);
    },
  };
}

test("valida mensagem vazia, tamanho e mass assignment", () => {
  assert.throws(() => parseTeamsMessageInput({ message: "   " }), HttpError);
  assert.throws(
    () => parseTeamsMessageInput({ message: "x".repeat(TEAMS_MESSAGE_MAX_LENGTH + 1) }),
    HttpError,
  );
  assert.throws(
    () => parseTeamsMessageInput({ message: "olá", participantIds: [MARIA_OID] }),
    /não é aceito/,
  );
  assert.deepEqual(parseTeamsMessageInput({ message: "  olá  " }), { message: "olá" });
});

test("Chamar recusa conteudo e destinatarios enviados pelo frontend", () => {
  assert.doesNotThrow(() => assertEmptyTeamsCallInput(undefined));
  assert.doesNotThrow(() => assertEmptyTeamsCallInput({}));
  assert.throws(() => assertEmptyTeamsCallInput({ participantIds: [MARIA_OID] }), HttpError);
  assert.throws(() => assertEmptyTeamsCallInput({ message: "texto escolhido no cliente" }), HttpError);
});

test("resolver usa somente a relacao pauta-participante e identidade forte", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const executor = {
    async query(sql: string, params: unknown[]) {
      capturedSql = sql;
      capturedParams = params;
      return {
        rowCount: 1,
        rows: [{
          meeting_title: "Reunião de orçamento",
          meeting_start_at: new Date("2026-08-28T12:00:00.000Z"),
          meeting_timezone: "America/Sao_Paulo",
          meeting_link: "https://teams.example/legacy-meeting",
          calendar_join_url: "https://teams.microsoft.com/l/meetup-join/real-meeting",
          agenda_item_title: "Aprovação do orçamento",
          agenda_item_scheduled_start_time: "10:15:00",
          agenda_item_duration_minutes: 30,
          participant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          participant_name: "Maria",
          participant_type: "internal",
          participant_tenant_id: TENANT_ID,
          participant_object_id: MARIA_OID,
          user_tenant_id: null,
          user_object_id: null,
        }],
      };
    },
  } as unknown as Pick<Pool, "query">;

  const loaded = await loadAgendaMessageContext(MEETING_ID, AGENDA_ID, executor);

  assert.deepEqual(capturedParams, [MEETING_ID, AGENDA_ID]);
  assert.match(capturedSql, /JOIN meeting_agenda_items ai\s+ON ai\.meeting_id = m\.id/);
  assert.match(capturedSql, /meeting_agenda_item_participants/);
  assert.match(capturedSql, /mp\.meeting_id = m\.id/);
  assert.match(capturedSql, /meeting_calendar_integrations/);
  assert.equal(loaded.calendarJoinUrl, "https://teams.microsoft.com/l/meetup-join/real-meeting");
  assert.equal(loaded.agendaItemScheduledStartTime, "10:15:00");
  assert.equal(loaded.agendaItemDurationMinutes, 30);
  assert.deepEqual(loaded.participants[0], {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Maria",
    greetingName: "Maria",
    entraTenantId: TENANT_ID,
    entraObjectId: MARIA_OID,
    teamsRole: "owner",
  });
});

test("pauta de outra reuniao e rejeitada sem resolver destinatarios", async () => {
  const executor = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;

  await assert.rejects(
    loadAgendaMessageContext(MEETING_ID, AGENDA_ID, executor),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
});

test("Chamar preserva IDOR: pauta de outra reuniao nao chega ao Graph", async () => {
  let acquisitions = 0;
  const executor = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;

  await assert.rejects(
    sendAgendaItemTeamsCall(MEETING_ID, AGENDA_ID, ACTOR, "api-user-token", {
      loadContext: (meetingId, agendaItemId) =>
        loadAgendaMessageContext(meetingId, agendaItemId, executor),
      acquireDelegated: async () => {
        acquisitions += 1;
        return DELEGATED;
      },
    }),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(acquisitions, 0);
});

test("Graph recebe criação 1:1 e mensagem manual como texto com token delegado", async () => {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const request = (async <T>(
    _config: DelegatedTeamsContext["config"],
    path: string,
    options: Parameters<TeamsGraphRequest>[2] = {},
  ): Promise<T> => {
    calls.push({ path, options: options as unknown as Record<string, unknown> });
    return (calls.length === 1 ? { id: "chat/1" } : undefined) as T;
  }) as TeamsGraphRequest;

  await sendOneToOneTeamsMessage(
    DELEGATED,
    SENDER_OID,
    MARIA_OID,
    "Precisamos revisar os valores.",
    "owner",
    "text",
    request,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.path, "/chats");
  assert.equal(calls[0]!.options.method, "POST");
  assert.equal(calls[0]!.options.accessToken, DELEGATED.accessToken);
  assert.deepEqual(calls[0]!.options.body, {
    chatType: "oneOnOne",
    members: [
      {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${SENDER_OID}')`,
      },
      {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${MARIA_OID}')`,
      },
    ],
  });
  assert.equal(calls[1]!.path, "/chats/chat%2F1/messages");
  assert.deepEqual(calls[1]!.options.body, {
    body: { contentType: "text", content: "Precisamos revisar os valores." },
  });
});

test("Graph recebe a chamada automática com contentType html", async () => {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const request = (async <T>(
    _config: DelegatedTeamsContext["config"],
    path: string,
    options: Parameters<TeamsGraphRequest>[2] = {},
  ): Promise<T> => {
    calls.push({ path, options: options as unknown as Record<string, unknown> });
    return (calls.length === 1 ? { id: "chat-automatico" } : undefined) as T;
  }) as TeamsGraphRequest;

  await sendOneToOneTeamsMessage(
    DELEGATED,
    SENDER_OID,
    MARIA_OID,
    "<strong>PGCP — Chamada para pauta</strong>",
    "owner",
    "html",
    request,
  );

  assert.deepEqual(calls[1]!.options.body, {
    body: {
      contentType: "html",
      content: "<strong>PGCP — Chamada para pauta</strong>",
    },
  });
});

test("Chamar envia template HTML personalizado com cronograma e link corporativo", async () => {
  const messages: Array<{ content: string; contentType: "text" | "html" }> = [];
  const response = await sendAgendaItemTeamsCall(
    MEETING_ID,
    AGENDA_ID,
    ACTOR,
    "api-user-token",
    dependencies(context([participant("p1", "Maria", MARIA_OID)]), async (_oid, content, contentType) => {
      messages.push({ content, contentType });
    }),
  );

  assert.equal(response.sent, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.contentType, "html");
  const html = messages[0]!.content;
  assert.match(html, /<strong>PGCP — Chamada para pauta<\/strong>/);
  assert.match(html, /Olá, Maria\.<br><br>/);
  assert.match(html, /<strong>Prepare-se\. A sua pauta começará em breve\.<\/strong>/);
  assert.match(html, /<strong>Reunião:<\/strong> Reunião de orçamento<br>/);
  assert.match(html, /<strong>Pauta:<\/strong> Aprovação do orçamento<br>/);
  assert.match(html, /<strong>Data:<\/strong> 28\/08\/2026<br>/);
  assert.match(html, /<strong>Horário:<\/strong> 10:15 às 10:45<br>/);
  assert.match(html, /<strong>Duração:<\/strong> 30 minutos<br><br>/);
  assert.match(
    html,
    /<a href="https:\/\/teams\.microsoft\.com\/l\/meetup-join\/real-meeting"><strong>Entrar na reunião pelo Microsoft Teams<\/strong><\/a>/,
  );
  assert.equal((html.match(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/real-meeting/g) ?? []).length, 1);
  assert.doesNotMatch(html, />https:\/\/teams\.microsoft\.com/);
  assert.doesNotMatch(html, /teams\.example\/legacy-meeting/);
});

test("Chamar escapa nome, reunião e pauta sem permitir tags arbitrárias", () => {
  const html = buildAgendaCallContent(
    {
      ...context([]),
      meetingTitle: `Diretoria <script>alert("x")</script> & 'Especial'`,
      agendaItemTitle: `Planejamento <2027> & "Estratégia" 'Global'`,
      calendarJoinUrl: "https://teams.example/join?a=1&b=%22x%22",
    },
    `Ana <Admin> & "Operações" 'Brasil'`,
  ).message;

  assert.match(html, /Olá, Ana &lt;Admin&gt; &amp; &quot;Operações&quot; &#39;Brasil&#39;\./);
  assert.match(
    html,
    /Diretoria &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;Especial&#39;/,
  );
  assert.match(
    html,
    /Planejamento &lt;2027&gt; &amp; &quot;Estratégia&quot; &#39;Global&#39;/,
  );
  assert.match(html, /href="https:\/\/teams\.example\/join\?a=1&amp;b=%22x%22"/);
  assert.doesNotMatch(html, /<script>/i);
});

test("Chamar sem nome confiável usa saudação genérica", async () => {
  let message = "";
  const withoutName = {
    ...participant("p1", "Participante", MARIA_OID),
    greetingName: null,
  };

  await sendAgendaItemTeamsCall(
    MEETING_ID,
    AGENDA_ID,
    ACTOR,
    "api-user-token",
    dependencies(context([withoutName]), async (_oid, content) => {
      message = content;
    }),
  );

  assert.match(message, /<br><br>Olá\.<br><br>/);
  assert.doesNotMatch(message, /Olá, Participante/);
});

test("Chamar varios participantes faz uma tentativa 1:1 para cada um", async () => {
  const attempted: string[] = [];
  const response = await sendAgendaItemTeamsCall(
    MEETING_ID,
    AGENDA_ID,
    ACTOR,
    "api-user-token",
    dependencies(
      context([
        participant("p1", "Maria", MARIA_OID),
        participant("p2", "João", JOAO_OID),
        participant("p3", "Carlos", CARLOS_OID),
      ]),
      async (oid) => { attempted.push(oid); },
    ),
  );

  assert.deepEqual(attempted, [MARIA_OID, JOAO_OID, CARLOS_OID]);
  assert.equal(response.total, 3);
  assert.equal(response.sent, 3);
});

test("Chamar preserva sucesso parcial", async () => {
  const response = await sendAgendaItemTeamsCall(
    MEETING_ID,
    AGENDA_ID,
    ACTOR,
    "api-user-token",
    dependencies(
      context([
        participant("p1", "Maria", MARIA_OID),
        participant("p2", "João", JOAO_OID),
        participant("p3", "Carlos", CARLOS_OID),
      ]),
      async (oid) => {
        if (oid === CARLOS_OID) throw new GraphError("falha", "x", 503);
      },
    ),
  );

  assert.equal(response.sent, 2);
  assert.equal(response.failed, 1);
  assert.deepEqual(response.results.map((item) => item.status), ["sent", "sent", "failed"]);
});

test("Chamar pauta sem participantes nao adquire token nem chama Graph", async () => {
  let acquisitions = 0;
  let sends = 0;
  const response = await sendAgendaItemTeamsCall(
    MEETING_ID,
    AGENDA_ID,
    ACTOR,
    "api-user-token",
    {
      loadContext: async () => context([]),
      acquireDelegated: async () => {
        acquisitions += 1;
        return DELEGATED;
      },
      sendOneToOne: async () => { sends += 1; },
      audit: async () => undefined,
    },
  );

  assert.deepEqual(response, {
    meetingId: MEETING_ID,
    agendaItemId: AGENDA_ID,
    total: 0,
    sent: 0,
    failed: 0,
    results: [],
  });
  assert.equal(acquisitions, 0);
  assert.equal(sends, 0);
});

test("Chamar reuniao sem link valido falha antes de adquirir token", async () => {
  let acquisitions = 0;
  const ctx = {
    ...context([participant("p1", "Maria", MARIA_OID)]),
    calendarJoinUrl: null,
    meetingLink: "javascript:alert(1)",
  };

  await assert.rejects(
    sendAgendaItemTeamsCall(MEETING_ID, AGENDA_ID, ACTOR, "api-user-token", {
      ...dependencies(ctx, async () => undefined),
      acquireDelegated: async () => {
        acquisitions += 1;
        return DELEGATED;
      },
    }),
    (error: unknown) =>
      error instanceof HttpError && error.status === 422 && /não possui link/.test(error.message),
  );
  assert.equal(acquisitions, 0);
});

test("Chamar usa a data no fuso da reuniao e o horario persistido da pauta", () => {
  const content = buildAgendaCallContent({
    ...context([participant("p1", "Maria", MARIA_OID)]),
    // Em UTC ja e dia 29; em Sao Paulo a reuniao ainda pertence ao dia 28.
    meetingStartAt: new Date("2026-08-29T01:30:00.000Z"),
    agendaItemScheduledStartTime: "23:30:00",
    agendaItemDurationMinutes: 45,
  });

  assert.equal(content.date, "28/08/2026");
  assert.equal(content.startTime, "23:30");
  assert.equal(content.endTime, "00:15");
  assert.match(content.message, /<strong>Data:<\/strong> 28\/08\/2026/);
  assert.match(content.message, /<strong>Horário:<\/strong> 23:30 às 00:15/);
});

test("mensagem manual permanece texto e não interpreta HTML digitado", async () => {
  const deliveries: Array<{ message: string; contentType: "text" | "html" }> = [];
  const manual = "<strong>não transformar em HTML</strong>";

  await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: manual },
    ACTOR,
    "api-user-token",
    dependencies(context([participant("p1", "Maria", MARIA_OID)]), async (_oid, message, contentType) => {
      deliveries.push({ message, contentType });
    }),
  );

  assert.deepEqual(deliveries, [{ message: manual, contentType: "text" }]);
});

test("um participante valido recebe uma tentativa individual", async () => {
  const attempted: string[] = [];
  const response = await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: "Mensagem" },
    ACTOR,
    "api-user-token",
    dependencies(context([participant("p1", "Maria", MARIA_OID)]), async (oid) => {
      attempted.push(oid);
    }),
  );

  assert.deepEqual(attempted, [MARIA_OID]);
  assert.equal(response.sent, 1);
  assert.equal(response.failed, 0);
});

test("varios participantes recebem tentativas 1:1 separadas", async () => {
  const attempted: string[] = [];
  const response = await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: "Mensagem" },
    ACTOR,
    "api-user-token",
    dependencies(
      context([
        participant("p1", "Maria", MARIA_OID),
        participant("p2", "João", JOAO_OID),
        participant("p3", "Carlos", CARLOS_OID),
      ]),
      async (oid) => { attempted.push(oid); },
    ),
  );

  assert.deepEqual(attempted, [MARIA_OID, JOAO_OID, CARLOS_OID]);
  assert.equal(response.total, 3);
  assert.equal(response.sent, 3);
});

test("sucesso parcial preserva os envios concluidos", async () => {
  const response = await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: "Mensagem" },
    ACTOR,
    "api-user-token",
    dependencies(
      context([
        participant("p1", "Maria", MARIA_OID),
        participant("p2", "João", JOAO_OID),
        participant("p3", "Carlos", CARLOS_OID),
      ]),
      async (oid) => {
        if (oid === CARLOS_OID) throw new GraphError("erro técnico", "BadRequest", 400);
      },
    ),
  );

  assert.equal(response.sent, 2);
  assert.equal(response.failed, 1);
  assert.deepEqual(response.results.map((r) => r.status), ["sent", "sent", "failed"]);
  assert.equal(response.results[2]!.code, "delivery_failed");
});

test("participante sem identidade nao usa nome ou email como aproximacao", async () => {
  let attempted = 0;
  const response = await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: "Mensagem" },
    ACTOR,
    "api-user-token",
    dependencies(
      context([{
        id: "p1",
        name: "Maria Silva",
        greetingName: "Maria Silva",
        entraTenantId: null,
        entraObjectId: null,
        teamsRole: "owner",
        identityIssue: "missing_entra_identity",
      }]),
      async () => { attempted += 1; },
    ),
  );

  assert.equal(attempted, 0);
  assert.equal(response.results[0]!.code, "missing_entra_identity");
});

for (const scenario of [
  { status: 401, expected: "unauthorized" },
  { status: 403, expected: "forbidden" },
  { status: 429, expected: "throttled" },
] as const) {
  test(`Graph ${scenario.status} vira falha segura e estruturada`, async () => {
    const response = await sendAgendaItemTeamsMessage(
      MEETING_ID,
      AGENDA_ID,
      { message: "Mensagem" },
      ACTOR,
      "api-user-token",
      dependencies(context([participant("p1", "Maria", MARIA_OID)]), async () => {
        throw new GraphError(
          "detalhe que nao deve sair",
          "technical_graph_code",
          scenario.status,
          scenario.status === 429 ? 17 : undefined,
        );
      }),
    );

    assert.equal(response.results[0]!.code, scenario.expected);
    assert.equal(JSON.stringify(response).includes("detalhe que nao deve sair"), false);
    if (scenario.status === 429) assert.equal(response.retryAfterSeconds, 17);
  });
}

test("Graph 429 interrompe novas chamadas e respeita Retry-After no resultado", async () => {
  const attempted: string[] = [];
  const response = await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: "Mensagem" },
    ACTOR,
    "api-user-token",
    dependencies(
      context([
        participant("p1", "Maria", MARIA_OID),
        participant("p2", "João", JOAO_OID),
        participant("p3", "Carlos", CARLOS_OID),
      ]),
      async (oid) => {
        attempted.push(oid);
        throw new GraphError("throttle", "TooManyRequests", 429, 23);
      },
    ),
  );

  assert.deepEqual(attempted, [MARIA_OID]);
  assert.deepEqual(response.results.map((r) => r.code), ["throttled", "throttled", "throttled"]);
  assert.equal(response.retryAfterSeconds, 23);
});

test("auditoria registra ator, pauta, destinatario e resultado sem conteudo", async () => {
  const audits: AuditEntry[] = [];
  const secretMessage = "conteúdo que não pertence ao histórico do PGCP";

  await sendAgendaItemTeamsMessage(
    MEETING_ID,
    AGENDA_ID,
    { message: secretMessage },
    ACTOR,
    "api-user-token",
    dependencies(
      context([
        participant("p1", "Maria", MARIA_OID),
        participant("p2", "Carlos", CARLOS_OID),
      ]),
      async (oid) => {
        if (oid === CARLOS_OID) throw new GraphError("falha", "x", 404);
      },
      audits,
    ),
  );

  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map((entry) => entry.status), ["success", "failure"]);
  assert.ok(audits.every((entry) => entry.actorUserId === ACTOR.userId));
  assert.ok(audits.every((entry) => entry.entityId === AGENDA_ID));
  assert.match(audits[0]!.entityLabel!, /Reunião de orçamento.*Aprovação do orçamento.*Maria/);
  assert.equal(JSON.stringify(audits).includes(secretMessage), false);
});

test("auditoria distingue Chamar e registra destinatario e horario sem copiar mensagem", async () => {
  const audits: AuditEntry[] = [];

  await sendAgendaItemTeamsCall(
    MEETING_ID,
    AGENDA_ID,
    ACTOR,
    "api-user-token",
    dependencies(
      context([participant("p1", "Maria", MARIA_OID)]),
      async () => undefined,
      audits,
    ),
  );

  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.action, "Chamada Teams enviada");
  assert.equal(audits[0]!.actorUserId, ACTOR.userId);
  assert.equal(audits[0]!.entityId, AGENDA_ID);
  assert.match(
    audits[0]!.entityLabel!,
    /Reunião de orçamento.*Aprovação do orçamento.*Maria.*28\/08\/2026 10:15/,
  );
  assert.equal(JSON.stringify(audits).includes("Você está sendo chamado"), false);
  assert.equal(JSON.stringify(audits).includes("teams.microsoft.com"), false);
});

test("fluxo usa OBO com .default e nao client credentials", () => {
  const source = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");
  assert.match(source, /acquireTokenOnBehalfOf/);
  assert.match(source, /graph\.microsoft\.com\/\.default/);
  assert.doesNotMatch(source, /acquireTokenByClientCredential/);
});

test("valida no resultado do MSAL os scopes delegados exigidos", () => {
  assert.equal(
    hasRequiredTeamsDelegatedScopes(["Chat.Create", "ChatMessage.Send", "Mail.Send"]),
    true,
  );
  assert.equal(
    hasRequiredTeamsDelegatedScopes([
      "https://graph.microsoft.com/chat.create",
      "https://graph.microsoft.com/CHATMESSAGE.SEND",
    ]),
    true,
  );
  assert.equal(hasRequiredTeamsDelegatedScopes(["Chat.Create"]), false);
  assert.equal(hasRequiredTeamsDelegatedScopes(["ChatMessage.Send"]), false);
});
