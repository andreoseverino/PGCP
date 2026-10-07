import { papelPadraoDoParticipante } from "./participants";
import type { MembroDoGrupo } from "./participation-groups-rules";

/**
 * Participantes do GRUPO DO ÓRGÃO como ponto de partida da lista da reunião.
 *
 * A lista da reunião é independente do cadastro do órgão: carregar o grupo
 * COPIA as pessoas para o formulário; remover/adicionar ali nunca mexe no
 * grupo (Administração). O servidor confere tudo de novo (duplicidade,
 * identidade, regras de responsável) — esta camada é só a experiência.
 */

/** O mínimo para dizer quem é a pessoa na lista do convite. */
export interface ConvidadoRef {
  name: string;
  entraObjectId?: string;
  email?: string;
  /** Veio do grupo do órgão (só UX: selo "Do órgão"). */
  doOrgao?: boolean;
}

/** Chave de identidade: `oid` do Entra; sem ele, o e-mail (externo); sem os dois, o nome. */
export function chaveDoConvidado(p: Pick<ConvidadoRef, "name" | "entraObjectId" | "email">): string {
  if (p.entraObjectId?.trim()) return `oid:${p.entraObjectId.trim().toLowerCase()}`;
  if (p.email?.trim()) return `mail:${p.email.trim().toLowerCase()}`;
  return `nome:${p.name.trim().toLowerCase()}`;
}

/** Já está na lista? Mesma pessoa pelo `oid` OU pelo mesmo e-mail (externo repetido). */
export function jaNaLista(lista: readonly ConvidadoRef[], alvo: ConvidadoRef): boolean {
  const chave = chaveDoConvidado(alvo);
  const email = alvo.email?.trim().toLowerCase();
  return lista.some((p) => chaveDoConvidado(p) === chave || (Boolean(email) && p.email?.trim().toLowerCase() === email));
}

export const MSG_JA_PARTICIPA = {
  pt: "Este participante já faz parte da reunião.",
  en: "This participant is already in the meeting."
} as const;

/** Membros do grupo → convidados da reunião (marcados "do órgão"). */
export function convidadosDoGrupo(membros: readonly MembroDoGrupo[], language: "en" | "pt") {
  return membros
    .filter((m) => m.nome.trim().length > 0)
    .map((m) => ({
      name: m.nome,
      role: papelPadraoDoParticipante(language),
      confirmed: false,
      entraObjectId: m.origem === "cielo" ? m.entraObjectId ?? undefined : undefined,
      email: m.email ?? undefined,
      doOrgao: true as const
    }));
}

/** Acrescenta sem duplicar (identidade ou e-mail). Quem já está fica como está. */
export function somarSemDuplicar<T extends ConvidadoRef>(atual: readonly T[], novos: readonly T[]): T[] {
  const lista = [...atual];
  for (const n of novos) if (!jaNaLista(lista, n)) lista.push(n);
  return lista;
}

/**
 * A lista ainda é EXATAMENTE a que veio do grupo (ninguém removido, ninguém
 * adicionado)? Ordem não importa. Lista intocada pode ser trocada sem perguntar.
 */
export function listaIntocada(atual: readonly ConvidadoRef[], automatica: readonly ConvidadoRef[] | null): boolean {
  if (!automatica) return atual.length === 0;
  const a = atual.map(chaveDoConvidado).sort();
  const b = automatica.map(chaveDoConvidado).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Escolha/troca de órgão na NOVA reunião:
 *   primeiro órgão (nenhum grupo aplicado)  → soma o grupo ao que já está (ex.: organizador);
 *   lista intocada desde o último grupo     → substitui pelo grupo do novo órgão, sem perguntar;
 *   lista ajustada à mão                    → pergunta antes (substituir a lista inteira).
 */
export function acaoNaTrocaDeOrgao(
  atual: readonly ConvidadoRef[],
  automatica: readonly ConvidadoRef[] | null
): "somar" | "substituir" | "confirmar" {
  if (!automatica) return "somar";
  return listaIntocada(atual, automatica) ? "substituir" : "confirmar";
}
