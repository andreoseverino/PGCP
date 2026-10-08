import { parseDurationMinutes } from "./agenda-time";
import type { AgendaValidation } from "./agenda-validation";
import { getInitials } from "./user";
import type { AgendaItem, Meeting, MeetingAgenda, Participant, PhysicalLocation } from "../types";
import type { ComiteVinculo } from "./committee-link";

/**
 * Tradução entre o contrato da API de reuniões e o modelo que as telas usam.
 *
 * Só transformação: nenhuma chamada de rede, nenhum estado. As chamadas ficam
 * em `meetings.ts`. A separação não é cerimônia — é o que torna a conversão de
 * fuso, a mais fácil de errar em silêncio, verificável sem subir servidor.
 *
 * Os dois vocabulários são diferentes de propósito. A API fala em instantes
 * (`startAt`/`endAt` + `timezone` IANA) e em órgão resolvido
 * (`governanceBody`); a UI legada fala em `date` + `startTime` + `endTime` e em
 * `category` textual. Obrigar o servidor a imitar o formato antigo levaria para
 * o banco decisões que já se provaram erradas.
 *
 * Toda a conversão vive AQUI. Nenhum componente monta data, fuso ou payload por
 * conta própria — repetir essa aritmética em três telas é como os formatos
 * divergem.
 */

// -----------------------------------------------------------------------------
// Contrato da API
// -----------------------------------------------------------------------------

export type ApiMeetingStatus =
  | "draft"
  | "scheduled"
  | "needs_approval"
  | "in_progress"
  | "done"
  | "approved"
  | "closed";

export interface ApiGovernanceBody {
  id: string;
  name: string;
  /** Presidente da Mesa cadastrado no órgão (fato do órgão, não da reunião). */
  chairEntraObjectId: string | null;
  chairName: string | null;
}

