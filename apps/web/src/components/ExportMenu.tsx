import React, { useEffect, useRef, useState } from "react";
import { CalendarRange, ChevronDown, Download, FileDown, type LucideIcon } from "lucide-react";
import CalendarExportModal from "./CalendarExportModal";
import CronogramaExportModal from "./CronogramaExportModal";

/**
 * EXPORTAR E RELATÓRIOS — ponto ÚNICO, no cabeçalho global (ao lado da busca),
 * disponível em qualquer tela. Cada item abre o seu modal (padrão do sistema);
 * o servidor decide o conteúdo de cada arquivo. Novos relatórios entram aqui,
 * em `ITENS`.
 *
 * Filtros iniciais vêm do contexto: órgão do topo e ano corrente.
 */
type Relatorio = "calendario" | "cronograma";

export default function ExportMenu({
  language,
  orgaoContexto,
  compacto = false
}: {
  language: "en" | "pt";
  /** Órgão do contexto global ("" = todos). */
  orgaoContexto: string;
  /** Só o ícone (barra do celular). */
  compacto?: boolean;
}) {
  const pt = language === "pt";
  const [aberto, setAberto] = useState(false);
  const [relatorio, setRelatorio] = useState<Relatorio | null>(null);
  const raiz = useRef<HTMLDivElement>(null);
  const ano = new Date().getFullYear();

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAberto(false);
    };
    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);

  const ITENS: Array<{ id: Relatorio; Icone: LucideIcon; rotulo: string; descricao: string }> = [
    {
      id: "calendario",
      Icone: FileDown,
      rotulo: pt ? "Exportar Agenda Anual" : "Export annual plan",
      descricao: pt ? "Lista das reuniões em PDF, por período e comitê." : "Meeting list (PDF) by period and committee."
    },
    {
      id: "cronograma",
      Icone: CalendarRange,
      rotulo: pt ? "Exportar cronograma" : "Export schedule",
      descricao: pt ? "Visão anual em grade: comitês × meses." : "Yearly grid: committees × months."
    }
  ];

  return (
    <div ref={raiz} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        aria-haspopup="menu"
        aria-expanded={aberto}
        title={pt ? "Exportar e relatórios" : "Export and reports"}
        className={`inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white text-xs font-bold text-[#00658d] hover:bg-sky-50 transition cursor-pointer ${
          compacto ? "p-2" : "px-3 py-2"
        }`}
      >
        <Download className="w-3.5 h-3.5" />
        {!compacto && (
          <>
            {pt ? "Exportar" : "Export"}
            <ChevronDown className={`w-3 h-3 transition-transform ${aberto ? "rotate-180" : ""}`} />
          </>
        )}
      </button>

      {aberto && (
        <div
          role="menu"
          className={`absolute top-full mt-2 w-72 bg-white border border-slate-200 rounded-2xl shadow-md overflow-hidden z-50 ${compacto ? "right-0" : "left-0"}`}
        >
          <p className="px-4 pt-3 pb-1 text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
            {pt ? "Exportar e relatórios" : "Export and reports"}
          </p>
          {ITENS.map(({ id, Icone, rotulo, descricao }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              onClick={() => {
                setAberto(false);
                setRelatorio(id);
              }}
              className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition cursor-pointer flex items-start gap-2.5 border-t border-slate-100 first-of-type:border-t-0"
            >
              <Icone className="w-4 h-4 text-[#00658d] mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-slate-800">{rotulo}</span>
                <span className="block text-[10px] text-slate-400 font-semibold">{descricao}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {relatorio === "calendario" && (
        <CalendarExportModal language={language} governanceBodyId={orgaoContexto} ano={ano} onClose={() => setRelatorio(null)} />
      )}
      {relatorio === "cronograma" && (
        <CronogramaExportModal language={language} governanceBodyId={orgaoContexto} ano={ano} onClose={() => setRelatorio(null)} />
      )}
    </div>
  );
}
