import React, { useEffect, useRef } from "react";
import { Bold, Italic, List, ListOrdered } from "lucide-react";
import { descricaoComoHtml, sanitizarHtml } from "../lib/rich-text";

/**
 * EDITOR DE TEXTO RICO MÍNIMO — negrito, itálico, listas e parágrafos.
 *
 * `contentEditable` + comandos nativos do navegador (`execCommand`): sem
 * biblioteca nova, estável em todos os navegadores corporativos. O que sai do
 * editor passa SEMPRE por `sanitizarHtml` (lista fechada, sem atributos) antes
 * de virar estado; colar também é saneado. O servidor saneia de novo — este
 * componente nunca é a barreira de segurança.
 */

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  language: "en" | "pt";
  ariaLabel: string;
  placeholder?: string;
  id?: string;
  minHeightClass?: string;
}

type Comando = "bold" | "italic" | "insertUnorderedList" | "insertOrderedList";

export default function RichTextEditor({
  value,
  onChange,
  language,
  ariaLabel,
  placeholder,
  id,
  minHeightClass = "min-h-[140px]"
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pt = language === "pt";

  // Controlado sem perder o cursor: só reescreve o DOM quando o valor externo
  // difere do que o editor já mostra (ex.: template aplicado de fora).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const externo = descricaoComoHtml(value);
    if (sanitizarHtml(el.innerHTML) !== externo) el.innerHTML = externo;
  }, [value]);

  // Só avisa quando o conteúdo MUDOU (focar/sair sem digitar não é edição).
  const emitir = () => {
    const el = ref.current;
    if (!el) return;
    const html = sanitizarHtml(el.innerHTML);
    if (html !== descricaoComoHtml(value)) onChange(html);
  };

  const aplicar = (comando: Comando) => {
    ref.current?.focus();
    document.execCommand(comando);
    emitir();
  };

  const colar = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const texto = e.clipboardData.getData("text/plain");
    const limpo = html ? sanitizarHtml(html) : descricaoComoHtml(texto);
    document.execCommand("insertHTML", false, limpo);
    emitir();
  };

  const botoes: Array<{ comando: Comando; rotulo: string; Icone: typeof Bold }> = [
    { comando: "bold", rotulo: pt ? "Negrito" : "Bold", Icone: Bold },
    { comando: "italic", rotulo: pt ? "Itálico" : "Italic", Icone: Italic },
    { comando: "insertUnorderedList", rotulo: pt ? "Lista com marcadores" : "Bulleted list", Icone: List },
    { comando: "insertOrderedList", rotulo: pt ? "Lista numerada" : "Numbered list", Icone: ListOrdered }
  ];

  const vazio = !value || sanitizarHtml(value).replace(/<[^>]+>/g, "").trim() === "";

  return (
    <div className="border border-slate-200 rounded-xl bg-white focus-within:border-[#00658d] focus-within:ring-2 focus-within:ring-[#00658d]/10">
      <div role="toolbar" aria-label={pt ? "Formatação" : "Formatting"} className="flex gap-1 border-b border-slate-100 px-2 py-1.5">
        {botoes.map(({ comando, rotulo, Icone }) => (
          <button
            key={comando}
            type="button"
            title={rotulo}
            aria-label={rotulo}
            // mousedown: mantém a seleção do texto no editor ao clicar.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => aplicar(comando)}
            className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
          >
            <Icone className="w-3.5 h-3.5" />
          </button>
        ))}
      </div>
      <div className="relative">
        {vazio && placeholder && (
          <p aria-hidden="true" className="pointer-events-none absolute left-4 top-3 text-sm text-slate-400">
            {placeholder}
          </p>
        )}
        <div
          id={id}
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          contentEditable
          suppressContentEditableWarning
          onInput={emitir}
          onBlur={emitir}
          onPaste={colar}
          className={`rich-text px-4 py-3 text-sm text-slate-800 outline-none ${minHeightClass} max-h-[320px] overflow-y-auto`}
        />
      </div>
    </div>
  );
}

/** Exibição somente leitura, sempre com HTML saneado. */
export function RichTextView({ html, vazio, className = "" }: { html: string | null | undefined; vazio: string; className?: string }) {
  const seguro = descricaoComoHtml(html);
  if (!seguro) return <p className={`text-slate-400 text-sm italic ${className}`}>{vazio}</p>;
  // `seguro` só contém p/br/strong/em/ul/ol/li SEM atributos (sanitizarHtml).
  return <div className={`rich-text text-sm text-slate-700 ${className}`} dangerouslySetInnerHTML={{ __html: seguro }} />;
}
