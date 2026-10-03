/**
 * CRONOGRAMA DOS TEMAS — mesma regra de `apps/api/src/meetings/schedule.ts`.
 *
 * Ordem = posição global na reunião; cada tema começa quando o anterior
 * termina, a partir do início da reunião. Tema sem duração recebe início e
 * fica sem término (não vira 0 em silêncio). Usado pela Agenda Anual e pelo
 * Pipeline — uma regra só.
 */

export interface TemaNoCronograma {
  id: string;
  durationMinutes: number | null;
}

export interface HorarioDoTema {
  id: string;
  inicio: string;
  fim: string | null;
}

export function minutosDoDia(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

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

export function tempoDaReuniao(reuniaoMin: number, temas: readonly TemaNoCronograma[]) {
  const temasMin = temas.reduce((s, t) => s + (t.durationMinutes ?? 0), 0);
  const semDuracao = temas.filter((t) => t.durationMinutes === null || t.durationMinutes === undefined).length;
  return {
    reuniaoMin,
    temasMin,
    semDuracao,
    excessoMin: Math.max(0, temasMin - reuniaoMin),
    disponivelMin: Math.max(0, reuniaoMin - temasMin)
  };
}
