/**
 * Filtro por ÓRGÃO COLEGIADO (`governance_bodies`) — regra única de
 * visualização usada por Calendário, Pipeline e Agenda Anual.
 *
 * Só filtra o que já foi carregado: não altera status, não toca no banco.
 * `""` = Todos (estado inicial).
 */

export const TODOS_OS_ORGAOS = "";

export function filtrarPorOrgao<T extends { governanceBodyId?: string }>(
  itens: readonly T[],
  orgaoId: string
): T[] {
  return orgaoId ? itens.filter((i) => i.governanceBodyId === orgaoId) : [...itens];
}

/** Agendas Anuais por ano e órgão (`""`/`null` = todos). */
export function filtrarAgendasAnuais<T extends { year: number; governanceBody: { id: string } }>(
  agendas: readonly T[],
  ano: number | null,
  orgaoId: string
): T[] {
  return agendas.filter(
    (a) => (ano === null || a.year === ano) && (!orgaoId || a.governanceBody.id === orgaoId)
  );
}

/** Anos existentes nas agendas, do mais recente para o mais antigo. */
export function anosDasAgendas(agendas: readonly { year: number }[]): number[] {
  return [...new Set(agendas.map((a) => a.year))].sort((a, b) => b - a);
}
