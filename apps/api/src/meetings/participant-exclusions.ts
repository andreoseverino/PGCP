import type { PoolClient } from "pg";

/**
 * EXCEÇÃO POR REUNIÃO (031) para a inclusão automática de participantes.
 *
 * Remover alguém da reunião grava a exceção; a inclusão automática (grupo do
 * órgão, participantes padrão do tema) consulta a exceção e pula a pessoa;
 * incluir a pessoa por escolha explícita apaga a exceção. Os grupos nunca são
 * alterados por aqui, e a exceção vale só para AQUELA reunião.
 *
 * Identidade = a de `meeting_participants`: par Microsoft (tenant, oid) ou,
 * para convidado sem identidade, o e-mail.
 */

export interface IdentidadeNaReuniao {
  entraTenantId: string | null;
  entraObjectId: string | null;
  email: string | null;
}

type Executor = Pick<PoolClient, "query">;

/**
 * Resolve a identidade de quem vai entrar/sair. Usuário do PGCP sem o par no
 * corpo é lido de `users` (o par é a identidade estável; e-mail é só snapshot).
 */
export async function identidadeDe(
  executor: Executor,
  p: { userId?: string | null; entraObjectId?: string | null; email?: string | null },
  tenantId: string,
): Promise<IdentidadeNaReuniao> {
  const email = p.email?.trim() || null;
  if (p.entraObjectId) return { entraTenantId: tenantId, entraObjectId: p.entraObjectId, email };
  if (p.userId) {
    const { rows } = await executor.query<{ entra_tenant_id: string | null; entra_object_id: string | null; email: string | null }>(
      "SELECT entra_tenant_id, entra_object_id, email FROM users WHERE id = $1",
      [p.userId],
    );
    const u = rows[0];
    if (u?.entra_object_id && u.entra_tenant_id) {
      return { entraTenantId: u.entra_tenant_id, entraObjectId: u.entra_object_id, email: email ?? u.email };
    }
    return { entraTenantId: null, entraObjectId: null, email: email ?? u?.email ?? null };
  }
  return { entraTenantId: null, entraObjectId: null, email };
}

/** Condição SQL da mesma pessoa ($2 tenant, $3 oid, $4 e-mail). */
const MESMA_PESSOA = `(
     ($3::uuid IS NOT NULL AND entra_tenant_id = $2::uuid AND entra_object_id = $3::uuid)
  OR (entra_object_id IS NULL AND $4::text IS NOT NULL AND lower(email) = lower($4::text))
)`;

const parametros = (meetingId: string, i: IdentidadeNaReuniao) => [meetingId, i.entraTenantId, i.entraObjectId, i.email];

/** A pessoa foi removida explicitamente desta reunião? */
export async function estaExcluidaDaReuniao(executor: Executor, meetingId: string, i: IdentidadeNaReuniao): Promise<boolean> {
  if (!i.entraObjectId && !i.email) return false;
  const { rows } = await executor.query(
    `SELECT 1 FROM meeting_participant_exclusions WHERE meeting_id = $1 AND ${MESMA_PESSOA} LIMIT 1`,
    parametros(meetingId, i),
  );
  return rows.length > 0;
}

/** Grava a exceção (idempotente). Devolve `true` se uma exceção nova nasceu. */
export async function registrarExclusao(
  executor: Executor,
  meetingId: string,
  i: IdentidadeNaReuniao,
  actorUserId: string,
): Promise<boolean> {
  if (!i.entraObjectId && !i.email) return false; // participante só textual: nada a lembrar
  const { rowCount } = await executor.query(
    `INSERT INTO meeting_participant_exclusions
            (meeting_id, entra_tenant_id, entra_object_id, email, created_by_user_id)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [meetingId, i.entraTenantId, i.entraObjectId, i.email ? i.email.slice(0, 320) : null, actorUserId],
  );
  return (rowCount ?? 0) > 0;
}

/** Escolha explícita de incluir a pessoa: a exceção deixa de valer. */
export async function limparExclusao(executor: Executor, meetingId: string, i: IdentidadeNaReuniao): Promise<boolean> {
  if (!i.entraObjectId && !i.email) return false;
  const { rowCount } = await executor.query(
    `DELETE FROM meeting_participant_exclusions WHERE meeting_id = $1 AND ${MESMA_PESSOA}`,
    parametros(meetingId, i),
  );
  return (rowCount ?? 0) > 0;
}
