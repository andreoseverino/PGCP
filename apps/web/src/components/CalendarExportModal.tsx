import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileSpreadsheet, FileText, X } from "lucide-react";
import { describeMeetingError } from "../lib/meetings";
import { exportarCalendario, validarExportacao, type FiltrosDaExportacao, type FormatoDeExportacao } from "../lib/calendar-export";

/**
 * Exportar o Calendário em PDF ou Excel. Filtros: período (todo o calendário
 * ou intervalo) + o órgão do CONTEXTO GLOBAL — o mesmo recorte da tela.
 */

interface CalendarExportModalProps {
  language: "en" | "pt";
  /** Órgão do contexto global ("" = todos). */
  governanceBodyId: string;
  nomeDoOrgao: string | null;
  /** Ano exibido no Calendário: sugere o intervalo. */
  ano: number;
  onClose: () => void;
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";

export default function CalendarExportModal({ language, governanceBodyId, nomeDoOrgao, ano, onClose }: CalendarExportModalProps) {
  const pt = language === "pt";
  const [filtros, setFiltros] = useState<FiltrosDaExportacao>({
    formato: "pdf",
    abrangencia: "todo",
    dateFrom: `${ano}-01-01`,
    dateTo: `${ano}-12-31`,
    governanceBodyId
  });
  const [exportando, setExportando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const exportar = async () => {
    const problema = validarExportacao(filtros, language);
    setErro(problema);
    if (problema || exportando) return;
    setExportando(true);
    try {
      await exportarCalendario(filtros);
      onClose();
    } catch (error) {
      setErro(describeMeetingError(error, language));
    } finally {
      setExportando(false);
    }
  };

  const formatos: Array<{ id: FormatoDeExportacao; rotulo: string; Icone: typeof FileText }> = [
    { id: "pdf", rotulo: "PDF", Icone: FileText },
    { id: "xlsx", rotulo: "Excel (.xlsx)", Icone: FileSpreadsheet }
  ];

  // Portal no <body>: centralizado na VIEWPORT, independente de ancestral com
  // transform/backdrop-filter (mesmo padrão do modal Nova reunião).
  return createPortal(
    <div className="fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="exportar-calendario-titulo" className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 id="exportar-calendario-titulo" className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
            <Download className="w-4 h-4 text-[#00658d]" />
            {pt ? "Exportar calendário" : "Export calendar"}
          </h3>
          <button type="button" onClick={onClose} aria-label={pt ? "Fechar" : "Close"} className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-xs">
          <fieldset className="space-y-1.5">
            <legend className={LABEL}>{pt ? "Formato" : "Format"}</legend>
            <div className="grid grid-cols-2 gap-2">
              {formatos.map(({ id, rotulo, Icone }) => (
                <label
                  key={id}
                  className={`flex items-center gap-2 border rounded-xl px-3 py-2 cursor-pointer font-bold ${
                    filtros.formato === id ? "border-[#00658d] bg-sky-50 text-[#00658d]" : "border-slate-200 text-slate-600"
                  }`}
                >
                  <input
                    type="radio"
                    name="formato"
                    value={id}
                    checked={filtros.formato === id}
                    onChange={() => setFiltros((f) => ({ ...f, formato: id }))}
                    className="sr-only"
                  />
                  <Icone className="w-4 h-4" />
                  {rotulo}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className={LABEL}>{pt ? "Período" : "Period"}</legend>
            <label className="flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
              <input type="radio" name="abrangencia" checked={filtros.abrangencia === "todo"} onChange={() => setFiltros((f) => ({ ...f, abrangencia: "todo" }))} />
              {pt ? "Todo o calendário" : "Whole calendar"}
            </label>
            <label className="flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
              <input type="radio" name="abrangencia" checked={filtros.abrangencia === "periodo"} onChange={() => setFiltros((f) => ({ ...f, abrangencia: "periodo" }))} />
              {pt ? "Intervalo de datas" : "Date range"}
            </label>
            {filtros.abrangencia === "periodo" && (
              <div className="grid grid-cols-2 gap-2 pl-5">
                <div className="flex flex-col gap-1">
                  <label htmlFor="expDe" className={LABEL}>{pt ? "De" : "From"}</label>
                  <input id="expDe" type="date" value={filtros.dateFrom} onChange={(e) => setFiltros((f) => ({ ...f, dateFrom: e.target.value }))} className={INPUT} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="expAte" className={LABEL}>{pt ? "Até" : "To"}</label>
                  <input id="expAte" type="date" value={filtros.dateTo} onChange={(e) => setFiltros((f) => ({ ...f, dateTo: e.target.value }))} className={INPUT} />
                </div>
              </div>
            )}
          </fieldset>

          <p className="text-[10px] text-slate-500 font-semibold">
            {pt ? "Órgão de governança" : "Governance body"}: <strong>{nomeDoOrgao ?? (pt ? "Todos" : "All")}</strong>
            {pt ? " (contexto selecionado no topo)." : " (selected at the top)."}
          </p>

          {erro && (
            <p role="alert" className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{erro}</p>
          )}
        </div>

        <div className="bg-slate-50 px-5 py-3 flex justify-end gap-2 border-t border-slate-100 rounded-b-2xl">
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-xl cursor-pointer">
            {pt ? "Cancelar" : "Cancel"}
          </button>
          <button
            type="button"
            disabled={exportando}
            onClick={() => void exportar()}
            className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            {exportando ? (pt ? "Gerando..." : "Generating...") : pt ? "Exportar" : "Export"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
