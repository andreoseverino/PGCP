import React, { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileText, FolderOpen, Info, Search } from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import {
  dataNoFuso,
  destinoDoContexto,
  downloadDocument,
  FILTROS_INICIAIS,
  listDocuments,
  mensagemDeVazio,
  rotuloDoTipo,
  type DocumentoDoPgcp,
  type FiltrosDaTela
} from "../lib/documents";

/**
 * DOCUMENTOS — biblioteca central do PGCP (MVP, leitura).
 *
 * Reúne os documentos que o PGCP já guarda — Atas das reuniões e as versões
 * enviadas/aprovadas da Agenda Anual — sem cópia: baixar usa a rota de origem
 * de cada um. Ainda NÃO há envio de arquivos (o PGCP não tem armazenamento de
 * arquivos definido); quando houver, os anexos entram nesta mesma lista.
 *
 * O órgão do contexto global filtra a lista; não é autorização (o servidor
 * decide o que cada pessoa pode ver).
 */

interface DocumentsViewProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  meetings: Meeting[];
  libraryTopics: Array<{ id: string; title: string }>;
  /** Órgão do contexto global ("" = todos). */
  orgaoContexto: string;
  onOpenMeeting: (meetingId: string) => void;
  onOpenAnnualAgenda: () => void;
  triggerToast: (msg: string) => void;
}

const PAGINA = 50;
const CAMPO =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#00658d]";
const ROTULO = "text-[9.5px] font-bold text-slate-400 uppercase tracking-wider";

