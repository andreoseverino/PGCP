import React from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import {
  dataNoFuso,
  rotuloDaOrigem,
  rotuloDoTipo,
  tamanhoLegivel,
  type DocumentoDoPgcp
} from "../lib/documents-rules";

/**
 * Uma linha de documento — mesma apresentação na biblioteca (Documentos) e na
 * aba Documentos da reunião (Pipeline): nome, extensão, tamanho, quem enviou/
 * emitiu, data, reunião, tema, origem e ações. Nunca mostra caminho de arquivo.
 */
export default function DocumentItem({
  doc,
  language,
  mostrarReuniao = true,
  onDownload,
  onOpenContext
}: {
  doc: DocumentoDoPgcp;
  language: "en" | "pt";
  /** Na aba da própria reunião, o contexto já é óbvio. */
  mostrarReuniao?: boolean;
  onDownload: (d: DocumentoDoPgcp) => void;
  onOpenContext?: (d: DocumentoDoPgcp) => void;
}) {
  const pt = language === "pt";
  const contexto = doc.meeting
    ? `${dataNoFuso(doc.meeting.startAt, doc.meeting.timezone)} — ${doc.meeting.title}`
    : doc.annualAgenda
      ? `${pt ? "Agenda Anual" : "Annual plan"} ${doc.annualAgenda.year} (${pt ? "versão" : "version"} ${doc.annualAgenda.version})`
      : null;
  const detalhes = [
    tamanhoLegivel(doc.sizeBytes) !== "—" ? tamanhoLegivel(doc.sizeBytes) : null,
    doc.author?.name ? `${doc.source === "user" ? (pt ? "Enviado por" : "Uploaded by") : pt ? "Emitido por" : "Issued by"} ${doc.author.name}` : null,
    dataNoFuso(doc.documentAt, "America/Sao_Paulo", true)
  ].filter(Boolean);

  return (
    <li className="flex items-start gap-3 py-3 px-4 border-t border-slate-100 first:border-t-0">
      <div className="w-9 h-9 rounded-lg bg-sky-50 text-[#00658d] flex flex-col items-center justify-center shrink-0">
        <FileText className="w-4 h-4" aria-hidden="true" />
        <span className="text-[8px] font-extrabold uppercase leading-none mt-0.5">{doc.extension || "—"}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-slate-800 break-words" title={doc.name}>{doc.name}</p>
        {doc.description && <p className="text-[11px] text-slate-500 mt-0.5 break-words">{doc.description}</p>}
        <p className="text-[10px] text-slate-400 font-semibold mt-0.5">{detalhes.join(" · ")}</p>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[9.5px] font-bold">{rotuloDoTipo(doc.type, language)}</span>
          <span
            className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold ${
              doc.source === "pgcp" ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-[#00658d]"
            }`}
          >
            {rotuloDaOrigem(doc.source, language)}
          </span>
          {doc.type !== "anexo" && <span className="px-1.5 py-0.5 rounded bg-slate-50 text-slate-500 text-[9.5px] font-semibold">{doc.status}</span>}
          {mostrarReuniao && contexto && (
            <span className="px-1.5 py-0.5 rounded bg-slate-50 text-slate-500 text-[9.5px] font-semibold max-w-full truncate" title={contexto}>
              {contexto}
            </span>
          )}
          {doc.topic && (
            <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 text-[9.5px] font-semibold max-w-full truncate" title={doc.topic.title}>
              {pt ? "Tema: " : "Topic: "}
              {doc.topic.title}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onDownload(doc)}
          className="p-1.5 text-[#00658d] hover:bg-sky-50 rounded-lg cursor-pointer"
          title={pt ? "Baixar" : "Download"}
          aria-label={pt ? `Baixar ${doc.name}` : `Download ${doc.name}`}
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        {onOpenContext && (
          <button
            type="button"
            onClick={() => onOpenContext(doc)}
            className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"
            title={doc.meeting?.releasedToPipeline ? (pt ? "Abrir a reunião" : "Open meeting") : pt ? "Abrir a Agenda Anual" : "Open Annual plan"}
            aria-label={pt ? `Abrir contexto de ${doc.name}` : `Open context of ${doc.name}`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}
