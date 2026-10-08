/**
 * DOCUMENTOS — regras PURAS da biblioteca central (sem rede; testáveis em Node).
 * Cliente HTTP em `documents.ts`.
 *
 * A biblioteca reúne os anexos enviados no Pipeline (guardados no S3, com o
 * metadado no PostgreSQL) e os documentos que o PGCP gera (Atas, versão vigente
 * da Agenda Anual). A lista e a árvore vêm SEMPRE dos metadados da API — nunca
 * de uma listagem do bucket. Órgão do contexto global é filtro, não autorização.
 */

/** Tipos de NEGÓCIO. Além de anexo/Ata/Agenda: PDFs gerados das versões da reunião, das pautas aprovadas e a versão atual da Agenda. */
export type TipoDeDocumento = "anexo" | "ata" | "agenda_anual" | "versao_reuniao" | "pautas" | "agenda_previa";
export type OrigemDoDocumento = "user" | "pgcp";
/** Formato do arquivo (visão "Tipo" da Biblioteca), decidido pelo servidor pela extensão. */
export type FormatoDoDocumento = "pdf" | "documento" | "planilha" | "apresentacao" | "imagem" | "video" | "outros";
export const FORMATOS: readonly FormatoDoDocumento[] = ["pdf", "documento", "planilha", "apresentacao", "imagem", "video", "outros"];

export interface DocumentoDoPgcp {
  /** Opaco: "doc:<uuid>" (anexo), "ata:<reunião>", "agenda:<versão>". */
  id: string;
  type: TipoDeDocumento;
  source: OrigemDoDocumento;
  name: string;
  extension: string;
  sizeBytes: number | null;
  description: string | null;
  status: string;
  governanceBody: { id: string; name: string };
  meeting: {
    id: string;
    title: string;
    startAt: string;
    timezone: string;
    annualAgendaId: string | null;
    releasedToPipeline: boolean;
  } | null;
  /** Tema DA REUNIÃO a que o anexo pertence. */
  topic: { id: string; title: string } | null;
  annualAgenda: { id: string; year: number; version: number } | null;
  /** Versão da reunião (tipo `versao_reuniao`): baixa o PDF daquela versão. */
  meetingVersion?: { id: string; number: number } | null;
  author: { id: string; name: string } | null;
  documentAt: string;
  /** Formato (ausente em API antiga = "outros"). */
  format?: FormatoDoDocumento;
  /** Favorito de quem está vendo (preferência pessoal). */
  favorite?: boolean;
}

// --- Experiência "Drive": visões, breadcrumb, pastas e filtros compactos ------------

/** Visões da navegação lateral. Pastas = a árvore derivada (não há pasta no banco). */
export type VisaoDaBiblioteca = "biblioteca" | "recentes" | "favoritos" | "armazenamento";

export function rotuloDoFormato(f: FormatoDoDocumento, language: "en" | "pt"): string {
  const pt = language === "pt";
  const r: Record<FormatoDoDocumento, [string, string]> = {
    pdf: ["PDF", "PDF"],
    documento: ["Documento", "Document"],
    planilha: ["Planilha", "Spreadsheet"],
    apresentacao: ["Apresentação", "Presentation"],
    imagem: ["Imagem", "Image"],
    video: ["Vídeo", "Video"],
    outros: ["Outros", "Other"]
  };
  return r[f][pt ? 0 : 1];
}

/** Filtro "Modificado" (data do documento, dia de Brasília) → intervalo. */
export type OpcaoModificado = "" | "hoje" | "7d" | "30d" | "ano" | "personalizado";

export function periodoDoModificado(opcao: OpcaoModificado, hoje: string): { de: string; ate: string } | null {
  const [a, m, d] = hoje.split("-").map(Number);
  const menos = (dias: number) => new Date(Date.UTC(a!, m! - 1, d! - dias)).toISOString().slice(0, 10);
  switch (opcao) {
    case "hoje":
      return { de: hoje, ate: hoje };
    case "7d":
      return { de: menos(6), ate: hoje };
    case "30d":
      return { de: menos(29), ate: hoje };
    case "ano":
      return { de: `${a}-01-01`, ate: hoje };
    default:
      return null; // "" = sem filtro; "personalizado" = datas escolhidas na tela
  }
}

