import type { Meeting } from "../types";

/**
 * Calendário ANUAL — cálculo puro (sem React) para a visão de 12 meses e a
 * lista lateral "Reuniões do ano". Datas são as locais da reunião
 * (`Meeting.date`, já convertida no fuso dela por `meetingFromApi`).
 */

export const MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
export const MESES_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MESES_CURTOS_PT = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

export interface MesDoCalendario {
  /** 0 = janeiro. */
  mes: number;
  /** Células de domingo a sábado; `null` = espaço antes do dia 1. */
  dias: Array<{ dia: number; data: string } | null>;
}

const dois = (n: number) => String(n).padStart(2, "0");

/** Os 12 meses do ano. UTC só para aritmética de calendário (sem fuso da máquina). */
export function mesesDoAno(ano: number): MesDoCalendario[] {
  return Array.from({ length: 12 }, (_, mes) => {
    const inicio = new Date(Date.UTC(ano, mes, 1)).getUTCDay();
    const total = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    const dias: MesDoCalendario["dias"] = Array.from({ length: inicio }, () => null);
    for (let d = 1; d <= total; d++) dias.push({ dia: d, data: `${ano}-${dois(mes + 1)}-${dois(d)}` });
    return { mes, dias };
  });
}

/** Reuniões do ano, cronológicas (data, início, título). Manuais e da Agenda Anual juntas. */
export function reunioesDoAno<T extends Pick<Meeting, "date" | "startTime" | "title">>(
  meetings: readonly T[],
  ano: number
): T[] {
  const prefixo = `${ano}-`;
  return meetings
    .filter((m) => m.date.startsWith(prefixo))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title)
    );
}

export function reunioesPorDia<T extends Pick<Meeting, "date">>(meetings: readonly T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const m of meetings) mapa.set(m.date, [...(mapa.get(m.date) ?? []), m]);
  return mapa;
}

/** "20 JAN" — rótulo compacto da lista lateral. */
export function rotuloCurto(data: string, language: "en" | "pt"): string {
  const mes = Number(data.slice(5, 7)) - 1;
  const nome = language === "pt" ? MESES_CURTOS_PT[mes] : MESES_EN[mes]!.slice(0, 3).toUpperCase();
  return `${data.slice(8, 10)} ${nome}`;
}

/** Data sugerida para Nova reunião: dia destacado, senão hoje (se no ano), senão 1º dia útil do ano. */
export function dataSugerida(ano: number, hoje: string, destacado: string | null): string {
  if (destacado?.startsWith(`${ano}-`)) return destacado;
  if (hoje.startsWith(`${ano}-`)) return hoje;
  return `${ano}-01-02`;
}
