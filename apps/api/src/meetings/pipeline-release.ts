import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import pool from "../database.js";

/**
 * LIBERAÇÃO PARA O PIPELINE.
 *
 * Reunião vinculada a uma Agenda Anual é preparada NA AGENDA (temas,
 * participantes, duração, ordem, prévia, aprovação) e só fica operacional no
 * Pipeline depois que a Agenda é APROVADA. Reunião sem Agenda Anual
 * (`annual_agenda_id IS NULL`) segue o Pipeline normalmente.
 *
 * Nada é copiado na aprovação: o Pipeline passa a operar a MESMA reunião.
 *
 * A Agenda Anual edita pelas próprias rotas (`/annual-agendas/...`), que chamam
 * as funções de serviço de reunião dentro da transação travada da Agenda — não
 * passam por esta guarda, que protege só o router `/meetings`.
 */

export const MSG_EM_PREPARACAO_NA_AGENDA =
  "Esta reunião ainda está em preparação na Agenda Anual e será liberada para o Pipeline após a aprovação.";

/** Condição SQL: a reunião `alias` está liberada para o Pipeline. */
export const liberadaParaPipelineSql = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM annual_agendas a_lib
                WHERE a_lib.id = ${alias}.annual_agenda_id AND a_lib.status <> 'approved')`;

/** Status da Agenda Anual da reunião → liberada? (`null` = reunião avulsa). */
export function liberadaParaPipeline(statusDaAgenda: string | null | undefined): boolean {
  return !statusDaAgenda || statusDaAgenda === "approved";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rotas de `/meetings/:id/...` que NÃO são operação do Pipeline e continuam
 * valendo antes da aprovação: o convite de calendário (Calendário → reunião →
 * convite; regra 025: o convite sai no agendamento, antes de qualquer
 * aprovação). Leituras (GET/HEAD) também seguem livres.
 */
const FORA_DO_PIPELINE = [/^\/calendar-sync\/?$/];

export async function statusDaAgendaDaReuniao(
  executor: Pick<PoolClient, "query">,
  meetingId: string,
): Promise<string | null> {
  const { rows } = await executor.query<{ status: string | null }>(
    `SELECT a.status FROM meetings m LEFT JOIN annual_agendas a ON a.id = m.annual_agenda_id WHERE m.id = $1`,
    [meetingId],
  );
  return rows[0]?.status ?? null;
}

/**
 * Guarda ÚNICA do router `/meetings` (montada antes das rotas): mutação numa
 * reunião cuja Agenda Anual não está aprovada → 409 com a mensagem de negócio.
 * Reunião inexistente ou id inválido seguem para a rota (404/400 de sempre).
 */
export function exigirLiberadaParaPipeline(
  consultar: (meetingId: string) => Promise<string | null> = (id) => statusDaAgendaDaReuniao(pool, id),
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = req.params.id;
    if (req.method === "GET" || req.method === "HEAD" || typeof id !== "string" || !UUID.test(id)) return next();
    const resto = req.path; // relativo ao "/:id"
    if (FORA_DO_PIPELINE.some((r) => r.test(resto))) return next();
    try {
      if (!liberadaParaPipeline(await consultar(id))) {
        res.status(409).json({ error: MSG_EM_PREPARACAO_NA_AGENDA, code: "annual_agenda_not_approved" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
