/**
 * Filtro por ÓRGÃO COLEGIADO (`governance_bodies`) — regra única de
 * visualização usada por Visão Geral, Calendário e Pipeline.
 *
 * Só filtra o que já foi carregado: não altera status, não toca no banco.
 * `""` = Todos (estado inicial).
 */

export function filtrarPorOrgao<T extends { governanceBodyId?: string }>(
  itens: readonly T[],
  orgaoId: string
): T[] {
  return orgaoId ? itens.filter((i) => i.governanceBodyId === orgaoId) : [...itens];
}
