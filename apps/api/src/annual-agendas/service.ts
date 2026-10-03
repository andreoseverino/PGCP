import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAudit, recordAuditIn } from "../audit/service.js";
import { syncMeetingCalendar, type CalendarSyncStatus } from "../calendar/service.js";
import {
  inserirReuniao,
  parseModalidade,
  parseOrganizerInput,
  parseParticipantInput,
  traduzirErroDeBanco,
  type MeetingActor,
  type Modalidade,
  type OrganizerInput,
  type ParticipantInput,
} from "../meetings/create.js";
import { parseEmailDoAprovador } from "../meetings/agenda-validation.js";
import { enviarEmail } from "../mail/send.js";
import { GraphError } from "../graph/client.js";
import { dentroDaTransacao, transacaoAmbiente } from "../transacao-ambiente.js";
import { horaLocal, parseTipoDeSessao, type TipoDeSessao } from "../meetings/title.js";
import { cronogramaDosTemas, tempoDaReuniao, type TempoDaReuniao } from "../meetings/schedule.js";
import {
  gerarPdfDaAgendaAnual,
  nomeDoArquivoDaAgendaAnual,
  type DocumentoDaAgendaNoPdf,
  type ReuniaoDaAgendaNoPdf,
  type TemaNoPdf,
} from "./pdf.js";
import {
  diferencasAposEnvio,
  lerSnapshot,
  montarSnapshot,
  totaisDoSnapshot,
  type SnapshotDaAgenda,
} from "./snapshot.js";
import { addAgenda, parseAgendaInput, removeAgenda, updateAgenda } from "../meetings/agendas.js";
import { inserirTemaNaBiblioteca } from "../agenda-topics/write.js";
import {
  addAgendaItem,
  addAgendaItemParticipant,
  addParticipant,
  removeParticipant,
  parseAgendaItemInput,
  parseAgendaItemParticipantInput,
  parseAgendaItemPatch,
  parseReorderInput,
  removeAgendaItem,
  removeAgendaItemParticipant,
  reorderAgendaItems,
  updateAgendaItem,
} from "../meetings/update.js";

type AgendaItemPatch = ReturnType<typeof parseAgendaItemPatch>;
import { PDF_CONTENT_TYPE } from "../agenda-pdf/document.js";

/**
 * AGENDA ANUAL — consolidação das reuniões de um órgão no ano (028).
 *
 *   CALENDÁRIO cria a reunião (Outlook/Teams) -> AGENDA ANUAL reúne as
 *   reuniões do órgão/ano (`meetings.annual_agenda_id`), prepara Pauta -> Tema
 *   nas MESMAS entidades da reunião, gera o compilado e envia para aprovação ->
 *   aprovada = versão (snapshot) bloqueada -> PIPELINE segue operando.
 *
 *   Em elaboração      conteúdo editável (associar reuniões, pautas, temas)
 *   Enviada            bloqueada; volta a editar só RETIRANDO da aprovação
 *   Aprovada           bloqueada de vez; o documento é o snapshot da versão
 *
 * Datas planejadas + RESERVA (025) continuam: reservar cria a reunião pelo
 * mesmo caminho do Calendário, já associada à agenda.
 *
 * REGRA DE PRODUTO: a reserva NAO espera a aprovacao. O objetivo e bloquear
 * cedo a agenda de executivos de baixa disponibilidade; uma Agenda Anual pode
 * estar `pending_approval` com todas as reunioes ja no calendario de todos.
 * Por isso sao dois eixos:
 *
 *   annual_agendas.status               aprovacao do PLANEJAMENTO
 *   annual_agenda_items.meeting_id      reserva de cada data (reuniao criada)
 *
 * Depois da reserva a reuniao e uma reuniao como outra qualquer: editada pelo
 * Pipeline (PATCH /meetings/:id), que atualiza o MESMO evento. A data prevista
 * do item fica como registro do planejamento; a data vigente e a da reuniao.
 *
 * Leitura: qualquer usuario PGCP ativo (mesma Politica A das reunioes).
 * Mutacao: `PGCP.Assessoria`, na rota.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ANNUAL_AGENDA_STATUSES = ["draft", "pending_approval", "approved"] as const;
export type AnnualAgendaStatus = (typeof ANNUAL_AGENDA_STATUSES)[number];

/** Uma agenda anual com mais de uma reuniao por semana ja nao e "anual". */
export const MAX_ITENS_POR_AGENDA = 60;
const MAX_PARTICIPANTES = 200;
export const FUSO_PADRAO = "America/Sao_Paulo";

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

export interface AnnualAgendaSummary {
  id: string;
  governanceBody: { id: string; name: string };
  year: number;
  title: string;
  status: AnnualAgendaStatus;
  approvalSentAt: string | null;
  approvalSentTo: string | null;
  approvedAt: string | null;
  itemsCount: number;
  reservedCount: number;
  /** Reuniões associadas (`meetings.annual_agenda_id`), de qualquer origem. */
  meetingsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnnualAgendaItem {
  id: string;
  title: string;
  /** Data/horario PLANEJADOS no item. */
  startAt: string;
  endAt: string;
  timezone: string;
  /** Reuniao criada pela reserva. `null` = data ainda nao reservada. */
  meeting: {
    id: string;
    title: string;
    /** Data VIGENTE — pode ter sido editada pelo Pipeline. */
    startAt: string;
    endAt: string;
    timezone: string;
    status: string;
    calendarSyncStatus: CalendarSyncStatus | null;
  } | null;
}

/** Reunião da agenda com o conteúdo VIGENTE (as mesmas linhas do Pipeline). */
export interface AnnualAgendaMeeting {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  status: string;
  origin: "manual" | "annual_agenda";
  calendarSyncStatus: CalendarSyncStatus | null;
  /** Data planejada que gerou a reunião pela reserva; `null` = associada do Calendário. */
  plannedItemId: string | null;
  agendas: Array<{ id: string; title: string; position: number }>;
  /** Temas na ordem GLOBAL da reunião, com o cronograma calculado. */
  items: Array<{
    id: string;
    title: string;
    position: number;
    agendaId: string | null;
    agendaTopicId: string | null;
    durationMinutes: number | null;
    /** Ficha do tema (a mesma do Pipeline), para o formulário de edição. */
    responsibleLabel: string | null;
    responsibleEntraObjectId: string | null;
    typeId: string | null;
    natureId: string | null;
    isCircularTheme: boolean;
    description: string | null;
    inicio: string;
    fim: string | null;
    /** Participantes vinculados AO TEMA (`meeting_agenda_item_participants`). */
    participants: Array<{ id: string; name: string }>;
  }>;
  /** Soma das durações x janela da reunião. */
  tempo: TempoDaReuniao;
  /** Participantes DA REUNIÃO (`meeting_participants`), uma vez cada. */
  participants: Array<{ id: string; name: string; email: string | null; external: boolean; inGovernanceBodyGroup: boolean }>;
  /** Como a reunião está na versão enviada/aprovada; `null` = não estava. */
  sent: { title: string; startAt: string; endAt: string; timezone: string } | null;
  changedAfterSending: { data: boolean; titulo: boolean } | null;
}

export interface AnnualAgendaDetail extends AnnualAgendaSummary {
  /** `true` só em elaboração; o servidor revalida em toda mutação. */
  editable: boolean;
  /** Datas planejadas (025). */
  items: AnnualAgendaItem[];
  meetings: AnnualAgendaMeeting[];
  /** Reuniões do mesmo órgão/ano ainda fora desta agenda. */
  candidates: Array<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    timezone: string;
    origin: "manual" | "annual_agenda";
    linkedToOtherAgenda: boolean;
  }>;
  /** Reuniões que estavam na versão enviada/aprovada e não estão mais. */
  removedAfterSending: Array<{ title: string; startAt: string; timezone: string }>;
  version: {
    id: string;
    number: number;
    state: "open" | "approved";
    sentAt: string;
    sentTo: string;
    approvedAt: string | null;
    approvedByName: string | null;
  } | null;
  totals: { reunioes: number; pautas: number; temas: number };
}

// ---------------------------------------------------------------------------
// Leitura do corpo
// ---------------------------------------------------------------------------

function objeto(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  return body as Record<string, unknown>;
}

/** Allowlist fechada: campo desconhecido e recusado, nunca ignorado. */
function somenteCampos(dados: Record<string, unknown>, permitidos: readonly string[]): void {
  for (const chave of Object.keys(dados)) {
    if (!permitidos.includes(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
    }
  }
}

function texto(valor: unknown, campo: string, max: number): string {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new HttpError(400, `O campo '${campo}' é obrigatório.`);
  }
  const limpo = valor.trim();
  if (limpo.length > max) throw new HttpError(400, `O campo '${campo}' deve ter no máximo ${max} caracteres.`);
  return limpo;
}

function uuid(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || !UUID_PATTERN.test(valor.trim())) {
    throw new HttpError(400, `O campo '${campo}' deve ser um UUID.`);
  }
  return valor.trim().toLowerCase();
}

export function assertId(valor: string, campo = "Identificador"): string {
  if (!UUID_PATTERN.test(valor)) throw new HttpError(400, `${campo} inválido.`);
  return valor.toLowerCase();
}

export interface AnnualAgendaInput {
  governanceBodyId: string;
  year: number;
  title: string;
}

export function parseAnnualAgendaInput(body: unknown): AnnualAgendaInput {
  const dados = objeto(body);
  somenteCampos(dados, ["governanceBodyId", "year", "title"]);

  const year = dados.year;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, "O campo 'year' deve ser um ano entre 2000 e 2100.");
  }

  return {
    governanceBodyId: uuid(dados.governanceBodyId, "governanceBodyId"),
    year,
    title: texto(dados.title, "title", 200),
  };
}

/** PATCH da agenda: so o titulo. Orgao e ano definem a agenda e nao mudam. */
export function parseAnnualAgendaPatch(body: unknown): { title: string } {
  const dados = objeto(body);
  somenteCampos(dados, ["title"]);
  return { title: texto(dados.title, "title", 200) };
}

