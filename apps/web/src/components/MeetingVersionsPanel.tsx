import React, { useEffect, useState } from "react";
import { FileClock, FileDown } from "lucide-react";
import { downloadMeetingVersionPdf, listMeetingVersions, type VersaoDaReuniao } from "../lib/meeting-versions";
import { salvarArquivo } from "../lib/documents";
import { describeMeetingError } from "../lib/meetings";

/**
 * HISTÓRICO DE VERSÕES da reunião: cada alteração relevante gravada vira uma
 * versão com PDF (gerado pelo servidor a partir da fotografia imutável).
 * Leitura para qualquer usuário ativo — mesma política do detalhe.
 */
export default function MeetingVersionsPanel({
  language,
  meetingId,
  recarregarQuando,
  triggerToast
}: {
  language: "en" | "pt";
  meetingId: string;
  /** Muda depois de uma alteração da reunião (ex.: `updatedAt`) para recarregar. */
  recarregarQuando: string;
  triggerToast: (msg: string) => void;
}) {
  const pt = language === "pt";
  const [versoes, setVersoes] = useState<VersaoDaReuniao[] | null>(null);
  const [erro, setErro] = useState(false);
  const [baixando, setBaixando] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    setErro(false);
    listMeetingVersions(meetingId, c.signal)
      .then(setVersoes)
      .catch((e) => {
        if ((e as Error)?.name !== "AbortError") setErro(true);
      });
    return () => c.abort();
  }, [meetingId, recarregarQuando]);

  const baixar = async (v: VersaoDaReuniao) => {
    setBaixando(v.id);
    try {
      const { blob, filename } = await downloadMeetingVersionPdf(meetingId, v.id);
      salvarArquivo(blob, filename ?? `reuniao-v${v.number}.pdf`);
    } catch (e) {
      triggerToast(describeMeetingError(e, language));
    } finally {
      setBaixando(null);
    }
  };

  return (
    <section aria-labelledby="versoes-da-reuniao" className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
      <h3 id="versoes-da-reuniao" className="text-xs font-extrabold text-slate-900 uppercase tracking-widest flex items-center gap-2">
        <FileClock className="w-4 h-4 text-[#00658d]" />
        {pt ? "Versões da reunião" : "Meeting versions"}
      </h3>
      <p className="text-[11px] text-slate-500 font-medium">
        {pt
          ? "Cada alteração relevante gera uma versão em PDF com a reunião como estava naquele momento."
          : "Each relevant change creates a PDF version with the meeting as it was at that moment."}
      </p>
      {erro && <p className="text-[11px] font-semibold text-rose-700">{pt ? "Não foi possível carregar as versões." : "Could not load versions."}</p>}
      {!erro && versoes === null && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}
      {versoes && versoes.length === 0 && (
        <p className="text-[11px] text-slate-400 font-semibold">
          {pt ? "Nenhuma versão ainda: a primeira é gravada na próxima alteração." : "No versions yet: the first is recorded on the next change."}
        </p>
      )}
      {versoes && versoes.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {versoes.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-[12px] font-extrabold text-slate-800">
                  {pt ? `Versão ${v.number}` : `Version ${v.number}`}
                  <span className="font-semibold text-slate-500"> · {v.changeSummary}</span>
                </p>
                <p className="text-[10px] text-slate-400 font-semibold">
                  {new Date(v.createdAt).toLocaleString(pt ? "pt-BR" : "en-US")} · {v.createdBy.name}
                </p>
              </div>
              <button
                type="button"
                disabled={baixando === v.id}
                onClick={() => void baixar(v)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer shrink-0"
              >
                <FileDown className="w-3.5 h-3.5" />PDF
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