/** Filtros da VISÃO: Recentes e Favoritos ignoram a pasta; Recentes ordena por data. */
export function filtrosDaVisao(visao: VisaoDaBiblioteca, f: FiltrosDaTela): FiltrosDaTela {
  if (visao === "recentes") return { ...f, orgao: f.orgao, reuniao: "", tema: "", agenda: "", ano: "", mes: "", dia: "", favoritos: false, ordem: "recentes" };
  if (visao === "favoritos") return { ...f, reuniao: "", tema: "", agenda: "", ano: "", mes: "", dia: "", favoritos: true };
  return { ...f, favoritos: false };
}

export interface PastaFilha {
  pasta: PastaSelecionada;
  nome: string;
  total: number | null;
  tipo: "pasta" | "agenda" | "reuniao";
}

/** Subpastas do local atual (seção "Pastas"), da MESMA árvore derivada. */
export function pastasFilhas(pasta: PastaSelecionada, arvore: ArvoreDeDocumentos | null, language: "en" | "pt"): PastaFilha[] {
  if (!arvore) return [];
  if (pasta.tipo === "todos") {
    return arvore.bodies.map((b) => ({ pasta: { tipo: "orgao", orgaoId: b.id }, nome: b.name, total: b.total, tipo: "pasta" }));
  }
  const orgao = arvore.bodies.find((b) => b.id === pasta.orgaoId);
  if (!orgao) return [];
  if (pasta.tipo === "orgao") {
    return orgao.years.map((y) => ({
      pasta: { tipo: "ano", orgaoId: orgao.id, ano: y.year },
      nome: String(y.year),
      total: y.annualAgendas.reduce((s, x) => s + x.total, 0) + y.months.reduce((s, mm) => s + mm.meetings.reduce((t, r) => t + r.total, 0), 0),
      tipo: "pasta"
    }));
  }
  const ano = orgao.years.find((y) => y.year === pasta.ano);
  if (!ano) return [];
  if (pasta.tipo === "ano") {
    return [
      ...ano.annualAgendas.map((x): PastaFilha => ({
        pasta: { tipo: "agenda", orgaoId: orgao.id, ano: ano.year, agendaId: x.id },
        nome: language === "pt" ? `Agenda Anual${x.title ? ` — ${x.title}` : ""}` : `Annual plan${x.title ? ` — ${x.title}` : ""}`,
        total: x.total,
        tipo: "agenda"
      })),
      ...ano.months.map((mm): PastaFilha => ({
        pasta: { tipo: "mes", orgaoId: orgao.id, ano: ano.year, mes: mm.month },
        nome: NOMES_DOS_MESES[mm.month - 1] ?? String(mm.month),
        total: mm.meetings.reduce((s, r) => s + r.total, 0),
        tipo: "pasta"
      }))
    ];
  }
  const mes = ano.months.find((x) => x.month === (pasta as { mes?: number }).mes);
  if (pasta.tipo === "mes") {
    return diasDoMes(mes?.meetings ?? []).map((d) => ({
      pasta: { tipo: "dia", orgaoId: orgao.id, ano: ano.year, mes: pasta.mes, dia: d.dia },
      nome: rotuloDoDia(d.dia, pasta.mes),
      total: d.meetings.reduce((s, r) => s + r.total, 0),
      tipo: "pasta"
    }));
  }
  if (pasta.tipo === "dia") {
    return (diasDoMes(mes?.meetings ?? []).find((d) => d.dia === pasta.dia)?.meetings ?? []).map((r) => ({
      pasta: { tipo: "reuniao", orgaoId: orgao.id, ano: ano.year, mes: pasta.mes, dia: pasta.dia, reuniaoId: r.id },
      nome: rotuloDaReuniaoNaArvore(r),
      total: r.total,
      tipo: "reuniao"
    }));
  }
  return []; // Agenda Anual e reunião são o último nível.
}