export interface AnnualAgendaItemInput {
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

function instante(valor: unknown, campo: string): Date {
  const bruto = texto(valor, campo, 40);
  const data = new Date(bruto);
  if (Number.isNaN(data.getTime())) {
    throw new HttpError(400, `O campo '${campo}' deve ser uma data/hora ISO-8601 válida.`);
  }
  return data;
}

function fuso(valor: unknown): string {
  if (valor === undefined || valor === null) return FUSO_PADRAO;
  const bruto = texto(valor, "timezone", 64);
  if (bruto !== "UTC" && !bruto.includes("/")) {
    throw new HttpError(400, "O campo 'timezone' deve ser um identificador IANA, não uma abreviação.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: bruto });
  } catch {
    throw new HttpError(400, `Fuso horário desconhecido: '${bruto}'.`);
  }
  return bruto;
}

export function parseAnnualAgendaItemInput(body: unknown): AnnualAgendaItemInput {
  const dados = objeto(body);
  somenteCampos(dados, ["title", "startAt", "endAt", "timezone"]);

  const inicio = instante(dados.startAt, "startAt");
  const fim = instante(dados.endAt, "endAt");
  if (fim.getTime() <= inicio.getTime()) {
    throw new HttpError(400, "O horário de término deve ser depois do horário de início.");
  }

  return {
    title: texto(dados.title, "title", 300),
    startAt: inicio.toISOString(),
    endAt: fim.toISOString(),
    timezone: fuso(dados.timezone),
  };
}

/** Ano civil do instante NO FUSO da reuniao (22h de 31/12 em SP ja e outro ano em UTC). */
export function anoLocal(iso: string, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric" }).format(new Date(iso)));
}

export function assertDentroDoAno(item: AnnualAgendaItemInput, ano: number): void {
  if (anoLocal(item.startAt, item.timezone) !== ano) {
    throw new HttpError(400, `A data da reunião precisa estar dentro de ${ano}, o ano desta Agenda Anual.`);
  }
}

/**
 * O que a reserva aplica a TODAS as datas ainda nao reservadas. Mesmo
 * vocabulario e mesmas regras do agendamento pelo Calendario — importadas,
 * nao recopiadas.
 */
export interface ReserveInput {
  /** Tipo (030): as reuniões criadas recebem o TÍTULO PADRONIZADO. */
  sessionType?: TipoDeSessao;
  modality: Modalidade;
  physicalLocationKey: string | null;
  organizer?: OrganizerInput;
  participants: ParticipantInput[];
}

export function parseReserveInput(body: unknown): ReserveInput {
  const dados = objeto(body);
  somenteCampos(dados, ["sessionType", "modality", "physicalLocationKey", "organizer", "participants"]);

  const participantesBrutos = dados.participants ?? [];
  if (!Array.isArray(participantesBrutos)) {
    throw new HttpError(400, "O campo 'participants' deve ser uma lista.");
  }
  if (participantesBrutos.length > MAX_PARTICIPANTES) {
    throw new HttpError(400, `O campo 'participants' aceita no máximo ${MAX_PARTICIPANTES} itens.`);
  }

  const { modality, physicalLocationKey } = parseModalidade(dados);

  return {
    sessionType: dados.sessionType === undefined ? undefined : parseTipoDeSessao(dados.sessionType),
    modality,
    physicalLocationKey,
    organizer: parseOrganizerInput(dados.organizer),
    participants: participantesBrutos.map((p, i) => parseParticipantInput(p, `participants[${i}]`)),
  };
}

/**
 * Datas que a reserva vai transformar em reuniao: SO as que ainda nao tem
 * reuniao. E isto — mais o `UNIQUE (meeting_id)` e o lock da agenda — que torna
 * "reservar de novo" inofensivo: nenhuma data vira duas reunioes, nenhum evento
 * duplicado nasce.
 */
export function itensAReservar<T extends { meetingId: string | null }>(itens: readonly T[]): T[] {
  return itens.filter((item) => !item.meetingId);
}

/**
 * Transicoes da APROVACAO do planejamento.
 *
 *   draft            -> pending_approval  (enviar: grava a versao/snapshot)
 *   pending_approval -> pending_approval  (reenviar: nova versao, anterior retirada)
 *   pending_approval -> draft             (retirar da aprovacao, explicito)
 *   pending_approval -> approved          (registrar: a versao enviada vira a aprovada)
 *   approved         -> approved          (idempotente; nao volta)
 *
 * Pular de draft para approved nao existe: aprovacao sem pedido nao tem lastro.
 */
export function podeEnviarParaAprovacao(status: AnnualAgendaStatus): boolean {
  return status === "draft" || status === "pending_approval";
}

export function podeRegistrarAprovacao(status: AnnualAgendaStatus): boolean {
  return status === "pending_approval" || status === "approved";
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  governance_body_id: string;
  governance_body_name: string;
  year: number;
  title: string;
  status: AnnualAgendaStatus;
  approval_sent_at: Date | null;
  approval_sent_to: string | null;
  approved_at: Date | null;
  items_count: number;
  reserved_count: number;
  meetings_count: number;
  created_at: Date;
  updated_at: Date;
}

const SUMMARY_SELECT = `
  SELECT a.id, a.governance_body_id, gb.name AS governance_body_name, a.year, a.title,
         a.status, a.approval_sent_at, a.approval_sent_to, a.approved_at,
         (SELECT count(*) FROM annual_agenda_items i WHERE i.annual_agenda_id = a.id)::int AS items_count,
         (SELECT count(*) FROM annual_agenda_items i
           WHERE i.annual_agenda_id = a.id AND i.meeting_id IS NOT NULL)::int AS reserved_count,
         (SELECT count(*) FROM meetings m WHERE m.annual_agenda_id = a.id)::int AS meetings_count,
         a.created_at, a.updated_at
    FROM annual_agendas a
    JOIN governance_bodies gb ON gb.id = a.governance_body_id`;

function toSummary(row: SummaryRow): AnnualAgendaSummary {
  return {
    id: row.id,
    governanceBody: { id: row.governance_body_id, name: row.governance_body_name },
    year: row.year,
    title: row.title,
    status: row.status,
    approvalSentAt: row.approval_sent_at?.toISOString() ?? null,
    approvalSentTo: row.approval_sent_to,
    approvedAt: row.approved_at?.toISOString() ?? null,
    itemsCount: row.items_count,
    reservedCount: row.reserved_count,
    meetingsCount: row.meetings_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listAnnualAgendas(): Promise<AnnualAgendaSummary[]> {
  const { rows } = await pool.query<SummaryRow>(
    `${SUMMARY_SELECT} ORDER BY a.year DESC, gb.name, a.id LIMIT 200`,
  );
  return rows.map(toSummary);
}

/**
 * VISÃO ANUAL: ano -> órgão -> (agenda formal ou não) -> reuniões.
 *
 * As reuniões do Calendário aparecem mesmo sem Agenda Anual formalizada.
 * Nada é gravado aqui (abrir a tela não cria agenda). Duas consultas, sem
 * N+1, sem Graph. O filtro de órgão é do cliente (contexto global = filtro
 * visual, não autorização: a leitura é a mesma Política A de /meetings).
 */
export interface VisaoAnualGrupo {
  governanceBody: { id: string; name: string; isActive: boolean };
  agenda: { id: string; title: string; status: AnnualAgendaStatus; meetingsCount: number } | null;
  meetings: Array<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    timezone: string;
    status: string;
    origin: "manual" | "annual_agenda";
    /** Agenda a que pertence (`null` = ainda sem agenda). */
    annualAgendaId: string | null;
  }>;
}

export function parseAnoDaVisao(valor: unknown): number {
  const ano = typeof valor === "string" && /^\d{4}$/.test(valor) ? Number(valor) : NaN;
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) {
    throw new HttpError(400, "Informe 'year' entre 2000 e 2100.");
  }
  return ano;
}

/** Agrupa por órgão, em ordem de nome; reuniões em ordem de data. Puro. */
export function agruparVisaoAnual(
  reunioes: ReadonlyArray<VisaoAnualGrupo["meetings"][number] & { governanceBody: VisaoAnualGrupo["governanceBody"] }>,
  agendas: ReadonlyArray<NonNullable<VisaoAnualGrupo["agenda"]> & { governanceBody: VisaoAnualGrupo["governanceBody"] }>,
): VisaoAnualGrupo[] {
  const grupos = new Map<string, VisaoAnualGrupo>();
  const grupo = (gb: VisaoAnualGrupo["governanceBody"]) => {
    let g = grupos.get(gb.id);
    if (!g) {
      g = { governanceBody: gb, agenda: null, meetings: [] };
      grupos.set(gb.id, g);
    }
    return g;
  };
  for (const a of agendas) {
    const { governanceBody, ...agenda } = a;
    grupo(governanceBody).agenda = agenda;
  }
  for (const r of reunioes) {
    const { governanceBody, ...reuniao } = r;
    grupo(governanceBody).meetings.push(reuniao);
  }
  for (const g of grupos.values()) g.meetings.sort((x, y) => x.startAt.localeCompare(y.startAt) || x.id.localeCompare(y.id));
  return [...grupos.values()].sort((a, b) => a.governanceBody.name.localeCompare(b.governanceBody.name, "pt-BR"));
}

/**
 * Anos que EXISTEM nos dados: com reunião (ano no fuso da reunião) ou com
 * Agenda Anual. Somente leitura; nenhum ano artificial.
 */
export async function anosComDados(): Promise<number[]> {
  const { rows } = await pool.query<{ ano: number }>(
    `SELECT DISTINCT ano FROM (
        SELECT EXTRACT(YEAR FROM start_at AT TIME ZONE timezone)::int AS ano FROM meetings
        UNION
        SELECT year FROM annual_agendas
     ) a ORDER BY ano DESC`,
  );
  return rows.map((r) => r.ano);
}

/** Ano inicial: o atual se existir; senão o mais próximo; `null` sem dados. */
export function anoInicial(anos: readonly number[], atual: number): number | null {
  if (anos.length === 0) return null;
  if (anos.includes(atual)) return atual;
  return [...anos].sort((a, b) => Math.abs(a - atual) - Math.abs(b - atual) || b - a)[0]!;
}

export async function visaoAnual(ano: number): Promise<{ year: number; years: number[]; groups: VisaoAnualGrupo[] }> {
  const { rows: reunioes } = await pool.query<{
    id: string;
    title: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    status: string;
    origin: "manual" | "annual_agenda";
    annual_agenda_id: string | null;
    gb_id: string;
    gb_name: string;
    gb_active: boolean;
  }>(
    `SELECT m.id, m.title, m.start_at, m.end_at, m.timezone, m.status, m.origin, m.annual_agenda_id,
            gb.id AS gb_id, gb.name AS gb_name, gb.is_active AS gb_active
       FROM meetings m
       JOIN governance_bodies gb ON gb.id = m.governance_body_id
      WHERE EXTRACT(YEAR FROM m.start_at AT TIME ZONE m.timezone)::int = $1
      ORDER BY m.start_at, m.id
      LIMIT 2000`,
    [ano],
  );
  const { rows: agendas } = await pool.query<{
    id: string;
    title: string;
    status: AnnualAgendaStatus;
    meetings_count: number;
    gb_id: string;
    gb_name: string;
    gb_active: boolean;
  }>(
    `SELECT a.id, a.title, a.status,
            (SELECT count(*) FROM meetings m WHERE m.annual_agenda_id = a.id)::int AS meetings_count,
            gb.id AS gb_id, gb.name AS gb_name, gb.is_active AS gb_active
       FROM annual_agendas a
       JOIN governance_bodies gb ON gb.id = a.governance_body_id
      WHERE a.year = $1`,
    [ano],
  );
  const orgao = (r: { gb_id: string; gb_name: string; gb_active: boolean }) => ({
    id: r.gb_id,
    name: r.gb_name,
    isActive: r.gb_active,
  });
  return {
    year: ano,
    years: await anosComDados(),
    groups: agruparVisaoAnual(
      reunioes.map((r) => ({
        id: r.id,
        title: r.title,
        startAt: r.start_at.toISOString(),
        endAt: r.end_at.toISOString(),
        timezone: r.timezone,
        status: r.status,
        origin: r.origin,
        annualAgendaId: r.annual_agenda_id,
        governanceBody: orgao(r),
      })),
      agendas.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        meetingsCount: a.meetings_count,
        governanceBody: orgao(a),
      })),
    ),
  };
}

