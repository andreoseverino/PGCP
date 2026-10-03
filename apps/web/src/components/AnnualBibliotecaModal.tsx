import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Search, Users, X } from "lucide-react";
import DurationHoursMinutesSelect from "./DurationHoursMinutesSelect";
import { formatMinutesAsTime } from "../lib/agenda-time";
import { filtrarBiblioteca, type TemaDaBibliotecaResumo } from "../lib/annual-agenda-rules";

/**
 * "Adicionar da Biblioteca" — SÓ seleção de tema já cadastrado. Busca local
 * (a lista já está carregada), resumo para a escolha e, escolhido, duração
 * (sugerida pelo tema-mestre) e pauta (com duas ou mais). Não cria, não edita
 * e não exclui tema da Biblioteca; o servidor copia ficha e participantes do
 * tema-mestre pela regra já existente.
 */
interface Props {
  language: "en" | "pt";
  ocupado: boolean;
  temas: readonly TemaDaBibliotecaResumo[];
  pautas: ReadonlyArray<{ id: string; title: string }>;
  onCancel: () => void;
  onAdd: (dados: { agendaTopicId: string; durationMinutes: number; agendaId?: string }) => void;
}

export default function AnnualBibliotecaModal({ language, ocupado, temas, pautas, onCancel, onAdd }: Props) {
  const pt = language === "pt";
  const [busca, setBusca] = useState("");
  const [escolhido, setEscolhido] = useState<TemaDaBibliotecaResumo | null>(null);
  const [minutos, setMinutos] = useState(30);
  const [pautaId, setPautaId] = useState(pautas[0]?.id ?? "");
  const visiveis = useMemo(() => filtrarBiblioteca(temas, busca), [temas, busca]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ocupado) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ocupado, onCancel]);

  const escolher = (t: TemaDaBibliotecaResumo) => {
    setEscolhido(t);
    if (t.durationMinutes) setMinutos(t.durationMinutes);
  };

  return createPortal(
    <div className="fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6">
      <div role="dialog" aria-modal="true" aria-labelledby="annual-biblioteca-titulo"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden animate-fade-in">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 shrink-0">
          <h3 id="annual-biblioteca-titulo" className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-[#00658d]" />{pt ? "Adicionar da Biblioteca" : "Add from Library"}
          </h3>
          <button type="button" onClick={onCancel} disabled={ocupado} className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer" aria-label={pt ? "Fechar" : "Close"}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          {temas.length === 0 ? (
            <p className="text-[11px] text-slate-500 font-semibold bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-center">
              {pt
                ? "Nenhum Tema cadastrado na Biblioteca. Use “+ Novo tema” para cadastrar um tema desta reunião."
                : "No topics in the Library. Use “+ New topic” to create one for this meeting."}
            </p>
          ) : (
            <>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} aria-label={pt ? "Buscar tema" : "Search topic"}
                  placeholder={pt ? "Buscar tema..." : "Search topic..."}
                  className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#00658d]" />
              </div>
              <ul role="listbox" aria-label={pt ? "Temas da Biblioteca" : "Library topics"} className="space-y-1.5">
                {visiveis.length === 0 && <li className="text-[11px] text-slate-400 font-semibold text-center py-3">{pt ? "Nenhum tema encontrado." : "No topics found."}</li>}
                {visiveis.map((t) => (
                  <li key={t.id}>
                    <button type="button" role="option" aria-selected={escolhido?.id === t.id} onClick={() => escolher(t)}
                      className={`w-full text-left rounded-xl border px-3 py-2 transition cursor-pointer ${
                        escolhido?.id === t.id ? "border-[#00658d] bg-sky-50/70 ring-1 ring-[#00658d]/30" : "border-slate-100 hover:border-slate-300 hover:bg-slate-50"
                      }`}>
                      <p className="text-[12px] font-bold text-slate-800 truncate">{t.title}</p>
                      <p className="text-[10px] text-slate-500 font-semibold flex flex-wrap gap-x-1.5">
                        {[t.natureza, t.tipo, t.durationMinutes ? `${t.durationMinutes} min` : null, t.responsavel].filter(Boolean).join(" · ")}
                        {t.participantes ? <span className="inline-flex items-center gap-0.5"><Users className="w-3 h-3" />{t.participantes}</span> : null}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {escolhido && (
            <div className="border-t border-slate-100 pt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">{pt ? "Duração nesta reunião" : "Duration"} *</span>
                <DurationHoursMinutesSelect language={language} value={formatMinutesAsTime(minutos)} onChangeMinutes={setMinutos}
                  selectClassName="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 outline-none cursor-pointer focus:ring-1 focus:ring-[#00658d]" />
              </div>
              {pautas.length > 1 && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="annualBibliotecaPauta" className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">{pt ? "Pauta" : "Agenda"}</label>
                  <select id="annualBibliotecaPauta" value={pautaId} onChange={(e) => setPautaId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs cursor-pointer">
                    {pautas.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0">
          <button type="button" onClick={onCancel} disabled={ocupado} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer">
            {pt ? "Cancelar" : "Cancel"}
          </button>
          <button type="button" disabled={ocupado || !escolhido || minutos < 1}
            onClick={() => escolhido && onAdd({ agendaTopicId: escolhido.id, durationMinutes: minutos, ...(pautas.length > 1 && pautaId ? { agendaId: pautaId } : {}) })}
            className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer disabled:opacity-50">
            {pt ? "Adicionar à reunião" : "Add to meeting"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