type ReuniaoDaArvore = ArvoreDeDocumentos["bodies"][number]["years"][number]["months"][number]["meetings"][number];

/** Dia LOCAL da reunião (fuso dela) — pasta de Dia entre Mês e Reunião. */
export function diaDaReuniao(r: { startAt: string; timezone: string }): number {
  return Number(dataNoFuso(r.startAt, r.timezone).slice(0, 2));
}

/** Reuniões do mês agrupadas por dia local, em ordem. */
export function diasDoMes(meetings: readonly ReuniaoDaArvore[]): Array<{ dia: number; meetings: ReuniaoDaArvore[] }> {
  const dias: Array<{ dia: number; meetings: ReuniaoDaArvore[] }> = [];
  for (const r of meetings) {
    const dia = diaDaReuniao(r);
    const grupo = dias.find((d) => d.dia === dia);
    if (grupo) grupo.meetings.push(r);
    else dias.push({ dia, meetings: [r] });
  }
  return dias.sort((a, b) => a.dia - b.dia);
}

/** "15/10" — nome da pasta de dia. */
export function rotuloDoDia(dia: number, mes: number): string {
  return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}`;
}

/** Breadcrumb CLICÁVEL: "Biblioteca › Órgão › 2026 › Outubro › Reunião". */
export function trilhaNavegavel(
  pasta: PastaSelecionada,
  arvore: ArvoreDeDocumentos | null,
  language: "en" | "pt"
): Array<{ rotulo: string; pasta: PastaSelecionada }> {
  const nomes = trilhaDaPasta(pasta, arvore, language);
  const raiz = { rotulo: language === "pt" ? "Biblioteca" : "Library", pasta: { tipo: "todos" } as PastaSelecionada };
  if (pasta.tipo === "todos") return [raiz];
  const alvos: PastaSelecionada[] = [{ tipo: "orgao", orgaoId: pasta.orgaoId }];
  if (pasta.tipo !== "orgao") alvos.push({ tipo: "ano", orgaoId: pasta.orgaoId, ano: pasta.ano });
  if (pasta.tipo === "agenda") alvos.push(pasta);
  if (pasta.tipo === "mes" || pasta.tipo === "dia" || pasta.tipo === "reuniao") alvos.push({ tipo: "mes", orgaoId: pasta.orgaoId, ano: pasta.ano, mes: pasta.mes });
  if (pasta.tipo === "dia") alvos.push(pasta);
  if (pasta.tipo === "reuniao" && pasta.dia !== undefined) alvos.push({ tipo: "dia", orgaoId: pasta.orgaoId, ano: pasta.ano, mes: pasta.mes, dia: pasta.dia });
  if (pasta.tipo === "reuniao") alvos.push(pasta);
  return [raiz, ...alvos.map((p, i) => ({ rotulo: nomes[i] ?? "", pasta: p }))];
}

/** Pastas VISUAIS (metadados): Órgão → Ano → (Agenda Anual | Mês → Dia → Reunião). O Dia é derivado na tela. */
export interface ArvoreDeDocumentos {
  bodies: Array<{
    id: string;
    name: string;
    total: number;
    years: Array<{
      year: number;
      annualAgendas: Array<{ id: string; title: string; total: number }>;
      months: Array<{
        month: number;
        meetings: Array<{ id: string; title: string; startAt: string; timezone: string; releasedToPipeline: boolean; total: number }>;
      }>;
    }>;
  }>;
}

/** Pasta selecionada na árvore (vira filtro da lista). */
export type PastaSelecionada =
  | { tipo: "todos" }
  | { tipo: "orgao"; orgaoId: string }
  | { tipo: "ano"; orgaoId: string; ano: number }
  | { tipo: "agenda"; orgaoId: string; ano: number; agendaId: string }
  | { tipo: "mes"; orgaoId: string; ano: number; mes: number }
  | { tipo: "dia"; orgaoId: string; ano: number; mes: number; dia: number }
  /** `dia` ausente: reunião aberta por atalho (a trilha não mostra o Dia). */
  | { tipo: "reuniao"; orgaoId: string; ano: number; mes: number; dia?: number; reuniaoId: string };

export interface FiltrosDaTela {
  busca: string;
  orgao: string;
  reuniao: string;
  /** Tema DA REUNIÃO (meeting_agenda_item). */
  tema: string;
  agenda: string;
  /** Pasta Ano/Mês: ano e mês DA REUNIÃO (mesmo critério da árvore), não do upload. */
  ano: string;
  mes: string;
  /** Pasta Dia: dia LOCAL da reunião. */
  dia: string;
  pessoa: string;
  tipo: "" | TipoDeDocumento;
  /** Formato do arquivo (PDF, Planilha...). */
  formato: "" | FormatoDoDocumento;
  /** Visão Favoritos: só os favoritos de quem vê. */
  favoritos: boolean;
  origem: "" | OrigemDoDocumento;
  de: string;
  ate: string;
  ordem: "recentes" | "antigos" | "nome" | "nome_desc";
}

export const FILTROS_INICIAIS: FiltrosDaTela = {
  busca: "",
  orgao: "",
  reuniao: "",
  tema: "",
  agenda: "",
  ano: "",
  mes: "",
  dia: "",
  pessoa: "",
  tipo: "",
  formato: "",
  favoritos: false,
  origem: "",
  de: "",
  ate: "",
  ordem: "recentes"
};

/** Filtros da tela -> query string da API (só o que foi preenchido). */
export function consultaDosFiltros(f: FiltrosDaTela, pagina: { limit: number; offset: number }): string {
  const p = new URLSearchParams();
  const por: Array<[string, string]> = [
    ["q", f.busca.trim()],
    ["governanceBodyId", f.orgao],
    ["meetingId", f.reuniao],
    ["agendaItemId", f.tema],
    ["annualAgendaId", f.agenda],
    ["year", f.ano],
    ["month", f.mes],
    ["day", f.dia],
    ["authorUserId", f.pessoa],
    ["type", f.tipo],
    ["format", f.formato],
    ["favorites", f.favoritos ? "true" : ""],
    ["source", f.origem],
    ["dateFrom", f.de],
    ["dateTo", f.ate]
  ];
  for (const [k, v] of por) if (v) p.set(k, v);
  if (f.ordem !== "recentes") p.set("sort", f.ordem);
  p.set("limit", String(pagina.limit));
  if (pagina.offset > 0) p.set("offset", String(pagina.offset));
  return p.toString();
}

/**
 * Pasta → filtros de CONTEXTO (órgão, ano/mês da reunião, Agenda, reunião). A
 * busca e os demais filtros do usuário (tipo, origem, período, autor) continuam.
 */
export function filtrosDaPasta(pasta: PastaSelecionada, base: FiltrosDaTela): FiltrosDaTela {
  // Tema da reunião só faz sentido dentro da própria reunião.
  const tema = pasta.tipo === "reuniao" && base.reuniao === pasta.reuniaoId ? base.tema : "";
  const limpo: FiltrosDaTela = { ...base, orgao: "", reuniao: "", tema, agenda: "", ano: "", mes: "", dia: "" };
  switch (pasta.tipo) {
    case "todos":
      return limpo;
    case "orgao":
      return { ...limpo, orgao: pasta.orgaoId };
    case "ano":
      return { ...limpo, orgao: pasta.orgaoId, ano: String(pasta.ano) };
    case "agenda":
      return { ...limpo, orgao: pasta.orgaoId, agenda: pasta.agendaId };
    case "mes":
      return { ...limpo, orgao: pasta.orgaoId, ano: String(pasta.ano), mes: String(pasta.mes) };
    case "dia":
      return { ...limpo, orgao: pasta.orgaoId, ano: String(pasta.ano), mes: String(pasta.mes), dia: String(pasta.dia) };
    case "reuniao":
      return { ...limpo, orgao: pasta.orgaoId, reuniao: pasta.reuniaoId };
  }
}

export const NOMES_DOS_MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
] as const;

/** "Comitê › 2026 › Outubro › 15/10 — Reunião" — trilha da pasta para o painel. */
export function trilhaDaPasta(pasta: PastaSelecionada, arvore: ArvoreDeDocumentos | null, language: "en" | "pt"): string[] {
  const todos = language === "pt" ? "Todos os documentos" : "All documents";
  if (pasta.tipo === "todos") return [todos];
  const orgao = arvore?.bodies.find((b) => b.id === pasta.orgaoId);
  const trilha = [orgao?.name ?? (language === "pt" ? "Órgão" : "Body")];
  if (pasta.tipo === "orgao") return trilha;
  trilha.push(String(pasta.ano));
  if (pasta.tipo === "ano") return trilha;
  const ano = orgao?.years.find((y) => y.year === pasta.ano);
  if (pasta.tipo === "agenda") {
    trilha.push(ano?.annualAgendas.find((a) => a.id === pasta.agendaId)?.title ?? "Agenda Anual");
    return trilha;
  }
  trilha.push(NOMES_DOS_MESES[pasta.mes - 1] ?? String(pasta.mes));
  if (pasta.tipo === "mes") return trilha;
  if (pasta.tipo === "dia") return [...trilha, rotuloDoDia(pasta.dia, pasta.mes)];
  if (pasta.dia !== undefined) trilha.push(rotuloDoDia(pasta.dia, pasta.mes));
  const reuniao = ano?.months.find((m) => m.month === pasta.mes)?.meetings.find((r) => r.id === pasta.reuniaoId);
  trilha.push(reuniao ? rotuloDaReuniaoNaArvore(reuniao) : language === "pt" ? "Reunião" : "Meeting");
  return trilha;
}

/** Pasta da reunião = o NOME da reunião (a data já está nas pastas Mês e Dia). */
export function rotuloDaReuniaoNaArvore(r: { title: string; startAt: string; timezone: string }): string {
  return r.title;
}

export function rotuloDoTipo(tipo: TipoDeDocumento, language: "en" | "pt"): string {
  if (tipo === "anexo") return language === "pt" ? "Anexo" : "Attachment";
  if (tipo === "ata") return language === "pt" ? "Ata" : "Minutes";
  if (tipo === "versao_reuniao") return language === "pt" ? "Versão da reunião" : "Meeting version";
  if (tipo === "pautas") return language === "pt" ? "Pautas aprovadas" : "Approved agenda";
  if (tipo === "agenda_previa") return language === "pt" ? "Agenda Anual (versão atual)" : "Annual plan (current)";
  return language === "pt" ? "Agenda Anual" : "Annual plan";
}

export function rotuloDaOrigem(origem: OrigemDoDocumento, language: "en" | "pt"): string {
  if (origem === "pgcp") return language === "pt" ? "Gerado pelo PGCP" : "Generated by PGCP";
  return language === "pt" ? "Enviado por usuário" : "Uploaded by user";
}

/** Tamanho legível ("1,2 MB"); desconhecido (gerado) = "—". */
export function tamanhoLegivel(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1).replace(".", ",")} MB`;
}

