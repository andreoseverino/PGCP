import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { versionarEmTransacaoPropria } from "../meetings/versions.js";
import {
  GraphError,
  getDirectoryAddressesByObjectIds,
  getGraphConfig,
  graphRequest,
  missingGraphConfig,
  type DirectoryAddress,
  type GraphConfig,
} from "../graph/client.js";
import { lerLocalDaReuniao } from "../meetings/locations.js";
import {
  montarAttendees,
  montarEvento,
  planejarChamadaDoEvento,
  resolverEnderecoCorporativo,
  type ParticipanteParaConvite,
  type ReuniaoParaCalendario,
} from "./mapper.js";

/**
 * Sincronizacao da reuniao com o calendario externo.
 *
 * PostgreSQL e Microsoft Graph NAO compartilham transacao, e este modulo nao
 * finge que compartilham. A reuniao commita primeiro e continua valida mesmo se
 * o Graph falhar; o resultado da chamada distribuida fica em
 * `meeting_calendar_integrations.sync_status`.
 *
 * A tela NUNCA diz "convite enviado" com base numa suposicao: o status vem
 * daqui, e `failed` e `failed`.
 *
 * APP-ONLY. Nao ha `/me`: a caixa e resolvida pela identidade MICROSOFT do
 * organizador (`meetings.organizer_entra_object_id`), e as chamadas usam
 * `/users/{oid}/events`. Isso e o que permite reprocessar sem exigir a sessao
 * do organizador — que pode nem ter conta no PGCP.
 *
 * ORGANIZADOR != QUEM CADASTROU. A assessora cadastra (`created_by_user_id`);
 * o evento nasce no calendario do Presidente (`organizer_*`). A trilha registra
 * quem executou; o calendario, de quem e a agenda.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CALENDAR_PROVIDER = "outlook";

export type CalendarSyncStatus = "pending" | "synced" | "failed" | "stale";

export interface CalendarIntegration {
  meetingId: string;
  provider: string;
  providerEventId: string | null;
  webLink: string | null;
  joinUrl: string | null;
  syncStatus: CalendarSyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface IntegrationRow {
  id: string;
  meeting_id: string;
  provider: string;
  provider_event_id: string | null;
  provider_calendar_id: string | null;
  web_link: string | null;
  join_url: string | null;
  idempotency_key: string;
  sync_status: CalendarSyncStatus;
  last_synced_at: Date | null;
  last_error: string | null;
}

type Executor = Pick<PoolClient, "query">;

const SELECT_INTEGRATION = `
  SELECT id, meeting_id, provider, provider_event_id, provider_calendar_id,
         web_link, join_url, idempotency_key, sync_status, last_synced_at, last_error
    FROM meeting_calendar_integrations
   WHERE meeting_id = $1 AND provider = $2`;

function montar(row: IntegrationRow): CalendarIntegration {
  return {
    meetingId: row.meeting_id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    webLink: row.web_link,
    joinUrl: row.join_url,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

/** Integracao da reuniao, se ja existir. Ausencia NAO e erro. */
export async function findCalendarIntegration(
  meetingId: string,
  executor: Executor = pool,
): Promise<CalendarIntegration | null> {
  const { rows } = await executor.query<IntegrationRow>(SELECT_INTEGRATION, [meetingId, CALENDAR_PROVIDER]);
  return rows[0] ? montar(rows[0]) : null;
}

/**
 * Marca o evento como desatualizado.
 *
 * Chamada DENTRO da transacao da mutacao que desatualizou — assim a reuniao
 * nunca fica alterada com a integracao dizendo `synced`. Sem integracao, ou com
 * integracao que ainda nao produziu evento, nao ha nada a desatualizar.
 */
export async function marcarComoDesatualizada(
  executor: Executor,
  meetingId: string,
): Promise<void> {
  await executor.query(
    `UPDATE meeting_calendar_integrations
        SET sync_status = 'stale'
      WHERE meeting_id = $1
        AND provider = $2
        AND sync_status = 'synced'`,
    [meetingId, CALENDAR_PROVIDER],
  );
}

