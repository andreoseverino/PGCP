import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

/**
 * TRANSAÇÃO AMBIENTE — para compor operações existentes numa transação maior
 * sem mudar a assinatura delas.
 *
 * Caso de uso: a Agenda Anual trava a própria linha (`FOR UPDATE`), revalida o
 * status e, NA MESMA transação, executa a criação/edição de pauta ou tema de
 * `meetings/`. Os `emTransacao` daqueles módulos consultam `transacaoAmbiente()`:
 * havendo uma, usam o mesmo cliente (sem BEGIN/COMMIT próprios) e o erro sobe
 * para quem abriu a transação fazer o ROLLBACK.
 *
 * Fora de `dentroDaTransacao`, nada muda: cada operação abre a sua.
 */
const ambiente = new AsyncLocalStorage<PoolClient>();

export function transacaoAmbiente(): PoolClient | undefined {
  return ambiente.getStore();
}

export function dentroDaTransacao<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return ambiente.run(client, fn);
}
