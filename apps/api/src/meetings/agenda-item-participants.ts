import type { PoolClient } from "pg";
import { recordAuditIn } from "../audit/service.js";
import { marcarComoDesatualizada } from "../calendar/service.js";
import {
  prepararParticipantes,
  type MeetingActor,
  type ParticipantInput,
  type ParticipanteResolvido,
} from "./create.js";

/**
 * Participantes POR PAUTA (Opção A) — núcleo reutilizável.
 *
 * INVARIANTE: quem participa de uma pauta existe também em `meeting_participants`.
 * O vínculo aponta para `meeting_participants` (não para o diretório), então isso
 * é estrutural. Ao adicionar alguém a uma pauta que ainda não está na reunião, o
 * PGCP o adiciona à reunião pelo MESMO caminho da aba Participantes — mesma
 * resolução de identidade, mesma marca de calendário desatualizado, mesma
 * auditoria. Nada de segundo fluxo.
 *
 * Este módulo NÃO importa `update.ts`: as rotas direcionadas (add/remove) vivem
 * lá e chamam estas peças, evitando ciclo de import.
 */

/**
 * Grava um NOVO participante da reunião. Idêntico ao INSERT da aba Participantes
 * (`addParticipant`), extraído para ter uma fonte só: mesma marca de calendário
 * e mesma trilha. NÃO deduplica — quem chama garante que a pessoa ainda não está.
 */
export async function inserirMeetingParticipant(
  client: PoolClient,
  meetingId: string,
  preparado: ParticipanteResolvido,
  actor: MeetingActor,
  titulo: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO meeting_participants
            (meeting_id, user_id, display_name, email, participant_type,
             role_in_meeting, is_confirmed, entra_tenant_id, entra_object_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
    [
      meetingId,
      preparado.userId,
      preparado.displayName,
      preparado.email,
      preparado.participantType,
      preparado.roleInMeeting,
      preparado.isConfirmed,
      preparado.entraObjectId ? actor.entraTenantId : null,
      preparado.entraObjectId,
    ],
  );

  // A lista de convidados mudou: o evento no calendário deixa de refletir a
  // reunião. MESMO comportamento da aba Participantes, na mesma transação.
  await marcarComoDesatualizada(client, meetingId);

  await recordAuditIn(client, {
    actorUserId: actor.userId,
    actorName: actor.name,
    action: "Participante adicionado",
    entityType: "meeting_participant",
    entityId: rows[0]!.id,
    entityLabel: titulo,
    status: "success",
  });

  return rows[0]!.id;
}

/**
 * FIND-OR-CREATE serializado do participante da reunião.
 *
 * Deduplicação SÓ por identificador estável (`user_id` / `entra_object_id`) — nunca
 * por `display_name` sozinho. Sem esses ids (participante textual), a pessoa é
 * sempre criada, como no modelo atual.
 *
 * A serialização contra corrida é responsabilidade do chamador: ele bloqueia a
 * reunião (`SELECT ... FROM meetings WHERE id = $1 FOR UPDATE`) antes de chamar,
 * então dois adds concorrentes à mesma reunião não criam a mesma pessoa duas
 * vezes. Não há UNIQUE de identidade em `meeting_participants` (dados legados),
 * por isso o lock — e não um índice novo — é o que garante a exclusão mútua.
 */
export async function findOrCreateMeetingParticipant(
  client: PoolClient,
  meetingId: string,
  input: ParticipantInput,
  actor: MeetingActor,
  titulo: string,
): Promise<{ id: string; criado: boolean }> {
  const [preparado] = await prepararParticipantes(client, [input], actor.entraTenantId);

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM meeting_participants
      WHERE meeting_id = $1
        AND ( ($2::uuid IS NOT NULL AND user_id = $2)
           OR ($3::uuid IS NOT NULL AND entra_object_id = $3) )
      LIMIT 1`,
    [meetingId, preparado!.userId, preparado!.entraObjectId],
  );
  if (rows[0]) return { id: rows[0].id, criado: false };

  const id = await inserirMeetingParticipant(client, meetingId, preparado!, actor, titulo);
  return { id, criado: true };
}

/**
 * Remove um participante DA REUNIÃO — fonte única, idêntica à da aba
 * Participantes (`removeParticipant`): DELETE em `meeting_participants` +
 * calendário desatualizado + auditoria. Por causa do `ON DELETE CASCADE` da 020,
 * apagar o participante elimina TODOS os vínculos dele com pautas desta reunião.
 * Devolve o `rowCount` para o chamador decidir o 404.
 */
export async function excluirMeetingParticipant(
  client: PoolClient,
  meetingId: string,
  participantId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<number> {
  const { rowCount } = await client.query(
    "DELETE FROM meeting_participants WHERE id = $1 AND meeting_id = $2",
    [participantId, meetingId],
  );
  if ((rowCount ?? 0) > 0) {
    // A lista de convidados mudou: o evento no calendário deixa de refletir a
    // reunião. MESMO comportamento da aba Participantes.
    await marcarComoDesatualizada(client, meetingId);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Participante removido",
      entityType: "meeting_participant",
      entityId: participantId,
      entityLabel: titulo,
      status: "success",
    });
  }
  return rowCount ?? 0;
}

/**
 * Cria o vínculo pauta↔participante. PK composta => idempotente. Devolve `true`
 * quando um vínculo NOVO foi criado (para o chamador distinguir do repetido).
 */
export async function vincularParticipanteNaPauta(
  client: PoolClient,
  agendaItemId: string,
  meetingParticipantId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO meeting_agenda_item_participants (meeting_agenda_item_id, meeting_participant_id)
          VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [agendaItemId, meetingParticipantId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * SNAPSHOT dos participantes do tema da Biblioteca para a pauta da reunião.
 *
 * Para cada `agenda_topic_participant`: find-or-create o `meeting_participant`
 * (adicionando à reunião se preciso) e cria o vínculo. Depois disso a pauta é
 * independente do tema. Roda dentro da transação do chamador.
 */
export async function snapshotTopicParticipantsIntoItem(
  client: PoolClient,
  meetingId: string,
  agendaItemId: string,
  agendaTopicId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<void> {
  const { rows } = await client.query<{
    user_id: string | null;
    display_name: string | null;
    email: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT user_id, display_name, email, entra_object_id
       FROM agenda_topic_participants WHERE agenda_topic_id = $1`,
    [agendaTopicId],
  );

  for (const p of rows) {
    const input: ParticipantInput = {
      userId: p.user_id ?? undefined,
      entraObjectId: p.entra_object_id ?? undefined,
      displayName: p.display_name ?? undefined,
      email: p.email ?? undefined,
    };
    const { id } = await findOrCreateMeetingParticipant(client, meetingId, input, actor, titulo);
    await vincularParticipanteNaPauta(client, agendaItemId, id);
  }
}
