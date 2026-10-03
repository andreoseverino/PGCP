import React, { useEffect, useMemo, useState } from "react";
import { CalendarRange, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderTree, Search, X } from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import {
  destinoDoContexto,
  downloadDocument,
  filtrosDaPasta,
  FILTROS_INICIAIS,
  getDocumentsTree,
  listDocuments,
  mensagemDeVazio,
  NOMES_DOS_MESES,
  rotuloDaReuniaoNaArvore,
  rotuloDoTipo,
  salvarArquivo,
  secoesDaReuniao,
  trilhaDaPasta,
  type ArvoreDeDocumentos,
  type DocumentoDoPgcp,
  type FiltrosDaTela,
  type PastaSelecionada
} from "../lib/documents";
import DocumentItem from "./DocumentItem";

/**
 * DOCUMENTOS — biblioteca central do PGCP.
 *
 * Reúne os anexos enviados no Pipeline (reunião inteira ou tema da reunião) e
 * os documentos que o PGCP gera (Atas, versão vigente da Agenda Anual). As
 * pastas à esquerda são VISUAIS — Órgão → Ano → (Agenda Anual | Mês → "DD/MM —
 * Reunião") — montadas dos metadados pela API; não há pasta no banco nem
 * leitura do bucket. Enviar arquivo é no Pipeline, dentro da reunião.
 *
 * O órgão do contexto global filtra; não é autorização (o servidor decide o
 * que cada pessoa pode ver e baixar).
 */

interface DocumentsViewProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  meetings: Meeting[];
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

const mesmaPasta = (a: PastaSelecionada, b: PastaSelecionada) => JSON.stringify(a) === JSON.stringify(b);

