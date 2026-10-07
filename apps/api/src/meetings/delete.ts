import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { GraphError, getGraphConfig, graphRequest } from "../graph/client.js";
import { versionarReuniaoSeMudou } from "./versions.js";

/**
 * EXCLUIR REUNIÃO = CANCELAMENTO LÓGICO (migration 036).
 *
 * Nada é apagado: participantes, pautas, temas, Anotações, Ata, documentos,
 * integração de calendário, VERSÕES (e seus PDFs) e `audit_logs` ficam como
 * histórico. A reunião sai dos fluxos ativos (`cancelled_at IS NOT NULL`:
 * Pipeline, Calendário, Agenda Anual, exportação, grupos) e vira somente
 * leitura — no router (409) e no banco (trigger da 036).
 *
 * ORDEM, para nunca deixar estado inconsistente:
 *
 *   1. UMA transação no PGCP: trava a reunião, marca `cancelled_at`, grava a
 *      trilha e a VERSÃO final (a "fotografia" da reunião cancelada).
 *   2. Depois do COMMIT: cancela o evento do Outlook/Teams no Graph
 *      (`DELETE` no calendário do organizador — o Exchange envia o
 *      cancelamento aos convidados, comportamento padrão do Outlook).
 *      Sucesso (ou 404: o evento já não existia) grava
 *      `calendar_event_cancelled_at`.
 *
 * Falha no Graph segue o padrão do projeto para chamadas externas: NÃO desfaz
 * o ato local, registra a falha na trilha e deixa o estado EXPLÍCITO
 * (cancelamento externo pendente). Repetir a exclusão é idempotente: a
 * reunião já cancelada só tenta de novo o evento pendente.
 *
 * Ao contrário de antes, cancelar uma reunião COM documentos é permitido: os
 * documentos ficam no histórico dela, nada é apagado.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MSG_REUNIAO_CANCELADA = "Esta reunião foi cancelada e está disponível somente para consulta.";

/**
 * Guarda do router `/meetings`: toda MUTAÇÃO em `/:id/...` de reunião
 * cancelada responde 409. Leitura (GET/HEAD) segue livre — o histórico
 * continua consultável. A própria exclusão (`DELETE /:id`) passa: repetir é
 * idempotente e retenta o cancelamento externo pendente.
 */
