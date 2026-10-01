import React, { useMemo, useState } from "react";
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, MapPin, MonitorSmartphone } from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import GovernanceBodyFilter from "./GovernanceBodyFilter";
import { filtrarPorOrgao, TODOS_OS_ORGAOS } from "../lib/governance-filter";
import { DEFAULT_TIMEZONE, instantToLocal } from "../lib/meetings";
import { originLabel } from "../lib/pipeline";
import {
  dataSugerida,
  MESES_EN,
  MESES_PT,
  mesesDoAno,
  reunioesDoAno,
  reunioesPorDia,
  rotuloCurto
} from "../lib/annual-calendar";

/**
 * CALENDÁRIO — visão ANUAL. Único ponto com "Nova reunião".
 *
 * Área principal: os 12 meses do ano selecionado, com os dias que têm reunião
 * destacados. Coluna lateral: Nova reunião + "Reuniões de AAAA", cronológicas.
 *
 * O Calendário só VISUALIZA, CRIA e LEVA à reunião: clicar numa reunião abre
 * o detalhe no Pipeline (mesma tela de preparação), sem edição paralela aqui.
 */

interface CalendarViewProps {
  language: "en" | "pt";
  meetings: Meeting[];
  meetingsLoading: boolean;
  /** Opções do filtro "Órgão colegiado". */
  governanceBodies: GovernanceBody[];
  /** Mostra "Nova reunião". Cortesia: o servidor exige `PGCP.Assessoria`. */
  canSchedule: boolean;
  onNewMeeting: (date: string) => void;
  /** Abre a reunião no Pipeline. */
  onMeetingClick: (meeting: Meeting) => void;
}

const SEMANA_PT = ["D", "S", "T", "Q", "Q", "S", "S"];
const SEMANA_EN = ["S", "M", "T", "W", "T", "F", "S"];

function corDoDia(qtde: number, destacado: boolean): string {
  if (destacado) return "bg-[#00658d] text-white font-extrabold";
  if (qtde === 0) return "text-slate-500";
  if (qtde === 1) return "bg-sky-100 text-[#00658d] font-extrabold";
  return "bg-sky-300 text-[#001e2d] font-extrabold";
}

