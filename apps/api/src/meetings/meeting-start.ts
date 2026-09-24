import type { PoolClient } from "pg";
import { recordAuditIn } from "../audit/service.js";
import { HttpError } from "../http-error.js";
import type { MeetingActor } from "./create.js";

/** Estados que o produto apresenta como fase anterior ao inicio. */
export const PRE_START_MEETING_STATUSES = [
  "draft",
  "scheduled",
  "needs_approval",
  "approved",
] as const;

/**
 * Pre-requisitos para iniciar a reuniao.
 *
 * A sequencia do produto e: pautas em preparacao -> enviadas para validacao ->
 * aprovadas -> convite enviado -> reuniao. Iniciar antes disso pulava a
 * aprovacao e o convite em silencio, e o Stepper ainda pintava essas etapas
 * como cumpridas.
 *
 * Convite enviado = existe evento no calendario: `synced`, ou `stale` (evento
 * existe, mas a reuniao foi editada depois do envio — o CHECK da 011 garante
 * `provider_event_id` nos dois). `pending` e `failed` nao tem evento.
 */
export type PendenciaDeInicio = "pautas_nao_aprovadas" | "convite_nao_enviado";

export function pendenciasParaIniciar(estado: {
  agendaValidationStatus: string;
  calendarSyncStatus: string | null;
}): PendenciaDeInicio[] {
  const pendencias: PendenciaDeInicio[] = [];
  if (estado.agendaValidationStatus !== "approved") pendencias.push("pautas_nao_aprovadas");
  if (estado.calendarSyncStatus !== "synced" && estado.calendarSyncStatus !== "stale") {
    pendencias.push("convite_nao_enviado");
  }
  return pendencias;
}

const TEXTO_DA_PENDENCIA: Record<PendenciaDeInicio, string> = {
  pautas_nao_aprovadas: "as pautas ainda não foram aprovadas",
  convite_nao_enviado: "o convite do Outlook/Teams ainda não foi enviado",
};

/**
 * Barreira unica de inicio: usada pela transicao manual (PATCH status) e pela
 * automatica (conclusao de pauta). Deve rodar na transacao do chamador, depois
 * do lock da reuniao.
 *
 * So vale para quem ainda esta na fase pre-reuniao: reuniao ja em andamento
 * nao e barrada, e `done`/`closed` seguem as regras de quem chamou.
 */
export async function exigirProntaParaIniciar(
  client: PoolClient,
  meetingId: string,
): Promise<void> {
  const { rows } = await client.query<{
    status: string;
    agenda_validation_status: string;
    sync_status: string | null;
  }>(
    `SELECT m.status, m.agenda_validation_status, ci.sync_status
       FROM meetings m
       LEFT JOIN meeting_calendar_integrations ci
              ON ci.meeting_id = m.id AND ci.provider = 'outlook'
      WHERE m.id = $1`,
    [meetingId],
  );
  const reuniao = rows[0];
  if (!reuniao) throw new HttpError(404, "Reunião não encontrada.");
  if (!(PRE_START_MEETING_STATUSES as readonly string[]).includes(reuniao.status)) return;

  const pendencias = pendenciasParaIniciar({
    agendaValidationStatus: reuniao.agenda_validation_status,
    calendarSyncStatus: reuniao.sync_status,
  });
  if (pendencias.length > 0) {
    throw new HttpError(
      409,
      `Não é possível iniciar a reunião: ${pendencias.map((p) => TEXTO_DA_PENDENCIA[p]).join(" e ")}.`,
    );
  }
}

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
  // Concluir pauta de reuniao nao iniciada tambem e iniciar: mesma barreira.
  await exigirProntaParaIniciar(client, meetingId);

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
