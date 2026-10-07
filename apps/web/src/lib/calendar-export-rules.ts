/**
 * Regras PURAS da exportação do Calendário (testáveis sem rede). O cliente
 * HTTP fica em `calendar-export.ts`.
 */

export type FormatoDeExportacao = "pdf" | "xlsx";

export interface FiltrosDaExportacao {
  formato: FormatoDeExportacao;
  /** `todo` = calendário completo; `periodo` = intervalo de datas. */
  abrangencia: "todo" | "periodo";
  dateFrom?: string;
  dateTo?: string;
  /** Órgão do contexto global ("" = todos). */
  governanceBodyId?: string;
}

/** Primeiro problema dos filtros, ou `null`. O servidor revalida. */
export function validarExportacao(f: FiltrosDaExportacao, language: "en" | "pt"): string | null {
  const pt = language === "pt";
  if (f.abrangencia === "periodo") {
    if (!f.dateFrom || !f.dateTo) return pt ? "Informe a data inicial e a final." : "Enter start and end dates.";
    if (f.dateFrom > f.dateTo) return pt ? "A data inicial não pode ser depois da final." : "Start date must not be after end date.";
  }
  return null;
}

/** Query string fechada: só os parâmetros que o servidor aceita. */
export function consultaDaExportacao(f: FiltrosDaExportacao): string {
  const q = new URLSearchParams({ format: f.formato });
  if (f.abrangencia === "periodo") {
    if (f.dateFrom) q.set("dateFrom", f.dateFrom);
    if (f.dateTo) q.set("dateTo", f.dateTo);
  }
  if (f.governanceBodyId) q.set("governanceBodyId", f.governanceBodyId);
  return q.toString();
}