/**
 * Cria a linha de integracao junto da reuniao, em `pending`.
 *
 * Nasce na MESMA transacao da reuniao para que a chave de idempotencia exista
 * antes de qualquer tentativa de chamada. Sem organizador resolvido nao ha
 * caixa de destino, e a linha simplesmente nao e criada — a reuniao continua
 * valida, apenas sem projecao no calendario.
 */
export async function prepararIntegracao(
  executor: Executor,
  meetingId: string,
  organizerEntraObjectId: string | null,
): Promise<void> {
  // Sem identidade Microsoft do organizador nao ha caixa de destino. A reuniao
  // continua valida; so nao tem projecao no calendario.
  if (!organizerEntraObjectId) return;

  await executor.query(
    `INSERT INTO meeting_calendar_integrations (meeting_id, provider, sync_status)
          VALUES ($1, $2, 'pending')
     ON CONFLICT (meeting_id, provider) DO NOTHING`,
    [meetingId, CALENDAR_PROVIDER],
  );
}

// ---------------------------------------------------------------------------
// Pre-condicoes
// ---------------------------------------------------------------------------

export interface PreCondicaoFalha {
  code:
    | "graph_not_configured"
    | "no_organizer"
    | "organizer_without_entra_identity"
    | "participants_without_email";
  message: string;
  /** Preenchido apenas em `participants_without_email`. */
  participants?: Array<{ participantId: string; displayName: string }>;
}

export class CalendarPreconditionError extends HttpError {
  constructor(readonly falha: PreCondicaoFalha) {
    super(422, falha.message);
    this.name = "CalendarPreconditionError";
  }
}

interface DadosDaSincronizacao {
  reuniao: ReuniaoParaCalendario;
  ownerEntraObjectId: string;
  participantes: ParticipanteParaConvite[];
}

type DirectoryAddressResolver = (
  config: GraphConfig,
  objectIds: readonly string[],
) => Promise<Map<string, DirectoryAddress>>;

/**
 * Reidrata somente participantes Entra do tenant configurado que não possuem
 * endereço local utilizável. A consulta é uma só operação lógica, batelada no
 * cliente Graph, e não grava snapshots nem altera a identidade persistida.
 */
export async function resolverEnderecosCorporativosDosParticipantes(
  participantes: readonly ParticipanteParaConvite[],
  config: GraphConfig,
  resolver: DirectoryAddressResolver = getDirectoryAddressesByObjectIds,
): Promise<ParticipanteParaConvite[]> {
  const tenant = config.tenantId.toLowerCase();
  const oids = [
    ...new Map(
      participantes
        .filter(
          (participante) =>
            !resolverEnderecoCorporativo(participante.email, participante.userPrincipalName) &&
            participante.entraTenantId?.toLowerCase() === tenant &&
            Boolean(participante.entraObjectId),
        )
        .map((participante) => [
          participante.entraObjectId!.toLowerCase(),
          participante.entraObjectId!,
        ]),
    ).values(),
  ];

  if (oids.length === 0) return [...participantes];

  const porOid = await resolver(config, oids);
  return participantes.map((participante) => {
    const endereco = participante.entraObjectId
      ? porOid.get(participante.entraObjectId.toLowerCase())
      : undefined;
    return endereco
      ? {
          ...participante,
          email: endereco.mail,
          userPrincipalName: endereco.userPrincipalName,
        }
      : { ...participante };
  });
}

/**
 * Reune tudo que a sincronizacao precisa e recusa cedo o que nao da para
 * cumprir. Falhar aqui e melhor do que descobrir no meio da chamada ao Graph:
 * a mensagem fica util e nenhum evento parcial nasce.
 */
