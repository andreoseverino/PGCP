import React, { useEffect, useRef, useState } from "react";
import { Paperclip, Upload, X } from "lucide-react";
import { ACCEPT_DO_INPUT, problemaNoArquivo, tamanhoLegivel, uploadMeetingDocument } from "../lib/documents";

/**
 * "Adicionar documento" — o MESMO diálogo para a reunião inteira e para um tema
 * DESTA reunião (o botão do tema abre com ele já escolhido). A tela só
 * pré-valida (vazio, extensão); tipo real, conteúdo, tamanho máximo, contexto e
 * permissão são decididos pelo servidor.
 */
export default function UploadDocumentModal({
  language,
  meetingId,
  temas,
  temaInicial,
  onClose,
  onUploaded
}: {
  language: "en" | "pt";
  meetingId: string;
  /** Temas DESTA reunião (meeting_agenda_items). */
  temas: Array<{ id: string; title: string }>;
  /** `null` = reunião inteira; id = tema preselecionado. */
  temaInicial: string | null;
  onClose: () => void;
  onUploaded: (nome: string) => void;
}) {
  const pt = language === "pt";
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [contexto, setContexto] = useState<"reuniao" | "tema">(temaInicial ? "tema" : "reuniao");
  const [tema, setTema] = useState<string>(temaInicial ?? "");
  const [descricao, setDescricao] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const controle = useRef<AbortController | null>(null);

  useEffect(() => () => controle.current?.abort(), []);

  const escolher = (f: File | null) => {
    setErro(f ? problemaNoArquivo(f, language) : null);
    setArquivo(f);
  };

  const mensagemDoErro = (e: unknown): string => {
    const status = (e as { status?: number }).status;
    const msg = (e as Error).message;
    if (status === 503) return pt ? "O armazenamento de documentos não está disponível no momento. Tente mais tarde." : "Document storage is unavailable. Try again later.";
    if (status === 0) return pt ? "Sem conexão com o servidor." : "No connection to the server.";
    if (status === 401) return pt ? "Sua sessão expirou." : "Your session expired.";
    if (status === 403) return pt ? "Você não tem permissão para adicionar documentos." : "You are not allowed to add documents.";
    // 400/404/409/413/415: a API já devolve a mensagem pronta para o usuário.
    if (status && msg) return msg;
    return pt ? "Não foi possível enviar o documento." : "Could not upload the document.";
  };

  const enviar = async () => {
    if (!arquivo || enviando) return;
    const problema = problemaNoArquivo(arquivo, language);
    if (problema) {
      setErro(problema);
      return;
    }
    if (contexto === "tema" && !tema) {
      setErro(pt ? "Escolha o tema da reunião." : "Choose the meeting topic.");
      return;
    }
    setEnviando(true);
    setErro(null);
    controle.current = new AbortController();
    try {
      const doc = await uploadMeetingDocument(
        meetingId,
        arquivo,
        { agendaItemId: contexto === "tema" ? tema : null, descricao },
        controle.current.signal
      );
      onUploaded(doc.name);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErro(mensagemDoErro(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="tituloUpload">
      <div className="absolute inset-0 bg-slate-900/40" onClick={() => !enviando && onClose()} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 id="tituloUpload" className="text-sm font-extrabold text-slate-800 flex items-center gap-2">
            <Paperclip className="w-4 h-4 text-[#00658d]" />
            {pt ? "Adicionar documento" : "Add document"}
          </h3>
          <button type="button" onClick={onClose} disabled={enviando} aria-label={pt ? "Fechar" : "Close"} className="p-1 text-slate-500 cursor-pointer disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1">
          <label htmlFor="uploadArquivo" className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{pt ? "Arquivo" : "File"}</label>
          <input
            id="uploadArquivo"
            type="file"
            accept={ACCEPT_DO_INPUT}
            disabled={enviando}
            onChange={(e) => escolher(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-slate-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-sky-50 file:text-[#00658d] file:font-bold file:cursor-pointer"
          />
          <p className="text-[10px] text-slate-400">
            {arquivo
              ? `${arquivo.name} · ${tamanhoLegivel(arquivo.size)}`
              : pt ? "PDF, PowerPoint, Word ou Excel." : "PDF, PowerPoint, Word or Excel."}
          </p>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">{pt ? "Vincular a" : "Link to"}</legend>
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input type="radio" name="contextoUpload" checked={contexto === "reuniao"} onChange={() => setContexto("reuniao")} disabled={enviando} className="accent-[#00658d]" />
            {pt ? "Reunião inteira" : "Whole meeting"}
          </label>
          <label className={`flex items-center gap-2 text-xs ${temas.length ? "text-slate-700 cursor-pointer" : "text-slate-400"}`}>
            <input
              type="radio"
              name="contextoUpload"
              checked={contexto === "tema"}
              onChange={() => setContexto("tema")}
              disabled={enviando || temas.length === 0}
              className="accent-[#00658d]"
            />
            {pt ? "Tema da reunião" : "Meeting topic"}
            {temas.length === 0 && <span className="text-[10px]">({pt ? "nenhum tema cadastrado" : "no topics yet"})</span>}
          </label>
          {contexto === "tema" && (
            <select
              value={tema}
              onChange={(e) => setTema(e.target.value)}
              disabled={enviando}
              aria-label={pt ? "Tema da reunião" : "Meeting topic"}
              className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer"
            >
              <option value="">{pt ? "Escolha o tema" : "Choose the topic"}</option>
              {temas.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          )}
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="uploadDescricao" className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            {pt ? "Descrição (opcional)" : "Description (optional)"}
          </label>
          <input
            id="uploadDescricao"
            value={descricao}
            maxLength={500}
            disabled={enviando}
            onChange={(e) => setDescricao(e.target.value)}
            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
          />
        </div>

        {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={enviando} className="px-4 py-2 text-xs font-bold text-slate-600 rounded-xl hover:bg-slate-100 cursor-pointer disabled:opacity-40">
            {pt ? "Cancelar" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => void enviar()}
            disabled={!arquivo || enviando || Boolean(problemaNoArquivo(arquivo, language))}
            className="px-4 py-2 text-xs font-bold text-white bg-[#00658d] hover:bg-[#00aeef] rounded-xl inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-3.5 h-3.5" />
            {enviando ? (pt ? "Enviando..." : "Uploading...") : pt ? "Enviar" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