type Executor = Pick<PoolClient, "query">;

/** Janela da reunião em minutos (`fim - início`). */
export function minutosDaReuniao(inicio: Date, fim: Date): number {
  return Math.max(0, Math.round((fim.getTime() - inicio.getTime()) / 60000));
}

/**
 * Reuniões com programação incoerente para APROVAÇÃO: temas que somam mais
 * que a reunião, ou tema sem duração (sem duração não há cronograma).
 */
export function problemasDeTempo(
  reunioes: ReadonlyArray<{ id: string; title: string; start_at: Date; end_at: Date }>,
  temas: ReadonlyArray<{ meeting_id: string; id: string; duration_minutes: number | null }>,
): string[] {
  const problemas: string[] = [];
  for (const r of reunioes) {
    const t = tempoDaReuniao(
      minutosDaReuniao(r.start_at, r.end_at),
      temas.filter((x) => x.meeting_id === r.id).map((x) => ({ id: x.id, durationMinutes: x.duration_minutes })),
    );
    const detalhes: string[] = [];
    if (t.excessoMin > 0) detalhes.push(`excede em ${t.excessoMin} min (reunião ${t.reuniaoMin} min, temas ${t.temasMin} min)`);
    if (t.semDuracao > 0) detalhes.push(`${t.semDuracao} tema(s) sem duração`);
    if (detalhes.length > 0) problemas.push(`"${r.title}" — ${detalhes.join(", ")}`);
  }
  return problemas;
}

/**
 * Regrava `scheduled_start_time` dos temas da reunião pelo cronograma (mesma
 * função da tela e do snapshot). Chamado na transação das edições feitas pela
 * Agenda Anual: o Pipeline lê os mesmos horários.
 */
async function regravarHorariosDosTemas(client: PoolClient, meetingId: string): Promise<void> {
  const { rows: [reuniao] } = await client.query<{ start_at: Date; timezone: string }>(
    "SELECT start_at, timezone FROM meetings WHERE id = $1",
    [meetingId],
  );
  if (!reuniao) return;
  const { rows: temas } = await client.query<{ id: string; duration_minutes: number | null }>(
    "SELECT id, duration_minutes FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position, id",
    [meetingId],
  );
  const horarios = cronogramaDosTemas(
    horaLocal(reuniao.start_at.toISOString(), reuniao.timezone),
    temas.map((t) => ({ id: t.id, durationMinutes: t.duration_minutes })),
  );
  for (const h of horarios) {
    await client.query(
      "UPDATE meeting_agenda_items SET scheduled_start_time = $3 WHERE id = $1 AND meeting_id = $2",
      [h.id, meetingId, h.inicio],
    );
  }
}

/**
 * Conteúdo da agenda a partir das MESMAS entidades da reunião:
 * reuniões (`meetings.annual_agenda_id`), pautas (`meeting_agendas`) e temas
 * (`meeting_agenda_items`). Base da tela, da prévia e do snapshot.
 */
