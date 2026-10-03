import type { TopicParticipant, TopicParticipantPayload } from "./agenda-topic-adapters";
import type { ParticipanteSelecionado } from "./participant-search";
import { enderecoDoDiretorio } from "./corporate-email";

/**
 * Regras PURAS dos grupos de participação (sem rede) — testáveis em Node.
 * Cliente HTTP em `participation-groups.ts`.
 */

export type OrigemDaPessoa = "cielo" | "externo";

export interface GrupoDeOrgao {
  id: string;
  name: string;
  isActive: boolean;
  members: number;
}

export interface MembroDoGrupo {
  /** Id do vínculo com o grupo (para remover). */
  id: string;
  nome: string;
  email: string | null;
  origem: OrigemDaPessoa;
}

/** Corpo FECHADO para o grupo do órgão: só a identidade escolhida. */
export function corpoDoMembroDoOrgao(sel: ParticipanteSelecionado): { entraObjectId: string } | { externalParticipantId: string } {
  return sel.origem === "entra" ? { entraObjectId: sel.user.id } : { externalParticipantId: sel.participante.id };
}

/** Participante padrão do tema: pessoa Cielo pela identidade; externo por nome + e-mail. */
export function corpoDoParticipantePadrao(sel: ParticipanteSelecionado): TopicParticipantPayload {
  if (sel.origem === "entra") {
    return {
      entraObjectId: sel.user.id,
      displayName: sel.user.displayName ?? enderecoDoDiretorio(sel.user) ?? undefined,
      email: enderecoDoDiretorio(sel.user) ?? undefined
    };
  }
  return { displayName: sel.participante.fullName, email: sel.participante.email };
}

/** Participante padrão do tema na mesma forma dos membros do grupo do órgão. */
export function membroDoTema(p: TopicParticipant): MembroDoGrupo {
  return {
    id: p.id,
    nome: p.displayName ?? p.userName ?? p.email ?? "",
    email: p.email,
    origem: p.entraObjectId || p.userId ? "cielo" : "externo"
  };
}

/** Aviso depois de entrar no grupo do órgão (reuniões abertas existentes). */
export function avisoDeInclusaoNoGrupo(nome: string, atualizadas: number, comExcecao: number, language: "en" | "pt"): string {
  const pt = language === "pt";
  const base = pt
    ? atualizadas === 0
      ? `${nome} adicionado(a) ao grupo. Nenhuma reunião aberta precisou ser atualizada.`
      : `${nome} adicionado(a) ao grupo e incluído(a) em ${atualizadas} ${atualizadas === 1 ? "reunião aberta" : "reuniões abertas"}.`
    : atualizadas === 0
      ? `${nome} added to the group. No open meeting needed changes.`
      : `${nome} added to the group and to ${atualizadas} open meeting(s).`;
  if (comExcecao === 0) return base;
  return pt
    ? `${base} ${comExcecao} ${comExcecao === 1 ? "reunião continua" : "reuniões continuam"} sem a pessoa, porque ela foi removida antes.`
    : `${base} ${comExcecao} meeting(s) stay without them (removed before).`;
}

export function rotuloDaOrigem(origem: OrigemDaPessoa, language: "en" | "pt"): string {
  if (origem === "cielo") return "Cielo";
  return language === "pt" ? "Externo" : "External";
}

export function rotuloDePessoas(n: number, language: "en" | "pt"): string {
  if (language === "pt") return n === 1 ? "1 pessoa" : `${n} pessoas`;
  return n === 1 ? "1 person" : `${n} people`;
}

/** Quem já está no grupo não é oferecido de novo na busca. */
export function jaNoGrupo(membros: readonly MembroDoGrupo[]): { emails: string[] } {
  return { emails: membros.map((m) => m.email).filter((e): e is string => Boolean(e)) };
}

/** Busca simples por nome (sem acento/caixa) na lista da esquerda. */
export function filtrarPorNome<T extends { name?: string; title?: string }>(itens: readonly T[], termo: string): T[] {
  const norm = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim();
  const alvo = norm(termo);
  return alvo ? itens.filter((i) => norm(i.name ?? i.title ?? "").includes(alvo)) : [...itens];
}