export interface ApiMeetingSummary {
  id: string;
  title: string;
  description: string | null;
  governanceBody: ApiGovernanceBody;
  organizer: { userId: string; name: string } | null;
  startAt: string;
  endAt: string;
  timezone: string;
  meetingLink: string | null;
  onlineMeetingProvider: "teamsForBusiness" | null;
  modality: "online" | "in_person";
  physicalLocation: PhysicalLocation | null;
  origin: "manual" | "annual_agenda";
  annualAgendaId: string | null;
  annualAgendaStatus?: "draft" | "pending_approval" | "approved" | null;
  /** Decidido no servidor (Agenda Anual aprovada ou reunião avulsa). */
  releasedToPipeline?: boolean;
  /** Na versão APROVADA da Agenda Anual (o Pipeline lista só estas). */
  approvedInAnnualAgenda?: boolean;
  calendarSyncStatus: "pending" | "synced" | "failed" | "stale" | null;
  /** `meeting_minutes.status`; `null` = Ata não iniciada. Ausente em APIs antigas. */
  minutesStatus?: "draft" | "under_review" | "approved" | "closed" | null;
  /** Tipo (030); `null` = título livre (legado). */
  sessionType?: "ordinary" | "extraordinary" | null;
  status: ApiMeetingStatus;
  /** Cancelada/excluída logicamente (036). `null`/ausente = ativa. */
  cancelledAt?: string | null;
  /** Evento do Outlook/Teams cancelado; `null` com reunião cancelada e evento = pendente. */
  calendarEventCancelledAt?: string | null;
  /** Ciclo da PAUTA. Eixo separado de `status` e do estado do convite. */
  agendaValidation: AgendaValidation;
  recurrence: string | null;
  pendingRequirements: string | null;
  participantsCount: number;
  agendaItemsCount: number;
  /** Temas sem duração definida (alerta do Pipeline). Ausente em APIs antigas. */
  agendaItemsWithoutDuration?: number;
  /** Anexos enviados à reunião/temas (migration 033). Ausente em APIs antigas. */
  documentsCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** Espelho de `CalendarIntegration` do backend. */
export interface ApiCalendarIntegration {
  meetingId: string;
  provider: string;
  providerEventId: string | null;
  webLink: string | null;
  joinUrl: string | null;
  syncStatus: "pending" | "synced" | "failed" | "stale";
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface ApiMeetingParticipant {
  id: string;
  userId: string | null;
  userName: string | null;
  displayName: string | null;
  email: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
  participantType: "internal" | "external";
  roleInMeeting: string | null;
  isConfirmed: boolean;
  attended: boolean | null;
  /** Pertence hoje ao grupo do órgão da reunião (informativo). */
  inGovernanceBodyGroup?: boolean;
}

export interface ApiMeetingAgendaItem {
  id: string;
  /** Pauta (agrupador) do tema. `null` = sem pauta. */
  agendaId: string | null;
  title: string;
  position: number;
  scheduledStartTime: string | null;
  durationMinutes: number | null;
  executionStatus: "pending" | "presenting" | "completed" | "postponed";
  agendaTopicId: string | null;
  postponedFromItemId: string | null;
  responsible: { label: string; entraTenantId: string | null; entraObjectId: string | null } | null;
  presenterLabel: string | null;
  /** Tema circular nesta reunião (`meeting_agenda_items.is_circular_theme`). */
  isCircularTheme: boolean;
  /** Ficha cadastral (snapshot 019). Tipo/Natureza vêm com `{id, name}`. */
  type: { id: string; name: string } | null;
  nature: { id: string; name: string } | null;
  description: string | null;
  generatesActionItem: boolean;
  participants: { participantId: string; name: string }[];
}

export interface ApiMeetingDetail extends ApiMeetingSummary {
  participants: ApiMeetingParticipant[];
  agendas: MeetingAgenda[];
  agendaItems: ApiMeetingAgendaItem[];
  calendar: ApiCalendarIntegration | null;
}

// -----------------------------------------------------------------------------
// Fuso horário
// -----------------------------------------------------------------------------

/** Fuso padrão da operação. Usado quando o formulário não oferece escolha. */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

const doisDigitos = (n: number) => String(n).padStart(2, "0");

/**
 * Deslocamento do fuso, em milissegundos, no instante dado.
 *
 * `Intl` sabe converter instante -> hora local; o caminho inverso não existe na
 * plataforma. Formatar o instante no fuso alvo e reinterpretar o resultado como
 * se fosse UTC devolve exatamente a diferença entre os dois.
 */
function deslocamentoEm(instante: number, timeZone: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(instante));

  const pegar = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? "0");

  // `hour12: false` produz 24 para a meia-noite em alguns ICU; 24 e 0 são o
  // mesmo instante, e normalizar aqui evita um dia de erro.
  const hora = pegar("hour") % 24;

  const comoUtc = Date.UTC(
    pegar("year"),
    pegar("month") - 1,
    pegar("day"),
    hora,
    pegar("minute"),
    pegar("second")
  );

  return comoUtc - instante;
}

/**
 * Converte data e hora LOCAIS de um fuso para o instante absoluto.
 *
 *   ("2026-06-15", "10:00", "America/Sao_Paulo") -> "2026-06-15T13:00:00.000Z"
 *
 * Duas passagens porque o deslocamento depende do próprio instante: a primeira
 * estimativa usa o offset do palpite inicial, e perto de uma virada de horário
 * de verão esse offset muda justamente no intervalo calculado. A segunda
 * passagem corrige.
 *
 * NÃO usa o fuso da máquina. O formulário já sabe em que fuso a reunião
 * acontece, e o navegador de quem agenda pode estar em outro país.
 */
export function localToInstant(date: string, time: string, timeZone: string): string {
  const combinado = Date.parse(`${date}T${normalizarHora(time)}:00Z`);
  if (Number.isNaN(combinado)) {
    throw new Error(`Data ou hora inválida: "${date} ${time}".`);
  }

  const primeiro = deslocamentoEm(combinado, timeZone);
  let instante = combinado - primeiro;

  const segundo = deslocamentoEm(instante, timeZone);
  if (segundo !== primeiro) instante = combinado - segundo;

  return new Date(instante).toISOString();
}

