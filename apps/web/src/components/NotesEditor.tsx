import React, { useEffect } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
// Já vem instalado junto com o StarterKit — não é dependência nova.
import { Placeholder } from "@tiptap/extensions";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  CheckSquare,
  Eraser
} from "lucide-react";

interface NotesEditorProps {
  /** HTML das anotações. */
  value: string;
  onChange: (html: string) => void;
  /** Muda de reunião: força recarregar o conteúdo no editor. */
  documentKey: string;
  language: "en" | "pt";
  placeholder?: string;
  /**
   * Editável? `false` mostra o mesmo conteúdo sem permitir digitar.
   *
   * Quem não tem `PGCP.Assessoria` lê as anotações (Política A) mas não as
   * escreve — o servidor recusa o `PUT`, e um editor que aceita digitação
   * prometeria uma gravação que não vai acontecer.
   */
  editable?: boolean;
}

/**
 * Editor rich text das anotações da reunião.
 *
 * Persistimos HTML, não Markdown: a usuária vê negrito, títulos e listas
 * formatados de verdade, sem sintaxe técnica na tela.
 *
 * Segurança: o HTML volta a ser interpretado pelo próprio Tiptap, que só
 * aceita os nós e marcas declarados no schema abaixo. Qualquer `<script>` ou
 * atributo de evento é descartado na análise. Este conteúdo NUNCA deve ser
 * renderizado com `dangerouslySetInnerHTML` em outro lugar.
 */
export default function NotesEditor({
  value,
  onChange,
  documentKey,
  language,
  placeholder,
  editable = true
}: NotesEditorProps) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2] },
          // Recursos fora do escopo pedido ficam desligados.
          codeBlock: false,
          blockquote: false,
          horizontalRule: false
        }),
        TaskList,
        TaskItem.configure({ nested: false }),
        Placeholder.configure({ placeholder: placeholder || "" })
      ],
      content: value || "",
      editable,
      editorProps: {
        attributes: {
          class:
            "pgcp-notes prose-none w-full min-h-[26rem] px-5 py-4 text-sm text-slate-800 leading-relaxed font-medium focus:outline-none"
        }
      },
      onUpdate: ({ editor }) => onChange(editor.getHTML())
    },
    // Recria o editor ao trocar de reunião, evitando vazar conteúdo entre elas.
    [documentKey]
  );

  // Mantém o editor em sincronia quando o conteúdo muda por fora (ex.: apoio
  // contextual inserindo blocos). Evita loop comparando com o HTML atual.
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) return null;

  const t = {
    bold: language === "en" ? "Bold" : "Negrito",
    italic: language === "en" ? "Italic" : "Itálico",
    h1: language === "en" ? "Heading" : "Título",
    h2: language === "en" ? "Subheading" : "Subtítulo",
    bullet: language === "en" ? "Bullet list" : "Lista com marcadores",
    ordered: language === "en" ? "Numbered list" : "Lista numerada",
    task: language === "en" ? "Checklist" : "Checklist",
    clear: language === "en" ? "Clear formatting" : "Limpar formatação"
  };

  const tools: Array<{
    icon: React.ElementType;
    title: string;
    action: () => void;
    isActive: () => boolean;
  }> = [
    {
      icon: Bold,
      title: t.bold,
      action: () => editor.chain().focus().toggleBold().run(),
      isActive: () => editor.isActive("bold")
    },
    {
      icon: Italic,
      title: t.italic,
      action: () => editor.chain().focus().toggleItalic().run(),
      isActive: () => editor.isActive("italic")
    },
    {
      icon: Heading1,
      title: t.h1,
      action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      isActive: () => editor.isActive("heading", { level: 1 })
    },
    {
      icon: Heading2,
      title: t.h2,
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      isActive: () => editor.isActive("heading", { level: 2 })
    },
    {
      icon: List,
      title: t.bullet,
      action: () => editor.chain().focus().toggleBulletList().run(),
      isActive: () => editor.isActive("bulletList")
    },
    {
      icon: ListOrdered,
      title: t.ordered,
      action: () => editor.chain().focus().toggleOrderedList().run(),
      isActive: () => editor.isActive("orderedList")
    },
    {
      icon: CheckSquare,
      title: t.task,
      action: () => editor.chain().focus().toggleTaskList().run(),
      isActive: () => editor.isActive("taskList")
    },
    {
      icon: Eraser,
      title: t.clear,
      action: () => editor.chain().focus().clearNodes().unsetAllMarks().run(),
      isActive: () => false
    }
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 px-4 py-2 bg-slate-50/70 border-b border-slate-100 select-none">
        {tools.map((tool) => {
          const Icon = tool.icon;
          const active = tool.isActive();
          return (
            <button
              key={tool.title}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={tool.action}
              title={tool.title}
              aria-label={tool.title}
              aria-pressed={active}
              className={`p-1.5 rounded-lg border transition cursor-pointer ${
                active
                  ? "bg-[#c6e7ff]/40 text-[#00658d] border-[#00658d]/20"
                  : "text-slate-500 border-transparent hover:text-[#00658d] hover:bg-white hover:border-slate-200"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}
      </div>

      <EditorContent editor={editor} />
    </>
  );
}