async function carregarConteudo(db: Executor, id: string) {
  const { rows: resumo } = await db.query<SummaryRow>(`${SUMMARY_SELECT} WHERE a.id = $1`, [id]);
  if (!resumo[0]) throw new HttpError(404, "Agenda Anual não encontrada.");

  const { rows: itens } = await db.query<{
    id: string;
    title: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    meeting_id: string | null;
    meeting_title: string | null;
    meeting_start_at: Date | null;
    meeting_end_at: Date | null;
    meeting_timezone: string | null;
    meeting_status: string | null;
    sync_status: CalendarSyncStatus | null;
  }>(
    `SELECT i.id, i.title, i.start_at, i.end_at, i.timezone, i.meeting_id,
            m.title AS meeting_title, m.start_at AS meeting_start_at, m.end_at AS meeting_end_at,
            m.timezone AS meeting_timezone, m.status AS meeting_status,
            ci.sync_status
       FROM annual_agenda_items i
       LEFT JOIN meetings m ON m.id = i.meeting_id
       LEFT JOIN meeting_calendar_integrations ci ON ci.meeting_id = m.id AND ci.provider = 'outlook'
      WHERE i.annual_agenda_id = $1
      ORDER BY coalesce(m.start_at, i.start_at), i.id`,
    [id],
  );

  const { rows: reunioes } = await db.query<{
    id: string;
    title: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    status: string;
    origin: "manual" | "annual_agenda";
    sync_status: CalendarSyncStatus | null;
    planned_item_id: string | null;
  }>(
    `SELECT m.id, m.title, m.start_at, m.end_at, m.timezone, m.status, m.origin,
            ci.sync_status, i.id AS planned_item_id
       FROM meetings m
       LEFT JOIN meeting_calendar_integrations ci ON ci.meeting_id = m.id AND ci.provider = 'outlook'
       LEFT JOIN annual_agenda_items i ON i.meeting_id = m.id
      WHERE m.annual_agenda_id = $1
      ORDER BY m.start_at, m.id`,
    [id],
  );
  const ids = reunioes.map((r) => r.id);

  const { rows: pautas } = await db.query<{ id: string; meeting_id: string; title: string; position: number }>(
    `SELECT id, meeting_id, title, position FROM meeting_agendas
      WHERE meeting_id = ANY($1::uuid[]) ORDER BY meeting_id, position, id`,
    [ids],
  );
  const { rows: temas } = await db.query<{
    id: string;
    meeting_id: string;
    meeting_agenda_id: string | null;
    title: string;
    position: number;
    agenda_topic_id: string | null;
    duration_minutes: number | null;
    responsible_label: string | null;
    responsible_entra_object_id: string | null;
    agenda_topic_type_id: string | null;
    agenda_topic_nature_id: string | null;
    type_name: string | null;
    nature_name: string | null;
    is_circular_theme: boolean;
    description: string | null;
  }>(
    `SELECT i.id, i.meeting_id, i.meeting_agenda_id, i.title, i.position, i.agenda_topic_id, i.duration_minutes,
            i.responsible_label, i.responsible_entra_object_id, i.agenda_topic_type_id, i.agenda_topic_nature_id,
            ty.name AS type_name, na.name AS nature_name, i.is_circular_theme, i.description
       FROM meeting_agenda_items i
       LEFT JOIN agenda_topic_types ty ON ty.id = i.agenda_topic_type_id
       LEFT JOIN agenda_topic_natures na ON na.id = i.agenda_topic_nature_id
      WHERE i.meeting_id = ANY($1::uuid[]) ORDER BY i.meeting_id, i.position, i.id`,
    [ids],
  );
  // Participantes de cada TEMA (não da reunião inteira).
  const { rows: pessoas } = await db.query<{
    item_id: string;
    id: string;
    name: string;
    email: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT ip.meeting_agenda_item_id AS item_id, mp.id, mp.display_name AS name, mp.email,
            coalesce(mp.entra_object_id, u.entra_object_id) AS entra_object_id
       FROM meeting_agenda_item_participants ip
       JOIN meeting_participants mp ON mp.id = ip.meeting_participant_id
       JOIN meeting_agenda_items i ON i.id = ip.meeting_agenda_item_id
       LEFT JOIN users u ON u.id = mp.user_id
      WHERE i.meeting_id = ANY($1::uuid[])
      ORDER BY mp.display_name, mp.id`,
    [ids],
  );
  // E-mail e oid ficam só no servidor (snapshot/PDF); a tela recebe id + nome.
  const participantesDoTema = new Map<
    string,
    Array<{ id: string; name: string; email: string | null; entraObjectId: string | null }>
  >();
  for (const p of pessoas) {
    participantesDoTema.set(p.item_id, [
      ...(participantesDoTema.get(p.item_id) ?? []),
      { id: p.id, name: p.name, email: p.email, entraObjectId: p.entra_object_id },
    ]);
  }

  // Participantes DA REUNIÃO (meeting_participants: uma linha por pessoa, sem
  // somar as listas dos temas) — uma consulta para todas as reuniões.
  const { rows: daReuniao } = await db.query<{
    meeting_id: string;
    id: string;
    name: string;
    email: string | null;
    externo: boolean;
    no_grupo: boolean;
  }>(
    `SELECT mp.meeting_id, mp.id, coalesce(mp.display_name, u.name, mp.email, '') AS name,
            nullif(btrim(coalesce(mp.email, u.email, '')), '') AS email,
            (mp.user_id IS NULL AND mp.entra_object_id IS NULL) AS externo,
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
            ) AS no_grupo
       FROM meeting_participants mp
       LEFT JOIN users u ON u.id = mp.user_id
      WHERE mp.meeting_id = ANY($1::uuid[])
      ORDER BY 3, mp.id`,
    [ids],
  );
  const participantesDaReuniao = new Map<
    string,
    Array<{ id: string; name: string; email: string | null; external: boolean; inGovernanceBodyGroup: boolean }>
  >();
  for (const p of daReuniao) {
    participantesDaReuniao.set(p.meeting_id, [
      ...(participantesDaReuniao.get(p.meeting_id) ?? []),
      { id: p.id, name: p.name, email: p.email, external: p.externo, inGovernanceBodyGroup: p.no_grupo },
    ]);
  }

  return { resumo: resumo[0], itens, reunioes, pautas, temas, participantesDoTema, participantesDaReuniao };
}

function snapshotDoConteudo(conteudo: Awaited<ReturnType<typeof carregarConteudo>>): SnapshotDaAgenda {
  const r = conteudo.resumo;
  return montarSnapshot({
    agenda: {
      id: r.id,
      title: r.title,
      year: r.year,
      governanceBody: { id: r.governance_body_id, name: r.governance_body_name },
    },
    reunioes: conteudo.reunioes.map((m) => ({
      id: m.id,
      title: m.title,
      startAt: m.start_at.toISOString(),
      endAt: m.end_at.toISOString(),
      timezone: m.timezone,
    })),
    pautas: conteudo.pautas.map((p) => ({ id: p.id, meetingId: p.meeting_id, title: p.title, position: p.position })),
    temas: conteudo.temas.map((t) => ({
      id: t.id,
      meetingId: t.meeting_id,
      agendaId: t.meeting_agenda_id,
      title: t.title,
      position: t.position,
      durationMinutes: t.duration_minutes,
      participantes: (conteudo.participantesDoTema.get(t.id) ?? []).map((p) => p.name),
      pessoas: (conteudo.participantesDoTema.get(t.id) ?? []).map((p) => ({ nome: p.name, email: p.email?.trim() || null })),
      responsavel: t.responsible_label,
      // E-mail do responsável-pessoa: o da linha de participante dele no tema
      // (invariante: responsável com identidade participa do tema). Sem Graph.
      responsavelEmail: t.responsible_entra_object_id
        ? (conteudo.participantesDoTema.get(t.id) ?? []).find((p) => p.entraObjectId === t.responsible_entra_object_id)?.email?.trim() || null
        : null,
      tipo: t.type_name,
      natureza: t.nature_name,
      circular: t.is_circular_theme,
      descricao: t.description,
    })),
    // Datas planejadas ainda sem reunião também fazem parte do plano enviado.
    datasSemReuniao: conteudo.itens
      .filter((i) => !i.meeting_id)
      .map((i) => ({ title: i.title, startAt: i.start_at.toISOString(), endAt: i.end_at.toISOString(), timezone: i.timezone })),
  });
}

interface VersaoRow {
  id: string;
  version: number;
  snapshot: unknown;
  sent_at: Date;
  sent_to: string;
  approved_at: Date | null;
  approved_by_name: string | null;
  withdrawn_at: Date | null;
}

/** Versão vigente: a aprovada, ou a enviada em aberto. Retiradas ficam só no histórico. */
async function versaoVigente(db: Executor, id: string): Promise<VersaoRow | null> {
  const { rows } = await db.query<VersaoRow>(
    `SELECT v.id, v.version, v.snapshot, v.sent_at, v.sent_to, v.approved_at, v.withdrawn_at,
            u.name AS approved_by_name
       FROM annual_agenda_versions v
       LEFT JOIN users u ON u.id = v.approved_by_user_id
      WHERE v.annual_agenda_id = $1 AND v.withdrawn_at IS NULL
      ORDER BY v.version DESC
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function findAnnualAgenda(id: string): Promise<AnnualAgendaDetail> {
  assertId(id);
  const conteudo = await carregarConteudo(pool, id);
  const { resumo, itens, reunioes, pautas, temas, participantesDoTema, participantesDaReuniao } = conteudo;

  const versao = await versaoVigente(pool, id);
  const enviado = versao ? lerSnapshot(versao.snapshot) : null;
  const enviadas = new Map((enviado?.reunioes ?? []).filter((r) => r.meetingId).map((r) => [r.meetingId!, r]));

  // Reuniões do MESMO órgão e ano que ainda não estão nesta agenda.
  const { rows: candidatas } = await pool.query<{
    id: string;
    title: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    origin: "manual" | "annual_agenda";
    annual_agenda_id: string | null;
  }>(
    `SELECT m.id, m.title, m.start_at, m.end_at, m.timezone, m.origin, m.annual_agenda_id
       FROM meetings m
      WHERE m.governance_body_id = $1
        AND m.annual_agenda_id IS DISTINCT FROM $2
        AND EXTRACT(YEAR FROM m.start_at AT TIME ZONE m.timezone) = $3
      ORDER BY m.start_at, m.id
      LIMIT 200`,
    [resumo.governance_body_id, id, resumo.year],
  );

  const idsAtuais = new Set(reunioes.map((r) => r.id));

  return {
    ...toSummary(resumo),
    editable: resumo.status === "draft",
    items: itens.map((i) => ({
      id: i.id,
      title: i.title,
      startAt: i.start_at.toISOString(),
      endAt: i.end_at.toISOString(),
      timezone: i.timezone,
      meeting: i.meeting_id
        ? {
            id: i.meeting_id,
            title: i.meeting_title!,
            startAt: i.meeting_start_at!.toISOString(),
            endAt: i.meeting_end_at!.toISOString(),
            timezone: i.meeting_timezone!,
            status: i.meeting_status!,
            calendarSyncStatus: i.sync_status,
          }
        : null,
    })),
    meetings: reunioes.map((m) => {
      const atual = {
        title: m.title,
        startAt: m.start_at.toISOString(),
        endAt: m.end_at.toISOString(),
      };
      const naVersao = enviadas.get(m.id) ?? null;
      const temasDaReuniao = temas.filter((t) => t.meeting_id === m.id);
      const noCronograma = temasDaReuniao.map((t) => ({ id: t.id, durationMinutes: t.duration_minutes }));
      const horarios = new Map(
        cronogramaDosTemas(horaLocal(atual.startAt, m.timezone), noCronograma).map((h) => [h.id, h]),
      );
      return {
        id: m.id,
        ...atual,
        timezone: m.timezone,
        status: m.status,
        origin: m.origin,
        calendarSyncStatus: m.sync_status,
        plannedItemId: m.planned_item_id,
        agendas: pautas
          .filter((p) => p.meeting_id === m.id)
          .map((p) => ({ id: p.id, title: p.title, position: p.position })),
        items: temasDaReuniao.map((t) => ({
          id: t.id,
          title: t.title,
          position: t.position,
          agendaId: t.meeting_agenda_id,
          agendaTopicId: t.agenda_topic_id,
          durationMinutes: t.duration_minutes,
          responsibleLabel: t.responsible_label,
          responsibleEntraObjectId: t.responsible_entra_object_id,
          typeId: t.agenda_topic_type_id,
          natureId: t.agenda_topic_nature_id,
          isCircularTheme: t.is_circular_theme,
          description: t.description,
          inicio: horarios.get(t.id)!.inicio,
          fim: horarios.get(t.id)!.fim,
          participants: (participantesDoTema.get(t.id) ?? []).map((p) => ({ id: p.id, name: p.name })),
        })),
        tempo: tempoDaReuniao(minutosDaReuniao(m.start_at, m.end_at), noCronograma),
        /** Quem está NA REUNIÃO (uma vez cada), para a visão consolidada da Agenda. */
        participants: participantesDaReuniao.get(m.id) ?? [],
        sent: naVersao
          ? { title: naVersao.title, startAt: naVersao.startAt, endAt: naVersao.endAt, timezone: naVersao.timezone }
          : null,
        changedAfterSending: naVersao ? diferencasAposEnvio(naVersao, atual) : null,
      };
    }),
    removedAfterSending: (enviado?.reunioes ?? [])
      .filter((r) => r.meetingId && !idsAtuais.has(r.meetingId))
      .map((r) => ({ title: r.title, startAt: r.startAt, timezone: r.timezone })),
    candidates: candidatas.map((c) => ({
      id: c.id,
      title: c.title,
      startAt: c.start_at.toISOString(),
      endAt: c.end_at.toISOString(),
      timezone: c.timezone,
      origin: c.origin,
      linkedToOtherAgenda: c.annual_agenda_id !== null,
    })),
    version: versao
      ? {
          id: versao.id,
          number: versao.version,
          state: versao.approved_at ? "approved" : "open",
          sentAt: versao.sent_at.toISOString(),
          sentTo: versao.sent_to,
          approvedAt: versao.approved_at?.toISOString() ?? null,
          approvedByName: versao.approved_by_name,
        }
      : null,
    totals: totaisDoSnapshot(snapshotDoConteudo(conteudo)),
  };
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

async function emTransacao<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw traduzirErroDaAgenda(error);
  } finally {
    client.release();
  }
}

/** Violação das regras estruturais da 028 (trigger/CHECK) vira 409 legível. */
export const MSG_AGENDA_DUPLICADA = "Já existe uma Agenda Anual para este órgão e ano.";

function traduzirErroDaAgenda(error: unknown): unknown {
  const codigo = (error as { code?: string } | null)?.code;
  if (codigo === "23505" && (error as { constraint?: string }).constraint === "annual_agendas_body_year_uk") {
    return new HttpError(409, MSG_AGENDA_DUPLICADA);
  }
  if (codigo === "23514") {
    const mensagem = (error as { message?: string }).message ?? "";
    return new HttpError(409, mensagem.startsWith("A reunião e a Agenda Anual")
      ? "A reunião e a Agenda Anual precisam ser do mesmo órgão colegiado."
      : "A versão enviada/aprovada da Agenda Anual não pode ser alterada.");
  }
  return traduzirErroDeBanco(error);
}

interface AgendaTravada {
  title: string;
  year: number;
  status: AnnualAgendaStatus;
  governance_body_id: string;
}

/** Lock na agenda: serializa conteúdo, reserva e aprovação. */
async function travarAgenda(client: PoolClient, id: string): Promise<AgendaTravada> {
  const { rows } = await client.query<AgendaTravada>(
    "SELECT title, year, status, governance_body_id FROM annual_agendas WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Agenda Anual não encontrada.");
  return rows[0];
}

/**
 * Conteúdo da Agenda Anual só muda EM ELABORAÇÃO.
 *
 *   pending_approval  o aprovador está analisando a versão enviada: nada muda
 *                     até RETIRAR da aprovação (volta explícita a draft);
 *   approved          versão aprovada: bloqueada de vez.
 *
 * Substitui a reabertura silenciosa de antes (alterar datas voltava a draft).
 */
