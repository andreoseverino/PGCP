import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import type { AgendaValidationStatus } from "./agenda-validation.js";
import { findCalendarIntegration, type CalendarIntegration, type CalendarSyncStatus } from "../calendar/service.js";
import { lerLocalDaReuniao, type LocalFisico } from "./locations.js";

/**
 * Leitura de reunioes. SOMENTE LEITURA nesta etapa.
 *
 * Fonte unica: PostgreSQL. Nao existe fallback para mock, initialData ou
 * qualquer estado do navegador — se o banco estiver vazio, a resposta e uma
 * lista vazia, e isso e um resultado correto.
 *
 * O contrato usa os nomes das COLUNAS, em camelCase, e nao os nomes do tipo
 * `Meeting` do frontend. Alinhar a API ao formato legado apenas para facilitar
 * a troca de fonte carregaria para o servidor decisoes que ja se provaram
 * erradas — `category` como texto do orgao e o exemplo mais claro.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mesmo conjunto do CHECK `meetings_status_check`. */
export const MEETING_STATUSES = [
  "draft",
  "scheduled",
  "needs_approval",
  "in_progress",
  "done",
  "approved",
  "closed",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Teto de resultados. Protege o banco de uma consulta sem limite. */
export const MEETINGS_LIMIT_DEFAULT = 100;
export const MEETINGS_LIMIT_MAX = 200;

// -----------------------------------------------------------------------------
// Contrato
// -----------------------------------------------------------------------------

/** Orgao colegiado resolvido. Substitui o antigo `Meeting.category`, que era texto. */
export interface MeetingGovernanceBody {
  id: string;
  name: string;
  /**
   * Presidente da Mesa CADASTRADO NO ÓRGÃO (migration 023) — fato do órgão,
   * nao desta reuniao. Alimenta a secao MESA da Ata sem depender de alguem
   * marcar um participante como "presidente" toda vez.
   */
  chairEntraObjectId: string | null;
  chairName: string | null;
  /**
   * Presidente da Mesa EXTERNO (035): cadastro `external_participants`, sem
   * conta no PGCP e sem identidade Microsoft. Exclusivo com
   * `chairEntraObjectId`. Não concede acesso a nada.
   */
  chairExternalParticipantId: string | null;
}

/**
 * Organizador, quando ha uma PESSOA com conta no PGCP.
 *
 * Vem nulo tambem quando o organizador e um setor ("Secretaria Geral de
 * Governanca"): `meetings` so tem `organizer_user_id`, sem coluna de rotulo
 * textual. Preencher com o nome de quem criou a reuniao seria inventar.
 */
export interface MeetingOrganizer {
  userId: string;
  name: string;
}

export interface MeetingSummary {
  id: string;
  title: string;
  description: string | null;
  governanceBody: MeetingGovernanceBody;
  organizer: MeetingOrganizer | null;
  /** Instante em UTC (ISO-8601). O fuso de exibicao vem de `timezone`. */
  startAt: string;
  endAt: string;
  /** Identificador IANA, ex.: America/Sao_Paulo. Nunca abreviacao como BRT. */
  timezone: string;
  /** Link digitado a mao (sala de terceiro). NAO e o link do Teams. */
  meetingLink: string | null;
  /**
   * Reuniao online do PROPRIO evento de calendario, quando houver.
   *
   * Aqui vive a DECISAO; o link provisionado pelo Graph vive em
   * `calendar.joinUrl`. Ter os dois lados separados e o que permite a tela
   * dizer "Teams pedido, ainda nao sincronizado" sem inventar link.
   */
  onlineMeetingProvider: "teamsForBusiness" | null;
  /**
   * Modalidade (025). `in_person` continua com Teams — ele e contingencia.
   */
  modality: "online" | "in_person";
  /**
   * Local fisico resolvido do catalogo (`locations.ts`), so no presencial.
   * Endereco `null` enquanto nao estiver configurado — nunca inventado.
   */
  physicalLocation: LocalFisico | null;
  /** De onde a reuniao veio: Calendario (manual) ou reserva da Agenda Anual. */
  origin: "manual" | "annual_agenda";
  annualAgendaId: string | null;
  /** Status da Agenda Anual da reunião (`null` = reunião avulsa). */
  annualAgendaStatus: "draft" | "pending_approval" | "approved" | null;
  /**
   * Operacional no Pipeline? SEMPRE `true` desde 10/2026: a Agenda Anual não
   * tem mais aprovação que segure a reunião. Mantido no contrato para clientes
   * que ainda leem o campo.
   */
  releasedToPipeline: true;
  /**
   * Estado do convite (`meeting_calendar_integrations.sync_status`), tambem no
   * resumo para o Pipeline nao precisar abrir cada reuniao. `null` = sem
   * integracao preparada.
   */
  calendarSyncStatus: CalendarSyncStatus | null;
  /**
   * Situação da Ata (`meeting_minutes.status`) no resumo, para a Visão Geral
   * contar atas pendentes sem abrir cada reunião. `null` = Ata não iniciada.
   */
  minutesStatus: MinutesStatusResumo | null;
  /** Tipo (030); `null` = legado com título livre. */
  sessionType: "ordinary" | "extraordinary" | null;
  status: MeetingStatus;
  /**
   * Cancelada/excluída logicamente (036). `null` = ativa. Cancelada sai das
   * listagens ativas e é somente leitura; o detalhe continua legível (histórico).
   */
  cancelledAt: string | null;
  /** Evento do Outlook/Teams cancelado. `null` com reunião cancelada e evento = pendente. */
  calendarEventCancelledAt: string | null;
  /**
   * Ciclo da PAUTA — eixo SEPARADO de `status`, que e o ciclo da reuniao.
   *
   *   draft     em preparacao; nada saiu do PGCP
   *   sent      PDF enviado ao aprovador, aguardando validacao
   *   approved  validacao registrada pela Secretaria
   *
   * Desde a 025 o convite NAO depende deste eixo, e desde 10/2026 iniciar a
   * reuniao tambem nao (`meeting-start.ts`): a validacao e OPCIONAL, gravada
   * como historico.
   */
  agendaValidation: {
    status: AgendaValidationStatus;
    sentAt: string | null;
    /** E-mail do aprovador. Dado de negocio, nunca credencial. */
    sentTo: string | null;
    approvedAt: string | null;
  };
  recurrence: string | null;
  pendingRequirements: string | null;
  /** DERIVADO: COUNT em meeting_participants. Nao existe coluna equivalente. */
  participantsCount: number;
  /** DERIVADO: COUNT em meeting_agenda_items. */
  agendaItemsCount: number;
  /** Temas sem duração (impedem o cronograma). */
  agendaItemsWithoutDuration: number;
  /** Documentos ANEXADOS à reunião ou aos temas dela (`documents`). */
  documentsCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Participante da reuniao.
 *
 * Tres identificadores DISTINTOS, devolvidos lado a lado e nunca convertidos
 * um no outro:
 *
 *   userId                        -> identidade interna do PGCP
 *   entraTenantId + entraObjectId -> identidade Microsoft
 *   displayName / email           -> snapshot textual do momento da inclusao
 *
 * Nenhuma chamada ao Microsoft Graph acontece aqui: o snapshot do banco basta
 * para renderizar, e a lista de presenca continua funcionando com o Graph fora
 * do ar.
 */
export interface MeetingParticipant {
  id: string;
  userId: string | null;
  /** `users.name` quando ha conta no PGCP. NAO substitui `displayName`. */
  userName: string | null;
  displayName: string | null;
  email: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
  participantType: "internal" | "external";
  roleInMeeting: string | null;
  isConfirmed: boolean;
  attended: boolean | null;
  /**
   * A pessoa pertence HOJE ao grupo do órgão colegiado da reunião (027/031) —
   * informativo (texto de remoção, origem discreta). Não autoriza nada.
   */
  inGovernanceBodyGroup: boolean;
}

/** Responsavel pela pauta. Conceito DISTINTO de apresentador. */
export interface AgendaItemResponsible {
  /** Pessoa, area, orgao ou coletivo. Snapshot textual. */
  label: string;
  /** Preenchidos so quando o responsavel e pessoa escolhida no diretorio. */
  entraTenantId: string | null;
  entraObjectId: string | null;
}

/**
 * PAUTA da reuniao (025): agrupa temas. Reuniao -> Pauta -> Tema.
 */
export interface MeetingAgenda {
  id: string;
  title: string;
  position: number;
}

/**
 * TEMA da reuniao (`meeting_agenda_items`). O nome tecnico e anterior a 025,
 * quando "pauta" designava o assunto especifico; a tabela nao foi renomeada.
 */
export interface MeetingAgendaItem {
  id: string;
  /** Pauta a que este tema pertence. `null` = tema sem pauta (legado). */
  agendaId: string | null;
  title: string;
  position: number;
  /** Hora local do dia da reuniao (HH:mm:ss), sem fuso proprio. */
  scheduledStartTime: string | null;
  durationMinutes: number | null;
  executionStatus: "pending" | "presenting" | "completed" | "postponed";
  /** Pauta da biblioteca que originou o item, quando houve uma. */
  agendaTopicId: string | null;
  /** Item de outra reuniao do qual este veio por adiamento. */
  postponedFromItemId: string | null;
  responsible: AgendaItemResponsible | null;
  /**
   * Apresentador coletivo/textual. Campo SEPARADO de `responsible` de
   * proposito: responder pela pauta e apresenta-la sao papeis diferentes.
   * Apresentadores pessoa vivem em `meeting_agenda_item_presenters` e nao sao
   * lidos nesta etapa — nenhuma tela os preenche ainda.
   */
  presenterLabel: string | null;
  /** Tema circular NESTA reuniao — propriedade da pauta da reuniao. */
  isCircularTheme: boolean;
  /**
   * Ficha cadastral NESTA reuniao (snapshot, 019). Tipo e Natureza vêm com
   * `{id, name}` para a tela pré-selecionar e o PDF exibir. `null` quando a
   * pauta não tem o campo (item antigo ou criado sem classificação).
   */
  type: { id: string; name: string } | null;
  nature: { id: string; name: string } | null;
  description: string | null;
  /** "Tema de FUP" — apenas classificação; não cria action_item. */
  generatesActionItem: boolean;
  /**
   * Participantes POR PAUTA (020, Opção A). Cada um existe também em
   * `meeting_participants` — `participantId` é o id da participação na reunião,
   * usado para desvincular. `name` é o rótulo de exibição.
   */
  participants: { participantId: string; name: string }[];
}

export interface MeetingDetail extends MeetingSummary {
  participants: MeetingParticipant[];
  /** Pautas (agrupadores), em ordem. */
  agendas: MeetingAgenda[];
  /** Temas, em ordem global de `position`. */
  agendaItems: MeetingAgendaItem[];
  /**
   * Estado da projecao no calendario externo. `null` quando a reuniao nao tem
   * integracao preparada — tipicamente por nao ter organizador resolvido.
   *
   * A tela le daqui se o convite existe. Nunca supoe sucesso: `failed` e
   * `failed`, e `stale` significa que o evento existe mas nao reflete mais a
   * reuniao.
   */
  calendar: CalendarIntegration | null;
}

// -----------------------------------------------------------------------------
// Linhas do banco
// -----------------------------------------------------------------------------

interface MeetingRow {
  id: string;
  title: string;
  description: string | null;
  start_at: Date;
  end_at: Date;
  timezone: string;
  meeting_link: string | null;
  online_meeting_provider: "teamsForBusiness" | null;
  modality: "online" | "in_person";
  physical_location_snapshot: unknown;
  origin: "manual" | "annual_agenda";
  annual_agenda_id: string | null;
  annual_agenda_status: "draft" | "pending_approval" | "approved" | null;
  calendar_sync_status: CalendarSyncStatus | null;
  minutes_status: MinutesStatusResumo | null;
  session_type: "ordinary" | "extraordinary" | null;
  status: MeetingStatus;
  cancelled_at: Date | null;
  calendar_event_cancelled_at: Date | null;
  agenda_validation_status: AgendaValidationStatus;
  agenda_validation_sent_at: Date | null;
  agenda_validation_sent_to: string | null;
  agenda_approved_at: Date | null;
  recurrence: string | null;
  pending_requirements: string | null;
  created_at: Date;
  updated_at: Date;
  governance_body_id: string;
  governance_body_name: string;
  governance_body_chair_entra_object_id: string | null;
  governance_body_chair_name: string | null;
  governance_body_chair_external_id: string | null;
  organizer_user_id: string | null;
  organizer_name: string | null;
  participants_count: number;
  agenda_items_count: number;
  agenda_items_without_duration: number;
  documents_count: number;
}

interface ParticipantRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  display_name: string | null;
  email: string | null;
  entra_tenant_id: string | null;
  entra_object_id: string | null;
  participant_type: "internal" | "external";
  role_in_meeting: string | null;
  is_confirmed: boolean;
  attended: boolean | null;
  in_body_group: boolean;
}

interface AgendaItemRow {
  id: string;
  meeting_agenda_id: string | null;
  title: string;
  position: number;
  scheduled_start_time: string | null;
  duration_minutes: number | null;
  execution_status: MeetingAgendaItem["executionStatus"];
  agenda_topic_id: string | null;
  postponed_from_item_id: string | null;
  responsible_label: string | null;
  responsible_entra_tenant_id: string | null;
  responsible_entra_object_id: string | null;
  presenter_label: string | null;
  is_circular_theme: boolean;
  agenda_topic_type_id: string | null;
  type_name: string | null;
  agenda_topic_nature_id: string | null;
  nature_name: string | null;
  description: string | null;
  generates_action_item: boolean;
}

function toSummary(row: MeetingRow): MeetingSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    governanceBody: {
      id: row.governance_body_id,
      name: row.governance_body_name,
      chairEntraObjectId: row.governance_body_chair_entra_object_id,
      chairName: row.governance_body_chair_name,
      chairExternalParticipantId: row.governance_body_chair_external_id,
    },
    organizer:
      row.organizer_user_id && row.organizer_name
        ? { userId: row.organizer_user_id, name: row.organizer_name }
        : null,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    timezone: row.timezone,
    meetingLink: row.meeting_link,
    onlineMeetingProvider: row.online_meeting_provider,
    modality: row.modality,
    // Copia congelada no momento da escolha (038), nunca o cadastro atual.
    physicalLocation: row.modality === "in_person" ? lerLocalDaReuniao(row.physical_location_snapshot) : null,
    origin: row.origin,
    annualAgendaId: row.annual_agenda_id,
    annualAgendaStatus: row.annual_agenda_status,
    releasedToPipeline: true,
    calendarSyncStatus: row.calendar_sync_status,
    minutesStatus: row.minutes_status,
    sessionType: row.session_type,
    status: row.status,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    calendarEventCancelledAt: row.calendar_event_cancelled_at?.toISOString() ?? null,
    agendaValidation: {
      status: row.agenda_validation_status,
      sentAt: row.agenda_validation_sent_at?.toISOString() ?? null,
      sentTo: row.agenda_validation_sent_to,
      approvedAt: row.agenda_approved_at?.toISOString() ?? null,
    },
    recurrence: row.recurrence,
    pendingRequirements: row.pending_requirements,
    participantsCount: row.participants_count,
    agendaItemsCount: row.agenda_items_count,
    agendaItemsWithoutDuration: row.agenda_items_without_duration,
    documentsCount: row.documents_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toParticipant(row: ParticipantRow): MeetingParticipant {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    displayName: row.display_name,
    email: row.email,
    entraTenantId: row.entra_tenant_id,
    entraObjectId: row.entra_object_id,
    participantType: row.participant_type,
    roleInMeeting: row.role_in_meeting,
    isConfirmed: row.is_confirmed,
    attended: row.attended,
    inGovernanceBodyGroup: row.in_body_group,
  };
}

