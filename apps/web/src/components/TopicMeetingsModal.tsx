import React, { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckSquare, ChevronRight, Clock, Download, MapPin, Search, Square, Users, Video } from "lucide-react";
import { describeTopicError } from "../lib/agenda-topics";
import {
  alternarTodasVisiveis,
  dataEHorario,
  ehFutura,
  exportarReunioesDoTema,
  filtrarReunioes,
  idsParaExportar,
  listarReunioesDoTema,
  rotuloDoStatus,
  rotuloDoTemaNaReuniao,
  type FormatoDoArquivo,
  type RecorteTemporal,
  type ReuniaoDoTema
} from "../lib/topic-meetings";
import ModalShell, { BOTAO_CANCELAR, BOTAO_PRINCIPAL } from "./ModalShell";

/**
 * REUNIÕES DO TEMA — aberto pelo selo "N reuniões" do card da Biblioteca.
 *
 * Lista TODAS as reuniões em que o tema está na pauta (passadas, futuras e
 * canceladas), com busca livre, recorte Todas/Futuras/Passadas, seleção e
 * exportação (PDF ou Excel). Exporta a seleção; sem seleção, o que a lista
 * mostra. O servidor decide o conteúdo do arquivo.
 *
 * Fora do modo de seleção, clicar numa reunião fecha o modal e abre o
 * detalhe dela (`onOpenMeeting`).
 */