export function exigirEmElaboracao(status: AnnualAgendaStatus): void {
  if (status === "approved") {
    throw new HttpError(
      409,
      "Agenda Anual aprovada. Esta versão não pode mais ser alterada. A gestão operacional das reuniões continua disponível no Pipeline.",
    );
  }
  if (status === "pending_approval") {
    throw new HttpError(
      409,
      "Agenda Anual enviada para aprovação: o conteúdo está bloqueado. Retire-a da aprovação para voltar a editar.",
    );
  }
}

export async function createAnnualAgenda(
  input: AnnualAgendaInput,
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  const id = await emTransacao(async (client) => {
    const { rows: orgao } = await client.query("SELECT 1 FROM governance_bodies WHERE id = $1", [
      input.governanceBodyId,
    ]);
    if (orgao.length === 0) throw new HttpError(404, "Órgão de governança não encontrado.");

    // Uma por órgão/ano (029). Conferir antes devolve 409 legível; o índice
    // único cobre a corrida entre dois cliques simultâneos.
    const { rows: existente } = await client.query(
      "SELECT 1 FROM annual_agendas WHERE governance_body_id = $1 AND year = $2",
      [input.governanceBodyId, input.year],
    );
    if (existente.length > 0) throw new HttpError(409, MSG_AGENDA_DUPLICADA);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO annual_agendas (governance_body_id, year, title, created_by_user_id)
            VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.governanceBodyId, input.year, input.title, actor.userId],
    );
    const agendaId = rows[0]!.id;

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Agenda Anual criada",
      entityType: "annual_agenda",
      entityId: agendaId,
      entityLabel: `${input.title} (${input.year})`,
      status: "success",
    });

    // FORMALIZAR = trazer as reuniões que já existem no Calendário para o
    // mesmo órgão e ano, ainda sem agenda. Só o vínculo: mesma reunião, mesmo
    // evento Graph/Teams, nenhum convite. Qualquer origem.
    const { rows: associadas } = await client.query<{ id: string }>(
      `UPDATE meetings m SET annual_agenda_id = $1
        WHERE m.governance_body_id = $2
          AND m.annual_agenda_id IS NULL
          AND EXTRACT(YEAR FROM m.start_at AT TIME ZONE m.timezone)::int = $3
        RETURNING m.id`,
      [agendaId, input.governanceBodyId, input.year],
    );
    if (associadas.length > 0) {
      await recordAuditIn(client, {
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "Reuniões do Calendário associadas à Agenda Anual",
        entityType: "annual_agenda",
        entityId: agendaId,
        entityLabel: `${input.title} (${input.year}) — ${associadas.length} reunião(ões)`,
        status: "success",
      });
    }
    return agendaId;
  });

  return findAnnualAgenda(id);
}

export async function updateAnnualAgenda(
  id: string,
  input: { title: string },
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);
    await client.query("UPDATE annual_agendas SET title = $2 WHERE id = $1", [id, input.title]);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Agenda Anual renomeada",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: input.title,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

/**
 * Exclui a agenda EM ELABORAÇÃO e SEM reuniões. Com reunião associada, 409: a
 * reunião tem vida própria (Calendário/Pipeline) e a FK SET NULL a deixaria
 * órfã em silêncio. Agenda que já teve versão enviada também não sai (028).
 */
export async function deleteAnnualAgenda(id: string, actor: MeetingActor): Promise<void> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);
    const { rows } = await client.query(
      `SELECT 1 FROM meetings WHERE annual_agenda_id = $1
        UNION ALL
       SELECT 1 FROM annual_agenda_items WHERE annual_agenda_id = $1 AND meeting_id IS NOT NULL
        LIMIT 1`,
      [id],
    );
    if (rows.length > 0) {
      throw new HttpError(
        409,
        "Esta Agenda Anual já tem reuniões. Desassocie as reuniões (ou exclua-as pelo Pipeline) antes de excluir a agenda.",
      );
    }
    const { rows: versoes } = await client.query(
      "SELECT 1 FROM annual_agenda_versions WHERE annual_agenda_id = $1 LIMIT 1",
      [id],
    );
    if (versoes.length > 0) {
      throw new HttpError(409, "Esta Agenda Anual já foi enviada para aprovação; o histórico de versões é preservado.");
    }
    await client.query("DELETE FROM annual_agendas WHERE id = $1", [id]);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Agenda Anual excluída",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: `${agenda.title} (${agenda.year})`,
      status: "success",
    });
  });
}

export async function addAnnualAgendaItem(
  id: string,
  input: AnnualAgendaItemInput,
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);
    assertDentroDoAno(input, agenda.year);

    const { rows: total } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM annual_agenda_items WHERE annual_agenda_id = $1",
      [id],
    );
    if (total[0]!.n >= MAX_ITENS_POR_AGENDA) {
      throw new HttpError(409, `A Agenda Anual já tem o máximo de ${MAX_ITENS_POR_AGENDA} reuniões.`);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO annual_agenda_items (annual_agenda_id, title, start_at, end_at, timezone)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, input.title, input.startAt, input.endAt, input.timezone],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Reunião planejada na Agenda Anual",
      entityType: "annual_agenda_item",
      entityId: rows[0]!.id,
      entityLabel: `${agenda.title} — ${input.title}`,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

/** Item ja reservado e editado pelo Pipeline — la o evento e atualizado. */
async function exigirItemNaoReservado(
  client: PoolClient,
  agendaId: string,
  itemId: string,
): Promise<{ title: string }> {
  const { rows } = await client.query<{ title: string; meeting_id: string | null }>(
    "SELECT title, meeting_id FROM annual_agenda_items WHERE id = $1 AND annual_agenda_id = $2",
    [itemId, agendaId],
  );
  if (!rows[0]) throw new HttpError(404, "Reunião planejada não encontrada nesta Agenda Anual.");
  if (rows[0].meeting_id) {
    throw new HttpError(
      409,
      "Esta data já foi reservada. Altere a reunião pelo Pipeline: o evento existente é atualizado, sem duplicar convite.",
    );
  }
  return { title: rows[0].title };
}

