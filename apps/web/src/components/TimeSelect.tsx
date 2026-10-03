import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock } from "lucide-react";
import { aoTrocarHora, aoTrocarMinuto, decomporHorario, horaDisponivel, HORAS, MINUTOS, combinarHorario } from "../lib/time-options";

/**
 * Seletor de horário do PGCP (substitui o `<input type="time">` nativo).
 *
 * Fechado: mostra o valor "HH:mm". Aberto: duas colunas — HORA (00–23) e
 * MINUTO (00–55, de 5 em 5) —, roláveis de forma independente e abertas no
 * valor atual. Trocar a hora ou o minuto altera o valor na hora; combinações
 * fora de `options` (ex.: Término antes do Início) ficam desabilitadas.
 *
 * Esc fecha só o seletor; clique fora fecha. Escolher o minuto conclui.
 */
interface TimeSelectProps {
  id: string;
  value: string;
  /** Horários permitidos ("HH:mm"); define o que pode ser escolhido. */
  options: readonly string[];
  onChange: (hhmm: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const ITEM =
  "w-full h-8 flex items-center justify-center rounded-lg text-xs tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00658d]/40";

export default function TimeSelect({ id, value, options, onChange, placeholder = "--:--", disabled = false, className = "" }: TimeSelectProps) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const colunaHoras = useRef<HTMLDivElement>(null);
  const colunaMinutos = useRef<HTMLDivElement>(null);
  const atual = decomporHorario(value);

  // Clique fora fecha.
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);

  // Abre no valor atual: hora e minuto selecionados visíveis (centralizados).
  useEffect(() => {
    if (!aberto) return;
    const mostrar = (coluna: HTMLDivElement | null, chave: string | undefined) => {
      const alvo = chave ? coluna?.querySelector<HTMLElement>(`[data-valor="${chave}"]`) : null;
      if (coluna && alvo) coluna.scrollTop = alvo.offsetTop - coluna.clientHeight / 2 + alvo.clientHeight / 2;
    };
    mostrar(colunaHoras.current, atual?.hora);
    mostrar(colunaMinutos.current, atual?.minuto);
  }, [aberto]); // eslint-disable-line react-hooks/exhaustive-deps

  const teclado = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && aberto) {
      // Fecha só o seletor, não o modal que o contém.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setAberto(false);
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !aberto && e.target === e.currentTarget.firstElementChild) {
      e.preventDefault();
      setAberto(true);
    }
  };

  const escolherHora = (hora: string) => {
    const novo = aoTrocarHora(value, hora, options);
    if (novo) onChange(novo);
  };

  const escolherMinuto = (minuto: string) => {
    const novo = aoTrocarMinuto(value, minuto, options);
    if (novo) {
      onChange(novo);
      setAberto(false);
    }
  };

  const classeDaOpcao = (selecionada: boolean, habilitada: boolean) =>
    `${ITEM} ${
      selecionada
        ? "bg-[#00658d] text-white font-bold"
        : habilitada
          ? "text-slate-700 hover:bg-sky-50 hover:text-[#00658d] cursor-pointer"
          : "text-slate-300 cursor-not-allowed"
    }`;

  return (
    <div ref={raiz} className={`relative ${className}`} onKeyDown={teclado}>
      <button
        id={id}
        type="button"
        disabled={disabled || options.length === 0}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}
        className="w-full flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 tabular-nums focus:outline-none focus:ring-1 focus:ring-[#00658d] cursor-pointer disabled:cursor-not-allowed disabled:text-slate-400"
      >
        <span className="inline-flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          {value || <span className="text-slate-400">{placeholder}</span>}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition ${aberto ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {aberto && (
        <div
          role="dialog"
          aria-label="Hora e minuto"
          className="absolute left-0 top-full mt-1 z-50 w-full min-w-[9.5rem] bg-white border border-slate-200 rounded-xl shadow-lg p-1.5"
        >
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                ["HORA", HORAS, colunaHoras, atual?.hora, (h: string) => horaDisponivel(h, options), escolherHora],
                [
                  "MINUTO",
                  MINUTOS,
                  colunaMinutos,
                  atual?.minuto,
                  (m: string) => aoTrocarMinuto(value, m, options) !== null,
                  escolherMinuto
                ]
              ] as const
            ).map(([titulo, valores, ref, selecionado, habilitado, escolher]) => (
              <div key={titulo} className="min-w-0">
                <p className="text-[9px] font-extrabold text-slate-400 tracking-wider text-center pb-1">{titulo}</p>
                <div
                  ref={ref}
                  role="listbox"
                  aria-label={titulo === "HORA" ? "Hora" : "Minuto"}
                  className="relative max-h-[min(12rem,40vh)] overflow-y-auto space-y-0.5 pr-0.5"
                >
                  {valores.map((v) => {
                    const ok = habilitado(v);
                    return (
                      <button
                        key={v}
                        type="button"
                        role="option"
                        data-valor={v}
                        aria-selected={v === selecionado}
                        disabled={!ok}
                        onClick={() => escolher(v)}
                        className={classeDaOpcao(v === selecionado, ok)}
                        title={titulo === "HORA" ? `${v}:${atual?.minuto ?? "00"}` : combinarHorario(atual?.hora ?? "--", v)}
                      >
                        {v}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
