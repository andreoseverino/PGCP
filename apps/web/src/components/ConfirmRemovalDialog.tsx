import React from "react";
import { CheckCircle, Trash2, type LucideIcon } from "lucide-react";
import type { ConfirmacaoRemocao } from "../lib/participant-removal";
import ModalShell, { BOTAO_CANCELAR, BOTAO_PERIGO, BOTAO_PRINCIPAL } from "./ModalShell";

/**
 * Confirmação de ação destrutiva (remover participante, excluir tema da
 * Biblioteca, excluir reunião/pauta) no PADRÃO DE MODAL do sistema
 * (`ModalShell`, o mesmo da Nova reunião) — sem biblioteca de dialog.
 *
 * Só `onConfirm` executa a remoção; Cancelar, X e Esc só chamam `onCancel`
 * (Esc e X pela casca). Clicar fora não fecha.
 *
 * `variante="aprovar"`: mesmo diálogo para confirmar ação NÃO destrutiva mas
 * irreversível (ex.: aprovar a Agenda Anual) — azul do sistema, ícone de check.
 */
interface ConfirmRemovalDialogProps {
  language: "en" | "pt";
  confirmacao: ConfirmacaoRemocao;
  busy?: boolean;
  variante?: "remover" | "aprovar";
  /** Troca o ícone padrão (lixeira / check) quando a ação pede outro. */
  icone?: LucideIcon;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmRemovalDialog({
  language,
  confirmacao,
  busy = false,
  variante = "remover",
  icone,
  onCancel,
  onConfirm
}: ConfirmRemovalDialogProps) {
  const aprovar = variante === "aprovar";
  const Icone = icone ?? (aprovar ? CheckCircle : Trash2);

  return (
    <ModalShell
      language={language}
      papel="alertdialog"
      icone={Icone}
      tom={aprovar ? "padrao" : "perigo"}
      titulo={confirmacao.titulo}
      ocupado={busy}
      onClose={onCancel}
      rodape={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={BOTAO_CANCELAR}>
            {language === "pt" ? "Cancelar" : "Cancel"}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={aprovar ? BOTAO_PRINCIPAL : BOTAO_PERIGO}>
            <Icone className="w-3.5 h-3.5" />
            {confirmacao.acao}
          </button>
        </>
      }
    >
      <div className="space-y-3">
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
    </ModalShell>
  );
}