/** Id do anexo para o download ("doc:<uuid>" → "<uuid>"); gerados = null. */
export function idDoAnexo(d: Pick<DocumentoDoPgcp, "id" | "type">): string | null {
  return d.type === "anexo" && d.id.startsWith("doc:") ? d.id.slice(4) : null;
}

/**
 * Para onde o contexto leva: reunião liberada → Pipeline; reunião de Agenda
 * ainda não aprovada → Agenda Anual (regra de liberação); documento da Agenda
 * Anual → Agenda Anual.
 */
export function destinoDoContexto(d: Pick<DocumentoDoPgcp, "meeting" | "annualAgenda">): "pipeline" | "annual-agenda" | null {
  if (d.meeting) return d.meeting.releasedToPipeline ? "pipeline" : "annual-agenda";
  if (d.annualAgenda) return "annual-agenda";
  return null;
}

/** "Nenhum documento..." — distingue "nada no PGCP" de "nada com estes filtros". */
export function mensagemDeVazio(filtros: FiltrosDaTela, orgaoDoContexto: string, language: "en" | "pt"): string {
  const pt = language === "pt";
  const filtrando = Boolean(orgaoDoContexto) || (Object.keys(filtros) as Array<keyof FiltrosDaTela>).some((k) => k !== "ordem" && filtros[k]);
  if (filtrando) return pt ? "Nenhum documento encontrado com estes filtros." : "No documents match these filters.";
  return pt ? "Nenhum documento foi adicionado ao PGCP ainda." : "No documents in the PGCP yet.";
}

