import type { AgendaItem } from "../types";

/**
 * Remoção de participante — textos da CONFIRMAÇÃO (lógica pura, testável).
 *
 *   Remover do tema      só o vínculo com aquele tema; segue na reunião e nos
 *                        demais temas
 *   Remover da reunião   sai da reunião e, por consequência, de todos os temas
 *
 * Nenhuma das duas apaga o cadastro de participante externo do PGCP. A
 * confirmação é UX: quem aplica a regra, sobre o estado atual do banco, é o
 * backend.
 */

export interface ConfirmacaoRemocao {
  titulo: string;
  paragrafos: string[];
  /** Temas afetados (só na remoção da reunião). Vazio = não exibir lista. */
  temas: string[];
  /** Rótulo do botão que executa. */
  acao: string;
}

/**
 * Temas da reunião em que a pessoa está vinculada — a MESMA relação que o
 * detalhe da reunião já traz (`agendaItems[].participants`, de
 * `meeting_agenda_item_participants`). Sem segunda regra no frontend.
 */
export function temasDoParticipante(
  agenda: readonly Pick<AgendaItem, "title" | "participants">[],
  participantId: string
): string[] {
  return agenda
    .filter((tema) => (tema.participants ?? []).some((p) => p.participantId === participantId))
    .map((tema) => tema.title);
}

export function confirmacaoRemoverDoTema(
  nome: string,
  tema: string,
  language: "en" | "pt"
): ConfirmacaoRemocao {
  if (language === "en") {
    return {
      titulo: "Remove participant from this topic?",
      paragrafos: [
        `${nome} will be removed only from the topic "${tema}".`,
        "They will remain a meeting participant and stay in any other topics they are linked to."
      ],
      temas: [],
      acao: "Remove from topic"
    };
  }
  return {
    titulo: "Remover participante deste tema?",
    paragrafos: [
      `${nome} será removido(a) somente do tema "${tema}".`,
      "Continuará como participante da reunião e permanecerá nos demais temas aos quais estiver vinculado(a)."
    ],
    temas: [],
    acao: "Remover do tema"
  };
}

export function confirmacaoRemoverDaReuniao(
  nome: string,
  temas: readonly string[],
  language: "en" | "pt"
): ConfirmacaoRemocao {
  const pt = language === "pt";
  const cadastro = pt
    ? "O cadastro da pessoa no PGCP não será excluído."
    : "The person's PGCP record will not be deleted.";
  const impacto =
    temas.length > 0
      ? pt
        ? `${nome} será removido(a) desta reunião e também deixará de participar dos seguintes temas:`
        : `${nome} will be removed from this meeting and from the following topics:`
      : pt
        ? `${nome} será removido(a) desta reunião. Atualmente não está vinculado(a) a nenhum tema desta reunião.`
        : `${nome} will be removed from this meeting. They are not linked to any topic of this meeting.`;
  return {
    titulo: pt ? "Remover participante da reunião?" : "Remove participant from the meeting?",
    paragrafos: [impacto, cadastro],
    temas: [...temas],
    acao: pt ? "Remover da reunião" : "Remove from meeting"
  };
}