export function recusarMutacaoEmReuniaoCancelada(
  consultar: (meetingId: string) => Promise<boolean> = async (id) =>
    (await pool.query("SELECT 1 FROM meetings WHERE id = $1 AND cancelled_at IS NOT NULL", [id])).rows.length > 0,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = req.params.id;
    if (req.method === "GET" || req.method === "HEAD" || typeof id !== "string" || !UUID_PATTERN.test(id)) return next();
    if (req.method === "DELETE" && (req.path === "/" || req.path === "")) return next();
    try {
      if (await consultar(id)) {
        res.status(409).json({ error: MSG_REUNIAO_CANCELADA, code: "meeting_cancelled" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export type CancelamentoDoEvento = "cancelled" | "not_required" | "pending";

export interface ResultadoDoCancelamento {
  meetingId: string;
  cancelledAt: string;
  /** Situação do evento do Outlook/Teams. `pending` = Graph falhou; repetir a exclusão tenta de novo. */
  calendarCancellation: CancelamentoDoEvento;
  /** Mensagem para a pessoa quando o cancelamento externo ficou pendente. */
  warning?: string;
}

interface ReuniaoParaCancelar {
  title: string;
  cancelled_at: Date | null;
  calendar_event_cancelled_at: Date | null;
  organizer_entra_object_id: string | null;
  provider_event_id: string | null;
}

/** O evento externo precisa ser cancelado? (Puro, para teste.) */
export function eventoACancelar(r: Pick<ReuniaoParaCancelar, "provider_event_id" | "organizer_entra_object_id" | "calendar_event_cancelled_at">): boolean {
  return Boolean(r.provider_event_id && r.organizer_entra_object_id && !r.calendar_event_cancelled_at);
}

/** Dependências injetáveis (testes): banco e chamada ao Graph. */
export interface DependenciasDoCancelamento {
  db: Pick<Pool, "connect" | "query">;
  cancelarNoGraph: (organizerOid: string, eventId: string) => Promise<void>;
}

export async function deleteMeeting(
  meetingId: string,
  actor: { id: string; name: string },
  deps: Partial<DependenciasDoCancelamento> = {},
): Promise<ResultadoDoCancelamento> {
  if (!UUID_PATTERN.test(meetingId)) {
    throw new HttpError(400, "Identificador da reunião inválido.");
  }
  const db = deps.db ?? pool;
  const cancelarNoGraph = deps.cancelarNoGraph ?? cancelarEventoNoGraph;

  // 1. Cancelamento LOCAL, numa transação só.
  const client = await db.connect();
  let reuniao: ReuniaoParaCancelar;
  let cancelledAt: Date;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ReuniaoParaCancelar>(
      `SELECT m.title, m.cancelled_at, m.calendar_event_cancelled_at, m.organizer_entra_object_id,
              ci.provider_event_id
         FROM meetings m
         LEFT JOIN meeting_calendar_integrations ci ON ci.meeting_id = m.id AND ci.provider = 'outlook'
        WHERE m.id = $1
          FOR UPDATE OF m`,
      [meetingId],
    );
    if (!rows[0]) throw new HttpError(404, "Reunião não encontrada.");
    reuniao = rows[0];

    if (reuniao.cancelled_at) {
      // Idempotente: já cancelada. Só o evento externo pendente é retentado.
      cancelledAt = reuniao.cancelled_at;
    } else {
      const { rows: marcada } = await client.query<{ cancelled_at: Date }>(
        `UPDATE meetings SET cancelled_at = now(), cancelled_by_user_id = $2
          WHERE id = $1 AND cancelled_at IS NULL
          RETURNING cancelled_at`,
        [meetingId, actor.id],
      );
      cancelledAt = marcada[0]!.cancelled_at;
      await recordAuditIn(client, {
        actorUserId: actor.id,
        actorName: actor.name,
        action: "Reunião cancelada (exclusão lógica)",
        entityType: "meeting",
        entityId: meetingId,
        entityLabel: reuniao.title,
        status: "success",
      });
      // Fotografia final: a versão registra a reunião COMO CANCELADA.
      await versionarReuniaoSeMudou(client, meetingId, { userId: actor.id, name: actor.name });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const base = { meetingId, cancelledAt: cancelledAt.toISOString() };
  if (!eventoACancelar(reuniao)) {
    return {
      ...base,
      calendarCancellation: reuniao.calendar_event_cancelled_at ? "cancelled" : "not_required",
    };
  }

  // 2. Evento externo, DEPOIS do commit local.
  try {
    await cancelarNoGraph(reuniao.organizer_entra_object_id!, reuniao.provider_event_id!);
  } catch (error) {
    const mensagem = error instanceof GraphError ? error.message : "Falha desconhecida ao cancelar o evento.";
    // Fora da transação local (já commitada): a falha fica registrada mesmo assim.
    await recordAuditIn(db, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Cancelamento do evento Outlook falhou",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: `${reuniao.title} — ${mensagem}`.slice(0, 200),
      status: "failure",
    }).catch(() => {});
    return {
      ...base,
      calendarCancellation: "pending",
      warning:
        "A reunião foi cancelada no PGCP, mas o evento do Outlook/Teams não pôde ser cancelado agora. Tente excluir novamente para reenviar o cancelamento.",
    };
  }

  await db.query(
    "UPDATE meetings SET calendar_event_cancelled_at = now() WHERE id = $1 AND calendar_event_cancelled_at IS NULL",
    [meetingId],
  );
  await recordAuditIn(db, {
    actorUserId: actor.id,
    actorName: actor.name,
    action: "Evento Outlook cancelado",
    entityType: "meeting",
    entityId: meetingId,
    entityLabel: reuniao.title,
    status: "success",
  }).catch(() => {});
  return { ...base, calendarCancellation: "cancelled" };
}

/**
 * `DELETE` do evento no calendário do ORGANIZADOR: o Exchange envia o
 * cancelamento aos convidados. 404 = o evento já não existe (removido por
 * outra via) — é o estado desejado, não falha. Sem Graph configurado, lança:
 * o cancelamento externo fica pendente em vez de ser dado como feito.
 */
async function cancelarEventoNoGraph(organizerEntraObjectId: string, eventId: string): Promise<void> {
  const config = getGraphConfig();
  if (!config) throw new GraphError("Integração com o Microsoft Graph não configurada.", "graph_not_configured");
  try {
    await graphRequest(config, `/users/${organizerEntraObjectId}/events/${eventId}`, {
      method: "DELETE",
      timeoutMs: 15000,
    });
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return;
    throw error;
  }
}