function toAgendaItem(row: AgendaItemRow): MeetingAgendaItem {
  return {
    id: row.id,
    agendaId: row.meeting_agenda_id,
    title: row.title,
    position: row.position,
    scheduledStartTime: row.scheduled_start_time,
    durationMinutes: row.duration_minutes,
    executionStatus: row.execution_status,
    agendaTopicId: row.agenda_topic_id,
    postponedFromItemId: row.postponed_from_item_id,
    // Sem rotulo nao ha responsavel: a migration 003 garante que identidade
    // Microsoft nunca chega aqui desacompanhada de nome.
    responsible: row.responsible_label
      ? {
          label: row.responsible_label,
          entraTenantId: row.responsible_entra_tenant_id,
          entraObjectId: row.responsible_entra_object_id,
        }
      : null,
    presenterLabel: row.presenter_label,
    isCircularTheme: row.is_circular_theme,
    type: row.agenda_topic_type_id && row.type_name ? { id: row.agenda_topic_type_id, name: row.type_name } : null,
    nature:
      row.agenda_topic_nature_id && row.nature_name
        ? { id: row.agenda_topic_nature_id, name: row.nature_name }
        : null,
    description: row.description,
    generatesActionItem: row.generates_action_item,
    participants: [], // preenchido por listAgendaItems numa segunda consulta.
  };
}

