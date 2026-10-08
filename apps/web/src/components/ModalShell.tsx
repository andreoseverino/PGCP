import React, { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { X, type LucideIcon } from "lucide-react";

/**
 * PADRÃO DE MODAL DO PGCP — o mesmo da Nova reunião e do Novo tema. Todo modal
 * novo usa esta casca (ou repete exatamente estas classes):
 *
 *   - portal no <body>: centralizado na VIEWPORT, independente de ancestral
 *     com transform/backdrop-filter;
 *   - fundo só desfocado (`bg-white/10 backdrop-blur-md`), sem escurecer;
 *   - caixa branca `rounded-2xl`, borda `slate-200`, sombra, `max-h-[90vh]`;
 *   - cabeçalho fixo: ícone azul + título (+ subtítulo) e X; borda inferior;
 *   - corpo com rolagem única (barra fina visível, `scroll-visivel`);
 *   - rodapé fixo cinza com as ações à direita (Cancelar + ação principal).
 *
 * Esc e o X fecham (se `ocupado`, nada fecha). Clicar fora NÃO fecha: evita
 * perder o que foi digitado — mesmo comportamento da Nova reunião.
 */
interface ModalShellProps {
  language: "en" | "pt";
  titulo: React.ReactNode;
  subtitulo?: React.ReactNode;
  icone: LucideIcon;
  /** `perigo` = ação destrutiva (ícone vermelho). */
  tom?: "padrao" | "perigo";
  /** Largura máxima da caixa (classe Tailwind). */
  largura?: string;
  /** `alertdialog` para confirmações. */
  papel?: "dialog" | "alertdialog";
  ocupado?: boolean;
  onClose: () => void;
  rodape: React.ReactNode;
  children: React.ReactNode;
}

export default function ModalShell({
  language,
  titulo,
  subtitulo,
  icone: Icone,
  tom = "padrao",
  largura = "max-w-md",
  papel = "dialog",
  ocupado = false,
  onClose,
  rodape,
  children
}: ModalShellProps) {
  const idTitulo = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ocupado) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ocupado, onClose]);

  return createPortal(
    <div className="fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6">
      <div
        role={papel}
        aria-modal="true"
        aria-labelledby={idTitulo}
        className={`bg-white rounded-2xl shadow-2xl border border-slate-200 w-full ${largura} max-h-[90vh] flex flex-col overflow-hidden animate-fade-in`}
      >
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="min-w-0">
            <h3 id={idTitulo} className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
              <Icone className={`w-4 h-4 shrink-0 ${tom === "perigo" ? "text-red-600" : "text-[#00658d]"}`} />
              {titulo}
            </h3>
            {subtitulo && <div className="text-[11px] text-slate-500 font-medium mt-0.5">{subtitulo}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={ocupado}
            aria-label={language === "pt" ? "Fechar" : "Close"}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="scroll-visivel flex-1 min-h-0 overflow-y-auto px-6 py-5 text-xs">{children}</div>

        <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0">{rodape}</div>
      </div>
    </div>,
    document.body
  );
}

/** Classes dos botões do rodapé — as mesmas da Nova reunião. */
export const BOTAO_CANCELAR =
  "px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer disabled:opacity-50";
export const BOTAO_PRINCIPAL =
  "px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed";
export const BOTAO_PERIGO =
  "px-4 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer inline-flex items-center gap-2 disabled:opacity-50";