/** Caminho inverso: instante absoluto -> data e hora locais do fuso. */
export function instantToLocal(iso: string, timeZone: string): { date: string; time: string } {
  const instante = Date.parse(iso);
  if (Number.isNaN(instante)) {
    throw new Error(`Instante inválido: "${iso}".`);
  }

  const local = new Date(instante + deslocamentoEm(instante, timeZone));

  return {
    date: `${local.getUTCFullYear()}-${doisDigitos(local.getUTCMonth() + 1)}-${doisDigitos(local.getUTCDate())}`,
    time: `${doisDigitos(local.getUTCHours())}:${doisDigitos(local.getUTCMinutes())}`
  };
}

/** Aceita "9:00" e "09:00"; recusa o resto antes de virar data inválida. */
function normalizarHora(time: string): string {
  const casou = time.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!casou) throw new Error(`Hora inválida: "${time}".`);
  return `${doisDigitos(Number(casou[1]))}:${casou[2]}`;
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

/**
 * Os 7 status persistidos, nos dois sentidos.
 *
 * Nada aqui tem relação com o Stepper (Preparação, Em Reunião, Registro, Ata,
 * Finalizado), que continua DERIVADO em `meeting-progress.ts`, nem com
 * `presenting`, que é estado de pauta e não de reunião.
 */
const STATUS_API_PARA_UI: Record<ApiMeetingStatus, Meeting["status"]> = {
  draft: "Draft",
  scheduled: "Scheduled",
  needs_approval: "Needs Approval",
  in_progress: "In Progress",
  done: "Done",
  approved: "Approved",
  closed: "Closed"
};

export function statusFromApi(status: ApiMeetingStatus): Meeting["status"] {
  return STATUS_API_PARA_UI[status] ?? "Scheduled";
}

// -----------------------------------------------------------------------------
// API -> modelo de exibição
// -----------------------------------------------------------------------------

/** Minutos inteiros -> "HH:mm", o formato canônico de `agenda-time.ts`. */
function minutosParaDuracao(minutos: number | null): string {
  if (minutos === null || !Number.isFinite(minutos)) return "";
  return `${doisDigitos(Math.floor(minutos / 60))}:${doisDigitos(minutos % 60)}`;
}

export function participantFromApi(p: ApiMeetingParticipant): Participant {
  // O snapshot vem primeiro: é o nome escolhido no momento da inclusão. Só
  // quando ele não existe é que `users.name` responde. Os dois são campos
  // distintos na API e continuam distintos aqui — nada é convertido.
  const nome = p.displayName ?? p.userName ?? "";

  return {
    // PK da linha. Sem ela, remover um participante dependeria do nome — e o
    // nome não é chave.
    participantId: p.id,
    name: nome,
    role: p.roleInMeeting ?? "",
    initials: getInitials(nome),
    confirmed: p.isConfirmed,
    entraObjectId: p.entraObjectId ?? undefined,
    // Endereço para o convite. Não é identidade; a tela usa para dizer quem
    // ainda não pode ser convidado.
    email: p.email ?? undefined,
    inGovernanceBodyGroup: p.inGovernanceBodyGroup === true
  };
}

export function agendaItemFromApi(item: ApiMeetingAgendaItem): AgendaItem {
  return {
    id: item.id,
    // `scheduledStartTime` vem como "HH:mm:ss" do PostgreSQL.
    time: item.scheduledStartTime ? item.scheduledStartTime.slice(0, 5) : "",
    title: item.title,
    duration: minutosParaDuracao(item.durationMinutes),
    // RESPONSÁVEL, não apresentador. `presenterLabel` existe no contrato e é
    // deliberadamente ignorado: são papéis diferentes.
    author: item.responsible?.label ?? "",
    authorEntraObjectId: item.responsible?.entraObjectId ?? undefined,
    agendaTopicId: item.agendaTopicId ?? undefined,
    /*
     * O banco nunca devolve "presenting" como estado ativo de sessão: a API
     * recusa gravá-lo. Se aparecer, é resíduo de dado antigo — cai para
     * "pending", que é o estado base, em vez de ressuscitar um cronômetro que
     * não existe mais.
     */
    executionStatus:
      item.executionStatus === "completed" || item.executionStatus === "postponed"
        ? item.executionStatus
        : "pending",
    isCircularTheme: item.isCircularTheme,
    agendaTopicTypeId: item.type?.id,
    pautaType: item.type?.name,
    agendaTopicNatureId: item.nature?.id,
    pautaNature: item.nature?.name,
    description: item.description ?? undefined,
    generatesActionItem: item.generatesActionItem,
    participants: item.participants ?? [],
    agendaId: item.agendaId ?? undefined
  };
}