export default function TopicMeetingsModal({
  language,
  topicId,
  topicTitle,
  onClose,
  onOpenMeeting
}: {
  language: "en" | "pt";
  topicId: string;
  topicTitle: string;
  onClose: () => void;
  onOpenMeeting?: (meetingId: string) => void;
}) {
  const pt = language === "pt";
  const [reunioes, setReunioes] = useState<ReuniaoDoTema[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [recorte, setRecorte] = useState<RecorteTemporal>("todas");
  const [selecionando, setSelecionando] = useState(false);
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [formato, setFormato] = useState<FormatoDoArquivo>("pdf");
  const [exportando, setExportando] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    listarReunioesDoTema(topicId, c.signal)
      .then(setReunioes)
      .catch((e) => {
        if (!c.signal.aborted) setErro(describeTopicError(e, language));
      });
    return () => c.abort();
  }, [topicId, language]);

  const todas = reunioes ?? [];
  const visiveis = useMemo(() => filtrarReunioes(reunioes ?? [], busca, recorte, language), [reunioes, busca, recorte, language]);
  const qtdFuturas = todas.filter((r) => ehFutura(r)).length;
  const todasVisiveisMarcadas = visiveis.length > 0 && visiveis.every((r) => selecionadas.has(r.meetingId));
  const aExportar = idsParaExportar(todas, visiveis, selecionadas);
  const qtdAExportar = aExportar ? aExportar.length : todas.length;

  const alternar = (id: string) =>
    setSelecionadas((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const alternarSelecao = () => {
    if (selecionando) setSelecionadas(new Set());
    setSelecionando((v) => !v);
  };

  const exportar = async () => {
    if (exportando || qtdAExportar === 0) return;
    setExportando(true);
    setErro(null);
    try {
      await exportarReunioesDoTema(topicId, formato, aExportar);
    } catch (e) {
      setErro(describeTopicError(e, language));
    } finally {
      setExportando(false);
    }
  };

  const RECORTES: Array<[RecorteTemporal, string, number]> = [
    ["todas", pt ? "Todas" : "All", todas.length],
    ["futuras", pt ? "Futuras" : "Upcoming", qtdFuturas],
    ["passadas", pt ? "Passadas" : "Past", todas.length - qtdFuturas]
  ];

  return (
    <ModalShell
      language={language}
      icone={CalendarDays}
      largura="max-w-3xl"
      titulo={pt ? "Reuniões do tema" : "Topic meetings"}
      subtitulo={topicTitle}
      ocupado={exportando}
      onClose={onClose}
      rodape={
        <>
          <button type="button" onClick={onClose} disabled={exportando} className={BOTAO_CANCELAR}>
            {pt ? "Fechar" : "Close"}
          </button>
          <select
            aria-label={pt ? "Formato do arquivo" : "File format"}
            value={formato}
            onChange={(e) => setFormato(e.target.value as FormatoDoArquivo)}
            disabled={exportando}
            className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
          >
            <option value="pdf">PDF</option>
            <option value="xlsx">Excel</option>
          </select>
          <button
            type="button"
            onClick={() => void exportar()}
            disabled={exportando || reunioes === null || qtdAExportar === 0}
            className={BOTAO_PRINCIPAL}
          >
            <Download className="w-3.5 h-3.5" />
            {exportando
              ? pt ? "Gerando..." : "Generating..."
              : selecionadas.size > 0
                ? pt ? `Exportar selecionadas (${qtdAExportar})` : `Export selected (${qtdAExportar})`
                : pt ? `Exportar (${qtdAExportar})` : `Export (${qtdAExportar})`}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {/* Barra: busca + selecionar */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={pt ? "Buscar por reunião, comitê, data, status, local..." : "Search by meeting, committee, date, status, location..."}
              className="w-full bg-white border border-slate-200 rounded-xl pl-8 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
            />
          </div>
          <button
            type="button"
            onClick={alternarSelecao}
            aria-pressed={selecionando}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition cursor-pointer ${
              selecionando ? "bg-[#00658d] text-white border-[#00658d]" : "bg-white text-[#00658d] border-slate-200 hover:bg-sky-50"
            }`}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            {selecionando ? (pt ? "Cancelar seleção" : "Cancel selection") : pt ? "Selecionar" : "Select"}
          </button>
        </div>

        {/* Recorte + selecionar todas */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            {RECORTES.map(([id, rotulo, n]) => (
              <button
                key={id}
                type="button"
                onClick={() => setRecorte(id)}
                aria-pressed={recorte === id}
                className={`px-3 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                  recorte === id ? "bg-white text-[#00658d] shadow-xs" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {rotulo} <span className="text-slate-400">{n}</span>
              </button>
            ))}
          </div>
          {selecionando && (
            <div className="flex items-center gap-3 text-[11px] font-bold">
              <span className="text-slate-500">
                {selecionadas.size} {pt ? (selecionadas.size === 1 ? "selecionada" : "selecionadas") : "selected"}
              </span>
              <button
                type="button"
                onClick={() => setSelecionadas((s) => alternarTodasVisiveis(s, visiveis))}
                disabled={visiveis.length === 0}
                className="text-[#00658d] hover:underline cursor-pointer disabled:opacity-40"
              >
                {todasVisiveisMarcadas ? (pt ? "Desmarcar todas" : "Unselect all") : pt ? "Selecionar todas" : "Select all"}
              </button>
            </div>
          )}
        </div>

        {erro && (
          <p role="alert" className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{erro}</p>
        )}

        {/* Lista */}
        {reunioes === null && !erro ? (
          <p className="text-xs text-slate-400 font-semibold py-6 text-center">{pt ? "Carregando reuniões..." : "Loading meetings..."}</p>
        ) : visiveis.length === 0 ? (
          <p className="text-xs text-slate-400 font-semibold py-6 text-center">
            {todas.length === 0
              ? pt ? "Este tema ainda não está em nenhuma reunião." : "This topic is not in any meeting yet."
              : pt ? "Nenhuma reunião corresponde à busca." : "No meeting matches the search."}
          </p>
        ) : (
          <ul className="space-y-2">
            {visiveis.map((r) => {
              const { data, horario } = dataEHorario(r);
              const futura = ehFutura(r);
              const marcada = selecionadas.has(r.meetingId);
              const Conteudo = (
                <>
                  {selecionando &&
                    (marcada ? (
                      <CheckSquare className="w-4 h-4 text-[#00658d] shrink-0 mt-0.5" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />
                    ))}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${
                          r.cancelled
                            ? "bg-rose-50 text-rose-600 border-rose-100"
                            : futura
                              ? "bg-sky-50 text-[#00658d] border-sky-100"
                              : "bg-slate-50 text-slate-500 border-slate-200"
                        }`}
                      >
                        {r.cancelled ? (pt ? "Cancelada" : "Cancelled") : futura ? (pt ? "Futura" : "Upcoming") : pt ? "Passada" : "Past"}
                      </span>
                      {!r.cancelled && (
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-white text-slate-500 border border-slate-200">
                          {rotuloDoStatus(r, language)}
                        </span>
                      )}
                      {r.sessionType === "extraordinary" && (
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-50 text-amber-600 border border-amber-100">
                          {pt ? "Extraordinária" : "Extraordinary"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-extrabold text-[#001e2d] truncate">{r.title}</p>
                    <p className="text-[11px] font-semibold text-slate-500 truncate">{r.governanceBody}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] font-semibold text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" /> {data}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {horario}
                      </span>
                      <span className="inline-flex items-center gap-1 min-w-0">
                        {r.modality === "in_person" ? <MapPin className="w-3 h-3 shrink-0" /> : <Video className="w-3 h-3 shrink-0" />}
                        <span className="truncate">{r.modality === "in_person" ? r.location ?? (pt ? "Presencial" : "In person") : "Online"}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3 h-3" /> {r.participantsCount}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{pt ? "Tema nesta reunião" : "Topic here"}</p>
                    <p className="text-[11px] font-extrabold text-slate-700">{rotuloDoTemaNaReuniao(r.executionStatus, language)}</p>
                  </div>
                  {!selecionando && onOpenMeeting && (
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-[#00658d] shrink-0 self-center transition" />
                  )}
                </>
              );
              const caixa = `w-full text-left flex items-start gap-3 p-3 rounded-xl border transition ${
                marcada ? "border-[#00658d] bg-sky-50/40" : "border-slate-100 bg-slate-50/60"
              }`;
              return (
                <li key={r.meetingId}>
                  {selecionando ? (
                    <button type="button" onClick={() => alternar(r.meetingId)} aria-pressed={marcada} className={`${caixa} cursor-pointer hover:border-slate-300`}>
                      {Conteudo}
                    </button>
                  ) : onOpenMeeting ? (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenMeeting(r.meetingId);
                      }}
                      title={pt ? "Abrir reunião" : "Open meeting"}
                      className={`${caixa} group cursor-pointer hover:border-[#00658d]/40 hover:bg-white`}
                    >
                      {Conteudo}
                    </button>
                  ) : (
                    <div className={caixa}>{Conteudo}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ModalShell>
  );
}
