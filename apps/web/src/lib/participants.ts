import type { Participant } from "../types";

/**
 * O mínimo necessário para dizer se duas entradas são a mesma pessoa.
 * Papel, presença e iniciais não identificam ninguém.
 */
export type ParticipantRef = Pick<Participant, "name"> & { entraObjectId?: string };

const temIdentidade = (ref: ParticipantRef): boolean =>
  typeof ref.entraObjectId === "string" && ref.entraObjectId.trim().length > 0;

/**
 * Duas referências apontam para a mesma pessoa?
 *
 * `entraObjectId` é a identidade Microsoft e decide sozinho quando os dois
 * lados a possuem — nome é apelido, identidade não. Participante legado não
 * tem (foi digitado à mão ou veio dos mocks antigos), e aí só sobra o nome:
 * frágil, mas é o único dado disponível.
 *
 * O nome NÃO desempata quando os dois lados têm identidade: dois `oid`
 * diferentes são duas pessoas, mesmo homônimas.
 */
export function isSameParticipant(a: ParticipantRef, b: ParticipantRef): boolean {
  if (temIdentidade(a) && temIdentidade(b)) return a.entraObjectId === b.entraObjectId;
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

export function isAlreadyParticipant(lista: readonly ParticipantRef[], alvo: ParticipantRef): boolean {
  return lista.some((p) => isSameParticipant(p, alvo));
}

/**
 * Esta pessoa pode ser oferecida como participante da reunião?
 *
 * Só quem veio do diretório. Área, órgão e coletivo ("Todos", "Comitê de
 * Auditoria") não são convidáveis, e responsável digitado em texto livre não
 * traz identidade — sem ela não há como deduplicar nem como convidar depois.
 * Casar o texto com o Graph por semelhança seria adivinhação.
 */
export function canOfferAsParticipant(entraObjectId?: string): boolean {
  return typeof entraObjectId === "string" && entraObjectId.trim().length > 0;
}

/**
 * Acrescenta o participante se ele ainda não estiver na lista.
 * Devolve a lista original — a mesma referência — quando já existe.
 */
export function addParticipantOnce<T extends ParticipantRef>(lista: readonly T[], novo: T): T[] {
  return isAlreadyParticipant(lista, novo) ? [...lista] : [...lista, novo];
}

/**
 * Endereço utilizável de uma pessoa do diretório.
 *
 * `mail` é o endereço de correio propriamente dito. Quando vem nulo — conta sem
 * caixa publicada — o UPN costuma ser um endereço roteável e é o único
 * substituto legítimo; mas só se PARECER um endereço, porque UPN não é
 * obrigatoriamente um e-mail.
 *
 * Nunca construir endereço a partir do nome.
 */
export function enderecoDoDiretorio(pessoa: {
  mail?: string | null;
  userPrincipalName?: string | null;
}): string | undefined {
  const candidato = pessoa.mail?.trim() || pessoa.userPrincipalName?.trim();
  if (!candidato) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidato) ? candidato : undefined;
}

/** Formato mínimo de e-mail, para validar o que a pessoa digitou. */
export function ehEmailValido(valor: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor.trim());
}