/**
 * Reunião da API no formato que as telas atuais consomem.
 *
 * Campos sem equivalente no banco NÃO são inventados: `organizer` fica vazio
 * quando não há pessoa (o organizador setor não tem coluna), e `agenda` e
 * `participants` só aparecem no detalhe, porque a lista não os carrega.
 */
export function meetingFromApi(api: ApiMeetingSummary | ApiMeetingDetail): Meeting {
  const inicio = instantToLocal(api.startAt, api.timezone);
  const fim = instantToLocal(api.endAt, api.timezone);
  const detalhe = "participants" in api ? (api as ApiMeetingDetail) : null;

  return {
    id: api.id,
    title: api.title,
    date: inicio.date,
    startTime: inicio.time,
    endTime: fim.time,
    timeZone: api.timezone,
    // Exibição do órgão. A identidade continua sendo `governanceBody.id`;
    // este campo textual não resolve nada no servidor.
    category: api.governanceBody.name,
    governanceBodyId: api.governanceBody.id,
    // Presidente da Mesa do ÓRGÃO — alimenta a seção MESA da Ata
    // (`buildMinutesTemplate`). `null` = nenhum presidente cadastrado ainda.
    governanceBodyChairName: api.governanceBody.chairName,
    governanceBodyChairEntraObjectId: api.governanceBody.chairEntraObjectId,
    status: statusFromApi(api.status),
    expectedParticipantsCount: api.participantsCount,
    agendaItemsCount: api.agendaItemsCount,
    agendaItemsWithoutDuration: api.agendaItemsWithoutDuration ?? 0,
    documentsCount: api.documentsCount ?? 0,
    description: api.description ?? "",
    organizer: api.organizer?.name ?? "",
    meetingLink: api.meetingLink ?? undefined,
    onlineMeetingProvider: api.onlineMeetingProvider ?? undefined,
    recurrence: api.recurrence ?? undefined,
    missingRequirementText: api.pendingRequirements ?? undefined,
    agenda: detalhe ? detalhe.agendaItems.map(agendaItemFromApi) : undefined,
    agendas: detalhe ? detalhe.agendas ?? [] : undefined,
    modality: api.modality ?? "online",
    physicalLocation: api.physicalLocation ?? null,
    origin: api.origin ?? "manual",
    annualAgendaId: api.annualAgendaId ?? null,
    annualAgendaStatus: api.annualAgendaStatus ?? null,
    // Ausente (API antiga) = liberada: nunca esconder reunião por falta de campo.
    releasedToPipeline: api.releasedToPipeline !== false,
    approvedInAnnualAgenda: api.approvedInAnnualAgenda === true,
    calendarSyncStatus: api.calendarSyncStatus ?? null,
    minutesStatus: api.minutesStatus ?? null,
    sessionType: api.sessionType ?? null,
    cancelledAt: api.cancelledAt ?? null,
    calendarEventCancelledAt: api.calendarEventCancelledAt ?? null,
    participants: detalhe ? detalhe.participants.map(participantFromApi) : undefined,
    // Passa adiante como veio: o estado da sincronização é do servidor, e
    // convertê-lo aqui abriria espaço para a tela "melhorar" um `failed`.
    calendar: detalhe?.calendar ?? undefined,
    // Passa adiante como veio: quem decide se o convite pode sair e o servidor.
    agendaValidation: api.agendaValidation
  };
}

// -----------------------------------------------------------------------------
// Modelo de exibição -> payload de criação
// -----------------------------------------------------------------------------

