/**
 * CRONOGRAMA DOS TEMAS — fonte única do cálculo de horários (API).
 *
 * Ordem = `meeting_agenda_items.position`, que é GLOBAL na reunião (a mesma
 * do Pipeline). Cada tema começa quando o anterior termina, a partir do início
 * da reunião; a duração é `duration_minutes`.
 *
 * Tema SEM duração não vira 0 em silêncio: recebe início, fica sem término e
 * é contado em `semDuracao` — o envio para aprovação exige duração em todos.
 *
 * Espelhado em `web/src/lib/agenda-schedule.ts` (mesmos exemplos nos testes).
 */

export interface TemaNoCronograma {
  id: string;
  durationMinutes: number | null;
}

export interface HorarioDoTema {
  id: string;
  inicio: string;
  /** `null` quando o tema não tem duração. */
  fim: string | null;
}

export interface TempoDaReuniao {
  reuniaoMin: number;
  temasMin: number;
  semDuracao: number;
  /** > 0 = a pauta ultrapassa a reunião. */
  excessoMin: number;
  disponivelMin: number;
}

/** "HH:mm" -> minutos do dia. */
export function minutosDoDia(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutos -> "HH:mm" (passa da meia-noite volta a 00:00). */
export function hhmm(minutos: number): string {
  const total = ((Math.round(minutos) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function cronogramaDosTemas(inicioReuniao: string, temas: readonly TemaNoCronograma[]): HorarioDoTema[] {
  let atual = minutosDoDia(inicioReuniao);
  return temas.map((t) => {
    const inicio = hhmm(atual);
    if (t.durationMinutes === null || t.durationMinutes === undefined) return { id: t.id, inicio, fim: null };
    atual += t.durationMinutes;
    return { id: t.id, inicio, fim: hhmm(atual) };
  });
}

/** Soma dos temas x janela da reunião (`fim - início`, em minutos). */
export function tempoDaReuniao(reuniaoMin: number, temas: readonly TemaNoCronograma[]): TempoDaReuniao {
  const temasMin = temas.reduce((s, t) => s + (t.durationMinutes ?? 0), 0);
  const semDuracao = temas.filter((t) => t.durationMinutes === null || t.durationMinutes === undefined).length;
  return {
    reuniaoMin,
    temasMin,
    semDuracao,
    excessoMin: Math.max(0, temasMin - reuniaoMin),
    disponivelMin: Math.max(0, reuniaoMin - temasMin),
  };
}