export default function DocumentsView({
  language,
  governanceBodies,
  meetings,
  libraryTopics,
  orgaoContexto,
  onOpenMeeting,
  onOpenAnnualAgenda,
  triggerToast
}: DocumentsViewProps) {
  const pt = language === "pt";
  const [filtros, setFiltros] = useState<FiltrosDaTela>(FILTROS_INICIAIS);
  const [busca, setBusca] = useState("");
  const [docs, setDocs] = useState<DocumentoDoPgcp[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /** Quem emitiu (enviou a Agenda / editou a Ata por último) — opções do filtro "Emitido por". */
  const [autores, setAutores] = useState<Map<string, string>>(new Map());

  // Busca com pequena espera: uma consulta por pausa de digitação, não por tecla.
  useEffect(() => {
    const t = setTimeout(() => setFiltros((f) => (f.busca === busca ? f : { ...f, busca })), 300);
    return () => clearTimeout(t);
  }, [busca]);

  // Contexto global tem precedência sobre o filtro local de órgão.
  const efetivos = useMemo<FiltrosDaTela>(() => ({ ...filtros, orgao: orgaoContexto || filtros.orgao }), [filtros, orgaoContexto]);

  const carregar = async (offset: number, signal?: AbortSignal) => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await listDocuments(efetivos, { limit: PAGINA, offset }, signal);
      setDocs((atuais) => (offset === 0 ? r.documents : [...atuais, ...r.documents]));
      setTotal(r.total);
      setAutores((m) => {
        const novo = new Map(m);
        for (const d of r.documents) if (d.author) novo.set(d.author.id, d.author.name);
        return novo;
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErro(pt ? "Não foi possível carregar os documentos." : "Could not load documents.");
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    const c = new AbortController();
    void carregar(0, c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [efetivos]);

  const reunioesDoOrgao = useMemo(
    () =>
      meetings
        .filter((m) => !efetivos.orgao || m.governanceBodyId === efetivos.orgao)
        .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`)),
    [meetings, efetivos.orgao]
  );

  const mudar = <K extends keyof FiltrosDaTela>(k: K, v: FiltrosDaTela[K]) => setFiltros((f) => ({ ...f, [k]: v }));

  const baixar = async (d: DocumentoDoPgcp) => {
    try {
      const { blob, filename } = await downloadDocument(d);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename ?? `${d.name}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      triggerToast(pt ? "Não foi possível baixar o documento." : "Could not download the document.");
    }
  };

  const abrirContexto = (d: DocumentoDoPgcp) => {
    const destino = destinoDoContexto(d);
    if (destino === "pipeline" && d.meeting) onOpenMeeting(d.meeting.id);
    else if (destino === "annual-agenda") onOpenAnnualAgenda();
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h2 className="text-2xl font-extrabold text-[#001e2d] flex items-center gap-2">
          <FolderOpen className="w-6 h-6 text-[#00658d]" />
          {pt ? "Documentos" : "Documents"}
        </h2>
        <p className="text-xs text-slate-500 font-medium mt-1">
          {pt
            ? "Encontre os arquivos relacionados às reuniões, temas e órgãos colegiados do PGCP."
            : "Find the files related to PGCP meetings, topics and governance bodies."}
        </p>
      </div>

      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? "Por enquanto, aqui ficam as Atas das reuniões e as Agendas Anuais enviadas ou aprovadas. O envio de arquivos (PDF, PowerPoint) ainda não está disponível no PGCP."
          : "For now this lists meeting minutes and sent/approved Annual plans. File upload (PDF, PowerPoint) is not available in the PGCP yet."}
      </p>

      {/* Filtros */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="docBusca" className={ROTULO}>{pt ? "Buscar documento" : "Search document"}</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input id="docBusca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={pt ? "Nome do documento" : "Document name"} className={`${CAMPO} pl-9`} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="docOrgao" className={ROTULO}>{pt ? "Órgão colegiado" : "Governance body"}</label>
          <select id="docOrgao" value={efetivos.orgao} disabled={Boolean(orgaoContexto)} onChange={(e) => { mudar("orgao", e.target.value); mudar("reuniao", ""); }} className={`${CAMPO} cursor-pointer disabled:bg-slate-50`}
            title={orgaoContexto ? (pt ? "Definido pelo órgão selecionado no topo da tela" : "Set by the body selected at the top") : undefined}>
            <option value="">{pt ? "Todos" : "All"}</option>
            {governanceBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="docTipo" className={ROTULO}>{pt ? "Tipo" : "Type"}</label>
          <select id="docTipo" value={filtros.tipo} onChange={(e) => mudar("tipo", e.target.value as FiltrosDaTela["tipo"])} className={`${CAMPO} cursor-pointer`}>
            <option value="">{pt ? "Todos" : "All"}</option>
            <option value="ata">{rotuloDoTipo("ata", language)}</option>
            <option value="agenda_anual">{rotuloDoTipo("agenda_anual", language)}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="docReuniao" className={ROTULO}>{pt ? "Reunião" : "Meeting"}</label>
          <select id="docReuniao" value={filtros.reuniao} onChange={(e) => mudar("reuniao", e.target.value)} className={`${CAMPO} cursor-pointer`}>
            <option value="">{pt ? "Todas" : "All"}</option>
            {reunioesDoOrgao.map((m) => (
              <option key={m.id} value={m.id}>{`${m.date.split("-").reverse().join("/")} — ${m.title}`}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="docTema" className={ROTULO}>{pt ? "Tema da reunião" : "Meeting topic"}</label>
          <select id="docTema" value={filtros.tema} onChange={(e) => mudar("tema", e.target.value)} className={`${CAMPO} cursor-pointer`}>
            <option value="">{pt ? "Todos" : "All"}</option>
            {[...libraryTopics].sort((a, b) => a.title.localeCompare(b.title, "pt-BR")).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="docPessoa" className={ROTULO}>{pt ? "Emitido por" : "Issued by"}</label>
          <select id="docPessoa" value={filtros.pessoa} onChange={(e) => mudar("pessoa", e.target.value)} className={`${CAMPO} cursor-pointer`}
            title={pt ? "Quem enviou a Agenda ou editou a Ata por último" : "Who sent the plan or last edited the minutes"}>
            <option value="">{pt ? "Todas" : "All"}</option>
            {[...autores].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className={ROTULO}>{pt ? "Data do documento" : "Document date"}</span>
          <div className="flex items-center gap-1.5">
            <input type="date" aria-label={pt ? "De" : "From"} value={filtros.de} onChange={(e) => mudar("de", e.target.value)} className={CAMPO} />
            <input type="date" aria-label={pt ? "Até" : "To"} value={filtros.ate} onChange={(e) => mudar("ate", e.target.value)} className={CAMPO} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-slate-500 font-semibold">
          {carregando && docs.length === 0 ? (pt ? "Carregando..." : "Loading...") : pt ? `${total} documento(s)` : `${total} document(s)`}
        </p>
        <label className="flex items-center gap-2 text-[11px] text-slate-500 font-semibold">
          {pt ? "Ordenar por" : "Sort by"}
          <select value={filtros.ordem} onChange={(e) => mudar("ordem", e.target.value as FiltrosDaTela["ordem"])} className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[11px] cursor-pointer">
            <option value="recentes">{pt ? "Mais recentes" : "Newest"}</option>
            <option value="antigos">{pt ? "Mais antigos" : "Oldest"}</option>
            <option value="nome">{pt ? "Nome" : "Name"}</option>
          </select>
        </label>
      </div>

      {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {docs.length === 0 && !carregando ? (
          <p className="py-10 text-center text-xs text-slate-400 font-semibold">{mensagemDeVazio(filtros, orgaoContexto, language)}</p>
        ) : (
          <table className="w-full text-left text-xs table-fixed">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-3 px-4 w-[38%] md:w-[30%]">{pt ? "Documento" : "Document"}</th>
                <th className="py-3 px-2 hidden lg:table-cell">{pt ? "Tipo" : "Type"}</th>
                <th className="py-3 px-2 hidden md:table-cell">{pt ? "Órgão colegiado" : "Body"}</th>
                <th className="py-3 px-2">{pt ? "Reunião" : "Meeting"}</th>
                <th className="py-3 px-2 hidden xl:table-cell">{pt ? "Tema da reunião" : "Meeting topic"}</th>
                <th className="py-3 px-2 hidden lg:table-cell">{pt ? "Emitido por" : "Issued by"}</th>
                <th className="py-3 px-2 hidden sm:table-cell">{pt ? "Data" : "Date"}</th>
                <th className="py-3 px-4 text-right w-24">{pt ? "Ações" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t border-slate-100 align-top">
                  <td className="py-3 px-4">
                    <div className="flex items-start gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-[#00658d] shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="font-bold text-slate-800 truncate" title={d.name}>{d.name}</p>
                        <p className="text-[10px] text-slate-400 font-semibold truncate">{d.format} · {pt ? "Gerado pelo PGCP" : "Generated by PGCP"} · {d.status}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-2 text-slate-600 hidden lg:table-cell">{rotuloDoTipo(d.type, language)}</td>
                  <td className="py-3 px-2 text-slate-600 hidden md:table-cell truncate" title={d.governanceBody.name}>{d.governanceBody.name}</td>
                  <td className="py-3 px-2 text-slate-600 min-w-0">
                    {d.meeting ? (
                      <>
                        <p className="truncate" title={d.meeting.title}>{d.meeting.title}</p>
                        <p className="text-[10px] text-slate-400">{pt ? "Reunião em " : "Meeting on "}{dataNoFuso(d.meeting.startAt, d.meeting.timezone)}</p>
                      </>
                    ) : (
                      <span className="text-slate-400">{d.annualAgenda ? (pt ? `Agenda Anual ${d.annualAgenda.year}` : `Annual plan ${d.annualAgenda.year}`) : "—"}</span>
                    )}
                  </td>
                  {/* Atas e Agendas são documentos da reunião/agenda, não de um tema. */}
                  <td className="py-3 px-2 text-slate-400 hidden xl:table-cell">{d.meeting ? (pt ? "Toda a reunião" : "Whole meeting") : "—"}</td>
                  <td className="py-3 px-2 text-slate-600 hidden lg:table-cell truncate">{d.author?.name || "—"}</td>
                  <td className="py-3 px-2 text-slate-600 hidden sm:table-cell">{dataNoFuso(d.documentAt, "America/Sao_Paulo")}</td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button type="button" onClick={() => void baixar(d)} className="p-1.5 text-[#00658d] hover:bg-sky-50 rounded-lg cursor-pointer"
                      title={pt ? "Baixar" : "Download"} aria-label={pt ? `Baixar ${d.name}` : `Download ${d.name}`}>
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    {destinoDoContexto(d) && (
                      <button type="button" onClick={() => abrirContexto(d)} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"
                        title={destinoDoContexto(d) === "pipeline" ? (pt ? "Abrir a reunião" : "Open meeting") : pt ? "Abrir a Agenda Anual" : "Open Annual plan"}
                        aria-label={pt ? `Abrir contexto de ${d.name}` : `Open context of ${d.name}`}>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {docs.length < total && (
        <div className="flex justify-center">
          <button type="button" disabled={carregando} onClick={() => void carregar(docs.length)}
            className="px-4 py-2 text-xs font-bold text-[#00658d] border border-[#00658d]/30 rounded-xl hover:bg-sky-50 cursor-pointer disabled:opacity-50">
            {carregando ? (pt ? "Carregando..." : "Loading...") : pt ? "Carregar mais" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