export interface CreateParticipantPayload {
  entraObjectId?: string;
  displayName: string;
  email?: string;
  /**
   * Omitido quando a pessoa veio do diretório e o Graph não informou
   * `userType`. Nesse caso vale a derivação do servidor, que está documentada —
   * melhor do que o navegador chutar "internal" e afirmar um fato que não tem.
   */
  participantType?: "internal" | "external";
  roleInMeeting?: string;
  isConfirmed: boolean;
}

export interface CreateAgendaItemPayload {
  title: string;
  /** Pauta (agrupador) da MESMA reunião. Ausente = tema sem pauta. */
  agendaId?: string;
  /** Vínculo com a Biblioteca. Identidade, nunca título. */
  agendaTopicId?: string;
  durationMinutes?: number;
  scheduledStartTime?: string;
  responsibleLabel?: string;
  responsibleEntraObjectId?: string;
  /**
   * Tema circular nesta reunião. Ausente = false no banco (default). Só afirma
   * um fato; a API recusa qualquer valor que não seja booleano estrito.
   */
  isCircularTheme?: boolean;
  /**
   * Ficha cadastral (019). Ausente + `agendaTopicId` => o backend herda do tema
   * (snapshot). Explícito manda. `null` limpa (no PATCH). Allowlist estrita.
   */
  agendaTopicTypeId?: string | null;
  agendaTopicNatureId?: string | null;
  description?: string | null;
  generatesActionItem?: boolean;
  /** Comitê (040): órgãos extras por onde este tema também deve passar. */
  comites?: ComiteVinculo[];
  /**
   * Tema novo (sem `agendaTopicId`) que deve nascer também na Biblioteca —
   * mesmo esquema do "+ Novo tema" da Agenda Anual.
   */
  registerInLibrary?: boolean;
}

/**
 * Organizador enviado à API.
 *
 * O `entraTenantId` NÃO vai: o servidor o resolve do token validado. Nome e
 * e-mail são snapshot — exibição e endereço de entrega, nunca identidade.
 */
export interface CreateOrganizerPayload {
  entraObjectId: string;
  displayName: string;
  email?: string;
}

export interface CreateMeetingPayload {
  governanceBodyId: string;
  /** Ausente = quem cadastra também organiza. */
  organizer?: CreateOrganizerPayload;
  /** Ausente quando há `sessionType`: o servidor monta o título padronizado. */
  title?: string;
  /** Tipo (030). Com ele, o título é do servidor. */
  sessionType?: "ordinary" | "extraordinary";
  description?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  meetingLink?: string;
  recurrence?: string;
  pendingRequirements?: string;
  /** Modalidade (025). Ausente = online. */
  modality?: "online" | "in_person";
  /** Id do local cadastrado (Administração → Locais). Só no presencial. */
  physicalLocationId?: string;
  /*
   * SEM `onlineMeetingProvider`. Toda reunião do PGCP é um evento do Outlook
   * com reunião do Teams, e quem afirma isso é o servidor — não o navegador.
   * Um cliente antigo que ainda mandasse o campo não mudaria nada.
   */
  participants: CreateParticipantPayload[];
  agendaItems: CreateAgendaItemPayload[];
  /** A lista já contém o grupo do órgão, ajustado na tela (Nova reunião). */
  participantsIncludeGroup?: boolean;
}

/** Texto vazio não vira campo: `undefined` diz "não informado", "" não diz nada. */
const opcional = (valor: string | undefined | null): string | undefined => {
  const limpo = valor?.trim();
  return limpo ? limpo : undefined;
};

export interface BuildPayloadInput {
  governanceBodyId: string;
  /** Pessoa escolhida no diretório. Ausente = o próprio usuário organiza. */
  organizer?: CreateOrganizerPayload;
  title: string;
  description?: string;
  /** Data local da reunião, YYYY-MM-DD. */
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  meetingLink?: string;
  recurrence?: string;
  participants: Array<
    Pick<Participant, "name" | "role" | "confirmed" | "entraObjectId"> & {
      email?: string;
      participantType?: "internal" | "external";
    }
  >;
  agendaItems: Array<
    Pick<
      AgendaItem,
      | "time"
      | "title"
      | "duration"
      | "author"
      | "authorEntraObjectId"
      | "isCircularTheme"
      | "agendaTopicId"
      | "agendaTopicTypeId"
      | "agendaTopicNatureId"
      | "description"
      | "generatesActionItem"
    >
  >;
}

