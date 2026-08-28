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

// -----------------------------------------------------------------------------
// INVARIANTE: responsável de pauta que é PESSOA participa da reunião
// -----------------------------------------------------------------------------
//
// A garantia REAL é do backend (`meetings/agenda-item-participants.ts`), que
// aplica a mesma regra em toda criação e edição de pauta — inclusive numa
// chamada direta à API, sem tela. O que existe aqui é o reflexo IMEDIATO na
// tela de agendamento, onde a reunião ainda não foi gravada e não há resposta
// do servidor para absorver.

/** O que uma pauta guarda sobre quem responde por ela. */
export interface PautaComResponsavel {
  author?: string;
  authorEntraObjectId?: string;
}

/**
 * Papel de quem o PGCP acrescenta à lista por conta própria — o MESMO rótulo do
 * cadastro manual. Nenhum papel novo: a lista não deve ter duas classes de
 * convidado.
 */
export function papelPadraoDoParticipante(language: "en" | "pt"): string {
  return language === "en" ? "Participant" : "Convidado";
}

/**
 * O participante que este responsável deve ser — ou `null` quando não há pessoa
 * a convidar.
 *
 * Espelha `participanteDoResponsavel` do backend: só entra quem tem identidade
 * no diretório. Área, órgão e coletivo ("Todos", "Comitê de Auditoria") e texto
 * livre ficam de fora — não há a quem convidar nem como deduplicar, e casar o
 * texto com o diretório por semelhança uniria homônimos.
 *
 * Presença NUNCA nasce confirmada: quem montou a pauta não responde pela agenda
 * de quem foi convidado.
 */
export function participanteDoResponsavel(
  pauta: PautaComResponsavel,
  language: "en" | "pt",
): { name: string; role: string; confirmed: boolean; entraObjectId: string } | null {
  const entraObjectId = pauta.authorEntraObjectId?.trim();
  const name = pauta.author?.trim();
  if (!canOfferAsParticipant(entraObjectId) || !name) return null;

  return {
    name,
    role: papelPadraoDoParticipante(language),
    confirmed: false,
    entraObjectId: entraObjectId as string,
  };
}

/**
 * Pautas cujo responsável é esta pessoa.
 *
 * Base de duas coisas na tela: as etiquetas de pauta ao lado do participante e
 * o bloqueio da remoção de quem ainda responde por alguma. Compara IDENTIDADE
 * (`isSameParticipant`) — o casamento por substring de nome que existia antes
 * colava "Ana" em toda pauta cujo responsável contivesse "Ana".
 */
export function pautasSobResponsabilidade<T extends PautaComResponsavel>(
  pautas: readonly T[],
  pessoa: ParticipantRef,
): T[] {
  return pautas.filter((pauta) =>
    pauta.author?.trim()
      ? isSameParticipant({ name: pauta.author, entraObjectId: pauta.authorEntraObjectId }, pessoa)
      : false,
  );
}

/** Formato mínimo de e-mail, para validar o que a pessoa digitou. */
export function ehEmailValido(valor: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor.trim());
}