async function carregarDados(executor: Executor, meetingId: string): Promise<DadosDaSincronizacao> {
  const { rows } = await executor.query<{
    id: string;
    title: string;
    description: string | null;
    start_at: Date;
    end_at: Date;
    timezone: string;
    meeting_link: string | null;
    organizer_entra_object_id: string | null;
    organizer_name: string | null;
    online_meeting_provider: "teamsForBusiness" | null;
    modality: "online" | "in_person";
    physical_location_snapshot: unknown;
    cancelled_at: Date | null;
  }>(
    `SELECT m.id, m.title, m.description, m.start_at, m.end_at, m.timezone,
            m.meeting_link, m.online_meeting_provider,
            m.modality, m.physical_location_snapshot,
            m.organizer_entra_object_id, m.organizer_name, m.cancelled_at
       FROM meetings m
      WHERE m.id = $1`,
    [meetingId],
  );

  const row = rows[0];
  if (!row) throw new HttpError(404, "Reunião não encontrada.");
  // Cancelada (036): nunca recriar nem atualizar o evento (seria "ressuscitar" o convite).
  if (row.cancelled_at) throw new HttpError(409, "Esta reunião foi cancelada; o convite não é enviado nem atualizado.");

  if (!row.organizer_entra_object_id) {
    /*
     * A identidade que importa aqui e a MICROSOFT, nao a conta no PGCP: o
     * organizador pode nem ter entrado no sistema. Sem (tenant, oid) nao ha
     * caixa de destino, e nao existe substituto legitimo — escolher outra
     * caixa criaria o evento na agenda da pessoa errada.
     */
    throw new CalendarPreconditionError({
      code: "organizer_without_entra_identity",
      message:
        "A reunião não tem organizador com identidade corporativa. Sem ela não há caixa de correio de destino.",
    });
  }

  /*
   * Endereco local por participante, na ordem de confiabilidade:
   *   1. `users.email` de quem tem conta no PGCP;
   *   2. o e-mail snapshot do proprio registro;
   *   3. `users.upn` como fallback corporativo.
   *
   * Nunca derivado de nome. Pessoa do Entra sem conta no PGCP so tem endereco
   * se ele foi capturado no momento da escolha no diretorio. Quando nenhum
   * endereço local serve, tenant+OID permitem a reidratação segura no Graph.
   */
  const { rows: participantes } = await executor.query<{
    id: string;
    display_name: string | null;
    user_email: string | null;
    participant_email: string | null;
    user_principal_name: string | null;
    user_id: string | null;
    entra_tenant_id: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT p.id,
            COALESCE(u.name, p.display_name) AS display_name,
            u.email                          AS user_email,
            p.email                          AS participant_email,
            u.upn                            AS user_principal_name,
            p.user_id,
            p.entra_tenant_id,
            p.entra_object_id
       FROM meeting_participants p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1
      ORDER BY display_name`,
    [meetingId],
  );

  return {
    reuniao: {
      id: row.id,
      title: row.title,
      description: row.description,
      startAt: row.start_at,
      endAt: row.end_at,
      timezone: row.timezone,
      meetingLink: row.meeting_link,
      onlineMeetingProvider: row.online_meeting_provider,
      modality: row.modality,
      physicalLocation:
        // Copia congelada (038): o convite leva o endereco da escolha, nao o cadastro atual.
        row.modality === "in_person" ? lerLocalDaReuniao(row.physical_location_snapshot) : null,
    },
    ownerEntraObjectId: row.organizer_entra_object_id,
    participantes: participantes.map((p) => ({
      participantId: p.id,
      displayName: p.display_name,
      email: resolverEnderecoCorporativo(p.user_email, p.participant_email),
      userPrincipalName: p.user_principal_name,
      userId: p.user_id,
      entraTenantId: p.entra_tenant_id,
      entraObjectId: p.entra_object_id,
    })),
  };
}

/**
 * Mensagem de erro guardada em `last_error`.
 *
 * Texto legivel apenas. Payload do Graph, token e corpo de resposta NUNCA
 * chegam ao banco — `GraphError` ja nasce sem eles, e qualquer outro erro entra
 * como mensagem generica.
 */
function mensagemDoErro(error: unknown): string {
  if (error instanceof CalendarPreconditionError || error instanceof HttpError) return error.message;
  if (error instanceof GraphError) return error.message;
  return "Falha inesperada ao sincronizar com o calendário.";
}

async function registrarFalha(meetingId: string, mensagem: string): Promise<void> {
  await pool.query(
    `UPDATE meeting_calendar_integrations
        SET sync_status = CASE WHEN provider_event_id IS NULL THEN 'failed' ELSE 'stale' END,
            last_error = $3
      WHERE meeting_id = $1 AND provider = $2`,
    [meetingId, CALENDAR_PROVIDER, mensagem.slice(0, 500)],
  );
}

// ---------------------------------------------------------------------------
// Sincronizacao
// ---------------------------------------------------------------------------

interface EventoResposta {
  id?: string;
  webLink?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  /**
   * Reuniao online provisionada pelo Graph dentro do evento.
   *
   * `joinUrl` daqui e o endereco oficial de entrada. `onlineMeetingUrl`, no
   * nivel do evento, e legado e a Microsoft orienta nao usar para isso.
   */
  onlineMeeting?: { joinUrl?: string };
}

/**
 * Sincroniza DEPOIS de uma mutacao — e so quando a mutacao desatualizou o evento.
 *
 * Quem decide se ha o que reprojetar continua sendo `CAMPOS_QUE_DESATUALIZAM`
 * via `marcarComoDesatualizada`: este helper apenas LE o estado que a transacao
 * deixou. Mutacao que nao aparece no convite (FUP, Anotacoes, Ata, status,
 * pautas) nao vira `stale` e portanto nao chama a Microsoft.
 *
 * `stale` e SO `stale`:
 *
 *   pending  a criacao ja tentou; insistir a cada edicao repetiria uma
 *            tentativa que ninguem pediu
 *   failed   ficou para o botao de tentar de novo — reeenviar automatico
 *            transformaria cada edicao numa nova batida num sistema que ja
 *            respondeu que nao esta disponivel
 *   synced   nao ha o que reprojetar
 *
 * UMA tentativa, sem laco e sem espera. A falha e engolida de proposito: a
 * alteracao de negocio ja esta gravada, e transformar indisponibilidade da
 * Microsoft em erro da edicao mentiria sobre o que aconteceu no PostgreSQL.
 * `syncMeetingCalendar` ja registrou `failed`, a mensagem sanitizada e a trilha.
 *
 * NUNCA dentro da transacao: o chamador executa isto depois do COMMIT.
 */
export async function syncCalendarAfterMutationIfNeeded(
  meetingId: string,
  actor: { id: string; name: string },
): Promise<void> {
  const integracao = await findCalendarIntegration(meetingId);
  if (integracao?.syncStatus !== "stale") return;

  try {
    await syncMeetingCalendar(meetingId, actor);
  } catch {
    // Estado e trilha ja foram gravados por `syncMeetingCalendar`.
  }
}

/**
 * `ImmutableId` para o identificador persistido.
 *
 * O id padrao do Graph MUDA quando o item e movido de pasta — guardar esse
 * valor daria um ponteiro que quebra sozinho. O cabecalho pede a forma estavel.
 */
const PREFER_IMMUTABLE_ID = { Prefer: 'IdType="ImmutableId"' };

/**
 * Cria ou atualiza o evento da reuniao.
 *
 * IDEMPOTENCIA: se ja existe `provider_event_id`, a operacao e PATCH nesse id —
 * nao ha busca por titulo, data ou participante. Se nao existe, e POST com a
 * MESMA `idempotency_key` de sempre, enviada como `transactionId`; reenviar
 * apos timeout repete a chave e o Graph reconhece a tentativa.
 *
 * NAO existe reconciliacao por consulta. Se um dia for preciso reencontrar um
 * evento perdido sem `provider_event_id`, isso e decisao de desenho a reportar —
 * varrer o calendario por titulo e data e o oposto de identidade.
 */
export async function syncMeetingCalendar(
  meetingId: string,
  actor: { id: string; name: string },
): Promise<CalendarIntegration> {
  if (!UUID_PATTERN.test(meetingId)) throw new HttpError(400, "Identificador da reunião inválido.");

  const integracao = await findCalendarIntegration(meetingId);
  if (!integracao) {
    throw new HttpError(404, "Esta reunião não tem integração de calendário preparada.");
  }

  const { rows: chaves } = await pool.query<{ idempotency_key: string; provider_event_id: string | null }>(
    `SELECT idempotency_key, provider_event_id
       FROM meeting_calendar_integrations
      WHERE meeting_id = $1 AND provider = $2`,
    [meetingId, CALENDAR_PROVIDER],
  );
  const { idempotency_key: idempotencyKey, provider_event_id: eventoExistente } = chaves[0]!;

  try {
    const config = getGraphConfig();
    if (!config) {
      throw new CalendarPreconditionError({
        code: "graph_not_configured",
        message: `Integração com o Microsoft Graph não configurada. Faltam: ${missingGraphConfig().join(", ")}.`,
      });
    }

    const dados = await carregarDados(pool, meetingId);
    const participantes = await resolverEnderecosCorporativosDosParticipantes(
      dados.participantes,
      config,
    );
    const { attendees, semEndereco } = montarAttendees(participantes);

    if (semEndereco.length > 0) {
      /*
       * Bloqueio deliberado. Convite parcial em silencio faria a tela afirmar
       * que todos foram convidados quando alguem ficou de fora — e a pessoa que
       * agendou so descobriria na hora da reuniao.
       */
      throw new CalendarPreconditionError({
        code: "participants_without_email",
        message: `Não foi possível obter o endereço corporativo de ${semEndereco.length} participante(s). O convite não foi enviado.`,
        participants: semEndereco,
      });
    }

    const evento = montarEvento(dados.reuniao, attendees, { idempotencyKey });
    // Existe evento? PATCH nele. Nao existe? POST com a chave fixa. Nunca um
    // segundo evento para a mesma reuniao — ver `planejarChamadaDoEvento`.
    const chamada = planejarChamadaDoEvento(dados.ownerEntraObjectId, eventoExistente, evento);

    const resposta = await graphRequest<EventoResposta>(config, chamada.path, {
      method: chamada.method,
      body: chamada.body,
      headers: PREFER_IMMUTABLE_ID,
      timeoutMs: 15000,
    });

    const eventId = resposta.id ?? eventoExistente;
    if (!eventId) {
      throw new GraphError("O Graph não devolveu o identificador do evento.", "no_event_id");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<IntegrationRow>(
        `UPDATE meeting_calendar_integrations
            SET provider_event_id = $3,
                web_link          = COALESCE($4, web_link),
                join_url          = COALESCE($5, join_url),
                sync_status       = 'synced',
                last_synced_at    = now(),
                last_error        = NULL
          WHERE meeting_id = $1 AND provider = $2
          RETURNING id, meeting_id, provider, provider_event_id, provider_calendar_id,
                    web_link, join_url, idempotency_key, sync_status, last_synced_at, last_error`,
        [meetingId, CALENDAR_PROVIDER, eventId, resposta.webLink ?? null, resposta.onlineMeeting?.joinUrl ?? null],
      );

      /*
       * Trilha do fato consumado. Sem identificador de evento, sem link, sem
       * payload do Graph: a acao e a reuniao bastam para auditar, e o resto
       * seria dado operacional numa tabela de governanca.
       */
      await recordAuditIn(client, {
        actorUserId: actor.id,
        actorName: actor.name,
        /*
         * Uma acao, um registro. Habilitar a reuniao online e uma atualizacao do
         * MESMO evento — inventar um segundo evento de trilha para o mesmo
         * PATCH duplicaria o fato.
         */
        action: eventoExistente ? "Evento Outlook atualizado" : "Evento Outlook criado",
        entityType: "meeting",
        entityId: meetingId,
        entityLabel: dados.reuniao.title,
        status: "success",
      });

      await client.query("COMMIT");
      const integracaoGravada = montar(rows[0]!);
      /*
       * Versão da reunião (034) — convite criado é mudança de configuração.
       * DEPOIS do COMMIT e em transação própria: o evento já existe no
       * Exchange, e uma falha local de versionamento não pode desfazer o
       * registro do convite (o próximo envio criaria evento duplicado).
       */
      await versionarEmTransacaoPropria(meetingId, { userId: actor.id, name: actor.name }).catch((erro: unknown) => {
        console.error("[calendar] versão da reunião após o convite não foi registrada:", (erro as { code?: string })?.code ?? "erro");
      });
      return integracaoGravada;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const mensagem = mensagemDoErro(error);
    await registrarFalha(meetingId, mensagem);

    // Trilha da falha FORA de transacao: o evento pode ter sido criado do outro
    // lado, e engolir o registro por causa de um erro do banco esconderia
    // justamente o caso que precisa de investigacao.
    await recordAuditIn(pool, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Sincronização Outlook falhou",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: mensagem.slice(0, 200),
      status: "failure",
    }).catch(() => {});

    throw error;
  }
}