/**
 * Monta o corpo do POST a partir do que o formulário tem.
 *
 * O que NÃO entra, e por quê:
 *
 *   entraTenantId          o tenant é do servidor; o navegador não o afirma
 *   status                 quem define o status inicial é a API
 *   id / createdAt         o banco gera
 *   executionStatus        pauta nasce pendente; "presenting" é sessão ao vivo
 *   presenterLabel         apresentador é outro conceito, sem tela que o produza
 *   notes / minutes        outras ondas
 *   members / authorId     campos legados já removidos do modelo
 */
/**
 * Participantes do formulário -> contrato da API. Compartilhado pelo
 * agendamento do Calendário e pela reserva da Agenda Anual.
 */
export function participantsPayload(
  lista: BuildPayloadInput["participants"]
): CreateParticipantPayload[] {
  return lista
    .filter((p) => p.name.trim().length > 0)
    .map((p) => {
      const email = opcional(p.email);
      return {
        entraObjectId: p.entraObjectId,
        displayName: p.name.trim(),
        email,
        // Sem identidade no diretório, a pessoa está fora da organização — é
        // o único caso em que o tipo é certo sem consultar ninguém. Com
        // identidade, vale o `userType` do Graph; se ele veio nulo, o campo sai
        // do payload e o servidor aplica a derivação dele.
        participantType: p.entraObjectId ? p.participantType : ("external" as const),
        roleInMeeting: opcional(p.role),
        isConfirmed: p.confirmed
      };
    });
}

export function buildCreatePayload(input: BuildPayloadInput): CreateMeetingPayload {
  const participants = participantsPayload(input.participants);

  const agendaItems = input.agendaItems
    .filter((item) => item.title.trim().length > 0)
    .map((item) => {
      const minutos = item.duration?.trim() ? parseDurationMinutes(item.duration) : undefined;
      const responsibleLabel = opcional(item.author);

      return {
        title: item.title.trim(),
        durationMinutes: minutos,
        scheduledStartTime: opcional(item.time),
        responsibleLabel,
        // Identidade só acompanha um rótulo. Sem nome, a API recusa — e com
        // razão: a tela precisaria do Graph só para escrever quem responde.
        responsibleEntraObjectId: responsibleLabel ? item.authorEntraObjectId : undefined,
        // Só envia quando true; ausência cai no default false do banco. Nunca
        // manda `false` para não travar em booleano por acaso.
        isCircularTheme: item.isCircularTheme ? true : undefined,
        // Vínculo com o tema mestre (procedência + snapshot). Sem ele, o item
        // nasce solto — era o bug do drawer "Criar Nova Pauta".
        agendaTopicId: item.agendaTopicId,
        // Ficha (019): explícito manda; ausente + `agendaTopicId` => o backend
        // herda do tema (COALESCE). FUP só envia `true` (mesma razão do circular).
        agendaTopicTypeId: item.agendaTopicTypeId,
        agendaTopicNatureId: item.agendaTopicNatureId,
        description: item.description?.trim() ? item.description.trim() : undefined,
        generatesActionItem: item.generatesActionItem ? true : undefined
      };
    });

  return {
    governanceBodyId: input.governanceBodyId,
    /*
     * QUEM ORGANIZA ≠ QUEM CADASTRA. A assessora envia o Presidente aqui; o
     * servidor grava `created_by` a partir do token e nunca do corpo.
     */
    organizer: input.organizer,
    title: input.title.trim(),
    description: opcional(input.description),
    startAt: localToInstant(input.date, input.startTime, input.timezone),
    endAt: localToInstant(input.date, input.endTime, input.timezone),
    timezone: input.timezone,
    meetingLink: opcional(input.meetingLink),
    recurrence: opcional(input.recurrence),
    participants,
    agendaItems
  };
}

