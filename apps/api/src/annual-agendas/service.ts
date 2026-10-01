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
import { gerarPdfDaAgendaAnual, nomeDoArquivoDaAgendaAnual, type ReuniaoDaAgendaNoPdf } from "./pdf.js";
import { PDF_CONTENT_TYPE } from "../agenda-pdf/document.js";

/**
 * AGENDA ANUAL — planejamento das reunioes de um orgao ao longo do ano.
 *
 *   Criar Agenda Anual -> definir datas -> RESERVAR agendas (reunioes +
 *   eventos Outlook/Teams) -> reunioes aparecem no Pipeline -> enviar para
 *   aprovacao -> registrar aprovacao
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

export interface AnnualAgendaDetail extends AnnualAgendaSummary {
  items: AnnualAgendaItem[];
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
  modality: Modalidade;
  physicalLocationKey: string | null;
  organizer?: OrganizerInput;
  participants: ParticipantInput[];
}

export function parseReserveInput(body: unknown): ReserveInput {
  const dados = objeto(body);
  somenteCampos(dados, ["modality", "physicalLocationKey", "organizer", "participants"]);

  const participantesBrutos = dados.participants ?? [];
  if (!Array.isArray(participantesBrutos)) {
    throw new HttpError(400, "O campo 'participants' deve ser uma lista.");
  }
  if (participantesBrutos.length > MAX_PARTICIPANTES) {
    throw new HttpError(400, `O campo 'participants' aceita no máximo ${MAX_PARTICIPANTES} itens.`);
  }

  const { modality, physicalLocationKey } = parseModalidade(dados);

  return {
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
 * Transicoes da APROVACAO do planejamento. Independentes da reserva.
 *
 *   draft            -> pending_approval  (enviar para aprovacao)
 *   pending_approval -> pending_approval  (reenviar: corrige destinatario)
 *   pending_approval -> approved          (registrar aprovacao)
 *   approved         -> approved          (idempotente)
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
  created_at: Date;
  updated_at: Date;
}

const SUMMARY_SELECT = `
  SELECT a.id, a.governance_body_id, gb.name AS governance_body_name, a.year, a.title,
         a.status, a.approval_sent_at, a.approval_sent_to, a.approved_at,
         (SELECT count(*) FROM annual_agenda_items i WHERE i.annual_agenda_id = a.id)::int AS items_count,
         (SELECT count(*) FROM annual_agenda_items i
           WHERE i.annual_agenda_id = a.id AND i.meeting_id IS NOT NULL)::int AS reserved_count,
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

export async function findAnnualAgenda(id: string): Promise<AnnualAgendaDetail> {
  assertId(id);
  const { rows } = await pool.query<SummaryRow>(`${SUMMARY_SELECT} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Agenda Anual não encontrada.");

  const { rows: itens } = await pool.query<{
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

  return {
    ...toSummary(rows[0]),
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
    throw traduzirErroDeBanco(error);
  } finally {
    client.release();
  }
}

interface AgendaTravada {
  title: string;
  year: number;
  status: AnnualAgendaStatus;
  governance_body_id: string;
}

/** Lock na agenda: serializa reserva, edicao de datas e aprovacao. */
async function travarAgenda(client: PoolClient, id: string): Promise<AgendaTravada> {
  const { rows } = await client.query<AgendaTravada>(
    "SELECT title, year, status, governance_body_id FROM annual_agendas WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Agenda Anual não encontrada.");
  return rows[0];
}

/**
 * Mudar as DATAS depois de pedir a aprovacao invalida o que o aprovador viu:
 * a aprovacao volta para `draft` (mesma regra da validacao de pautas, 016).
 * A reserva nao e tocada — sao eixos independentes.
 */
async function reabrirAprovacao(
  client: PoolClient,
  id: string,
  agenda: AgendaTravada,
  actor: MeetingActor,
): Promise<void> {
  if (agenda.status === "draft") return;
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
    action: "Aprovação da Agenda Anual reaberta por alteração nas datas",
    entityType: "annual_agenda",
    entityId: id,
    entityLabel: agenda.title,
    status: "success",
  });
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

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO annual_agendas (governance_body_id, year, title, created_by_user_id)
            VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.governanceBodyId, input.year, input.title, actor.userId],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Agenda Anual criada",
      entityType: "annual_agenda",
      entityId: rows[0]!.id,
      entityLabel: `${input.title} (${input.year})`,
      status: "success",
    });
    return rows[0]!.id;
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
    await travarAgenda(client, id);
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
 * Exclui a agenda SEM reunioes reservadas. Com reserva, 409: as reunioes ja
 * estao no calendario de terceiros e tem vida propria no Pipeline.
 */
export async function deleteAnnualAgenda(id: string, actor: MeetingActor): Promise<void> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    const { rows } = await client.query(
      "SELECT 1 FROM annual_agenda_items WHERE annual_agenda_id = $1 AND meeting_id IS NOT NULL LIMIT 1",
      [id],
    );
    if (rows.length > 0) {
      throw new HttpError(
        409,
        "Esta Agenda Anual já tem reuniões reservadas. Exclua ou mantenha as reuniões pelo Pipeline antes de excluir a agenda.",
      );
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

    await reabrirAprovacao(client, id, agenda, actor);
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

    await reabrirAprovacao(client, id, agenda, actor);
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

    await reabrirAprovacao(client, id, agenda, actor);
  });
  return findAnnualAgenda(id);
}

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
 * quando o evento existe). NAO olha `status` da aprovacao — de proposito.
 */
