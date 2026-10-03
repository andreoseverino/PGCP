import type { PoolClient } from "pg";
import pool from "../database.js";
import { transacaoAmbiente } from "../transacao-ambiente.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import type { MeetingActor } from "./create.js";
import { findMeeting, type MeetingDetail } from "./service.js";
import { reabrirValidacaoSePreReuniao } from "./agenda-validation.js";

/**
 * PAUTAS da reuniao (025) — agrupadores de TEMAS.
 *
 *   REUNIAO -> PAUTA (`meeting_agendas`) -> TEMA (`meeting_agenda_items`)
 *
 * Nao existe nivel intermediario. Pautas e temas entram DEPOIS do agendamento,
 * pela preparacao (Pipeline) — nunca no cadastro inicial da reuniao.
 *
 * Isolamento entre reunioes em duas camadas: toda consulta filtra por
 * `meeting_id` (id de pauta de outra reuniao responde 404, nunca altera a
 * linha errada), e a FK composta da 025 impede no banco que um tema aponte para
 * pauta de outra reuniao.
 *
 * Mutacoes exigem `PGCP.Assessoria` (na rota). Criar, renomear e excluir pauta
 * e alteracao ESTRUTURAL: reabre a validacao se ainda for planejamento.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_PAUTAS_POR_REUNIAO = 50;

function assertUuid(valor: string, campo: string): string {
  if (!UUID_PATTERN.test(valor)) throw new HttpError(400, `${campo} inválido.`);
  return valor.toLowerCase();
}

export interface AgendaInput {
  title: string;
}

/** Corpo de criar/renomear pauta. Lista fechada: so `title`. */
export function parseAgendaInput(body: unknown): AgendaInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;
  for (const chave of Object.keys(dados)) {
    if (chave !== "title") {
      throw new HttpError(400, `O campo '${chave}' não pode ser informado para a pauta.`);
    }
  }
  if (typeof dados.title !== "string" || dados.title.trim().length === 0) {
    throw new HttpError(400, "Informe o título da pauta.");
  }
  const title = dados.title.trim();
  if (title.length > 200) throw new HttpError(400, "O título da pauta deve ter no máximo 200 caracteres.");
  return { title };
}

/**
 * A pauta existe NESTA reuniao? Usada por quem vincula tema a pauta, antes do
 * INSERT/UPDATE — 404 legivel em vez da violacao da FK composta.
 */
export async function exigirPautaDaReuniao(
  client: Pick<PoolClient, "query">,
  meetingId: string,
  agendaId: string,
): Promise<void> {
  const { rows } = await client.query(
    "SELECT 1 FROM meeting_agendas WHERE id = $1 AND meeting_id = $2",
    [agendaId, meetingId],
  );
  if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");
}

async function emTransacao(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  // Dentro da transação de quem chamou (ex.: Agenda Anual com a agenda travada).
  const ambienteAtual = transacaoAmbiente();
  if (ambienteAtual) return fn(ambienteAtual);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function tituloDaReuniaoTravada(client: PoolClient, meetingId: string): Promise<string> {
  const { rows } = await client.query<{ title: string }>(
    "SELECT title FROM meetings WHERE id = $1 FOR UPDATE",
    [meetingId],
  );
  if (rows.length === 0) throw new HttpError(404, "Reunião não encontrada.");
  return rows[0]!.title;
}

export async function addAgenda(
  meetingId: string,
  input: AgendaInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");

  await emTransacao(async (client) => {
    // Travada: posicao calculada sem corrida entre dois cliques.
    const titulo = await tituloDaReuniaoTravada(client, meetingId);

    const { rows: pos } = await client.query<{ proxima: number; total: number }>(
      `SELECT coalesce(max(position), 0) + 1 AS proxima, count(*)::int AS total
         FROM meeting_agendas WHERE meeting_id = $1`,
      [meetingId],
    );
    if (pos[0]!.total >= MAX_PAUTAS_POR_REUNIAO) {
      throw new HttpError(409, `A reunião já tem o máximo de ${MAX_PAUTAS_POR_REUNIAO} pautas.`);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO meeting_agendas (meeting_id, title, position)
            VALUES ($1, $2, $3) RETURNING id`,
      [meetingId, input.title, pos[0]!.proxima],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta criada",
      entityType: "meeting_agenda",
      entityId: rows[0]!.id,
      entityLabel: `${titulo} — ${input.title}`,
      status: "success",
    });

    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

export async function updateAgenda(
  meetingId: string,
  agendaId: string,
  input: AgendaInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(agendaId, "Identificador da pauta");

  await emTransacao(async (client) => {
    const titulo = await tituloDaReuniaoTravada(client, meetingId);

    // `meeting_id` no WHERE: id de pauta de outra reuniao nao altera nada.
    const { rowCount } = await client.query(
      "UPDATE meeting_agendas SET title = $3 WHERE id = $1 AND meeting_id = $2",
      [agendaId, meetingId, input.title],
    );
    if (rowCount === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta renomeada",
      entityType: "meeting_agenda",
      entityId: agendaId,
      entityLabel: `${titulo} — ${input.title}`,
      status: "success",
    });

    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

/**
 * Exclui a pauta VAZIA. Com temas, 409: apagar temas em cascata destruiria
 * FUP de origem e participantes por tema; soltar os temas em silencio mudaria
 * a estrutura que alguem montou. A pessoa move ou exclui os temas primeiro.
 */
export async function removeAgenda(
  meetingId: string,
  agendaId: string,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(agendaId, "Identificador da pauta");

  await emTransacao(async (client) => {
    const titulo = await tituloDaReuniaoTravada(client, meetingId);

    const { rows: temas } = await client.query(
      "SELECT 1 FROM meeting_agenda_items WHERE meeting_id = $1 AND meeting_agenda_id = $2 LIMIT 1",
      [meetingId, agendaId],
    );
    if (temas.length > 0) {
      throw new HttpError(409, "A pauta ainda tem temas. Mova ou exclua os temas antes de excluir a pauta.");
    }

    const { rows } = await client.query<{ title: string }>(
      "DELETE FROM meeting_agendas WHERE id = $1 AND meeting_id = $2 RETURNING title",
      [agendaId, meetingId],
    );
    if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta excluída",
      entityType: "meeting_agenda",
      entityId: agendaId,
      entityLabel: `${titulo} — ${rows[0]!.title}`,
      status: "success",
    });

    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}
