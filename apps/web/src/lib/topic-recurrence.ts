/**
 * RECORRÊNCIA DO TEMA (039). Mesmas opções da recorrência da reunião.
 *
 * Efeito (decidido no servidor): ao CRIAR uma reunião nova do MESMO órgão, o
 * tema entra sozinho, sem pauta, quando a última vez em que esteve numa
 * reunião + o intervalo já chegou. Reuniões já existentes não mudam.
 */

export type RecorrenciaDoTema = "weekly" | "biweekly" | "monthly" | "quarterly";

export const OPCOES_DE_RECORRENCIA: ReadonlyArray<{ value: "" | RecorrenciaDoTema; pt: string; en: string }> = [
  { value: "", pt: "Não se repete", en: "Does not repeat" },
  { value: "weekly", pt: "Semanal", en: "Weekly" },
  { value: "biweekly", pt: "Quinzenal", en: "Biweekly" },
  { value: "monthly", pt: "Mensal", en: "Monthly" },
  { value: "quarterly", pt: "Trimestral", en: "Quarterly" }
];

export function rotuloDaRecorrencia(valor: RecorrenciaDoTema | null | undefined, language: "en" | "pt"): string {
  const o = OPCOES_DE_RECORRENCIA.find((x) => x.value === (valor ?? ""));
  return o ? o[language] : "";
}

/** Valor do <select> ("" = não se repete) → corpo da API (`null`). */
export const recorrenciaParaApi = (valor: string): RecorrenciaDoTema | null =>
  (OPCOES_DE_RECORRENCIA.some((o) => o.value === valor) && valor ? (valor as RecorrenciaDoTema) : null);

export const AJUDA_RECORRENCIA = {
  pt: "Com recorrência, o tema entra automaticamente nas próximas reuniões criadas para este órgão (sem pauta), conforme o intervalo desde a última vez.",
  en: "With a recurrence, the theme is added automatically to the next meetings created for this body (no agenda), based on the interval since the last time."
} as const;
