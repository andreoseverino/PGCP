import React from "react";
import { Trash2 } from "lucide-react";
import type { ConfirmacaoRemocao } from "../lib/participant-removal";

/**
 * Confirmação de remoção de participante. Mesmo visual dos modais de exclusão
 * já existentes (excluir pauta, excluir reunião) — sem biblioteca de dialog.
 *
 * Só `onConfirm` executa a remoção; cancelar, clicar fora ou fechar não chamam
 * a API.
 */
interface ConfirmRemovalDialogProps {
  language: "en" | "pt";
  confirmacao: ConfirmacaoRemocao;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmRemovalDialog({
  language,
  confirmacao,
  busy = false,
  onCancel,
  onConfirm
}: ConfirmRemovalDialogProps) {
  return (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-removal-title"
        className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <h3 id="confirm-removal-title" className="text-sm font-extrabold text-slate-900">
              {confirmacao.titulo}
            </h3>
          </div>
          <p className="text-xs text-slate-600 font-medium leading-relaxed">{confirmacao.paragrafos[0]}</p>
          {confirmacao.temas.length > 0 && (
            <ul className="list-disc pl-5 space-y-0.5 text-xs text-slate-800 font-bold">
              {confirmacao.temas.map((tema, i) => (
                <li key={`${tema}-${i}`}>{tema}</li>
              ))}
            </ul>
          )}
          {confirmacao.paragrafos.slice(1).map((texto, i) => (
            <p key={i} className="text-xs text-slate-500 font-medium leading-relaxed">{texto}</p>
          ))}
        </div>
        <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer disabled:opacity-50"
          >
            {language === "pt" ? "Cancelar" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer inline-flex items-center gap-2 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {confirmacao.acao}
          </button>
        </div>
      </div>
    </div>
  );
}
