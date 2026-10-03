import React, { useEffect, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";
import {
  downloadDocument,
  listMeetingDocuments,
  salvarArquivo,
  secoesDaReuniao,
  type DocumentoDoPgcp
} from "../lib/documents";
import DocumentItem from "./DocumentItem";

/**
 * Aba DOCUMENTOS da reunião (Pipeline): anexos da reunião inteira, anexos por
 * tema da reunião e a Ata, em seções separadas. "Adicionar documento" abre o
 * diálogo compartilhado (o mesmo do botão de cada tema). Sem exclusão no MVP.
 */
export default function MeetingDocumentsPanel({
  language,
  meetingId,
  podeAdicionar,
  versao,
  onAdd,
  triggerToast
}: {
  language: "en" | "pt";
  meetingId: string;
  /** `PGCP.Assessoria` e reunião liberada no Pipeline. Cortesia; o servidor revalida. */
  podeAdicionar: boolean;
  /** Muda depois de um envio para recarregar a lista. */
  versao: number;
  onAdd: () => void;
  triggerToast: (msg: string) => void;
}) {
  const pt = language === "pt";
  const [docs, setDocs] = useState<DocumentoDoPgcp[] | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    setErro(false);
    listMeetingDocuments(meetingId, c.signal)
      .then(setDocs)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErro(true);
      });
    return () => c.abort();
  }, [meetingId, versao]);

  const baixar = async (d: DocumentoDoPgcp) => {
    try {
      const { blob, filename } = await downloadDocument(d);
      salvarArquivo(blob, filename ?? (d.extension ? `${d.name}.${d.extension}` : d.name));
    } catch (e) {
      triggerToast(
        (e as { status?: number }).status === 503
          ? pt ? "Armazenamento de documentos indisponível no momento." : "Document storage is unavailable."
          : pt ? "Não foi possível baixar o documento." : "Could not download the document."
      );
    }
  };

  const secoes = docs ? secoesDaReuniao(docs) : null;

  const lista = (itens: DocumentoDoPgcp[], vazio: string) =>
    itens.length === 0 ? (
      <p className="text-[11px] text-slate-400 font-semibold px-1">{vazio}</p>
    ) : (
      <ul className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {itens.map((d) => (
          <DocumentItem key={d.id} doc={d} language={language} mostrarReuniao={false} onDownload={(x) => void baixar(x)} />
        ))}
      </ul>
    );

  return (
    <div className="mt-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-extrabold text-slate-800 flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-[#00658d]" />
            {pt ? "Documentos da reunião" : "Meeting documents"}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {pt
              ? "Arquivos da reunião inteira e de cada tema. Também aparecem na biblioteca de Documentos."
              : "Files for the whole meeting and for each topic. They also appear in the Documents library."}
          </p>
        </div>
        {podeAdicionar && (
          <button
            type="button"
            onClick={onAdd}
            className="px-4 py-2 text-xs font-bold text-white bg-[#00658d] hover:bg-[#00aeef] rounded-xl inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            {pt ? "Adicionar documento" : "Add document"}
          </button>
        )}
      </div>

      {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{pt ? "Não foi possível carregar os documentos." : "Could not load documents."}</p>}
      {!secoes && !erro && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}

      {secoes && (
        <>
          <section className="space-y-2">
            <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{pt ? "Reunião inteira" : "Whole meeting"}</h4>
            {lista(secoes.gerais, pt ? "Nenhum documento da reunião inteira." : "No whole-meeting documents.")}
          </section>
          <section className="space-y-2">
            <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{pt ? "Por tema" : "By topic"}</h4>
            {secoes.temas.length === 0 ? (
              <p className="text-[11px] text-slate-400 font-semibold px-1">{pt ? "Nenhum documento de tema." : "No topic documents."}</p>
            ) : (
              secoes.temas.map((t) => (
                <div key={t.tema.id} className="space-y-1.5">
                  <p className="text-[11px] font-bold text-amber-800 px-1">{t.tema.title}</p>
                  {lista(t.docs, "")}
                </div>
              ))
            )}
          </section>
          <section className="space-y-2">
            <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{pt ? "Ata" : "Minutes"}</h4>
            {lista(secoes.atas, pt ? "A Ata aparece aqui quando for registrada." : "Minutes appear here once recorded.")}
          </section>
        </>
      )}
    </div>
  );
}