/** Data/hora no fuso informado ("dd/mm/aaaa"). */
export function dataNoFuso(iso: string, fuso: string, comHora = false): string {
  const opcoes: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric", ...(comHora ? { hour: "2-digit", minute: "2-digit" } : {}) };
  try {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: fuso }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: "UTC" }).format(new Date(iso));
  }
}

// --- Envio (pré-validação na tela; a decisão é do servidor) -----------------------

/** Mesma allowlist do servidor (`documents/file-rules.ts`). */
export const EXTENSOES_ACEITAS = ["pdf", "pptx", "ppt", "docx", "doc", "xlsx", "xls"] as const;
export const ACCEPT_DO_INPUT = EXTENSOES_ACEITAS.map((e) => `.${e}`).join(",");

/**
 * Pré-checagem para dar a mensagem antes de subir bytes. O servidor revalida
 * tudo (inclusive conteúdo e tamanho máximo configurado) e é quem decide.
 */
export function problemaNoArquivo(arquivo: { name: string; size: number }, language: "en" | "pt"): string | null {
  const pt = language === "pt";
  if (arquivo.size <= 0) return pt ? "O arquivo está vazio." : "The file is empty.";
  const partes = arquivo.name.toLowerCase().split(".");
  const ext = partes.length > 1 ? partes[partes.length - 1] : "";
  if (!(EXTENSOES_ACEITAS as readonly string[]).includes(ext)) {
    return pt
      ? "Tipo de arquivo não permitido. Envie PDF, PowerPoint, Word ou Excel."
      : "File type not allowed. Upload PDF, PowerPoint, Word or Excel.";
  }
  return null;
}