export async function reserveAnnualAgenda(
  id: string,
  input: ReserveInput,
  actor: MeetingActor,
): Promise<ResultadoDaReserva> {
  assertId(id);

  const criadas = await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);

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
// Aprovacao
// ---------------------------------------------------------------------------

/** Dados do PDF: data VIGENTE (a da reuniao, se reservada). */
async function dadosDoPdf(id: string) {
  const agenda = await findAnnualAgenda(id);
  const reunioes: ReuniaoDaAgendaNoPdf[] = agenda.items.map((item) => ({
    titulo: item.meeting?.title ?? item.title,
    inicioEm: item.meeting?.startAt ?? item.startAt,
    fimEm: item.meeting?.endAt ?? item.endAt,
    fuso: item.meeting?.timezone ?? item.timezone,
    reservada: Boolean(item.meeting),
  }));
  return { agenda, reunioes };
}

export async function gerarPdf(id: string): Promise<{ pdf: Buffer; nome: string }> {
  const { agenda, reunioes } = await dadosDoPdf(id);
  const pdf = await gerarPdfDaAgendaAnual({
    titulo: agenda.title,
    ano: agenda.year,
    orgao: agenda.governanceBody.name,
    status: agenda.status,
    emitidoEm: new Date().toISOString(),
    reunioes,
  });
  return { pdf, nome: nomeDoArquivoDaAgendaAnual(agenda.title, agenda.year) };
}

/**
 * Envia o PDF ao aprovador pela caixa de QUEM ESTA NA SESSAO (`Mail.Send`
 * delegado + OBO — o mesmo envio ja validado da validacao de pautas). O estado
 * so vira `pending_approval` DEPOIS de o Graph aceitar o e-mail.
 */
export async function solicitarAprovacao(
  id: string,
  emailBruto: unknown,
  actor: MeetingActor,
  userToken: string,
): Promise<AnnualAgendaDetail> {
  assertId(id);
  const email = parseEmailDoAprovador(emailBruto);

  const { agenda, reunioes } = await dadosDoPdf(id);
  if (!podeEnviarParaAprovacao(agenda.status)) {
    throw new HttpError(409, "Esta Agenda Anual já foi aprovada.");
  }
  if (reunioes.length === 0) {
    throw new HttpError(409, "Inclua ao menos uma reunião antes de enviar a Agenda Anual para aprovação.");
  }

  const pdf = await gerarPdfDaAgendaAnual({
    titulo: agenda.title,
    ano: agenda.year,
    orgao: agenda.governanceBody.name,
    status: "pending_approval",
    emitidoEm: new Date().toISOString(),
    reunioes,
  });

  try {
    await enviarEmail(userToken, {
      para: email,
      assunto: `Aprovação da Agenda Anual ${agenda.year} — ${agenda.title}`,
      // Texto puro, montado no servidor. Mesma decisao de `mail/send.ts`.
      corpo:
        `Olá,\n\n${actor.name} solicita a aprovação da Agenda Anual ${agenda.year} ` +
        `"${agenda.title}" (${agenda.governanceBody.name}), com ${reunioes.length} reunião(ões) prevista(s).\n\n` +
        "A programação completa segue no PDF em anexo. As datas já estão reservadas nos calendários " +
        "dos participantes para garantir a disponibilidade da agenda.\n\n" +
        "Por favor, responda a este e-mail com a sua aprovação.\n\n" +
        "--\nPGCP — Plataforma Corporativa de Gestão de Pautas",
      anexo: {
        nome: nomeDoArquivoDaAgendaAnual(agenda.title, agenda.year),
        tipo: PDF_CONTENT_TYPE,
        conteudo: pdf,
      },
    });
  } catch (error) {
    await recordAudit({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Falha ao enviar Agenda Anual para aprovação",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: agenda.title,
      status: "failure",
    });
    throw error;
  }

  try {
    await emTransacao(async (client) => {
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
        entityLabel: `${agenda.title} — aprovação solicitada a ${email}`,
        status: "success",
      });
    });
  } catch {
    // Mesma janela da validacao de pautas: o e-mail saiu, o estado nao gravou.
    await recordAudit({
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "E-mail da Agenda Anual enviado, mas o estado não foi gravado",
      entityType: "annual_agenda",
      entityId: id,
      entityLabel: `${agenda.title} — enviado a ${email}`,
      status: "failure",
    }).catch(() => {});
    throw new HttpError(
      500,
      "O e-mail com a Agenda Anual FOI ENVIADO, mas não foi possível registrar o envio no PGCP. Não reenvie.",
    );
  }

  return findAnnualAgenda(id);
}

/** Registra a aprovacao (ato humano; a resposta chega por e-mail). Idempotente. */
export async function registrarAprovacao(id: string, actor: MeetingActor): Promise<AnnualAgendaDetail> {
  assertId(id);
  await emTransacao(async (client) => {
    const agenda = await travarAgenda(client, id);
    if (agenda.status === "approved") return;
    if (!podeRegistrarAprovacao(agenda.status)) {
      throw new HttpError(409, "Envie a Agenda Anual para aprovação antes de registrar a aprovação.");
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
      entityLabel: agenda.title,
      status: "success",
    });
  });
  return findAnnualAgenda(id);
}
