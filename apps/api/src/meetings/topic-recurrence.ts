import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import type { MeetingActor } from "./create.js";
import {
  garantirResponsavelComoParticipante,
  snapshotTopicParticipantsIntoItem,
} from "./agenda-item-participants.js";

/**
 * RECORRÊNCIA DO TEMA (migration 039).
 *
 * Padrão na Biblioteca (`agenda_topics.recurrence`), valor efetivo no tema da
 * reunião (`meeting_agenda_items.recurrence`) — mesmo desenho do Tema circular.
 *
 * EFEITO: ao CRIAR uma reunião nova, entra automaticamente, como tema SEM
 * pauta, todo tema da Biblioteca cuja ÚLTIMA ocorrência em reunião do MESMO
 * órgão (não cancelada, não postergada, anterior à nova) tem recorrência e
 * cuja data + intervalo já chegou no dia da reunião nova. Reuniões já
 * existentes nunca mudam por isso (sem vínculo vivo). A Assessoria organiza o
 * tema depois no Pipeline (pauta, ordem, remoção).
 */

export const RECORRENCIAS_DO_TEMA = ["weekly", "biweekly", "monthly", "quarterly"] as const;
export type RecorrenciaDoTema = (typeof RECORRENCIAS_DO_TEMA)[number];

/** `null`/"" = não se repete. Qualquer outro valor fora da lista: 400. */
export function parseRecorrenciaDoTema(valor: unknown, campo = "recurrence"): RecorrenciaDoTema | null {
  if (valor === null || valor === "") return null;
  if (typeof valor !== "string" || !(RECORRENCIAS_DO_TEMA as readonly string[]).includes(valor)) {
    throw new HttpError(400, `'${campo}' aceita apenas: ${RECORRENCIAS_DO_TEMA.join(", ")} (ou vazio para não se repete).`);
  }
  return valor as RecorrenciaDoTema;
}

/** Intervalo SQL por recorrência (lista fechada; nunca texto do cliente). */
const INTERVALO_SQL = `CASE u.recurrence
  WHEN 'weekly' THEN interval '7 days'
  WHEN 'biweekly' THEN interval '14 days'
  WHEN 'monthly' THEN interval '1 month'
  WHEN 'quarterly' THEN interval '3 months' END`;

interface Ocorrencia {
  agenda_topic_id: string;
  title: string;
  duration_minutes: number | null;
  responsible_label: string | null;
  responsible_entra_object_id: string | null;
  is_circular_theme: boolean;
  agenda_topic_type_id: string | null;
  agenda_topic_nature_id: string | null;
  description: string | null;
  generates_action_item: boolean;
  recurrence: RecorrenciaDoTema;
}

/**
 * Inclui na reunião RECÉM-CRIADA os temas recorrentes vencidos do órgão.
 * Roda na transação da criação, depois dos temas enviados (um tema da
 * Biblioteca que já veio no corpo não é repetido). Devolve quantos entraram.
 */
export async function incluirTemasRecorrentes(
  client: PoolClient,
  meetingId: string,
  governanceBodyId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<number> {
  const { rows } = await client.query<Ocorrencia>(
    `WITH nova AS (
       SELECT start_at, timezone FROM meetings WHERE id = $2
     ),
     ultimas AS (
       SELECT DISTINCT ON (ai.agenda_topic_id)
              ai.agenda_topic_id, ai.title, ai.duration_minutes, ai.responsible_label,
              ai.responsible_entra_object_id, ai.is_circular_theme, ai.agenda_topic_type_id,
              ai.agenda_topic_nature_id, ai.description, ai.generates_action_item,
              ai.recurrence, m.start_at, m.timezone
         FROM meeting_agenda_items ai
         JOIN meetings m ON m.id = ai.meeting_id
         CROSS JOIN nova
        WHERE m.governance_body_id = $1
          AND m.id <> $2
          AND m.cancelled_at IS NULL
          AND m.start_at < nova.start_at
          AND ai.agenda_topic_id IS NOT NULL
          AND ai.execution_status <> 'postponed'
        ORDER BY ai.agenda_topic_id, m.start_at DESC, ai.position DESC
     )
     SELECT u.agenda_topic_id, u.title, u.duration_minutes, u.responsible_label,
            u.responsible_entra_object_id, u.is_circular_theme, u.agenda_topic_type_id,
            u.agenda_topic_nature_id, u.description, u.generates_action_item, u.recurrence
       FROM ultimas u CROSS JOIN nova
      WHERE u.recurrence IS NOT NULL
        AND ((u.start_at AT TIME ZONE u.timezone)::date + ${INTERVALO_SQL})::date
            <= (nova.start_at AT TIME ZONE nova.timezone)::date
        AND NOT EXISTS (SELECT 1 FROM meeting_agenda_items x
                         WHERE x.meeting_id = $2 AND x.agenda_topic_id = u.agenda_topic_id)
      ORDER BY u.title, u.agenda_topic_id`,
    [governanceBodyId, meetingId],
  );

  let incluidos = 0;
  for (const t of rows) {
    const { rows: item } = await client.query<{ id: string }>(
      `INSERT INTO meeting_agenda_items
              (meeting_id, agenda_topic_id, title, position, duration_minutes, execution_status,
               responsible_label, responsible_entra_tenant_id, responsible_entra_object_id,
               is_circular_theme, agenda_topic_type_id, agenda_topic_nature_id, description,
               generates_action_item, recurrence)
            VALUES ($1, $2, $3,
                    (SELECT COALESCE(max(position), 0) + 1 FROM meeting_agenda_items WHERE meeting_id = $1),
                    $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
      [
        meetingId,
        t.agenda_topic_id,
        t.title,
        t.duration_minutes,
        t.responsible_label,
        t.responsible_entra_object_id ? actor.entraTenantId : null,
        t.responsible_entra_object_id,
        t.is_circular_theme,
        t.agenda_topic_type_id,
        t.agenda_topic_nature_id,
        t.description,
        t.generates_action_item,
        t.recurrence,
      ],
    );
    // Mesmas regras da inclusão de tema: participantes padrão (exceção 031
    // respeitada) e responsável pessoa como participante.
    await snapshotTopicParticipantsIntoItem(client, meetingId, item[0]!.id, t.agenda_topic_id, actor, titulo);
    await garantirResponsavelComoParticipante(
      client,
      meetingId,
      item[0]!.id,
      { responsibleLabel: t.responsible_label, responsibleEntraObjectId: t.responsible_entra_object_id },
      actor,
      titulo,
    );
    incluidos += 1;
  }

  if (incluidos > 0) {
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: `Temas recorrentes incluídos automaticamente (${incluidos})`,
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: titulo,
      status: "success",
    });
  }
  return incluidos;
}