export default function DocumentsView({
  language,
  governanceBodies,
  meetings,
  orgaoContexto,
  onOpenMeeting,
  onOpenAnnualAgenda,
  triggerToast
}: DocumentsViewProps) {
  const pt = language === "pt";
  const [pasta, setPasta] = useState<PastaSelecionada>({ tipo: "todos" });
  const [filtros, setFiltros] = useState<FiltrosDaTela>(FILTROS_INICIAIS);
  const [busca, setBusca] = useState("");
  const [docs, setDocs] = useState<DocumentoDoPgcp[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [arvore, setArvore] = useState<ArvoreDeDocumentos | null>(null);
  const [erroArvore, setErroArvore] = useState(false);
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [gavetaAberta, setGavetaAberta] = useState(false);
  /** Quem enviou/emitiu — opções do filtro, acumuladas do que já veio. */
  const [autores, setAutores] = useState<Map<string, string>>(new Map());
  /** Temas da reunião aberta (dos anexos dela) — opções do filtro de tema. */
  const [temasDaReuniao, setTemasDaReuniao] = useState<Map<string, string>>(new Map());

  // Busca com pequena espera: uma consulta por pausa de digitação, não por tecla.
  useEffect(() => {
    const t = setTimeout(() => setFiltros((f) => (f.busca === busca ? f : { ...f, busca })), 300);
    return () => clearTimeout(t);
  }, [busca]);

  // Contexto global muda: volta para a raiz (a pasta anterior pode ser de outro órgão).
  useEffect(() => {
    setPasta(orgaoContexto ? { tipo: "orgao", orgaoId: orgaoContexto } : { tipo: "todos" });
  }, [orgaoContexto]);

  useEffect(() => {
    const c = new AbortController();
    setErroArvore(false);
    getDocumentsTree(orgaoContexto, c.signal)
      .then((a) => {
        setArvore(a);
        // Um órgão só: já abre para mostrar os anos.
        if (a.bodies.length === 1) setAbertos((s) => new Set(s).add(`b:${a.bodies[0]!.id}`));
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErroArvore(true);
      });
    return () => c.abort();
  }, [orgaoContexto]);

  useEffect(() => setTemasDaReuniao(new Map()), [pasta]);

  // Pasta → filtros de contexto; o órgão do topo tem precedência.
  const efetivos = useMemo<FiltrosDaTela>(() => {
    const f = filtrosDaPasta(pasta, filtros);
    return { ...f, orgao: orgaoContexto || f.orgao };
  }, [pasta, filtros, orgaoContexto]);

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
      if (pasta.tipo === "reuniao") {
        setTemasDaReuniao((m) => {
          const novo = new Map(m);
          for (const d of r.documents) if (d.topic) novo.set(d.topic.id, d.topic.title);
          return novo;
        });
      }
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

  const mudar = <K extends keyof FiltrosDaTela>(k: K, v: FiltrosDaTela[K]) => setFiltros((f) => ({ ...f, [k]: v }));

  const selecionar = (p: PastaSelecionada) => {
    setPasta(p);
    setGavetaAberta(false);
  };

  const alternar = (chave: string) =>
    setAbertos((s) => {
      const novo = new Set(s);
      if (novo.has(chave)) novo.delete(chave);
      else novo.add(chave);
      return novo;
    });

  /** Seletor "Reunião": leva à pasta da reunião (ano/mês do dia local dela). */
  const irParaReuniao = (id: string) => {
    if (!id) {
      selecionar(orgaoContexto ? { tipo: "orgao", orgaoId: orgaoContexto } : { tipo: "todos" });
      return;
    }
    const m = meetings.find((x) => x.id === id);
    if (!m?.governanceBodyId) return;
    selecionar({ tipo: "reuniao", orgaoId: m.governanceBodyId, ano: Number(m.date.slice(0, 4)), mes: Number(m.date.slice(5, 7)), reuniaoId: id });
  };

  const reunioesDoOrgao = useMemo(
    () =>
      meetings
        .filter((m) => !efetivos.orgao || m.governanceBodyId === efetivos.orgao)
        .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`)),
    [meetings, efetivos.orgao]
  );

  const baixar = async (d: DocumentoDoPgcp) => {
    try {
      const { blob, filename } = await downloadDocument(d);
      salvarArquivo(blob, filename ?? (d.extension ? `${d.name}.${d.extension}` : d.name));
    } catch (e) {
      const status = (e as { status?: number }).status;
      triggerToast(
        status === 503
          ? pt ? "Armazenamento de documentos indisponível no momento." : "Document storage is unavailable."
          : pt ? "Não foi possível baixar o documento." : "Could not download the document."
      );
    }
  };

  const abrirContexto = (d: DocumentoDoPgcp) => {
    const destino = destinoDoContexto(d);
    if (destino === "pipeline" && d.meeting) onOpenMeeting(d.meeting.id);
    else if (destino === "annual-agenda") onOpenAnnualAgenda();
  };

  const trilha = trilhaDaPasta(pasta, arvore, language);
  const secoes = pasta.tipo === "reuniao" ? secoesDaReuniao(docs) : null;

  const itemDaArvore = (
    p: PastaSelecionada,
    rotulo: string,
    totalDaPasta: number | null,
    nivel: number,
    chave?: string,
    icone: "pasta" | "agenda" | "reuniao" = "pasta"
  ) => {
    const ativo = mesmaPasta(p, pasta);
    const aberto = chave ? abertos.has(chave) : false;
    const Icone = icone === "agenda" ? CalendarRange : icone === "reuniao" ? FileText : ativo || aberto ? FolderOpen : Folder;
    return (
      <div className="flex items-center" style={{ paddingLeft: nivel * 12 }}>
        {chave ? (
          <button
            type="button"
            onClick={() => alternar(chave)}
            aria-expanded={aberto}
            aria-label={aberto ? (pt ? `Recolher ${rotulo}` : `Collapse ${rotulo}`) : pt ? `Expandir ${rotulo}` : `Expand ${rotulo}`}
            className="p-0.5 text-slate-400 hover:text-slate-700 cursor-pointer"
          >
            {aberto ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          type="button"
          onClick={() => {
            selecionar(p);
            if (chave && !aberto) alternar(chave);
          }}
          aria-current={ativo ? "true" : undefined}
          className={`flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-left text-[11px] cursor-pointer ${
            ativo ? "bg-[#00658d] text-white font-bold" : "text-slate-700 hover:bg-slate-100 font-semibold"
          }`}
        >
          <Icone className={`w-3.5 h-3.5 shrink-0 ${ativo ? "text-white" : "text-[#00658d]"}`} />
          <span className="truncate" title={rotulo}>{rotulo}</span>
          {totalDaPasta !== null && <span className={`ml-auto text-[9.5px] ${ativo ? "text-white/80" : "text-slate-400"}`}>{totalDaPasta}</span>}
        </button>
      </div>
    );
  };

  const arvoreRenderizada = (
    <nav aria-label={pt ? "Pastas de documentos" : "Document folders"} className="space-y-0.5">
      {!orgaoContexto && itemDaArvore({ tipo: "todos" }, pt ? "Todos os documentos" : "All documents", null, 0)}
      {erroArvore && <p className="text-[10.5px] text-red-600 font-semibold px-2 py-1">{pt ? "Não foi possível carregar as pastas." : "Could not load folders."}</p>}
      {arvore && arvore.bodies.length === 0 && (
        <p className="text-[10.5px] text-slate-400 font-semibold px-2 py-1">{pt ? "Nenhuma pasta com documentos." : "No folders with documents."}</p>
      )}
      {arvore?.bodies.map((b) => {
        const cb = `b:${b.id}`;
        return (
          <div key={b.id}>
            {itemDaArvore({ tipo: "orgao", orgaoId: b.id }, b.name, b.total, 0, cb)}
            {abertos.has(cb) &&
              b.years.map((y) => {
                const cy = `y:${b.id}:${y.year}`;
                return (
                  <div key={y.year}>
                    {itemDaArvore({ tipo: "ano", orgaoId: b.id, ano: y.year }, String(y.year), null, 1, cy)}
                    {abertos.has(cy) && (
                      <>
                        {y.annualAgendas.map((a) => (
                          <div key={a.id}>
                            {itemDaArvore(
                              { tipo: "agenda", orgaoId: b.id, ano: y.year, agendaId: a.id },
                              pt ? `Agenda Anual${a.title ? ` — ${a.title}` : ""}` : `Annual plan${a.title ? ` — ${a.title}` : ""}`,
                              a.total,
                              2,
                              undefined,
                              "agenda"
                            )}
                          </div>
                        ))}
                        {y.months.map((mm) => {
                          const cm = `m:${b.id}:${y.year}:${mm.month}`;
                          return (
                            <div key={mm.month}>
                              {itemDaArvore(
                                { tipo: "mes", orgaoId: b.id, ano: y.year, mes: mm.month },
                                NOMES_DOS_MESES[mm.month - 1] ?? String(mm.month),
                                mm.meetings.reduce((s, r) => s + r.total, 0),
                                2,
                                cm
                              )}
                              {abertos.has(cm) &&
                                mm.meetings.map((r) => (
                                  <div key={r.id}>
                                    {itemDaArvore(
                                      { tipo: "reuniao", orgaoId: b.id, ano: y.year, mes: mm.month, reuniaoId: r.id },
                                      rotuloDaReuniaoNaArvore(r),
                                      r.total,
                                      3,
                                      undefined,
                                      "reuniao"
                                    )}
                                  </div>
                                ))}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </nav>
  );

  const lista = (itens: DocumentoDoPgcp[], mostrarReuniao = true) => (
    <ul className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      {itens.map((d) => (
        <DocumentItem
          key={d.id}
          doc={d}
          language={language}
          mostrarReuniao={mostrarReuniao}
          onDownload={(x) => void baixar(x)}
          onOpenContext={destinoDoContexto(d) ? abrirContexto : undefined}
        />
      ))}
    </ul>
  );

  const secao = (titulo: string, itens: DocumentoDoPgcp[], vazio: string) => (
    <section className="space-y-2">
      <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{titulo}</h4>
      {itens.length === 0 ? <p className="text-[11px] text-slate-400 font-semibold px-1">{vazio}</p> : lista(itens, false)}
    </section>
  );

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-start justify-between gap-3">
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
          <p className="text-[11px] text-slate-400 font-medium mt-1">
            {pt
              ? "Para adicionar um arquivo, abra a reunião no Pipeline e use “Adicionar documento”."
              : "To add a file, open the meeting in the Pipeline and use “Add document”."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setGavetaAberta(true)}
          className="lg:hidden shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 cursor-pointer"
        >
          <FolderTree className="w-4 h-4 text-[#00658d]" />
          {pt ? "Pastas" : "Folders"}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[270px_minmax(0,1fr)] gap-5 items-start">
        {/* Árvore: coluna fixa no desktop; gaveta no celular. */}
        <aside className="hidden lg:block bg-white border border-slate-200 rounded-2xl p-3 max-h-[75vh] overflow-y-auto sticky top-4">
          {arvoreRenderizada}
        </aside>
        {gavetaAberta && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={pt ? "Pastas" : "Folders"}>
            <div className="absolute inset-0 bg-slate-900/40" onClick={() => setGavetaAberta(false)} />
            <div className="absolute left-0 top-0 bottom-0 w-[85%] max-w-xs bg-white p-4 overflow-y-auto shadow-xl">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-extrabold text-slate-800">{pt ? "Pastas" : "Folders"}</p>
                <button type="button" onClick={() => setGavetaAberta(false)} aria-label={pt ? "Fechar" : "Close"} className="p-1 text-slate-500 cursor-pointer">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {arvoreRenderizada}
            </div>
          </div>
        )}

        <div className="space-y-4 min-w-0">
          {/* Trilha da pasta */}
          <p className="text-[11px] font-bold text-slate-500 flex flex-wrap items-center gap-1" aria-label={pt ? "Pasta atual" : "Current folder"}>
            {trilha.map((parte, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300" />}
                <span className={i === trilha.length - 1 ? "text-slate-800" : ""}>{parte}</span>
              </React.Fragment>
            ))}
          </p>

          {/* Filtros */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor="docBusca" className={ROTULO}>{pt ? "Buscar documento" : "Search document"}</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  id="docBusca"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={pt ? "Ex.: promoção outubro pptx" : "E.g.: promotion october pptx"}
                  className={`${CAMPO} pl-9`}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="docOrgao" className={ROTULO}>{pt ? "Órgão colegiado" : "Governance body"}</label>
              <select
                id="docOrgao"
                value={efetivos.orgao}
                disabled={Boolean(orgaoContexto)}
                onChange={(e) => selecionar(e.target.value ? { tipo: "orgao", orgaoId: e.target.value } : { tipo: "todos" })}
                className={`${CAMPO} cursor-pointer disabled:bg-slate-50`}
                title={orgaoContexto ? (pt ? "Definido pelo órgão selecionado no topo da tela" : "Set by the body selected at the top") : undefined}
              >
                <option value="">{pt ? "Todos" : "All"}</option>
                {governanceBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="docReuniao" className={ROTULO}>{pt ? "Reunião" : "Meeting"}</label>
              <select id="docReuniao" value={efetivos.reuniao} onChange={(e) => irParaReuniao(e.target.value)} className={`${CAMPO} cursor-pointer`}>
                <option value="">{pt ? "Todas" : "All"}</option>
                {reunioesDoOrgao.map((m) => (
                  <option key={m.id} value={m.id}>{`${m.date.split("-").reverse().join("/")} — ${m.title}`}</option>
                ))}
              </select>
            </div>
            {pasta.tipo === "reuniao" && (
              <div className="flex flex-col gap-1">
                <label htmlFor="docTema" className={ROTULO}>{pt ? "Tema da reunião" : "Meeting topic"}</label>
                <select id="docTema" value={filtros.tema} onChange={(e) => mudar("tema", e.target.value)} className={`${CAMPO} cursor-pointer`}>
                  <option value="">{pt ? "Todos" : "All"}</option>
                  {[...temasDaReuniao].map(([id, titulo]) => <option key={id} value={id}>{titulo}</option>)}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label htmlFor="docTipo" className={ROTULO}>{pt ? "Tipo" : "Type"}</label>
              <select id="docTipo" value={filtros.tipo} onChange={(e) => mudar("tipo", e.target.value as FiltrosDaTela["tipo"])} className={`${CAMPO} cursor-pointer`}>
                <option value="">{pt ? "Todos" : "All"}</option>
                <option value="anexo">{rotuloDoTipo("anexo", language)}</option>
                <option value="ata">{rotuloDoTipo("ata", language)}</option>
                <option value="agenda_anual">{rotuloDoTipo("agenda_anual", language)}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="docOrigem" className={ROTULO}>{pt ? "Origem" : "Source"}</label>
              <select id="docOrigem" value={filtros.origem} onChange={(e) => mudar("origem", e.target.value as FiltrosDaTela["origem"])} className={`${CAMPO} cursor-pointer`}>
                <option value="">{pt ? "Todas" : "All"}</option>
                <option value="pgcp">{pt ? "Gerado pelo PGCP" : "Generated by PGCP"}</option>
                <option value="user">{pt ? "Enviado por usuário" : "Uploaded by user"}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="docPessoa" className={ROTULO}>{pt ? "Emitido/enviado por" : "Issued/uploaded by"}</label>
              <select id="docPessoa" value={filtros.pessoa} onChange={(e) => mudar("pessoa", e.target.value)} className={`${CAMPO} cursor-pointer`}
                title={pt ? "Quem enviou o arquivo, enviou a Agenda ou editou a Ata por último" : "Who uploaded the file, sent the plan or last edited the minutes"}>
                <option value="">{pt ? "Todas" : "All"}</option>
                {[...autores].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2 xl:col-span-1">
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

          {docs.length === 0 && !carregando ? (
            <p className="py-10 text-center text-xs text-slate-400 font-semibold bg-white border border-slate-200 rounded-2xl">
              {mensagemDeVazio(efetivos, orgaoContexto, language)}
            </p>
          ) : secoes ? (
            <div className="space-y-5">
              {secao(pt ? "Documentos da reunião" : "Meeting documents", secoes.gerais, pt ? "Nenhum anexo da reunião inteira." : "No whole-meeting attachments.")}
              <section className="space-y-2">
                <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{pt ? "Temas" : "Topics"}</h4>
                {secoes.temas.length === 0 ? (
                  <p className="text-[11px] text-slate-400 font-semibold px-1">{pt ? "Nenhum anexo de tema." : "No topic attachments."}</p>
                ) : (
                  secoes.temas.map((t) => (
                    <div key={t.tema.id} className="space-y-1.5">
                      <p className="text-[11px] font-bold text-amber-800 px-1">{t.tema.title}</p>
                      {lista(t.docs, false)}
                    </div>
                  ))
                )}
              </section>
              {secao(pt ? "Ata" : "Minutes", secoes.atas, pt ? "Ata ainda não registrada." : "Minutes not recorded yet.")}
            </div>
          ) : (
            lista(docs)
          )}

          {docs.length < total && (
            <div className="flex justify-center">
              <button type="button" disabled={carregando} onClick={() => void carregar(docs.length)}
                className="px-4 py-2 text-xs font-bold text-[#00658d] border border-[#00658d]/30 rounded-xl hover:bg-sky-50 cursor-pointer disabled:opacity-50">
                {carregando ? (pt ? "Carregando..." : "Loading...") : pt ? "Carregar mais" : "Load more"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
