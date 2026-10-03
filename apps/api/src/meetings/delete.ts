import pool from "../database.js";
import { contarDocumentos } from "../documents/service.js";
import { HttpError } from "../http-error.js";
import { recordAudit, recordAuditIn } from "../audit/service.js";
import { findCalendarIntegration } from "../calendar/service.js";
import { GraphError, getGraphConfig, graphRequest } from "../graph/client.js";

/**
 * Exclusao de reuniao — o ato que faltava (ver App.tsx, historico do front).
 *
 * A cascata inteira vem das FKs de `meetings` (migration 001 e seguintes):
 * participantes, pautas da reuniao (e, por tabela, os participantes/
 * apresentadores DELAS), Anotacoes, Ata (e as assinaturas dela) e a integracao
 * de calendario local somem com `ON DELETE CASCADE`. Nao ha necessidade de
 * apagar tabela por tabela aqui.
 *
 * O que DELIBERADAMENTE nao e apagado:
 *   - Temas na Biblioteca (`agenda_topics`): sobrevivem independentes, mesmo
 *     quando nasceram desta reuniao — `source_meeting_id`/
 *     `source_agenda_item_id` sao SET NULL, nunca CASCADE. E o mesmo principio
 *     do "Postergar": a pauta pode sair do fluxo da reuniao sem deixar de
 *     existir.
 *   - FUPs (`action_items`): sobrevivem, so perdem o vinculo de origem
 *     (`origin_meeting_id`/`origin_agenda_item_id` viram NULL).
 *
 * Se a reuniao ja tinha convite REAL no Outlook (`sync_status = 'synced'`),
 * tenta cancelar esse evento ANTES de apagar a linha local — melhor esforco:
 * falha no Graph nao impede a exclusao no PGCP, so fica registrada. Sem isso,
 * apagar aqui deixaria um convite fantasma na agenda de todo mundo, sem
 * ninguem saber que a reuniao nao existe mais.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MeetingRow {
  title: string;
  organizer_entra_object_id: string | null;
}

export async function deleteMeeting(
  meetingId: string,
  actor: { id: string; name: string },
): Promise<void> {
  if (!UUID_PATTERN.test(meetingId)) {
    throw new HttpError(400, "Identificador da reunião inválido.");
  }

  const { rows } = await pool.query<MeetingRow>(
    `SELECT title, organizer_entra_object_id FROM meetings WHERE id = $1`,
    [meetingId],
  );
  const reuniao = rows[0];
  if (!reuniao) throw new HttpError(404, "Reunião não encontrada.");

  // ANTES de cancelar o evento no Outlook: reunião com documentos não é
  // excluída (documentos de governança não somem sem política explícita).
  if ((await contarDocumentos(pool, { meetingId })) > 0) {
    throw new HttpError(409, "Esta reunião tem documentos anexados e não pode ser excluída.");
  }

  const integracao = await findCalendarIntegration(meetingId);
  if (integracao?.syncStatus === "synced" && integracao.providerEventId && reuniao.organizer_entra_object_id) {
    await cancelarEventoOutlook(
      reuniao.organizer_entra_object_id,
      integracao.providerEventId,
      meetingId,
      reuniao.title,
      actor,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /*
     * A trilha registra ANTES do DELETE: `audit_logs.entity_id` e texto solto,
     * sem FK para `meetings` (de proposito — a trilha tem que sobreviver ao que
     * ela audita). Gravar depois do DELETE, na mesma transacao, funcionaria
     * igual; gravar antes deixa a ordem de leitura do codigo bater com a ordem
     * dos fatos: primeiro decide-se registrar, so depois se apaga.
     */
    await recordAuditIn(client, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Reunião excluída",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: reuniao.title,
      status: "success",
    });

    await client.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Best-effort: nunca lanca. Se o evento ja tiver sido removido direto no
 * Outlook por outra via, o Graph devolve 404 — isso NAO e falha, e o estado
 * que a gente queria de qualquer forma.
 */
async function cancelarEventoOutlook(
  organizerEntraObjectId: string,
  eventId: string,
  meetingId: string,
  title: string,
  actor: { id: string; name: string },
): Promise<void> {
  const config = getGraphConfig();
  if (!config) return;

  try {
    await graphRequest(config, `/users/${organizerEntraObjectId}/events/${eventId}`, {
      method: "DELETE",
      timeoutMs: 15000,
    });
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return;

    const mensagem = error instanceof GraphError ? error.message : "Falha desconhecida ao cancelar o evento.";
    await recordAudit({
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Cancelamento do evento Outlook falhou ao excluir a reunião",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: `${title} — ${mensagem}`.slice(0, 200),
      status: "failure",
    }).catch(() => {});
  }
}