/**
 * Documentos de UMA reunião em seções: anexos da reunião inteira, anexos por
 * tema (na ordem em que aparecem) e Ata. Usado na pasta da reunião e na aba
 * Documentos do Pipeline.
 */
export function secoesDaReuniao(docs: readonly DocumentoDoPgcp[]): {
  gerais: DocumentoDoPgcp[];
  temas: Array<{ tema: { id: string; title: string }; docs: DocumentoDoPgcp[] }>;
  atas: DocumentoDoPgcp[];
  /** Gerados pelo PGCP: pautas aprovadas e as versões da reunião (mais nova primeiro). */
  gerados: DocumentoDoPgcp[];
} {
  const gerais: DocumentoDoPgcp[] = [];
  const atas: DocumentoDoPgcp[] = [];
  const gerados: DocumentoDoPgcp[] = [];
  const temas: Array<{ tema: { id: string; title: string }; docs: DocumentoDoPgcp[] }> = [];
  for (const d of docs) {
    if (d.type === "ata") atas.push(d);
    else if (d.type === "versao_reuniao" || d.type === "pautas") gerados.push(d);
    else if (d.topic) {
      const grupo = temas.find((t) => t.tema.id === d.topic!.id);
      if (grupo) grupo.docs.push(d);
      else temas.push({ tema: d.topic, docs: [d] });
    } else if (d.type === "anexo") gerais.push(d);
  }
  gerados.sort((a, b) =>
    a.type !== b.type ? (a.type === "pautas" ? -1 : 1) : (b.meetingVersion?.number ?? 0) - (a.meetingVersion?.number ?? 0)
  );
  return { gerais, temas, atas, gerados };
}
