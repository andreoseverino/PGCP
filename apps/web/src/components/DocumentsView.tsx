import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderTree,
  LayoutGrid,
  Library,
  List,
  MoreVertical,
  Plus,
  Presentation,
  Search,
  Star,
  Upload,
  X
} from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import {
  dataNoFuso,
  destinoDoContexto,
  downloadDocument,
  filtrosDaPasta,
  filtrosDaVisao,
  FILTROS_INICIAIS,
  FORMATOS,
  getDocumentsTree,
  getStorageSummary,
  listDocuments,
  mensagemDeVazio,
  NOMES_DOS_MESES,
  pastasFilhas,
  periodoDoModificado,
  rotuloDaReuniaoNaArvore,
  rotuloDoFormato,
  rotuloDoTipo,
  salvarArquivo,
  secoesDaReuniao,
  diasDoMes,
  rotuloDoDia,
  setDocumentFavorite,
  tamanhoLegivel,
  trilhaNavegavel,
  type ArvoreDeDocumentos,
  type DocumentoDoPgcp,
  type FiltrosDaTela,
  type FormatoDoDocumento,
  type OpcaoModificado,
  type PastaSelecionada,
  type ResumoDoArmazenamento,
  type VisaoDaBiblioteca
} from "../lib/documents";
import UploadDocumentModal from "./UploadDocumentModal";

/**
 * DOCUMENTOS — biblioteca central do PGCP, com a navegação do Google Drive
 * como REFERÊNCIA de experiência (não cópia):
 *
 *   lateral    + Novo · Biblioteca · Recentes · Favoritos · Armazenamento
 *              e, separadas, as PASTAS — a mesma árvore VISUAL de antes,
 *              Órgão → Ano → (Agenda Anual | Mês → "DD/MM — Reunião"), montada
 *              dos metadados pela API. Não há pasta no banco: "Nova pasta" e
 *              Lixeira ficaram fora (decisão de produto pendente).
 *   principal  breadcrumb clicável, busca, filtros em chips, seção Pastas
 *              (subpastas do local atual) e Arquivos em blocos ou lista.
 *
 * "Enviar arquivo" reaproveita o upload que já existia (anexo da reunião, no
 * S3, `PGCP.Assessoria`): só dentro da pasta de uma reunião ativa. Favorito é
 * preferência pessoal (servidor confere o acesso). O órgão do contexto global
 * filtra; não é autorização — o servidor decide o que cada pessoa vê e baixa.
 */

interface DocumentsViewProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  meetings: Meeting[];
  /** Órgão do contexto global ("" = todos). */
  orgaoContexto: string;
  /** Pode enviar anexo (cortesia; o servidor exige `PGCP.Assessoria`). */
  canUpload?: boolean;
  onOpenMeeting: (meetingId: string) => void;
  onOpenAnnualAgenda: () => void;
  triggerToast: (msg: string) => void;
}

const PAGINA = 50;
const CHIP =
  "bg-white border border-slate-200 rounded-full pl-3 pr-7 py-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer hover:bg-slate-50 focus:outline-none focus:ring-1 focus:ring-[#00658d] appearance-none bg-no-repeat bg-[length:12px] bg-[right_8px_center] max-w-[220px] truncate";
const SETA_DO_CHIP =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";
const ATIVO = "!bg-sky-50 !border-[#00658d]/40 !text-[#00658d]";

const mesmaPasta = (a: PastaSelecionada, b: PastaSelecionada) => JSON.stringify(a) === JSON.stringify(b);

const ICONE_DO_FORMATO: Record<FormatoDoDocumento, { Icone: typeof File; cor: string; fundo: string }> = {
  pdf: { Icone: FileText, cor: "text-red-600", fundo: "bg-red-50" },
  documento: { Icone: FileText, cor: "text-blue-600", fundo: "bg-blue-50" },
  planilha: { Icone: FileSpreadsheet, cor: "text-emerald-600", fundo: "bg-emerald-50" },
  apresentacao: { Icone: Presentation, cor: "text-amber-600", fundo: "bg-amber-50" },
  imagem: { Icone: FileImage, cor: "text-violet-600", fundo: "bg-violet-50" },
  video: { Icone: FileVideo, cor: "text-pink-600", fundo: "bg-pink-50" },
  outros: { Icone: File, cor: "text-slate-500", fundo: "bg-slate-100" }
};

const hojeEmBrasilia = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