// -----------------------------------------------------------------------------
// Consultas
// -----------------------------------------------------------------------------

/**
 * INNER JOIN em governance_bodies: a FK e NOT NULL com ON DELETE RESTRICT,
 * entao o orgao sempre resolve. LEFT JOIN em users porque `organizer_user_id`
 * e opcional por design.
 */
/** Valores de `meeting_minutes.status` (CHECK do banco). */
type MinutesStatusResumo = "draft" | "under_review" | "approved" | "closed";

const SUMMARY_SELECT = `
  SELECT m.id,
         m.title,
         m.description,
         m.start_at,
         m.end_at,
         m.timezone,
         m.meeting_link,
         m.online_meeting_provider,
         m.modality,
         m.physical_location_snapshot,
         m.origin,
         m.annual_agenda_id,
         (SELECT aa.status FROM annual_agendas aa WHERE aa.id = m.annual_agenda_id) AS annual_agenda_status,
         (SELECT ci.sync_status FROM meeting_calendar_integrations ci
           WHERE ci.meeting_id = m.id AND ci.provider = 'outlook') AS calendar_sync_status,
         (SELECT mm.status FROM meeting_minutes mm WHERE mm.meeting_id = m.id) AS minutes_status,
         m.session_type,
         m.status,
         m.cancelled_at,
         m.calendar_event_cancelled_at,
         m.agenda_validation_status,
         m.agenda_validation_sent_at,
         m.agenda_validation_sent_to,
         m.agenda_approved_at,
         m.recurrence,
         m.pending_requirements,
         m.created_at,
         m.updated_at,
         gb.id                    AS governance_body_id,
         gb.name                  AS governance_body_name,
         gb.chair_entra_object_id AS governance_body_chair_entra_object_id,
         -- Externo: o nome ATUAL do cadastro; Entra: o snapshot da escolha.
         COALESCE(chair_ext.full_name, gb.chair_name) AS governance_body_chair_name,
         gb.chair_external_participant_id AS governance_body_chair_external_id,
         m.organizer_user_id,
         org.name AS organizer_name,
         (SELECT count(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id)::int AS participants_count,
         (SELECT count(*) FROM meeting_agenda_items ai WHERE ai.meeting_id = m.id)::int AS agenda_items_count,
         (SELECT count(*) FROM meeting_agenda_items ai WHERE ai.meeting_id = m.id AND ai.duration_minutes IS NULL)::int AS agenda_items_without_duration,
         (SELECT count(*) FROM documents dc WHERE dc.meeting_id = m.id)::int AS documents_count
    FROM meetings m
    JOIN governance_bodies gb ON gb.id = m.governance_body_id
    LEFT JOIN external_participants chair_ext ON chair_ext.id = gb.chair_external_participant_id
    LEFT JOIN users org       ON org.id = m.organizer_user_id
`;

