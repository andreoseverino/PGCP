/**
 * ÓRGÃO COLEGIADO como CONTEXTO GLOBAL de navegação.
 *
 * Um seletor no cabeçalho; Visão Geral, Calendário, Pipeline e Agenda Anual
 * leem o mesmo valor. É FILTRO de visualização — não autoriza nada: o backend
 * e as App Roles continuam decidindo o que cada pessoa pode ver e fazer.
 *
 * Persistência: `localStorage` (preferência do dispositivo, como o idioma).
 * Valor desconhecido ou órgão que não existe mais volta para "Todos".
 */

import type { GovernanceBody } from "../types";

export const CHAVE_CONTEXTO_ORGAO = "pgcp_orgao_contexto";
export const TODOS = "";

/** Valor salvo, validado contra os órgãos carregados. Lista ainda vazia: mantém. */
export function contextoValido(salvo: string | null | undefined, orgaos: readonly GovernanceBody[]): string {
  const id = typeof salvo === "string" ? salvo.trim() : "";
  if (!id) return TODOS;
  if (orgaos.length === 0) return id;
  return orgaos.some((o) => o.id === id) ? id : TODOS;
}

/**
 * Órgão pré-selecionado ao criar reunião/agenda: o do contexto, se ATIVO.
 * Em "Todos" (ou órgão inativo) não inventa nada — a pessoa escolhe.
 */
export function orgaoInicialParaCriacao(id: string, orgaos: readonly GovernanceBody[]): string {
  return orgaos.some((o) => o.id === id && o.isActive) ? id : "";
}

/** Opções do seletor: ativos primeiro; inativos ao fim (histórico continua acessível). */
export function opcoesDoContexto(orgaos: readonly GovernanceBody[]): GovernanceBody[] {
  return [...orgaos].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, "pt-BR")
  );
}
