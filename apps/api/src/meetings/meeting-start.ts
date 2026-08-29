import type { PoolClient } from "pg";
import { recordAuditIn } from "../audit/service.js";
import type { MeetingActor } from "./create.js";

/** Estados que o produto apresenta como fase anterior ao inicio. */
export const PRE_START_MEETING_STATUSES = [
  "draft",
  "scheduled",
  "needs_approval",
  "approved",
] as const;

/**
 * Marca a reuniao como iniciada quando a primeira pauta e concluida.
 *
 * Deve ser chamada dentro da MESMA transacao que conclui a pauta. O UPDATE
 * condicional torna a operacao idempotente e segura mesmo se outro caminho
 * deixar de adquirir o lock da reuniao no futuro: somente um chamador observa
 * `rowCount = 1` e registra a transicao. `done` e `closed` ficam preservados.
 */
export async function startMeetingWhenAgendaItemCompletes(
  client: PoolClient,
  meetingId: string,
  meetingTitle: string,
  actor: MeetingActor,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE meetings
        SET status = 'in_progress'
      WHERE id = $1
        AND status IN ('draft', 'scheduled', 'needs_approval', 'approved')`,
    [meetingId],
  );

  if (rowCount === 0) return false;

  await recordAuditIn(client, {
    actorUserId: actor.userId,
    actorName: actor.name,
    action: "Reunião iniciada pela conclusão de pauta",
    entityType: "meeting",
    entityId: meetingId,
    entityLabel: meetingTitle,
    status: "success",
  });

  return true;
}
