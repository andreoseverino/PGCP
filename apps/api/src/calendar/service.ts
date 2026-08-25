import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { GraphError, getGraphConfig, graphRequest, missingGraphConfig } from "../graph/client.js";
import {
  montarAttendees,
  montarEvento,
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
    location: string | null;
    meeting_link: string | null;
    organizer_entra_object_id: string | null;
    organizer_name: string | null;
    online_meeting_provider: "teamsForBusiness" | null;
  }>(
    `SELECT m.id, m.title, m.description, m.start_at, m.end_at, m.timezone,
            m.location, m.meeting_link, m.online_meeting_provider,
            m.organizer_entra_object_id, m.organizer_name
       FROM meetings m
      WHERE m.id = $1`,
    [meetingId],
  );

  const row = rows[0];
  if (!row) throw new HttpError(404, "Reunião não encontrada.");

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
   * Endereco por participante, na ordem de confiabilidade:
   *   1. `users.email` de quem tem conta no PGCP;
   *   2. o e-mail informado no proprio registro do participante.
   *
   * Nunca derivado de nome. Pessoa do Entra sem conta no PGCP so tem endereco
   * se ele foi capturado no momento da escolha no diretorio.
   */
  const { rows: participantes } = await executor.query<{
    id: string;
    display_name: string | null;
    email: string | null;
    user_id: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT p.id,
            COALESCE(u.name, p.display_name) AS display_name,
            COALESCE(u.email, p.email)       AS email,
            p.user_id,
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
      location: row.location,
      meetingLink: row.meeting_link,
      onlineMeetingProvider: row.online_meeting_provider,
    },
    ownerEntraObjectId: row.organizer_entra_object_id,
    participantes: participantes.map((p) => ({
      participantId: p.id,
      displayName: p.display_name,
      email: p.email,
      userId: p.user_id,
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
    const { attendees, semEndereco } = montarAttendees(dados.participantes);

    if (semEndereco.length > 0) {
      /*
       * Bloqueio deliberado. Convite parcial em silencio faria a tela afirmar
       * que todos foram convidados quando alguem ficou de fora — e a pessoa que
       * agendou so descobriria na hora da reuniao.
       */
      throw new CalendarPreconditionError({
        code: "participants_without_email",
        message: `${semEndereco.length} participante(s) sem e-mail utilizável. O convite não foi enviado.`,
        participants: semEndereco,
      });
    }

    const evento = montarEvento(dados.reuniao, attendees, { idempotencyKey });
    const base = `/users/${dados.ownerEntraObjectId}`;

    const resposta = eventoExistente
      ? await graphRequest<EventoResposta>(config, `${base}/events/${eventoExistente}`, {
          method: "PATCH",
          // `transactionId` e so da criacao: reenvia-lo num PATCH nao significa nada.
          body: { ...evento, transactionId: undefined },
          headers: PREFER_IMMUTABLE_ID,
          timeoutMs: 15000,
        })
      : await graphRequest<EventoResposta>(config, `${base}/events`, {
          method: "POST",
          body: evento,
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
      return montar(rows[0]!);
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