export default function CalendarView({
  language,
  meetings,
  meetingsLoading,
  governanceBodies,
  canSchedule,
  onNewMeeting,
  onMeetingClick
}: CalendarViewProps) {
  const pt = language === "pt";
  const hoje = instantToLocal(new Date().toISOString(), DEFAULT_TIMEZONE).date;
  const [ano, setAno] = useState(() => Number(hoje.slice(0, 4)));
  const [destacado, setDestacado] = useState<string | null>(null);
  const [orgao, setOrgao] = useState(TODOS_OS_ORGAOS);

  const meses = useMemo(() => mesesDoAno(ano), [ano]);
  // Filtro por órgão ANTES de tudo: dias destacados, lista e contador derivam
  // do mesmo conjunto — nada escondido pelo filtro continua marcado.
  const doAno = useMemo(() => reunioesDoAno(filtrarPorOrgao(meetings, orgao), ano), [meetings, orgao, ano]);
  const porDia = useMemo(() => reunioesPorDia(doAno), [doAno]);

  const mudarAno = (delta: number) => {
    setAno((a) => a + delta);
    setDestacado(null);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-extrabold text-[#001e2d] flex items-center gap-2">
          <CalendarDays className="w-6 h-6 text-[#00658d]" />
          {pt ? "Calendário" : "Calendar"}
        </h2>
        <p className="text-xs text-slate-500 font-medium mt-1">
          {pt
            ? "Visão anual das reuniões. Agende aqui; a preparação (pautas e temas) acontece no Pipeline."
            : "Yearly view of meetings. Schedule here; preparation happens in the Pipeline."}
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6 items-start">
        <section className="bg-white border border-slate-200 rounded-2xl p-4 md:p-5 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
          <div className="sm:w-56">
            <GovernanceBodyFilter
              language={language}
              id="calendario-orgao"
              governanceBodies={governanceBodies}
              value={orgao}
              onChange={(id) => {
                setOrgao(id);
                setDestacado(null);
              }}
            />
          </div>
          <div className="flex items-center justify-center gap-6">
            <button type="button" onClick={() => mudarAno(-1)} aria-label={pt ? "Ano anterior" : "Previous year"}
              className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h3 className="text-2xl font-extrabold text-[#001e2d] tabular-nums" aria-live="polite">{ano}</h3>
            <button type="button" onClick={() => mudarAno(1)} aria-label={pt ? "Próximo ano" : "Next year"}
              className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <div className="hidden sm:block sm:w-56" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {meses.map(({ mes, dias }) => (
              <div key={mes} className="border border-slate-100 rounded-xl p-3" data-mes={mes}>
                <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-slate-700 mb-2">
                  {(pt ? MESES_PT : MESES_EN)[mes]}
                </h4>
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {(pt ? SEMANA_PT : SEMANA_EN).map((d, i) => (
                    <span key={i} className="text-[8.5px] font-bold text-slate-300">{d}</span>
                  ))}
                  {dias.map((c, i) => {
                    if (!c) return <span key={`v${i}`} />;
                    const lista = porDia.get(c.data) ?? [];
                    const ehHoje = c.data === hoje;
                    return (
                      <button
                        key={c.data}
                        type="button"
                        disabled={lista.length === 0}
                        onClick={() => setDestacado(destacado === c.data ? null : c.data)}
                        title={lista.map((m) => `${m.startTime} ${m.title}`).join(" • ") || undefined}
                        aria-label={lista.length ? `${c.data}: ${lista.length} ${pt ? "reunião(ões)" : "meeting(s)"}` : undefined}
                        className={`h-6 text-[10px] rounded-md tabular-nums ${corDoDia(lista.length, destacado === c.data)} ${
                          ehHoje ? "ring-1 ring-[#00658d]" : ""
                        } ${lista.length ? "cursor-pointer hover:ring-1 hover:ring-[#00aeef]" : "cursor-default"}`}
                      >
                        {c.dia}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {meetingsLoading && (
            <p className="text-[11px] text-slate-400 font-semibold mt-3">{pt ? "Carregando reuniões..." : "Loading meetings..."}</p>
          )}
        </section>

        <aside className="bg-white border border-slate-200 rounded-2xl p-4 space-y-4 xl:sticky xl:top-4">
          {canSchedule && (
            <button
              type="button"
              onClick={() => onNewMeeting(dataSugerida(ano, hoje, destacado))}
              className="w-full px-4 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center justify-center gap-2 shadow-sm cursor-pointer"
            >
              <CalendarPlus className="w-4 h-4" />
              {pt ? "Nova reunião" : "New meeting"}
            </button>
          )}

          <div className="border-b border-slate-100 pb-2">
            <h3 className="text-sm font-extrabold text-slate-800">{pt ? `Reuniões de ${ano}` : `Meetings in ${ano}`}</h3>
            <p className="text-[11px] text-slate-500 font-semibold">
              {doAno.length} {pt ? (doAno.length === 1 ? "reunião" : "reuniões") : doAno.length === 1 ? "meeting" : "meetings"}
            </p>
          </div>

          {doAno.length === 0 ? (
            <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Nenhuma reunião neste ano." : "No meetings this year."}</p>
          ) : (
            <ul className="space-y-1.5 max-h-[70vh] overflow-y-auto pr-1">
              {doAno.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onMeetingClick(m)}
                    title={pt ? "Abrir no Pipeline" : "Open in Pipeline"}
                    className={`w-full text-left flex gap-3 p-2 rounded-xl border cursor-pointer transition ${
                      destacado === m.date ? "border-[#00658d] bg-sky-50/60" : "border-transparent hover:bg-slate-50"
                    }`}
                  >
                    <span className="w-12 shrink-0 text-center text-[10px] font-extrabold text-[#00658d] leading-tight pt-0.5 tabular-nums">
                      {rotuloCurto(m.date, language)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-extrabold text-slate-800 truncate">{m.title}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-slate-500 font-semibold">
                        {m.startTime} - {m.endTime}
                        {m.modality === "in_person"
                          ? <MapPin className="w-3 h-3" aria-label={pt ? "Presencial" : "In person"} />
                          : <MonitorSmartphone className="w-3 h-3" aria-label="Online" />}
                      </span>
                      <span className="block text-[10px] text-slate-400 font-semibold truncate">
                        {m.category}
                        {m.origin === "annual_agenda" ? ` · ${originLabel(m.origin, language)}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
