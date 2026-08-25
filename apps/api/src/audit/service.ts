/**
 * Auditoria funcional — tabela `audit_logs`.
 *
 * Registra ACAO DE NEGOCIO e evento de governanca. Nao confundir com
 * observabilidade tecnica (latencia, exception, dependencia externa), que tem
 * destino proprio e ainda nao esta implementada.
 *
 * NUNCA registra token, authorization code ou segredo.
 */

import type { PoolClient } from "pg";
import pool from "../database.js";

/**
 * Quem executa a consulta. O pool para uma gravacao solta, um PoolClient
 * quando a auditoria precisa fazer parte da transacao que ela audita.
 */
type Executor = Pick<PoolClient, "query">;

export interface AuditEntry {
  /** `users.id` do autor, quando ja resolvido. Nulo quando nao ha usuario. */
  actorUserId: string | null;
  /** Nome exibido do autor. Obrigatorio pelo schema. */
  actorName: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  status: "success" | "failure";
}

async function insertAudit(executor: Executor, entry: AuditEntry): Promise<void> {
  await executor.query(
    `INSERT INTO audit_logs (actor_user_id, actor_name, action, entity_type, entity_id, entity_label, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorUserId,
      entry.actorName,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.entityLabel ?? null,
      entry.status,
    ],
  );
}

/**
 * Grava a entrada por fora de qualquer transacao. Falha de auditoria NAO
 * derruba a operacao auditada: perder um registro e ruim, mas impedir alguem
 * de entrar por causa disso e pior. O erro fica no log do servidor.
 *
 * Use esta forma para eventos que ja aconteceram e nao podem ser desfeitos —
 * o login e o caso tipico.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await insertAudit(pool, entry);
  } catch (error) {
    console.error("[audit] falha ao registrar entrada:", error instanceof Error ? error.message : error);
  }
}

/**
 * Grava DENTRO da transacao de quem chama, e PROPAGA o erro.
 *
 * Aqui engolir a falha seria pior do que inutil: dentro de uma transacao, um
 * INSERT que falha ja deixa a sessao abortada, entao o COMMIT cairia de
 * qualquer forma — e o motivo verdadeiro teria sumido no caminho. Propagar
 * mantem o vinculo: ou o ato e a trilha existem juntos, ou nenhum dos dois.
 */
export async function recordAuditIn(executor: Executor, entry: AuditEntry): Promise<void> {
  await insertAudit(executor, entry);
}