export async function updateAnnualAgendaItem(
  id: string,
  itemId: string,
  input: AnnualAgendaItemInput,
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  assertId(itemId, "Identificador da reunião planejada");
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);
    await exigirItemNaoReservado(client, id, itemId);
    assertDentroDoAno(input, agenda.year);

    await client.query(
      `UPDATE annual_agenda_items
          SET title = $3, start_at = $4, end_at = $5, timezone = $6
        WHERE id = $1 AND annual_agenda_id = $2`,
      [itemId, id, input.title, input.startAt, input.endAt, input.timezone],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Reunião planejada alterada na Agenda Anual",
      entityType: "annual_agenda_item",
      entityId: itemId,
      entityLabel: `${agenda.title} — ${input.title}`,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

export async function deleteAnnualAgendaItem(
  id: string,
  itemId: string,
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  assertId(itemId, "Identificador da reunião planejada");
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);
    const item = await exigirItemNaoReservado(client, id, itemId);

    await client.query("DELETE FROM annual_agenda_items WHERE id = $1 AND annual_agenda_id = $2", [itemId, id]);

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Reunião planejada removida da Agenda Anual",
      entityType: "annual_agenda_item",
      entityId: itemId,
      entityLabel: `${agenda.title} — ${item.title}`,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

// ---------------------------------------------------------------------------
// Reuniões do Calendário na Agenda Anual (sem cópia, sem Outlook)
// ---------------------------------------------------------------------------

/**
 * Regras de pertença, puras: mesma reunião só entra na agenda do MESMO órgão
 * e ano, e só se não estiver em outra agenda. `origin` NÃO importa — reunião
 * manual do Calendário faz parte do planejamento tanto quanto a reservada.
 */
export function motivoParaNaoAssociar(
  agenda: { id: string; governanceBodyId: string; year: number },
  reuniao: { governanceBodyId: string; anoLocal: number; annualAgendaId: string | null },
): string | null {
  if (reuniao.governanceBodyId !== agenda.governanceBodyId) {
    return "A reunião é de outro órgão colegiado.";
  }
  if (reuniao.anoLocal !== agenda.year) {
    return `A reunião não é de ${agenda.year}, o ano desta Agenda Anual.`;
  }
  if (reuniao.annualAgendaId && reuniao.annualAgendaId !== agenda.id) {
    return "A reunião já faz parte de outra Agenda Anual.";
  }
  return null;
}

/**
 * ASSOCIA uma reunião existente: só `meetings.annual_agenda_id`. Mesmo
 * `meeting.id`, mesmo evento Graph, mesmo link Teams, mesma origem — nenhuma
 * chamada ao Outlook, nenhum convite novo. Idempotente.
 */
export async function associarReuniao(
  id: string,
  meetingIdBruto: unknown,
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  const meetingId = uuid(meetingIdBruto, "meetingId");
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);

    const { rows } = await client.query<{
      title: string;
      governance_body_id: string;
      annual_agenda_id: string | null;
      ano_local: number;
    }>(
      `SELECT title, governance_body_id, annual_agenda_id,
              EXTRACT(YEAR FROM start_at AT TIME ZONE timezone)::int AS ano_local
         FROM meetings WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    const reuniao = rows[0];
    if (!reuniao) throw new HttpError(404, "Reunião não encontrada.");
    if (reuniao.annual_agenda_id === id) return;

    const motivo = motivoParaNaoAssociar(
      { id, governanceBodyId: agenda.governance_body_id, year: agenda.year },
      { governanceBodyId: reuniao.governance_body_id, anoLocal: reuniao.ano_local, annualAgendaId: reuniao.annual_agenda_id },
    );
    if (motivo) throw new HttpError(409, motivo);

    await client.query("UPDATE meetings SET annual_agenda_id = $2 WHERE id = $1 AND annual_agenda_id IS NULL", [
      meetingId,
      id,
    ]);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Reunião associada à Agenda Anual",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: `${agenda.title} — ${reuniao.title}`,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

/**
 * Desassocia (só em elaboração). Reunião que NASCEU da reserva desta agenda
 * (data planejada com `meeting_id`) não sai: a data voltaria a "não
 * reservada" e uma nova reserva criaria reunião duplicada.
 */
export async function desassociarReuniao(
  id: string,
  meetingId: string,
  actor: MeetingActor,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  assertId(meetingId, "Identificador da reunião");
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    exigirEmElaboracao(agenda.status);

    const { rows } = await client.query<{ title: string; planned: boolean }>(
      `SELECT m.title,
              EXISTS (SELECT 1 FROM annual_agenda_items i WHERE i.meeting_id = m.id) AS planned
         FROM meetings m WHERE m.id = $1 AND m.annual_agenda_id = $2 FOR UPDATE OF m`,
      [meetingId, id],
    );
    if (!rows[0]) throw new HttpError(404, "Reunião não encontrada nesta Agenda Anual.");
    if (rows[0].planned) {
      throw new HttpError(
        409,
        "Esta reunião foi criada pela reserva desta Agenda Anual e não pode ser desassociada. Para retirá-la, exclua a reunião pelo Pipeline.",
      );
    }

    await client.query("UPDATE meetings SET annual_agenda_id = NULL WHERE id = $1 AND annual_agenda_id = $2", [
      meetingId,
      id,
    ]);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Reunião desassociada da Agenda Anual",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: `${agenda.title} — ${rows[0].title}`,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

// ---------------------------------------------------------------------------
// Pautas e Temas pela Agenda Anual — as MESMAS operações da reunião
// ---------------------------------------------------------------------------

/**
 * Porta de entrada da Agenda Anual para o conteúdo das reuniões, ATÔMICA:
 *
 *   BEGIN
 *     trava a agenda (FOR UPDATE)            — serializa com o envio
 *     confere que a reunião é desta agenda   — IDOR: 404
 *     revalida "em elaboração"               — 409 enviada/aprovada
 *     executa a operação de `meetings/`      — MESMA transação (ambiente)
 *   COMMIT
 *
 * O envio para aprovação trava a mesma linha antes de tirar o snapshot: ou a
 * edição termina antes (e entra no snapshot), ou ela espera o envio e recebe
 * 409 sem aplicar nada. Nunca "snapshot enviado + edição aplicada depois".
 *
 * As funções delegadas são as do Pipeline (mesmas tabelas, regras e
 * auditoria). O Pipeline (`/meetings/...`) não passa por aqui e continua
 * operando a reunião depois da aprovação: a versão aprovada está no snapshot.
 *
 * Ordem de locks: agenda -> reunião (a operação trava a reunião). O Pipeline
 * só trava a reunião e nunca a agenda: sem ciclo, sem deadlock.
 */
async function exigirReuniaoDaAgenda(client: PoolClient, id: string, meetingId: string): Promise<void> {
  const { rows } = await client.query("SELECT 1 FROM meetings WHERE id = $1 AND annual_agenda_id = $2", [
    meetingId,
    id,
  ]);
  if (rows.length === 0) throw new HttpError(404, "Reunião não encontrada nesta Agenda Anual.");
}

/**
 * Edição pela Agenda Anual: os campos do cadastro do tema (os mesmos do
 * Pipeline, menos os operacionais como `executionStatus`). Altera SÓ a
 * instância da reunião — tema da Biblioteca não tem o mestre alterado.
 */
const CAMPOS_DO_TEMA_NA_AGENDA = [
  "title", "agendaId", "durationMinutes", "responsibleLabel", "responsibleEntraObjectId",
  "agendaTopicTypeId", "agendaTopicNatureId", "isCircularTheme", "description",
] as const;

/**
 * PAUTA PADRÃO (sem migration): a maioria das reuniões tem UMA pauta. Pela
 * Agenda Anual o usuário cria TEMAS; se a reunião ainda não tem pauta, o
 * servidor cria esta, na mesma transação. Nome neutro: a tela não a exibe
 * quando é a única; o Pipeline, o snapshot e o PDF a mostram normalmente.
 */
export const PAUTA_PADRAO = "Pauta da reunião";

/**
 * Dois fluxos, dois contratos FECHADOS:
 *
 *   NOVO TEMA          cadastro completo de um tema SÓ desta reunião (não vai
 *                      para a Biblioteca): os mesmos campos do Pipeline.
 *   DA BIBLIOTECA      só `agendaTopicId` (+ duração e pauta). O servidor
 *                      resolve o resto do tema-mestre (título, ficha,
 *                      participantes) pela regra já existente — o cliente não
 *                      consegue forjar responsável, tipo, natureza ou origem.
 */
export type NovoTemaDaAgenda =
  | {
      origem: "novo";
      /** Corpo já validado pelo `parseAgendaItemInput` do Pipeline. */
      tema: ReturnType<typeof parseAgendaItemInput>;
      participantes: ReturnType<typeof parseAgendaItemParticipantInput>[];
    }
  | { origem: "biblioteca"; agendaTopicId: string; durationMinutes?: number; agendaId?: string };

const MAX_PARTICIPANTES_DO_TEMA = 50;

function duracaoObrigatoria(valor: unknown): number {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 1 || valor > 1440) {
    throw new HttpError(400, "Informe a duração do tema em minutos (1 a 1440).");
  }
  return valor;
}

export function parseNovoTemaDaAgenda(body: unknown): NovoTemaDaAgenda {
  const dados = objeto(body);

  if (dados.agendaTopicId !== undefined) {
    somenteCampos(dados, ["agendaTopicId", "durationMinutes", "agendaId"]);
    return {
      origem: "biblioteca",
      agendaTopicId: uuid(dados.agendaTopicId, "agendaTopicId"),
      ...(dados.durationMinutes !== undefined ? { durationMinutes: duracaoObrigatoria(dados.durationMinutes) } : {}),
      ...(dados.agendaId !== undefined ? { agendaId: uuid(dados.agendaId, "agendaId") } : {}),
    };
  }

  somenteCampos(dados, [
    "title", "durationMinutes", "responsibleLabel", "responsibleEntraObjectId",
    "agendaTopicTypeId", "agendaTopicNatureId", "isCircularTheme", "description",
    "agendaId", "participants",
  ]);
  duracaoObrigatoria(dados.durationMinutes);
  const { participants, ...campos } = dados;
  if (participants !== undefined && !Array.isArray(participants)) {
    throw new HttpError(400, "'participants' deve ser uma lista.");
  }
  const lista = (participants as unknown[] | undefined) ?? [];
  if (lista.length > MAX_PARTICIPANTES_DO_TEMA) {
    throw new HttpError(400, `'participants' aceita no máximo ${MAX_PARTICIPANTES_DO_TEMA} itens.`);
  }
  return {
    origem: "novo",
    // Mesmas validações do Pipeline (limites, trim, responsável com identidade...).
    tema: parseAgendaItemInput(campos),
    participantes: lista.map((p) => parseAgendaItemParticipantInput(p)),
  };
}

/**
 * Cria o tema na reunião. Roda DENTRO de `editarConteudoPelaAgenda` (agenda
 * travada e em elaboração; horários recalculados ao final): sem pauta, cria a
 * PAUTA PADRÃO; com pauta, usa a informada ou a primeira. Tema NOVO é
 * cadastrado também na Biblioteca; tudo na MESMA transação — se algo falhar
 * (inclusive um participante), nada fica, nem o tema-mestre.
 */
export async function criarTemaNaReuniao(
  meetingId: string,
  input: NovoTemaDaAgenda,
  actor: MeetingActor,
): Promise<void> {
  const client = transacaoAmbiente();
  if (!client) throw new Error("criarTemaNaReuniao exige a transação da Agenda Anual.");

  const primeiraPauta = async () =>
    (
      await client.query<{ id: string }>(
        "SELECT id FROM meeting_agendas WHERE meeting_id = $1 ORDER BY position, id LIMIT 1",
        [meetingId],
      )
    ).rows[0]?.id;

  const pautaInformada = input.origem === "novo" ? input.tema.agendaId : input.agendaId;
  let pautaId = pautaInformada ?? (await primeiraPauta());
  if (!pautaId) {
    await addAgenda(meetingId, { title: PAUTA_PADRAO }, actor);
    pautaId = await primeiraPauta();
  }

  if (input.origem === "biblioteca") {
    const { rows } = await client.query<{ title: string; estimated_duration_minutes: number | null }>(
      "SELECT title, estimated_duration_minutes FROM agenda_topics WHERE id = $1",
      [input.agendaTopicId],
    );
    if (!rows[0]) throw new HttpError(404, "Tema não encontrado na Biblioteca.");
    const duracao = input.durationMinutes ?? rows[0].estimated_duration_minutes;
    if (!duracao) {
      throw new HttpError(400, "Este tema da Biblioteca não tem duração padrão: informe a duração em minutos.");
    }
    // Mesmo caminho do Pipeline: copia ficha e participantes do tema-mestre
    // para a reunião (snapshot); o tema-mestre não é alterado.
    await addAgendaItem(
      meetingId,
      parseAgendaItemInput({ title: rows[0].title, durationMinutes: duracao, agendaId: pautaId, agendaTopicId: input.agendaTopicId }),
      actor,
    );
    return;
  }

  // NOVO TEMA nasce também na BIBLIOTECA (catálogo único, `agenda_topics`): o
  // tema-mestre recebe a ficha e os participantes padrão (os do formulário + o
  // responsável-pessoa), pela MESMA função da Biblioteca. A instância na reunião
  // é vinculada a ele pelo MESMO caminho do "Adicionar da Biblioteca" (copia
  // ficha e participantes). Depois disso, editar a instância não toca no mestre.
  const t = input.tema;
  const agendaTopicId = await inserirTemaNaBiblioteca(
    client,
    {
      title: t.title,
      description: t.description ?? null,
      estimatedDurationMinutes: t.durationMinutes ?? null,
      generatesActionItem: t.generatesActionItem ?? false,
      responsibleLabel: t.responsibleLabel ?? null,
      responsibleEntraObjectId: t.responsibleEntraObjectId ?? null,
      agendaTopicTypeId: t.agendaTopicTypeId ?? null,
      agendaTopicNatureId: t.agendaTopicNatureId ?? null,
      isCircularTheme: t.isCircularTheme ?? false,
      participants: input.participantes.map((p) => ({
        userId: p.userId,
        entraObjectId: p.entraObjectId,
        displayName: p.displayName,
        email: p.email,
      })),
    },
    actor,
  );
  await addAgendaItem(meetingId, { ...t, agendaId: pautaId, agendaTopicId }, actor);

  if (input.participantes.length > 0) {
    // Escolha EXPLÍCITA neste formulário: quem foi removido antes desta reunião
    // (exceção 031) e por isso não veio na cópia entra agora — a exceção cai.
    // O tema acabou de entrar na última posição desta reunião.
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position DESC LIMIT 1",
      [meetingId],
    );
    for (const participante of input.participantes) {
      try {
        await addAgendaItemParticipant(meetingId, rows[0]!.id, participante, actor);
      } catch (error) {
        // Já veio vinculado pela cópia dos participantes padrão: nada a fazer.
        if (!(error instanceof HttpError && error.status === 409)) throw error;
      }
    }
  }
}

/** Reordenar pela Agenda: só a ordem (os horários o servidor recalcula). */
export function parseOrdemDaAgenda(body: unknown): { agendaItemIds: string[] } {
  const dados = objeto(body);
  somenteCampos(dados, ["agendaItemIds"]);
  return { agendaItemIds: parseReorderInput(dados).agendaItemIds };
}

export function parseTemaPatchDaAgenda(body: unknown): AgendaItemPatch {
  const dados = objeto(body);
  somenteCampos(dados, CAMPOS_DO_TEMA_NA_AGENDA);
  return parseAgendaItemPatch(dados);
}

export async function editarConteudoPelaAgenda(
  id: string,
  meetingId: string,
  operacao: (meetingId: string) => Promise<unknown>,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  assertId(meetingId, "Identificador da reunião");
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    await exigirReuniaoDaAgenda(client, id, meetingId);
    exigirEmElaboracao(agenda.status);
    await dentroDaTransacao(client, () => operacao(meetingId));
    // Ordem/duração podem ter mudado: horários recalculados na mesma transação.
    await regravarHorariosDosTemas(client, meetingId);
  });
  return findAnnualAgenda(id);
}

export {
  updateAgenda as renomearPauta,
  // Participantes DA REUNIÃO pela Agenda (antes da aprovação o Pipeline não
  // opera a reunião): mesmas funções da aba Participantes — deduplicação,
  // exceção 031 (incluir apaga, remover grava), convite marcado desatualizado.
  addParticipant as incluirParticipanteNaReuniao,
  removeParticipant as removerParticipanteDaReuniao,
  removeAgenda as excluirPauta,
  parseAgendaInput as parsePautaDaAgenda,
  addAgendaItemParticipant as vincularParticipanteAoTema,
  removeAgendaItemParticipant as desvincularParticipanteDoTema,
  parseAgendaItemParticipantInput as parseParticipanteDoTema,
  reorderAgendaItems as reordenarTemas,
  updateAgendaItem as alterarTema,
  removeAgendaItem as excluirTema,
};


// ---------------------------------------------------------------------------
// Reserva
// ---------------------------------------------------------------------------

export interface ResultadoDaReserva {
  /** Reunioes criadas nesta chamada. */
  created: number;
  /** Resultado do convite de cada reuniao que precisava de envio. */
  invitations: Array<{
    meetingId: string;
    title: string;
    syncStatus: CalendarSyncStatus;
    error?: string;
  }>;
  agenda: AnnualAgendaDetail;
}

/**
 * RESERVA as datas: cria as reunioes que faltam e envia os convites.
 *
 * Duas fases, pelo mesmo motivo de `POST /meetings` + `calendar-sync`:
 *
 *   1. UMA transacao, com a agenda travada: cada data sem reuniao vira reuniao
 *      (`inserirReuniao`, o mesmo caminho do Calendario, origem
 *      `annual_agenda`) e o item guarda `meeting_id`. Nenhuma chamada externa.
 *   2. Depois do COMMIT: convite de cada reuniao da agenda em `pending` ou
 *      `failed` — as recem-criadas e as que falharam antes. `synced`/`stale`
 *      nao sao reenviadas aqui (edicao e pelo Pipeline).
 *
 * IDEMPOTENTE: repetir nao cria reuniao nova (so datas sem `meeting_id`) e
 * nao cria evento novo (`syncMeetingCalendar` usa `transactionId` fixo e PATCH
 * quando o evento existe). So em elaboracao: reservar inclui reunioes na agenda.
 */
export async function reserveAnnualAgenda(
  id: string,
  input: ReserveInput,
  actor: MeetingActor,
): Promise<ResultadoDaReserva> {
  assertId(id);

  const criadas = await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    // Reservar inclui reuniões na agenda: conteúdo, só em elaboração.
    exigirEmElaboracao(agenda.status);

    const { rows } = await client.query<{
      id: string;
      title: string;
      start_at: Date;
      end_at: Date;
      timezone: string;
      meeting_id: string | null;
    }>(
      `SELECT id, title, start_at, end_at, timezone, meeting_id
         FROM annual_agenda_items
        WHERE annual_agenda_id = $1
        ORDER BY start_at, id
        FOR UPDATE`,
      [id],
    );

    const pendentes = itensAReservar(rows.map((r) => ({ ...r, meetingId: r.meeting_id })));
    for (const item of pendentes) {
      const meetingId = await inserirReuniao(
        client,
        {
          governanceBodyId: agenda.governance_body_id,
          modality: input.modality,
          physicalLocationKey: input.physicalLocationKey ?? undefined,
          organizer: input.organizer,
          // Com tipo, o servidor monta o título padronizado (030).
          sessionType: input.sessionType,
          title: item.title,
          startAt: item.start_at.toISOString(),
          endAt: item.end_at.toISOString(),
          timezone: item.timezone,
          participants: input.participants,
          // Reserva nao leva pauta nem tema: preparacao e no Pipeline.
          agendaItems: [],
        },
        actor,
        { origin: "annual_agenda", annualAgendaId: id },
      );

      // `meeting_id IS NULL` no WHERE: defesa extra contra dupla reserva.
      const { rowCount } = await client.query(
        "UPDATE annual_agenda_items SET meeting_id = $2 WHERE id = $1 AND meeting_id IS NULL",
        [item.id, meetingId],
      );
      if (rowCount !== 1) throw new HttpError(409, "Esta data já foi reservada por outra operação.");
    }

    if (pendentes.length > 0) {
      await recordAuditIn(client, {
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "Agendas reservadas pela Agenda Anual",
        entityType: "annual_agenda",
        entityId: id,
        entityLabel: `${agenda.title} — ${pendentes.length} reunião(ões) criada(s)`,
        status: "success",
      });
    }

    return pendentes.length;
  });

  const { rows: aConvidar } = await pool.query<{ meeting_id: string; title: string }>(
    `SELECT m.id AS meeting_id, m.title
       FROM annual_agenda_items i
       JOIN meetings m ON m.id = i.meeting_id
       JOIN meeting_calendar_integrations ci ON ci.meeting_id = m.id AND ci.provider = 'outlook'
      WHERE i.annual_agenda_id = $1
        AND ci.sync_status IN ('pending', 'failed')
      ORDER BY m.start_at, m.id`,
    [id],
  );

  const invitations: ResultadoDaReserva["invitations"] = [];
  for (const reuniao of aConvidar) {
    try {
      const integracao = await syncMeetingCalendar(reuniao.meeting_id, { id: actor.userId, name: actor.name });
      invitations.push({ meetingId: reuniao.meeting_id, title: reuniao.title, syncStatus: integracao.syncStatus });
    } catch (error) {
      // `syncMeetingCalendar` ja gravou `failed`, a mensagem sanitizada e a
      // trilha. Uma falha nao impede as demais datas.
      invitations.push({
        meetingId: reuniao.meeting_id,
        title: reuniao.title,
        syncStatus: "failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "Falha ao enviar o convite.",
      });
    }
  }

  return { created: criadas, invitations, agenda: await findAnnualAgenda(id) };
}

// ---------------------------------------------------------------------------
// Compilado (PDF), versões e aprovação
// ---------------------------------------------------------------------------

/** Tema do snapshot -> PDF, com o cronograma quando o snapshot o tem. */
/** Tema do snapshot -> PDF. Campo ausente (snapshot antigo) segue ausente: o PDF omite. */
function temaDoPdf(t: SnapshotDaAgenda["reunioes"][number]["temasSemPauta"][number]): TemaNoPdf {
  return {
    titulo: t.title,
    inicio: t.inicio,
    fim: t.fim,
    duracao: t.durationMinutes,
    participantes: t.participantes,
    pessoas: t.pessoas,
    responsavel: t.responsavel,
    responsavelEmail: t.responsavelEmail,
    tipo: t.tipo,
    natureza: t.natureza,
    circular: t.circular,
    descricao: t.descricao,
  };
}

/** Snapshot -> linhas do PDF. O PDF da versão sai SÓ do snapshot gravado. */
export function reunioesDoPdf(snapshot: SnapshotDaAgenda): ReuniaoDaAgendaNoPdf[] {
  return snapshot.reunioes.map((r) => ({
    titulo: r.title,
    inicioEm: r.startAt,
    fimEm: r.endAt,
    fuso: r.timezone,
    reservada: r.meetingId !== null,
    pautas: r.pautas.map((p) => ({ titulo: p.title, temas: p.temas.map(temaDoPdf) })),
    temasSemPauta: r.temasSemPauta.map(temaDoPdf),
  }));
}

function pdfDoSnapshot(
  snapshot: SnapshotDaAgenda,
  status: AnnualAgendaStatus,
  documento: DocumentoDaAgendaNoPdf,
): Promise<Buffer> {
  return gerarPdfDaAgendaAnual({
    titulo: snapshot.agenda.title,
    ano: snapshot.agenda.year,
    orgao: snapshot.agenda.governanceBody.name,
    status,
    emitidoEm: new Date().toISOString(),
    reunioes: reunioesDoPdf(snapshot),
    documento,
  });
}

/** PRÉVIA: estado atual, pode mudar. Nunca é o documento aprovado. */
export async function gerarPdf(id: string): Promise<{ pdf: Buffer; nome: string }> {
  assertId(id);
  const conteudo = await carregarConteudo(pool, id);
  const snapshot = snapshotDoConteudo(conteudo);
  const pdf = await pdfDoSnapshot(snapshot, conteudo.resumo.status, { tipo: "previa" });
  return { pdf, nome: nomeDoArquivoDaAgendaAnual(`${snapshot.agenda.title}-previa`, snapshot.agenda.year) };
}

/**
 * DOCUMENTO da versão vigente (enviada ou aprovada), a partir do snapshot
 * gravado — alterações posteriores no Pipeline não o afetam.
 */
export async function gerarDocumentoDaVersao(id: string): Promise<{ pdf: Buffer; nome: string }> {
  assertId(id);
  const versao = await versaoVigente(pool, id);
  if (!versao) throw new HttpError(404, "Esta Agenda Anual ainda não tem versão enviada para aprovação.");
  const snapshot = lerSnapshot(versao.snapshot);
  const pdf = await pdfDoSnapshot(snapshot, versao.approved_at ? "approved" : "pending_approval", {
    tipo: "versao",
    numero: versao.version,
    enviadaEm: versao.sent_at.toISOString(),
    enviadaA: versao.sent_to,
    aprovadaEm: versao.approved_at?.toISOString() ?? null,
    aprovadaPor: versao.approved_by_name ?? null,
  });
  const sufixo = versao.approved_at ? `aprovada-v${versao.version}` : `v${versao.version}`;
  return { pdf, nome: nomeDoArquivoDaAgendaAnual(`${snapshot.agenda.title}-${sufixo}`, snapshot.agenda.year) };
}

/**
 * Envia o compilado ao aprovador pela caixa de QUEM ESTÁ NA SESSÃO
 * (`Mail.Send` delegado + OBO — o mesmo envio já validado; nenhuma permissão
 * nova). UMA transação, com a agenda travada:
 *
 *   BEGIN
 *     trava a agenda e revalida o status
 *     captura o conteúdo (snapshot) e numera a versão
 *     envia o e-mail com o PDF DESSE snapshot
 *     grava a versão e marca "enviada"
 *   COMMIT
 *
 * Edições pela Agenda Anual travam a mesma linha: nenhuma entra entre a
 * captura e a gravação. Falha no e-mail -> ROLLBACK, nada muda. E-mail aceito
 * e COMMIT falhou -> trilha de falha e aviso para NÃO reenviar (mesma janela
 * já tratada na validação de pautas).
 *
 * Reenviar enquanto aguarda (corrigir destinatário) cria a versão seguinte e
 * retira a anterior — no máximo uma versão em aberto (índice da 028).
 */
/** Falha no envio do e-mail: a mesma causa, dizendo que a Agenda NÃO ficou como enviada. */
function comAvisoDeNaoEnviada(error: unknown): unknown {
  const aviso = " A Agenda não foi marcada como enviada.";
  if (error instanceof GraphError) {
    return new GraphError(`${error.message}${aviso}`, error.code, error.status, error.retryAfterSeconds);
  }
  if (error instanceof HttpError) return new HttpError(error.status, `${error.message}${aviso}`);
  return error;
}

export async function solicitarAprovacao(
  id: string,
  emailBruto: unknown,
  actor: MeetingActor,
  userToken: string,
  /** Injetável para teste; em produção, `Mail.Send` delegado (OBO). */
  enviar: (
    ...args: Parameters<typeof enviarEmail>
  ) => Promise<Awaited<ReturnType<typeof enviarEmail>> | void> = enviarEmail,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  const email = parseEmailDoAprovador(emailBruto);
  let enviado = false;
  let rotulo = "";

  try {
    await emTransacao(async (client) => {
      const atual = await travarAgenda(client, id);
      rotulo = atual.title;
      if (!podeEnviarParaAprovacao(atual.status)) {
        throw new HttpError(409, "Esta Agenda Anual já foi aprovada.");
      }

      const conteudo = await carregarConteudo(client, id);
      const snapshot = snapshotDoConteudo(conteudo);
      if (snapshot.reunioes.length === 0) {
        throw new HttpError(409, "Inclua ao menos uma reunião antes de enviar a Agenda Anual para aprovação.");
      }
      // Programação temporal coerente: sem excesso e sem tema sem duração.
      const problemas = problemasDeTempo(conteudo.reunioes, conteudo.temas);
      if (problemas.length > 0) {
        throw new HttpError(
          409,
          `Existem reuniões cuja duração dos temas ultrapassa o horário disponível ou tem tema sem duração: ${problemas.join("; ")}.`,
        );
      }
      const { rows: ultima } = await client.query<{ n: number }>(
        "SELECT coalesce(max(version), 0)::int AS n FROM annual_agenda_versions WHERE annual_agenda_id = $1",
        [id],
      );
      const numero = ultima[0]!.n + 1;
      const agenda = snapshot.agenda;
      const totais = totaisDoSnapshot(snapshot);

      const pdf = await pdfDoSnapshot(snapshot, "pending_approval", {
        tipo: "versao",
        numero,
        enviadaEm: new Date().toISOString(),
        enviadaA: email,
        aprovadaEm: null,
      });

      let aceito: { status: number; requestId: string | null } | null = null;
      try {
        aceito = (await enviar(userToken, {
          para: email,
          assunto: `Aprovação da Agenda Anual ${agenda.year} — ${agenda.title}`,
          // Texto puro, montado no servidor. Mesma decisao de `mail/send.ts`.
          corpo:
            `Olá,\n\n${actor.name} solicita a aprovação da Agenda Anual ${agenda.year} ` +
            `"${agenda.title}" (${agenda.governanceBody.name}): ${totais.reunioes} reunião(ões), ` +
            `${totais.pautas} pauta(s) e ${totais.temas} tema(s).\n\n` +
            `O compilado completo (versão ${numero}) segue no PDF em anexo.\n\n` +
            "Por favor, responda a este e-mail com a sua aprovação.\n\n" +
            "--\nPGCP — Plataforma Corporativa de Gestão de Pautas",
          anexo: {
            nome: nomeDoArquivoDaAgendaAnual(`${agenda.title}-v${numero}`, agenda.year),
            tipo: PDF_CONTENT_TYPE,
            conteudo: pdf,
          },
        }, "annual_agenda_send_mail")) || null;
      } catch (error) {
        // Nada foi gravado: sem versão, status inalterado (a transação desfaz).
        const status = (error as { status?: number } | null)?.status;
        const codigo = (error as { code?: string } | null)?.code;
        await recordAudit({
          actorUserId: actor.userId,
          actorName: actor.name,
          action: "Falha ao enviar Agenda Anual para aprovação",
          entityType: "annual_agenda",
          entityId: id,
          entityLabel: `${agenda.title}${status ? ` — Microsoft 365 respondeu ${status}` : ""}${codigo ? ` (${codigo})` : ""}`,
          status: "failure",
        });
        throw comAvisoDeNaoEnviada(error);
      }
      enviado = true;

      await client.query(
        `UPDATE annual_agenda_versions SET withdrawn_at = now()
          WHERE annual_agenda_id = $1 AND approved_at IS NULL AND withdrawn_at IS NULL`,
        [id],
      );
      await client.query(
        `INSERT INTO annual_agenda_versions (annual_agenda_id, version, snapshot, sent_to, sent_by_user_id)
              VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [id, numero, JSON.stringify(snapshot), email, actor.userId],
      );
      await client.query(
        `UPDATE annual_agendas
            SET status = 'pending_approval', approval_sent_at = now(), approval_sent_to = $2,
                approved_at = NULL, approved_by_user_id = NULL
          WHERE id = $1`,
        [id, email],
      );
      await recordAuditIn(client, {
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "Agenda Anual enviada para aprovação",
        entityType: "annual_agenda",
        entityId: id,
        // "Enviada" = ACEITA pelo Microsoft 365 (202); a entrega é do Exchange.
        entityLabel:
          `${agenda.title} — versão ${numero} enviada a ${email} (aceita pelo Microsoft 365` +
          `${aceito?.requestId ? `; request-id ${aceito.requestId}` : ""})`,
        status: "success",
      });
    });
  } catch (error) {
    if (!enviado) throw error;
    // O e-mail saiu, o estado nao gravou.
    await recordAudit({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "E-mail da Agenda Anual enviado, mas o estado não foi gravado",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: `${rotulo} — enviado a ${email}`,
      status: "failure",
    }).catch(() => {});
    throw new HttpError(
      500,
      "O e-mail com a Agenda Anual FOI ENVIADO, mas não foi possível registrar o envio no PGCP. Não reenvie.",
    );
  }

  return findAnnualAgenda(id);
}