export default function DocumentsView({
  language,
  governanceBodies,
  meetings,
  orgaoContexto,
  canUpload = false,
  onOpenMeeting,
  onOpenAnnualAgenda,
  triggerToast
}: DocumentsViewProps) {
  const pt = language === "pt";
  const [visao, setVisao] = useState<VisaoDaBiblioteca>("biblioteca");
  const [pasta, setPasta] = useState<PastaSelecionada>({ tipo: "todos" });
  const [filtros, setFiltros] = useState<FiltrosDaTela>(FILTROS_INICIAIS);
  const [modificado, setModificado] = useState<OpcaoModificado>("");
  const [busca, setBusca] = useState("");
  const [modo, setModo] = useState<"blocos" | "lista">("blocos");
  const [docs, setDocs] = useState<DocumentoDoPgcp[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [arvore, setArvore] = useState<ArvoreDeDocumentos | null>(null);
  const [erroArvore, setErroArvore] = useState(false);
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [gavetaAberta, setGavetaAberta] = useState(false);
  const [menuNovo, setMenuNovo] = useState(false);
  const [menuDoItem, setMenuDoItem] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [armazenamento, setArmazenamento] = useState<ResumoDoArmazenamento | null>(null);
  const [erroArmazenamento, setErroArmazenamento] = useState(false);
  /** Quem enviou/emitiu — opções do filtro, acumuladas do que já veio. */
  const [autores, setAutores] = useState<Map<string, string>>(new Map());
  /** Temas da reunião aberta (dos anexos dela) — filtro de tema e envio. */
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
        if (a.bodies.length === 1) setAbertos((s) => new Set(s).add(`b:${a.bodies[0]!.id}`));
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErroArvore(true);
      });
    return () => c.abort();
  }, [orgaoContexto, recarga]);

  useEffect(() => setTemasDaReuniao(new Map()), [pasta]);

  // Fecha o menu ⋮ ao clicar fora.
  useEffect(() => {
    if (!menuDoItem && !menuNovo) return;
    const fechar = () => {
      setMenuDoItem(null);
      setMenuNovo(false);
    };
    document.addEventListener("click", fechar);
    return () => document.removeEventListener("click", fechar);
  }, [menuDoItem, menuNovo]);

  // Pasta → filtros de contexto; visão (Recentes/Favoritos) por cima; o órgão do topo tem precedência.
  const efetivos = useMemo<FiltrosDaTela>(() => {
    const daPasta = visao === "biblioteca" ? filtrosDaPasta(pasta, filtros) : filtros;
    const f = filtrosDaVisao(visao, daPasta);
    return { ...f, orgao: orgaoContexto || f.orgao };
  }, [pasta, filtros, orgaoContexto, visao]);

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
    if (visao === "armazenamento") return;
    const c = new AbortController();
    void carregar(0, c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [efetivos, visao, recarga]);

  useEffect(() => {
    if (visao !== "armazenamento") return;
    const c = new AbortController();
    setErroArmazenamento(false);
    getStorageSummary(orgaoContexto, c.signal)
      .then(setArmazenamento)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErroArmazenamento(true);
      });
    return () => c.abort();
  }, [visao, orgaoContexto, recarga]);

  const mudar = <K extends keyof FiltrosDaTela>(k: K, v: FiltrosDaTela[K]) => setFiltros((f) => ({ ...f, [k]: v }));

  const escolherModificado = (opcao: OpcaoModificado) => {
    setModificado(opcao);
    if (opcao === "personalizado") return; // datas escolhidas nos campos abaixo
    const periodo = periodoDoModificado(opcao, hojeEmBrasilia());
    setFiltros((f) => ({ ...f, de: periodo?.de ?? "", ate: periodo?.ate ?? "" }));
  };

  const selecionar = (p: PastaSelecionada) => {
    setVisao("biblioteca");
    setPasta(p);
    setGavetaAberta(false);
  };

  /** Entrar numa subpasta (seção Pastas): seleciona e abre o caminho na árvore lateral. */
  const entrarNaPasta = (p: PastaSelecionada) => {
    selecionar(p);
    const chave =
      p.tipo === "orgao"
        ? `b:${p.orgaoId}`
        : p.tipo === "ano"
          ? `y:${p.orgaoId}:${p.ano}`
          : p.tipo === "mes"
            ? `m:${p.orgaoId}:${p.ano}:${p.mes}`
            : p.tipo === "dia"
              ? `d:${p.orgaoId}:${p.ano}:${p.mes}:${p.dia}`
              : null;
    if (chave) setAbertos((s) => new Set(s).add(chave));
  };

  const irParaVisao = (v: VisaoDaBiblioteca) => {
    setVisao(v);
    setGavetaAberta(false);
    if (v === "biblioteca") setPasta(orgaoContexto ? { tipo: "orgao", orgaoId: orgaoContexto } : { tipo: "todos" });
  };

  const alternar = (chave: string) =>
    setAbertos((s) => {
      const novo = new Set(s);
      if (novo.has(chave)) novo.delete(chave);
      else novo.add(chave);
      return novo;
    });

  /** Chip "Reunião": leva à pasta da reunião (ano/mês do dia local dela). */
  const irParaReuniao = (id: string) => {
    if (!id) {
      selecionar(orgaoContexto ? { tipo: "orgao", orgaoId: orgaoContexto } : { tipo: "todos" });
      return;
    }
    const m = meetings.find((x) => x.id === id);
    if (!m?.governanceBodyId) return;
    selecionar({
      tipo: "reuniao",
      orgaoId: m.governanceBodyId,
      ano: Number(m.date.slice(0, 4)),
      mes: Number(m.date.slice(5, 7)),
      dia: Number(m.date.slice(8, 10)),
      reuniaoId: id
    });
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

  /** Favorito otimista; erro desfaz e avisa. O servidor confere o acesso. */
  const alternarFavorito = async (d: DocumentoDoPgcp) => {
    const novo = !d.favorite;
    setDocs((lista) =>
      visao === "favoritos" && !novo ? lista.filter((x) => x.id !== d.id) : lista.map((x) => (x.id === d.id ? { ...x, favorite: novo } : x))
    );
    try {
      await setDocumentFavorite(d.id, novo);
    } catch {
      setRecarga((n) => n + 1);
      triggerToast(pt ? "Não foi possível atualizar o favorito." : "Could not update the favorite.");
    }
  };

  // "Enviar arquivo": só na pasta de uma reunião ATIVA (cancelada não aparece em `meetings`).
  const reuniaoParaEnvio =
    visao === "biblioteca" && pasta.tipo === "reuniao" && meetings.some((m) => m.id === pasta.reuniaoId) ? pasta.reuniaoId : null;
  const podeEnviar = canUpload && reuniaoParaEnvio !== null;

  const trilha = trilhaNavegavel(pasta, arvore, language);
  const subpastas = visao === "biblioteca" ? pastasFilhas(pasta, arvore, language) : [];
  const secoes = visao === "biblioteca" && pasta.tipo === "reuniao" ? secoesDaReuniao(docs) : null;
  const tituloDaVisao: Record<Exclude<VisaoDaBiblioteca, "biblioteca">, string> = {
    recentes: pt ? "Recentes" : "Recent",
    favoritos: pt ? "Favoritos" : "Starred",
    armazenamento: pt ? "Armazenamento" : "Storage"
  };

  // --- Árvore de pastas (a MESMA estrutura derivada de antes) ------------------------

  const itemDaArvore = (
    p: PastaSelecionada,
    rotulo: string,
    totalDaPasta: number | null,
    nivel: number,
    chave?: string,
    icone: "pasta" | "agenda" | "reuniao" = "pasta"
  ) => {
    const ativo = visao === "biblioteca" && mesmaPasta(p, pasta);
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
            ativo ? "bg-sky-100 text-[#00658d] font-bold" : "text-slate-700 hover:bg-slate-100 font-semibold"
          }`}
        >
          <Icone className="w-3.5 h-3.5 shrink-0 text-[#00658d]" />
          <span className="truncate" title={rotulo}>{rotulo}</span>
          {totalDaPasta !== null && <span className="ml-auto text-[9.5px] text-slate-400">{totalDaPasta}</span>}
        </button>
      </div>
    );
  };

  const arvoreRenderizada = (
    <nav aria-label={pt ? "Pastas de documentos" : "Document folders"} className="space-y-0.5">
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
                                diasDoMes(mm.meetings).map((d) => {
                                  const cd = `d:${b.id}:${y.year}:${mm.month}:${d.dia}`;
                                  return (
                                    <div key={d.dia}>
                                      {itemDaArvore(
                                        { tipo: "dia", orgaoId: b.id, ano: y.year, mes: mm.month, dia: d.dia },
                                        rotuloDoDia(d.dia, mm.month),
                                        d.meetings.reduce((s, r) => s + r.total, 0),
                                        3,
                                        cd
                                      )}
                                      {abertos.has(cd) &&
                                        d.meetings.map((r) => (
                                          <div key={r.id}>
                                            {itemDaArvore(
                                              { tipo: "reuniao", orgaoId: b.id, ano: y.year, mes: mm.month, dia: d.dia, reuniaoId: r.id },
                                              rotuloDaReuniaoNaArvore(r),
                                              r.total,
                                              4,
                                              undefined,
                                              "reuniao"
                                            )}
                                          </div>
                                        ))}
                                    </div>
                                  );
                                })}
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

  // --- Navegação lateral -------------------------------------------------------

  const itemDeNavegacao = (v: VisaoDaBiblioteca, rotulo: string, Icone: typeof File) => {
    const ativo = visao === v && (v !== "biblioteca" || pasta.tipo === "todos" || (Boolean(orgaoContexto) && pasta.tipo === "orgao"));
    return (
      <button
        type="button"
        onClick={() => irParaVisao(v)}
        aria-current={ativo ? "page" : undefined}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-full text-xs cursor-pointer ${
          ativo ? "bg-sky-100 text-[#00658d] font-extrabold" : "text-slate-700 hover:bg-slate-100 font-semibold"
        }`}
      >
        <Icone className="w-4 h-4 shrink-0" />
        {rotulo}
      </button>
    );
  };

  const lateral = (
    <div className="space-y-4">
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuNovo((v) => !v);
          }}
          aria-haspopup="menu"
          aria-expanded={menuNovo}
          className="inline-flex items-center gap-2 pl-4 pr-5 py-3 rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-md text-xs font-extrabold text-slate-800 cursor-pointer"
        >
          <Plus className="w-5 h-5 text-[#00658d]" />
          {pt ? "Novo" : "New"}
        </button>
        {menuNovo && (
          <div role="menu" onClick={(e) => e.stopPropagation()} className="absolute z-20 mt-2 w-64 bg-white border border-slate-200 rounded-xl shadow-lg py-1">
            <button
              type="button"
              role="menuitem"
              disabled={!podeEnviar}
              onClick={() => {
                setMenuNovo(false);
                setEnviando(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-left"
            >
              <Upload className="w-4 h-4 text-[#00658d]" />
              {pt ? "Enviar arquivo" : "Upload file"}
            </button>
            {!podeEnviar && (
              <p className="px-3 pb-2 text-[10px] text-slate-400 font-semibold">
                {canUpload
                  ? pt ? "Abra a pasta de uma reunião para enviar um arquivo a ela." : "Open a meeting folder to upload a file to it."
                  : pt ? "Seu perfil não envia documentos." : "Your profile cannot upload documents."}
              </p>
            )}
          </div>
        )}
      </div>

      <nav aria-label={pt ? "Biblioteca" : "Library"} className="space-y-0.5">
        {itemDeNavegacao("biblioteca", pt ? "Biblioteca" : "Library", Library)}
        {itemDeNavegacao("recentes", pt ? "Recentes" : "Recent", Clock)}
        {itemDeNavegacao("favoritos", pt ? "Favoritos" : "Starred", Star)}
        {itemDeNavegacao("armazenamento", pt ? "Armazenamento" : "Storage", Database)}
      </nav>

      <div className="border-t border-slate-200 pt-3">
        <p className="px-2 pb-1 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">{pt ? "Pastas" : "Folders"}</p>
        {arvoreRenderizada}
      </div>
    </div>
  );

  // --- Arquivos -------------------------------------------------------------------

  const formatoDe = (d: DocumentoDoPgcp): FormatoDoDocumento => d.format ?? "outros";

  const menuDoArquivo = (d: DocumentoDoPgcp) => (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuDoItem((atual) => (atual === d.id ? null : d.id));
        }}
        aria-label={pt ? `Ações de ${d.name}` : `Actions for ${d.name}`}
        aria-haspopup="menu"
        aria-expanded={menuDoItem === d.id}
        className="p-1.5 rounded-full text-slate-500 hover:bg-slate-100 cursor-pointer"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {menuDoItem === d.id && (
        <div role="menu" onClick={(e) => e.stopPropagation()} className="absolute right-0 z-20 mt-1 w-52 bg-white border border-slate-200 rounded-xl shadow-lg py-1">
          <button type="button" role="menuitem" onClick={() => { setMenuDoItem(null); void baixar(d); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer text-left">
            <Download className="w-4 h-4 text-[#00658d]" />{pt ? "Baixar" : "Download"}
          </button>
          {destinoDoContexto(d) && (
            <button type="button" role="menuitem" onClick={() => { setMenuDoItem(null); abrirContexto(d); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer text-left">
              <ExternalLink className="w-4 h-4 text-[#00658d]" />
              {d.meeting ? (pt ? "Abrir reunião" : "Open meeting") : pt ? "Abrir Agenda Anual" : "Open annual plan"}
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setMenuDoItem(null); void alternarFavorito(d); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer text-left">
            <Star className={`w-4 h-4 ${d.favorite ? "fill-amber-400 text-amber-500" : "text-[#00658d]"}`} />
            {d.favorite ? (pt ? "Remover dos favoritos" : "Remove from starred") : pt ? "Adicionar aos favoritos" : "Add to starred"}
          </button>
        </div>
      )}
    </div>
  );

  const estrela = (d: DocumentoDoPgcp) => (
    <button
      type="button"
      onClick={() => void alternarFavorito(d)}
      aria-pressed={Boolean(d.favorite)}
      aria-label={d.favorite ? (pt ? "Remover dos favoritos" : "Remove from starred") : pt ? "Adicionar aos favoritos" : "Add to starred"}
      className="p-1 rounded-full hover:bg-slate-100 cursor-pointer"
    >
      <Star className={`w-3.5 h-3.5 ${d.favorite ? "fill-amber-400 text-amber-500" : "text-slate-300"}`} />
    </button>
  );

  const contextoDo = (d: DocumentoDoPgcp) =>
    d.meeting ? d.meeting.title : d.annualAgenda ? `${rotuloDoTipo("agenda_anual", language)} ${d.annualAgenda.year}` : d.governanceBody.name;

  const blocos = (itens: DocumentoDoPgcp[]) => (
    <ul className="grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-3">
      {itens.map((d) => {
        const { Icone, cor, fundo } = ICONE_DO_FORMATO[formatoDe(d)];
        return (
          <li key={d.id} className="bg-white border border-slate-200 rounded-2xl hover:shadow-md transition flex flex-col min-w-0">
            <div className="flex items-center gap-2 px-3 pt-2.5 min-w-0">
              <Icone className={`w-4 h-4 shrink-0 ${cor}`} />
              {/* Nome é TEXTO (React escapa); nunca HTML. */}
              <p className="flex-1 min-w-0 text-[12px] font-bold text-slate-800 truncate" title={d.name}>{d.name}</p>
              {menuDoArquivo(d)}
            </div>
            {/* Sem preview de conteúdo: ícone do formato (nenhum arquivo é baixado para miniatura). */}
            <button
              type="button"
              onClick={() => void baixar(d)}
              title={pt ? "Baixar" : "Download"}
              className={`mx-3 my-2 h-24 rounded-xl ${fundo} flex items-center justify-center cursor-pointer`}
            >
              <Icone className={`w-10 h-10 ${cor}`} />
            </button>
            <div className="px-3 pb-3 space-y-0.5 min-w-0">
              <p className="text-[10.5px] text-slate-600 font-semibold truncate" title={contextoDo(d)}>{contextoDo(d)}</p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] text-slate-400 font-semibold truncate">
                  {rotuloDoFormato(formatoDe(d), language)} · {dataNoFuso(d.documentAt, "America/Sao_Paulo")}
                  {d.author ? ` · ${d.author.name}` : ""}
                </p>
                {estrela(d)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const lista = (itens: DocumentoDoPgcp[], mostrarReuniao = true) => (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <table className="w-full text-left table-fixed">
        <thead className="bg-slate-50 text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2">{pt ? "Nome" : "Name"}</th>
            <th className="px-3 py-2 w-28 hidden md:table-cell">{pt ? "Tipo" : "Type"}</th>
            {mostrarReuniao && <th className="px-3 py-2 hidden lg:table-cell">{pt ? "Reunião" : "Meeting"}</th>}
            <th className="px-3 py-2 w-40 hidden xl:table-cell">{pt ? "Emitido/enviado por" : "Issued/uploaded by"}</th>
            <th className="px-3 py-2 w-24 hidden sm:table-cell">{pt ? "Data" : "Date"}</th>
            <th className="px-3 py-2 w-20 text-right">{pt ? "Ações" : "Actions"}</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((d) => {
            const { Icone, cor } = ICONE_DO_FORMATO[formatoDe(d)];
            return (
              <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                <td className="px-3 py-2 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icone className={`w-4 h-4 shrink-0 ${cor}`} />
                    <span className="truncate text-[12px] font-semibold text-slate-800" title={d.name}>{d.name}</span>
                  </div>
                  <p className="md:hidden text-[10px] text-slate-400 font-semibold truncate pl-6">
                    {rotuloDoFormato(formatoDe(d), language)} · {dataNoFuso(d.documentAt, "America/Sao_Paulo")}
                  </p>
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-600 hidden md:table-cell">
                  {rotuloDoFormato(formatoDe(d), language)}
                  <span className="block text-[10px] text-slate-400">{rotuloDoTipo(d.type, language)}{d.sizeBytes !== null ? ` · ${tamanhoLegivel(d.sizeBytes)}` : ""}</span>
                </td>
                {mostrarReuniao && (
                  <td className="px-3 py-2 text-[11px] text-slate-600 hidden lg:table-cell"><span className="block truncate" title={contextoDo(d)}>{contextoDo(d)}</span></td>
                )}
                <td className="px-3 py-2 text-[11px] text-slate-600 hidden xl:table-cell"><span className="block truncate">{d.author?.name ?? "—"}</span></td>
                <td className="px-3 py-2 text-[11px] text-slate-600 hidden sm:table-cell">{dataNoFuso(d.documentAt, "America/Sao_Paulo")}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-0.5">{estrela(d)}{menuDoArquivo(d)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const colecao = (itens: DocumentoDoPgcp[], mostrarReuniao = true) => (modo === "blocos" ? blocos(itens) : lista(itens, mostrarReuniao));

  const secao = (titulo: string, itens: DocumentoDoPgcp[], vazio: string) => (
    <section className="space-y-2">
      <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{titulo}</h4>
      {itens.length === 0 ? <p className="text-[11px] text-slate-400 font-semibold px-1">{vazio}</p> : colecao(itens, false)}
    </section>
  );

  // --- Chips de filtro -------------------------------------------------------------

  const chip = (
    id: string,
    rotulo: string,
    valor: string,
    onChange: (v: string) => void,
    opcoes: Array<[string, string]>,
    extra: { disabled?: boolean; title?: string } = {}
  ) => (
    <select
      id={id}
      aria-label={rotulo}
      title={extra.title ?? rotulo}
      value={valor}
      disabled={extra.disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ backgroundImage: SETA_DO_CHIP }}
      className={`${CHIP} ${valor ? ATIVO : ""} disabled:opacity-60 disabled:cursor-not-allowed`}
    >
      <option value="">{rotulo}</option>
      {opcoes.map(([v, r]) => (
        <option key={v} value={v}>{r}</option>
      ))}
    </select>
  );

  const temFiltro =
    Boolean(filtros.formato || filtros.tipo || filtros.pessoa || filtros.origem || filtros.de || filtros.ate || filtros.tema || modificado) ||
    (!orgaoContexto && (pasta.tipo !== "todos"));

  const limparFiltros = () => {
    setFiltros((f) => ({ ...FILTROS_INICIAIS, busca: f.busca, ordem: f.ordem }));
    setModificado("");
    if (!orgaoContexto) setPasta({ tipo: "todos" });
  };

  const armazenamentoRenderizado = (
    <section aria-label={pt ? "Armazenamento" : "Storage"} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
      {erroArmazenamento && <p className="text-[11px] font-semibold text-red-600">{pt ? "Não foi possível carregar o armazenamento." : "Could not load storage."}</p>}
      {!erroArmazenamento && !armazenamento && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}
      {armazenamento && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              [pt ? "Documentos" : "Documents", String(armazenamento.documents)],
              [pt ? "Arquivos enviados" : "Uploaded files", `${armazenamento.attachments} · ${tamanhoLegivel(armazenamento.attachmentBytes)}`],
              [pt ? "Gerados pelo PGCP" : "Generated by PGCP", String(armazenamento.generated)]
            ].map(([r, v]) => (
              <div key={r} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">{r}</p>
                <p className="text-sm font-extrabold text-slate-800 mt-1">{v}</p>
              </div>
            ))}
          </div>
          <table className="w-full text-left text-[11px]">
            <thead className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
              <tr><th className="py-1">{pt ? "Tipo" : "Type"}</th><th className="py-1">{pt ? "Documentos" : "Documents"}</th><th className="py-1">{pt ? "Volume" : "Size"}</th></tr>
            </thead>
            <tbody>
              {armazenamento.byFormat.map((f) => (
                <tr key={f.format} className="border-t border-slate-100">
                  <td className="py-1.5 font-semibold text-slate-700">{rotuloDoFormato(f.format, language)}</td>
                  <td className="py-1.5 text-slate-600">{f.documents}</td>
                  <td className="py-1.5 text-slate-600">{f.bytes > 0 ? tamanhoLegivel(f.bytes) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-slate-400 font-semibold">
            {pt
              ? "Volume real dos arquivos enviados que você pode ver. Atas e Agenda Anual são geradas na hora do download e não ocupam armazenamento. O PGCP não define cota."
              : "Real size of uploaded files you can see. Minutes and annual plans are generated on download and use no storage. PGCP has no quota."}
          </p>
        </>
      )}
    </section>
  );

  return (
    <div className="space-y-4 animate-fade-in">
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

      <div className="grid grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)] gap-5 items-start">
        {/* Lateral fixa no desktop; gaveta no celular/tablet. */}
        <aside className="hidden lg:block max-h-[80vh] overflow-y-auto sticky top-4 pr-1">{lateral}</aside>
        {gavetaAberta && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={pt ? "Pastas" : "Folders"}>
            <div className="absolute inset-0 bg-slate-900/40" onClick={() => setGavetaAberta(false)} />
            <div className="absolute left-0 top-0 bottom-0 w-[85%] max-w-xs bg-white p-4 overflow-y-auto shadow-xl">
              <div className="flex items-center justify-end mb-2">
                <button type="button" onClick={() => setGavetaAberta(false)} aria-label={pt ? "Fechar" : "Close"} className="p-1 text-slate-500 cursor-pointer">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {lateral}
            </div>
          </div>
        )}

        <div className="space-y-4 min-w-0">
          {/* Busca destacada */}
          {visao !== "armazenamento" && (
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                id="docBusca"
                type="search"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                aria-label={pt ? "Pesquisar na Biblioteca" : "Search the Library"}
                placeholder={pt ? "Pesquisar na Biblioteca" : "Search the Library"}
                className="w-full bg-slate-100 focus:bg-white border border-transparent focus:border-slate-200 rounded-full pl-11 pr-4 py-3 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d] shadow-inner"
              />
            </div>
          )}

          {/* Breadcrumb clicável (ou o título da visão) */}
          <nav aria-label={pt ? "Local atual" : "Current location"} className="flex flex-wrap items-center gap-1 text-base font-extrabold text-slate-800">
            {visao === "biblioteca" ? (
              trilha.map((t, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
                  {i === trilha.length - 1 ? (
                    <span aria-current="page" className="truncate max-w-[60vw]">{t.rotulo}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => selecionar(t.pasta)}
                      disabled={Boolean(orgaoContexto) && t.pasta.tipo === "todos"}
                      className="px-2 py-0.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 cursor-pointer disabled:cursor-default disabled:hover:bg-transparent truncate max-w-[40vw]"
                    >
                      {t.rotulo}
                    </button>
                  )}
                </React.Fragment>
              ))
            ) : (
              <span>{tituloDaVisao[visao]}</span>
            )}
          </nav>

          {visao === "armazenamento" ? (
            armazenamentoRenderizado
          ) : (
            <>
              {/* Filtros compactos (chips) + ordenação + Blocos/Lista */}
              <div className="flex flex-wrap items-center gap-2">
                {chip("docFormato", pt ? "Tipo" : "Type", filtros.formato, (v) => mudar("formato", v as FiltrosDaTela["formato"]),
                  FORMATOS.map((f) => [f, rotuloDoFormato(f, language)]))}
                {chip("docPessoa", pt ? "Pessoas" : "People", filtros.pessoa, (v) => mudar("pessoa", v),
                  [...autores].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")),
                  { title: pt ? "Emitido/enviado por: quem enviou o arquivo, enviou a Agenda ou editou a Ata por último" : "Issued/uploaded by" })}
                {chip("docModificado", pt ? "Modificado" : "Modified", modificado, (v) => escolherModificado(v as OpcaoModificado), [
                  ["hoje", pt ? "Hoje" : "Today"],
                  ["7d", pt ? "Últimos 7 dias" : "Last 7 days"],
                  ["30d", pt ? "Últimos 30 dias" : "Last 30 days"],
                  ["ano", pt ? "Este ano" : "This year"],
                  ["personalizado", pt ? "Período personalizado" : "Custom range"]
                ], { title: pt ? "Data do documento" : "Document date" })}
                {modificado === "personalizado" && (
                  <span className="inline-flex items-center gap-1">
                    <input type="date" aria-label={pt ? "De" : "From"} value={filtros.de} onChange={(e) => mudar("de", e.target.value)}
                      className="bg-white border border-slate-200 rounded-full px-3 py-1 text-[11px]" />
                    <input type="date" aria-label={pt ? "Até" : "To"} value={filtros.ate} onChange={(e) => mudar("ate", e.target.value)}
                      className="bg-white border border-slate-200 rounded-full px-3 py-1 text-[11px]" />
                  </span>
                )}
                {chip("docOrgao", pt ? "Órgão colegiado" : "Governance body", efetivos.orgao,
                  (v) => selecionar(v ? { tipo: "orgao", orgaoId: v } : { tipo: "todos" }),
                  governanceBodies.map((b) => [b.id, b.name]),
                  { disabled: Boolean(orgaoContexto), title: orgaoContexto ? (pt ? "Definido pelo órgão selecionado no topo da tela" : "Set by the body selected at the top") : undefined })}
                {visao === "biblioteca" && chip("docReuniao", pt ? "Reunião" : "Meeting", efetivos.reuniao, irParaReuniao,
                  reunioesDoOrgao.map((m) => [m.id, `${m.date.split("-").reverse().join("/")} — ${m.title}`]))}
                {visao === "biblioteca" && pasta.tipo === "reuniao" && chip("docTema", pt ? "Tema da reunião" : "Meeting topic", filtros.tema, (v) => mudar("tema", v), [...temasDaReuniao])}
                {chip("docCategoria", pt ? "Categoria" : "Category", filtros.tipo, (v) => mudar("tipo", v as FiltrosDaTela["tipo"]), [
                  ["anexo", rotuloDoTipo("anexo", language)],
                  ["ata", rotuloDoTipo("ata", language)],
                  ["pautas", rotuloDoTipo("pautas", language)],
                  ["versao_reuniao", rotuloDoTipo("versao_reuniao", language)],
                  ["agenda_previa", rotuloDoTipo("agenda_previa", language)],
                  ["agenda_anual", language === "pt" ? "Agenda Anual (versão aprovada)" : "Annual plan (approved)"]
                ])}
                {chip("docOrigem", pt ? "Origem" : "Source", filtros.origem, (v) => mudar("origem", v as FiltrosDaTela["origem"]), [
                  ["pgcp", pt ? "Gerado pelo PGCP" : "Generated by PGCP"],
                  ["user", pt ? "Enviado por usuário" : "Uploaded by user"]
                ])}
                {temFiltro && (
                  <button type="button" onClick={limparFiltros} className="text-[11px] font-bold text-[#00658d] hover:underline px-1 cursor-pointer">
                    {pt ? "Limpar filtros" : "Clear filters"}
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {visao !== "recentes" && (
                    <select
                      aria-label={pt ? "Ordenar por" : "Sort by"}
                      value={filtros.ordem}
                      onChange={(e) => mudar("ordem", e.target.value as FiltrosDaTela["ordem"])}
                      style={{ backgroundImage: SETA_DO_CHIP }}
                      className={CHIP}
                    >
                      <option value="recentes">{pt ? "Mais recentes" : "Newest"}</option>
                      <option value="antigos">{pt ? "Mais antigos" : "Oldest"}</option>
                      <option value="nome">{pt ? "Nome A–Z" : "Name A–Z"}</option>
                      <option value="nome_desc">{pt ? "Nome Z–A" : "Name Z–A"}</option>
                    </select>
                  )}
                  <div role="group" aria-label={pt ? "Visualização" : "View"} className="inline-flex rounded-full border border-slate-200 bg-white overflow-hidden">
                    {([
                      ["blocos", LayoutGrid, pt ? "Blocos" : "Grid"],
                      ["lista", List, pt ? "Lista" : "List"]
                    ] as const).map(([id, Icone, rotulo]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setModo(id)}
                        aria-pressed={modo === id}
                        title={rotulo}
                        className={`px-3 py-1.5 inline-flex items-center gap-1 text-[11px] font-bold cursor-pointer ${
                          modo === id ? "bg-sky-100 text-[#00658d]" : "text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        <Icone className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">{rotulo}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Pastas do local atual */}
              {subpastas.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-xs font-extrabold text-slate-700">{pt ? "Pastas" : "Folders"}</h3>
                  <ul className="grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-2.5">
                    {subpastas.map((p) => {
                      const Icone = p.tipo === "agenda" ? CalendarRange : p.tipo === "reuniao" ? FileText : Folder;
                      return (
                        <li key={JSON.stringify(p.pasta)}>
                          <button
                            type="button"
                            onClick={() => entrarNaPasta(p.pasta)}
                            className="w-full flex items-center gap-3 px-4 py-3 bg-slate-100 hover:bg-sky-50 border border-transparent hover:border-[#00658d]/20 rounded-xl text-left cursor-pointer min-w-0"
                          >
                            <Icone className="w-5 h-5 shrink-0 text-[#00658d]" />
                            <span className="flex-1 min-w-0 text-[12px] font-bold text-slate-800 truncate" title={p.nome}>{p.nome}</span>
                            {p.total !== null && <span className="text-[10px] font-semibold text-slate-400">{p.total}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Arquivos */}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-extrabold text-slate-700">{pt ? "Arquivos" : "Files"}</h3>
                  <p className="text-[11px] text-slate-500 font-semibold">
                    {carregando && docs.length === 0 ? (pt ? "Carregando..." : "Loading...") : pt ? `${total} documento(s)` : `${total} document(s)`}
                  </p>
                </div>

                {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}

                {docs.length === 0 && !carregando ? (
                  <p className="py-10 text-center text-xs text-slate-400 font-semibold bg-white border border-slate-200 rounded-2xl">
                    {visao === "favoritos"
                      ? pt ? "Nenhum favorito ainda. Use a estrela de um arquivo para marcá-lo." : "No starred files yet."
                      : mensagemDeVazio(efetivos, orgaoContexto, language)}
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
                            {colecao(t.docs, false)}
                          </div>
                        ))
                      )}
                    </section>
                    {secao(pt ? "Ata" : "Minutes", secoes.atas, pt ? "Ata ainda não registrada." : "Minutes not recorded yet.")}
                    {secao(
                      pt ? "Gerados pelo PGCP (pautas e versões)" : "Generated by PGCP (agenda and versions)",
                      secoes.gerados,
                      pt ? "Nenhum documento gerado ainda." : "No generated documents yet."
                    )}
                  </div>
                ) : (
                  colecao(docs)
                )}

                {docs.length < total && (
                  <div className="flex justify-center">
                    <button type="button" disabled={carregando} onClick={() => void carregar(docs.length)}
                      className="px-4 py-2 text-xs font-bold text-[#00658d] border border-[#00658d]/30 rounded-xl hover:bg-sky-50 cursor-pointer disabled:opacity-50">
                      {carregando ? (pt ? "Carregando..." : "Loading...") : pt ? "Carregar mais" : "Load more"}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {/* Envio: o MESMO diálogo do Pipeline (anexo da reunião ou de um tema dela). */}
      {enviando && reuniaoParaEnvio && (
        <UploadDocumentModal
          language={language}
          meetingId={reuniaoParaEnvio}
          temas={[...temasDaReuniao].map(([id, title]) => ({ id, title }))}
          temaInicial={null}
          onClose={() => setEnviando(false)}
          onUploaded={(nome) => {
            setEnviando(false);
            setRecarga((n) => n + 1);
            triggerToast(pt ? `“${nome}” enviado.` : `“${nome}” uploaded.`);
          }}
        />
      )}
    </div>
  );
}
