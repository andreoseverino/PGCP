import { parseDurationMinutes } from "../lib/agenda-time";

/** Passos de 5 minutos — o mesmo grão já usado na Biblioteca. */
const MINUTE_STEPS = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

/** 0 a 12h: cobre qualquer pauta de reunião sem nunca exigir texto livre. */
const MAX_HOURS = 12;

interface DurationHoursMinutesSelectProps {
  language: "en" | "pt";
  /** Duração atual, em qualquer formato aceito por `parseDurationMinutes`. */
  value: string;
  /** Duração escolhida, já convertida para minutos totais. */
  onChangeMinutes: (totalMinutes: number) => void;
  /** Classe aplicada aos dois `<select>` — cada tela mantém o próprio estilo. */
  selectClassName: string;
}

/**
 * Par Horas/Minutos para tempo estimado — substitui o texto livre em toda
 * tela que pede duração. Zero digitação: qualquer valor sai de dois cliques,
 * em passos de 5 minutos.
 */
export default function DurationHoursMinutesSelect({
  language,
  value,
  onChangeMinutes,
  selectClassName
}: DurationHoursMinutesSelectProps) {
  const total = parseDurationMinutes(value, 30);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");

  return (
    <div className="flex gap-2">
      <div className="flex-1">
        <span className="text-[9px] text-slate-400 font-bold uppercase select-none">
          {language === "en" ? "Hours" : "Horas"}
        </span>
        <select
          value={hours}
          onChange={(e) => onChangeMinutes(Number(e.target.value) * 60 + Number(minutes))}
          className={selectClassName}
        >
          {Array.from({ length: MAX_HOURS + 1 }).map((_, i) => {
            const val = String(i).padStart(2, "0");
            return <option key={val} value={val}>{val}</option>;
          })}
        </select>
      </div>
      <div className="flex-1">
        <span className="text-[9px] text-slate-400 font-bold uppercase select-none">
          {language === "en" ? "Minutes" : "Minutos"}
        </span>
        <select
          value={minutes}
          onChange={(e) => onChangeMinutes(Number(hours) * 60 + Number(e.target.value))}
          className={selectClassName}
        >
          {MINUTE_STEPS.map((val) => (
            <option key={val} value={val}>{val}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
