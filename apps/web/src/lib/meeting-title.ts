/**
 * TÍTULO PADRONIZADO da reunião — PRÉVIA na tela.
 *
 *   09:00 | Cielo | Reunião Extraordinária do Comitê de Riscos (PRESENCIAL)
 *
 * Espelho de `apps/api/src/meetings/title.ts`: quem grava o título é o
 * servidor (a partir de hora, órgão, formato e tipo); aqui só se mostra antes
 * de salvar. Os testes dos dois lados usam os mesmos exemplos.
 */

export type SessionType = "ordinary" | "extraordinary";

export const EMPRESA_DO_TITULO = "Cielo";

export const SESSION_TYPE_OPTIONS: ReadonlyArray<{ id: SessionType; pt: string; en: string }> = [
  { id: "ordinary", pt: "Ordinária", en: "Ordinary" },
  { id: "extraordinary", pt: "Extraordinária", en: "Extraordinary" }
];

/** "do"/"da" pelo primeiro substantivo do órgão (Diretoria -> da; Comitê -> do). */
export function preposicaoDoOrgao(nome: string): "do" | "da" {
  const primeira = nome.trim().split(/\s+/)[0]?.toLocaleLowerCase("pt-BR") ?? "";
  return /(a|ão|ade|ção|são)$/.test(primeira) ? "da" : "do";
}

/** `startTime` já é a hora local (HH:mm) escolhida no formulário. */
export function montarTituloDaReuniao(dados: {
  startTime: string;
  orgao: string;
  tipo: SessionType;
  modalidade: "online" | "in_person";
}): string {
  const orgao = dados.orgao.trim();
  const tipo = dados.tipo === "extraordinary" ? "Extraordinária" : "Ordinária";
  const formato = dados.modalidade === "in_person" ? "PRESENCIAL" : "VIDEOCONFERÊNCIA";
  return `${dados.startTime} | ${EMPRESA_DO_TITULO} | Reunião ${tipo} ${preposicaoDoOrgao(orgao)} ${orgao} (${formato})`;
}

/** Prévia ou `null` enquanto falta campo. */
export function previaDoTitulo(dados: {
  startTime: string;
  orgao: string | undefined;
  tipo: SessionType | "" | null | undefined;
  modalidade: "online" | "in_person";
}): string | null {
  if (!dados.startTime || !dados.orgao || !dados.tipo) return null;
  return montarTituloDaReuniao({ startTime: dados.startTime, orgao: dados.orgao, tipo: dados.tipo, modalidade: dados.modalidade });
}