export interface ListMeetingsFilters {
  governanceBodyId?: string;
  status?: MeetingStatus;
  /** Data local (YYYY-MM-DD) do inicio da reuniao, inclusiva. */
  dateFrom?: string;
  dateTo?: string;
  limit: number;
}

export async function listMeetings(filters: ListMeetingsFilters, db: Executor = pool): Promise<MeetingSummary[]> {
  // Listagem = fluxos ATIVOS (Pipeline, Calendário, Visão Geral, busca):
  // reunião cancelada (036) não volta. O detalhe (`findMeeting`) segue legível.
  const conditions: string[] = ["m.cancelled_at IS NULL"];
  const params: unknown[] = [];

  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.governanceBodyId) {
    conditions.push(`m.governance_body_id = ${bind(filters.governanceBodyId)}`);
  }

  if (filters.status) {
    conditions.push(`m.status = ${bind(filters.status)}`);
  }

  /*
   * O recorte por data usa o fuso DA PROPRIA REUNIAO, nao UTC. Uma reuniao as
   * 22h em America/Sao_Paulo cai no dia seguinte em UTC, e filtrar pelo instante
   * cru a esconderia do dia em que ela de fato aconteceu.
   *
   * Custo: o predicado e uma expressao sobre `start_at` e nao usa o indice
   * `meetings_start_at_idx`. Aceitavel enquanto o volume for pequeno; se virar
   * problema, a saida e um indice por expressao, nao trocar a semantica.
   */
  if (filters.dateFrom) {
    conditions.push(`(m.start_at AT TIME ZONE m.timezone)::date >= ${bind(filters.dateFrom)}::date`);
  }

  if (filters.dateTo) {
    conditions.push(`(m.start_at AT TIME ZONE m.timezone)::date <= ${bind(filters.dateTo)}::date`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // `m.id` como criterio de desempate mantem a ordem estavel entre chamadas
  // quando duas reunioes comecam no mesmo instante.
  const { rows } = await db.query<MeetingRow>(
    `${SUMMARY_SELECT} ${where} ORDER BY m.start_at DESC, m.id LIMIT ${bind(filters.limit)}`,
    params,
  );

  return rows.map(toSummary);
}

type Executor = Pick<PoolClient, "query">;

/**
 * Detalhe da reuniao. `db` permite ler DENTRO de uma transacao (versionamento:
 * a foto precisa ver o que a mutacao acabou de gravar, antes do COMMIT). Num
 * cliente de transacao as consultas vao em sequencia — o `pg` nao paraleliza
 * no mesmo cliente.
 */
export async function findMeeting(id: string, db: Executor = pool): Promise<MeetingDetail> {
  assertValidId(id);

  const { rows } = await db.query<MeetingRow>(`${SUMMARY_SELECT} WHERE m.id = $1`, [id]);
  const row = rows[0];

  if (!row) {
    throw new HttpError(404, "Reunião não encontrada.");
  }

  const [participants, agendas, agendaItems, calendar] =
    db === pool
      ? await Promise.all([listParticipants(id), listAgendas(id), listAgendaItems(id), findCalendarIntegration(id)])
      : [
          await listParticipants(id, db),
          await listAgendas(id, db),
          await listAgendaItems(id, db),
          await findCalendarIntegration(id, db),
        ];

  return { ...toSummary(row), participants, agendas, agendaItems, calendar };
}

async function listAgendas(meetingId: string, db: Executor = pool): Promise<MeetingAgenda[]> {
  const { rows } = await db.query<MeetingAgenda>(
    `SELECT id, title, position
       FROM meeting_agendas
      WHERE meeting_id = $1
      ORDER BY position, id`,
    [meetingId],
  );
  return rows;
}

async function listParticipants(meetingId: string, db: Executor = pool): Promise<MeetingParticipant[]> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT mp.id,
            mp.user_id,
            u.name AS user_name,
            mp.display_name,
            mp.email,
            mp.entra_tenant_id,
            mp.entra_object_id,
            mp.participant_type,
            mp.role_in_meeting,
            mp.is_confirmed,
            mp.attended,
            -- Grupo do órgão da reunião: pessoa do diretório pelo par (tenant, oid);
            -- externo do PGCP pelo e-mail (é como ele entra na reunião).
            EXISTS (
              SELECT 1
                FROM participant_governance_bodies g
                JOIN meetings m ON m.id = mp.meeting_id AND m.governance_body_id = g.governance_body_id
                LEFT JOIN directory_people dp ON dp.id = g.directory_person_id
                LEFT JOIN external_participants ep ON ep.id = g.external_participant_id
               WHERE (dp.id IS NOT NULL
                      AND dp.entra_tenant_id = coalesce(mp.entra_tenant_id, u.entra_tenant_id)
                      AND dp.entra_object_id = coalesce(mp.entra_object_id, u.entra_object_id))
                  OR (ep.id IS NOT NULL AND mp.email IS NOT NULL AND lower(ep.email) = lower(mp.email))
            ) AS in_body_group
       FROM meeting_participants mp
       LEFT JOIN users u ON u.id = mp.user_id
      WHERE mp.meeting_id = $1
      ORDER BY coalesce(mp.display_name, u.name), mp.id`,
    [meetingId],
  );

  return rows.map(toParticipant);
}

async function listAgendaItems(meetingId: string, db: Executor = pool): Promise<MeetingAgendaItem[]> {
  const { rows } = await db.query<AgendaItemRow>(
    `SELECT ai.id,
            ai.meeting_agenda_id,
            ai.title,
            ai.position,
            ai.scheduled_start_time,
            ai.duration_minutes,
            ai.execution_status,
            ai.agenda_topic_id,
            ai.postponed_from_item_id,
            ai.responsible_label,
            ai.responsible_entra_tenant_id,
            ai.responsible_entra_object_id,
            ai.presenter_label,
            ai.is_circular_theme,
            ai.agenda_topic_type_id,   tt.name AS type_name,
            ai.agenda_topic_nature_id, tn.name AS nature_name,
            ai.description,
            ai.generates_action_item
       FROM meeting_agenda_items ai
       LEFT JOIN agenda_topic_types    tt ON tt.id = ai.agenda_topic_type_id
       LEFT JOIN agenda_topic_natures  tn ON tn.id = ai.agenda_topic_nature_id
      WHERE ai.meeting_id = $1
      ORDER BY ai.position`,
    [meetingId],
  );

  const itens = rows.map(toAgendaItem);

  // Participantes POR PAUTA (020): uma consulta para toda a reunião, agrupada por
  // item. `name` prioriza o nome de exibição/usuário; e-mail é último recurso.
  const { rows: vinculos } = await db.query<{
    meeting_agenda_item_id: string;
    participant_id: string;
    name: string;
  }>(
    `SELECT aip.meeting_agenda_item_id,
            mp.id AS participant_id,
            coalesce(mp.display_name, u.name, mp.email) AS name
       FROM meeting_agenda_item_participants aip
       JOIN meeting_agenda_items ai ON ai.id = aip.meeting_agenda_item_id
       JOIN meeting_participants  mp ON mp.id = aip.meeting_participant_id
       LEFT JOIN users u ON u.id = mp.user_id
      WHERE ai.meeting_id = $1
      ORDER BY coalesce(mp.display_name, u.name, mp.email), mp.id`,
    [meetingId],
  );

  const porItem = new Map<string, { participantId: string; name: string }[]>();
  for (const v of vinculos) {
    const lista = porItem.get(v.meeting_agenda_item_id) ?? [];
    lista.push({ participantId: v.participant_id, name: v.name });
    porItem.set(v.meeting_agenda_item_id, lista);
  }
  for (const item of itens) item.participants = porItem.get(item.id) ?? [];

  return itens;
}

// -----------------------------------------------------------------------------
// Validacao da entrada
// -----------------------------------------------------------------------------

/** Garante que o :id da rota e um UUID antes de ir ao banco. */
export function assertValidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new HttpError(400, "Identificador inválido.");
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Le os filtros da query string. Nao confia em nada que venha do cliente:
 * valor desconhecido vira 400, e nunca e ignorado em silencio — um filtro
 * descartado sem aviso devolveria mais dado do que o cliente pediu.
 */
export function parseListFilters(query: Record<string, unknown>): ListMeetingsFilters {
  const filters: ListMeetingsFilters = { limit: MEETINGS_LIMIT_DEFAULT };

  const texto = (valor: unknown, campo: string): string | undefined => {
    if (valor === undefined) return undefined;
    if (typeof valor !== "string") {
      throw new HttpError(400, `O parâmetro '${campo}' deve ser informado uma única vez.`);
    }
    const limpo = valor.trim();
    return limpo.length > 0 ? limpo : undefined;
  };

  const governanceBodyId = texto(query.governanceBodyId, "governanceBodyId");
  if (governanceBodyId) {
    if (!UUID_PATTERN.test(governanceBodyId)) {
      throw new HttpError(400, "O parâmetro 'governanceBodyId' deve ser um UUID.");
    }
    filters.governanceBodyId = governanceBodyId;
  }

  const status = texto(query.status, "status");
  if (status) {
    if (!(MEETING_STATUSES as readonly string[]).includes(status)) {
      throw new HttpError(400, `O parâmetro 'status' deve ser um de: ${MEETING_STATUSES.join(", ")}.`);
    }
    filters.status = status as MeetingStatus;
  }

  for (const campo of ["dateFrom", "dateTo"] as const) {
    const valor = texto(query[campo], campo);
    if (!valor) continue;
    if (!DATE_PATTERN.test(valor)) {
      throw new HttpError(400, `O parâmetro '${campo}' deve estar no formato YYYY-MM-DD.`);
    }
    /*
     * Rejeita 2026-02-30 e afins: o formato bate, mas a data nao existe.
     *
     * `Date.parse` NAO serve para isso — ele aceita o dia fora do intervalo do
     * mes e transborda em silencio (2026-02-30 vira 2026-03-02). Sem esta
     * verificacao, o valor chegaria ao PostgreSQL como `'2026-02-30'::date`,
     * que rejeita, e o cliente receberia 500 no lugar de 400.
     *
     * A ida e volta pelo ISO e o teste honesto: se o dia transbordou, a string
     * de volta e diferente da que entrou.
     */
    if (new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) !== valor) {
      throw new HttpError(400, `O parâmetro '${campo}' não é uma data válida.`);
    }
    filters[campo] = valor;
  }

  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new HttpError(400, "'dateFrom' não pode ser posterior a 'dateTo'.");
  }

  const limit = texto(query.limit, "limit");
  if (limit) {
    const valor = Number(limit);
    if (!Number.isInteger(valor) || valor < 1 || valor > MEETINGS_LIMIT_MAX) {
      throw new HttpError(400, `O parâmetro 'limit' deve ser um inteiro entre 1 e ${MEETINGS_LIMIT_MAX}.`);
    }
    filters.limit = valor;
  }

  return filters;
}
