/**
 * Estados visuais de um dia do Quadro Mensal da Visão Geral.
 *
 * "Hoje" e "dia selecionado" são DOIS canais independentes, e é isso que este
 * módulo garante: o fundo azul continua sendo o mapa de calor de reuniões, a
 * BORDA marca o dia de hoje e o ANEL marca a seleção. Selecionar o dia 15 não
 * pode apagar a marca do dia 28 — antes, "hoje" era só um sublinhado no número
 * e sumia sob os estilos de dia com reunião.
 *
 * Função pura para que a regra seja afirmável sem montar React.
 */

export interface CalendarDayInput {
  /** Dia da célula, em `AAAA-MM-DD` local. */
  dateStr: string;
  /** Hoje, no mesmo formato. */
  todayStr: string;
  /** Dia selecionado, ou `null`. */
  selectedDayStr: string | null;
  /** Quantidade de reuniões do PGCP no dia. Alimenta o mapa de calor. */
  meetingCount: number;
}

export interface CalendarDayState {
  isToday: boolean;
  isSelected: boolean;
  /** Classes da célula: fundo (mapa de calor) + borda (hoje) + anel (seleção). */
  className: string;
}

/** Fundo do dia conforme o volume de reuniões. Preserva o mapa de calor existente. */
function heatmapClasses(meetingCount: number, isSelected: boolean): string {
  if (meetingCount <= 0) {
    return isSelected
      ? "bg-slate-100 text-slate-900 font-bold"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900";
  }
  if (meetingCount === 1) return "bg-blue-50 text-blue-700 hover:bg-blue-100/80";
  if (meetingCount === 2) return "bg-blue-100 text-blue-800 hover:bg-blue-200/80";
  if (meetingCount === 3) return "bg-blue-300 text-blue-950 font-extrabold hover:bg-blue-400/80";
  return "bg-blue-600 text-white font-extrabold hover:bg-blue-700";
}

export function calendarDayState({
  dateStr,
  todayStr,
  selectedDayStr,
  meetingCount
}: CalendarDayInput): CalendarDayState {
  const isToday = dateStr === todayStr;
  const isSelected = selectedDayStr !== null && selectedDayStr === dateStr;

  const classes = [heatmapClasses(meetingCount, isSelected)];

  // Canal 1 — HOJE: borda interna da cor institucional. Sempre presente,
  // esteja o dia selecionado ou não.
  classes.push(isToday ? "border-2 border-[#00658d]" : "border border-transparent");

  // Canal 2 — SELEÇÃO: anel externo. Convive com a borda de hoje sem escondê-la.
  if (isSelected) {
    classes.push(
      meetingCount > 0
        ? "ring-2 ring-blue-500 ring-offset-1 z-10"
        : "ring-2 ring-slate-400 ring-offset-1 z-10"
    );
  }

  return { isToday, isSelected, className: classes.join(" ") };
}