/**
 * Registra a aprovação (ato humano; a resposta chega por e-mail): a VERSÃO
 * ENVIADA vira a aprovada e a agenda fica bloqueada. Idempotente.
 *
 * Sem versão em aberto (pedido feito antes da 028) não há como saber o que foi
 * aprovado: 409, reenvie para gerar a versão.
 */
export async function registrarAprovacao(id: string, actor: MeetingActor): Promise<AnnualAgendaDetail> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    if (agenda.status === "approved") return;
    if (!podeRegistrarAprovacao(agenda.status)) {
      throw new HttpError(409, "Envie a Agenda Anual para aprovação antes de registrar a aprovação.");
    }
    const { rows } = await client.query<{ id: string; version: number }>(
      `UPDATE annual_agenda_versions SET approved_at = now(), approved_by_user_id = $2
        WHERE annual_agenda_id = $1 AND approved_at IS NULL AND withdrawn_at IS NULL
        RETURNING id, version`,
      [id, actor.userId],
    );
    if (!rows[0]) {
      throw new HttpError(
        409,
        "Não há versão enviada registrada para esta Agenda Anual. Reenvie para aprovação para gerar a versão a ser aprovada.",
      );
    }
    await client.query(
      `UPDATE annual_agendas SET status = 'approved', approved_at = now(), approved_by_user_id = $2
        WHERE id = $1`,
      [id, actor.userId],
    );
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Agenda Anual marcada como aprovada",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: `${agenda.title} — versão ${rows[0].version}`,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}

/**
 * RETIRA da aprovação (só `pending_approval`): volta a "Em elaboração" de
 * forma explícita e auditada; a versão enviada fica no histórico como
 * retirada. Aprovada não volta.
 */
export async function retirarDaAprovacao(id: string, actor: MeetingActor): Promise<AnnualAgendaDetail> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    if (agenda.status !== "pending_approval") {
      throw new HttpError(
        409,
        agenda.status === "approved"
          ? "Agenda Anual aprovada não pode ser retirada da aprovação."
          : "Esta Agenda Anual não está aguardando aprovação.",
      );
    }
    await client.query(
      `UPDATE annual_agenda_versions SET withdrawn_at = now()
        WHERE annual_agenda_id = $1 AND approved_at IS NULL AND withdrawn_at IS NULL`,
      [id],
    );
    await client.query(
      `UPDATE annual_agendas
          SET status = 'draft', approval_sent_at = NULL, approval_sent_to = NULL,
              approved_at = NULL, approved_by_user_id = NULL
        WHERE id = $1`,
      [id],
    );
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Agenda Anual retirada da aprovação",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: agenda.title,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}
