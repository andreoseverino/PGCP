import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { syncMeetingCalendar } from "../calendar/service.js";
import { parseOrganizerInput, resolverOrganizador, type MeetingActor } from "./create.js";
import { cancelarEventoNoGraph } from "./delete.js";
import { findMeeting, type MeetingDetail } from "./service.js";
import { versionarReuniaoSeMudou } from "./versions.js";

/**
 * TROCAR O ORGANIZADOR (10/2026). O convite mora no calendário do
 * organizador, então trocar é mover o evento de caixa:
 *
 *   1. JÁ EXISTE evento na caixa antiga → cancela LÁ primeiro (o Exchange
 *      avisa os convidados). Se a Microsoft recusar, nada muda (502/erro).
 *   2. Transação: grava o novo organizador, desliga o evento antigo da
 *      integração (novo `idempotency_key`, status `pending`, sem link), versiona
 *      a reunião e registra a trilha.
 *   3. Depois do COMMIT: envia o convite pela caixa NOVA (mesmo caminho do
 *      "Tentar novamente"). Falha aqui fica registrada na integração como em
 *      qualquer envio — a troca em si já valeu.
 *
 * Sem evento (convite nunca saiu, ex.: caixa fora do Resource Scope) o passo 1
 * não existe: ninguém recebe cancelamento.
 */
export function parseTrocaDeOrganizador(body: unknown): { entraObjectId: string; displayName: string; email: string | null } {
  const dados = (body ?? {}) as Record<string, unknown>;
  for (const chave of Object.keys(dados)) {
    if (chave !== "organizer") throw new HttpError(400, `O campo '${chave}' não pode ser informado aqui.`);
  }
  const org = parseOrganizerInput(dados.organizer);
  if (!org?.entraObjectId || !org.displayName) {
    throw new HttpError(400, "Escolha o novo organizador no diretório corporativo.");
  }
  return { entraObjectId: org.entraObjectId, displayName: org.displayName, email: org.email ?? null };
}

export async function trocarOrganizador(
  meetingId: string,
  novo: { entraObjectId: string; displayName: string; email: string | null },
  actor: MeetingActor,
): Promise<MeetingDetail> {
  const atual = await findMeeting(meetingId);
  if (atual.cancelledAt) throw new HttpError(409, "Reunião cancelada: o organizador não pode ser trocado.");

  const { rows } = await pool.query<{ organizer_entra_object_id: string | null; provider_event_id: string | null }>(
    `SELECT m.organizer_entra_object_id, ci.provider_event_id
       FROM meetings m
       LEFT JOIN meeting_calendar_integrations ci ON ci.meeting_id = m.id AND ci.provider = 'outlook'
      WHERE m.id = $1`,
    [meetingId],
  );
  const antes = rows[0];
  if (!antes) throw new HttpError(404, "Reunião não encontrada.");
  if (antes.organizer_entra_object_id === novo.entraObjectId) {
    throw new HttpError(409, "Esta pessoa já é a organizadora da reunião.");
  }

  // 1. Evento existente: cancela na caixa ANTIGA antes de qualquer gravação.
  if (antes.provider_event_id && antes.organizer_entra_object_id) {
    await cancelarEventoNoGraph(antes.organizer_entra_object_id, antes.provider_event_id);
  }

  // 2. Grava a troca.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const organizador = await resolverOrganizador(client, { ...novo, email: novo.email ?? undefined }, actor);
    await client.query(
      `UPDATE meetings
          SET organizer_user_id = $2,
              organizer_entra_tenant_id = $3,
              organizer_entra_object_id = $4,
              organizer_name = $5,
              organizer_email = $6
        WHERE id = $1`,
      [meetingId, organizador.userId, actor.entraTenantId, organizador.entraObjectId, organizador.displayName, organizador.email],
    );
    await client.query(
      `UPDATE meeting_calendar_integrations
          SET provider_event_id = NULL, web_link = NULL, join_url = NULL,
              idempotency_key = gen_random_uuid(), sync_status = 'pending',
              last_synced_at = NULL, last_error = NULL
        WHERE meeting_id = $1 AND provider = 'outlook'`,
      [meetingId],
    );
    await versionarReuniaoSeMudou(client, meetingId, actor);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Organizador da reunião alterado",
      entityType: "Reunião",
      entityId: meetingId,
      entityLabel: `${atual.title} — ${atual.organizer?.name ?? "sem organizador"} → ${novo.displayName}${
        antes.provider_event_id ? " (convite antigo cancelado)" : ""
      }`,
      status: "success",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // 3. Convite pela caixa nova. A falha fica registrada na integração.
  try {
    await syncMeetingCalendar(meetingId, { id: actor.userId, name: actor.name });
  } catch {
    // Estado e trilha já gravados por `syncMeetingCalendar`.
  }
  return findMeeting(meetingId);
}
