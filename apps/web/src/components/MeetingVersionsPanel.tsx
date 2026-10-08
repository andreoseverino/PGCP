import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileClock, FileDown } from "lucide-react";
import {
  downloadMeetingVersionPdf,
  getMeetingVersionChanges,
  listMeetingVersions,
  type MudancasDaVersao,
  type VersaoDaReuniao
} from "../lib/meeting-versions";
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
  /** Seção inteira recolhida por padrão — o histórico é consulta eventual. */
  const [painelAberto, setPainelAberto] = useState(false);
  const [baixando, setBaixando] = useState<string | null>(null);
  /** Versão expandida mostrando o que mudou (campo a campo), uma por vez. */
  const [expandida, setExpandida] = useState<string | null>(null);
  const [mudancas, setMudancas] = useState<Record<string, MudancasDaVersao | "erro">>({});

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

  const expandir = (v: VersaoDaReuniao) => {
    if (expandida === v.id) {
      setExpandida(null);
      return;
    }
    setExpandida(v.id);
    if (mudancas[v.id]) return;
    getMeetingVersionChanges(meetingId, v.id)
      .then((r) => setMudancas((anterior) => ({ ...anterior, [v.id]: r })))
      .catch(() => setMudancas((anterior) => ({ ...anterior, [v.id]: "erro" })));
  };

  return (
    <section aria-labelledby="versoes-da-reuniao" className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
      <h3 id="versoes-da-reuniao">
        <button
          type="button"
          onClick={() => setPainelAberto((a) => !a)}
          aria-expanded={painelAberto}
          aria-controls="versoes-da-reuniao-conteudo"
          className="w-full flex items-center gap-2 text-left cursor-pointer group"
        >
          <FileClock className="w-4 h-4 text-[#00658d]" />
          <span className="text-xs font-extrabold text-slate-900 uppercase tracking-widest group-hover:text-[#00658d]">
            {pt ? "Versões da reunião" : "Meeting versions"}
          </span>
          {versoes && versoes.length > 0 && (
            <span className="text-[9px] text-[#00658d] font-extrabold bg-[#00658d]/5 px-2 py-0.5 rounded-full">{versoes.length}</span>
          )}
          <ChevronDown
            className={`w-4 h-4 text-slate-400 ml-auto shrink-0 transition-transform ${painelAberto ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      {painelAberto && (
        <div id="versoes-da-reuniao-conteudo" className="space-y-3">
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
              {versoes.map((v) => {
                const aberta = expandida === v.id;
                const dados = mudancas[v.id];
                // Grupos na ordem em que vieram (o servidor já ordena por seção).
                const grupos: { grupo: string; itens: MudancasDaVersao["changes"] }[] = [];
                if (dados && dados !== "erro") {
                  for (const c of dados.changes) {
                    const g = grupos.find((x) => x.grupo === c.grupo);
                    if (g) g.itens.push(c);
                    else grupos.push({ grupo: c.grupo, itens: [c] });
                  }
                }
                return (
                  <li key={v.id} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => expandir(v)}
                        className="min-w-0 flex items-start gap-1.5 text-left cursor-pointer group"
                      >
                        {aberta ? (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                        )}
                        <span className="min-w-0">
                          <p className="text-[12px] font-extrabold text-slate-800 group-hover:text-[#00658d]">
                            {pt ? `Versão ${v.number}` : `Version ${v.number}`}
                            <span className="font-semibold text-slate-500"> · {v.changeSummary}</span>
                          </p>
                          <p className="text-[10px] text-slate-400 font-semibold">
                            {new Date(v.createdAt).toLocaleString(pt ? "pt-BR" : "en-US")} · {v.createdBy.name}
                          </p>
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={baixando === v.id}
                        onClick={() => void baixar(v)}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer shrink-0"
                      >
                        <FileDown className="w-3.5 h-3.5" />PDF
                      </button>
                    </div>
                    {aberta && (
                      <div className="mt-2 ml-5 space-y-2">
                        {!dados && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}
                        {dados === "erro" && (
                          <p className="text-[11px] font-semibold text-rose-700">
                            {pt ? "Não foi possível carregar o que mudou." : "Could not load what changed."}
                          </p>
                        )}
                        {dados && dados !== "erro" && dados.changes.length === 0 && (
                          <p className="text-[11px] text-slate-400 font-semibold">
                            {pt ? "Nada para comparar (primeira versão registrada)." : "Nothing to compare (first recorded version)."}
                          </p>
                        )}
                        {grupos.map((g) => (
                          <div key={g.grupo} className="bg-slate-50 border border-slate-100 rounded-xl p-2.5">
                            <p className="text-[9.5px] font-extrabold text-slate-500 uppercase tracking-wide mb-1">{g.grupo}</p>
                            <div className="space-y-1">
                              {g.itens.map((c, i) => (
                                <p key={i} className="text-[11px] text-slate-700">
                                  <span className="font-bold">{c.campo}:</span>{" "}
                                  {c.antes === null ? (
                                    <span className="text-emerald-700 font-semibold">{c.depois}</span>
                                  ) : c.depois === null ? (
                                    <span className="text-rose-700 font-semibold line-through">{c.antes}</span>
                                  ) : (
                                    <>
                                      <span className="text-slate-400">{c.antes}</span>
                                      <span className="mx-1 text-slate-300">→</span>
                                      <span className="font-semibold text-slate-800">{c.depois}</span>
                                    </>
                                  )}
                                </p>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
