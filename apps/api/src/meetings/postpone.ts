import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { garantirResponsavelNaBiblioteca } from "../agenda-topics/write.js";
import type { MeetingActor } from "./create.js";
import { findMeeting, type MeetingDetail } from "./service.js";
import { travarReuniaoParaVersao, versionarReuniaoSeMudou } from "./versions.js";

/**
 * Postergar e Retomar — operacoes de DOMINIO, atomicas.
 *
 * Cada uma coordena duas escritas: o estado do item da reuniao e a copia na
 * Biblioteca. Deixar o navegador fazer duas chamadas nao seria atomico — daria
 * pauta postergada sem copia, ou copia orfa com a pauta ainda pendente.
 *
 * A ligacao entre a copia e a origem e ESTRUTURAL: o par
 * (source_meeting_id, source_agenda_item_id) em `agenda_topics`, com FK composta
 * MATCH FULL. Localizar a copia por titulo, responsavel, nome ou por um id
 * construido no cliente esta proibido — homonimos existem, e titulo nao e
 * identidade.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(valor: string, campo: string): string {
  if (!UUID_PATTERN.test(valor)) throw new HttpError(400, `${campo} inválido.`);
  return valor.toLowerCase();
}

interface ItemRow {
  id: string;
  title: string;
  duration_minutes: number | null;
  responsible_label: string | null;
  responsible_entra_tenant_id: string | null;
  responsible_entra_object_id: string | null;
  execution_status: string;
  meeting_title: string;
}

/** Carrega o item travando a linha, e confirma que ele e da reuniao informada. */
async function carregarItem(
  client: PoolClient,
  meetingId: string,
  agendaItemId: string,
): Promise<ItemRow> {
  const { rows } = await client.query<ItemRow>(
    `SELECT ai.id, ai.title, ai.duration_minutes,
            ai.responsible_label, ai.responsible_entra_tenant_id, ai.responsible_entra_object_id,
            ai.execution_status, m.title AS meeting_title
       FROM meeting_agenda_items ai
       JOIN meetings m ON m.id = ai.meeting_id
      WHERE ai.id = $1 AND ai.meeting_id = $2
        FOR UPDATE OF ai`,
    [agendaItemId, meetingId],
  );

  if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");
  return rows[0]!;
}

async function emTransacao<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** `emTransacao` + versão da reunião no fim da mesma transação (034). */
function emTransacaoVersionada<T>(
  meetingId: string,
  actor: MeetingActor,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return emTransacao(async (client) => {
    // Reunião travada PRIMEIRO: toda mutação versionada segue a mesma ordem
    // de locks (reunião -> filhos), e a versão final não disputa número.
    await travarReuniaoParaVersao(client, meetingId);
    const resultado = await fn(client);
    await versionarReuniaoSeMudou(client, meetingId, actor);
    return resultado;
  });
}

/**
 * POSTERGAR — retira a pauta do fluxo desta reuniao e devolve o assunto a
 * Biblioteca, para tratamento futuro.
 *
 * Idempotente: repetir nao cria segunda copia. A convergencia usa
 * `ON CONFLICT` sobre o indice parcial de procedencia, de modo que duas
 * chamadas simultaneas tambem terminam com uma copia so — checar antes e
 * inserir depois deixaria uma janela entre as duas.
 */
export async function postponeAgendaItem(
  meetingId: string,
  agendaItemId: string,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador da reunião");
  assertUuid(agendaItemId, "Identificador da pauta");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const item = await carregarItem(client, meetingId, agendaItemId);

    await client.query(
      "UPDATE meeting_agenda_items SET execution_status = 'postponed' WHERE id = $1 AND meeting_id = $2",
      [agendaItemId, meetingId],
    );

    /*
     * A copia e um SNAPSHOT do momento do Postergar: titulo, duracao e
     * responsavel como estao agora. Nao ha sincronizacao continua — editar a
     * pauta na reuniao depois nao altera a copia, e isso e deliberado.
     *
     * DO NOTHING e nao DO UPDATE: se ja existe copia desta origem, ela e de um
     * Postergar anterior e sobrescreve-la apagaria o snapshot original.
     */
    await client.query(
      `INSERT INTO agenda_topics
              (title, description, estimated_duration_minutes,
               responsible_label, responsible_entra_tenant_id, responsible_entra_object_id,
               source_meeting_id, source_agenda_item_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_meeting_id, source_agenda_item_id)
         WHERE source_meeting_id IS NOT NULL AND source_agenda_item_id IS NOT NULL
       DO NOTHING`,
      [
        item.title,
        `Pauta postergada na reunião "${item.meeting_title}" para possível tratamento futuro.`,
        item.duration_minutes,
        item.responsible_label,
        item.responsible_entra_tenant_id,
        item.responsible_entra_object_id,
        meetingId,
        agendaItemId,
      ],
    );

    const { rows: copia } = await client.query<{ id: string }>(
      `SELECT id
         FROM agenda_topics
        WHERE source_meeting_id = $1
          AND source_agenda_item_id = $2`,
      [meetingId, agendaItemId],
    );
    await garantirResponsavelNaBiblioteca(client, copia[0]!.id, {
      label: item.responsible_label,
      entraTenantId: item.responsible_entra_tenant_id,
      entraObjectId: item.responsible_entra_object_id,
    });

    // UMA entrada de dominio, nao uma por INSERT: quem le a trilha precisa ver
    // o ato ("postergou"), nao a mecanica interna.
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta postergada",
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: item.meeting_title,
      status: "success",
    });
  });

  return findMeeting(meetingId);
}

/**
 * RETOMAR — devolve a pauta ao fluxo desta reuniao e desfaz a copia automatica.
 *
 * A copia e localizada SOMENTE pela procedencia. Uma pauta criada a mao com o
 * mesmo titulo nao tem `source_*` e por isso nunca entra no `DELETE`.
 */
export async function resumeAgendaItem(
  meetingId: string,
  agendaItemId: string,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador da reunião");
  assertUuid(agendaItemId, "Identificador da pauta");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const item = await carregarItem(client, meetingId, agendaItemId);

    await client.query(
      "UPDATE meeting_agenda_items SET execution_status = 'pending' WHERE id = $1 AND meeting_id = $2",
      [agendaItemId, meetingId],
    );

    /*
     * As duas colunas no WHERE, não só `source_agenda_item_id`: o par é a
     * chave, e exigir os dois deixa explícito que uma procedência incompleta —
     * que o MATCH FULL já impede — nunca casaria aqui.
     *
     * Participantes da cópia saem por CASCADE.
     */
    await client.query(
      `DELETE FROM agenda_topics
        WHERE source_meeting_id = $1 AND source_agenda_item_id = $2`,
      [meetingId, agendaItemId],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta retomada",
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: item.meeting_title,
      status: "success",
    });
  });

  return findMeeting(meetingId);
}
