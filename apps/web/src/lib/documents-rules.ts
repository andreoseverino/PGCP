/**
 * DOCUMENTOS — regras PURAS da biblioteca central (sem rede; testáveis em Node).
 * Cliente HTTP em `documents.ts`.
 *
 * A biblioteca reúne os anexos enviados no Pipeline (guardados no S3, com o
 * metadado no PostgreSQL) e os documentos que o PGCP gera (Atas, versão vigente
 * da Agenda Anual). A lista e a árvore vêm SEMPRE dos metadados da API — nunca
 * de uma listagem do bucket. Órgão do contexto global é filtro, não autorização.
 */

export type TipoDeDocumento = "anexo" | "ata" | "agenda_anual";
export type OrigemDoDocumento = "user" | "pgcp";

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
  author: { id: string; name: string } | null;
  documentAt: string;
}

/** Pastas VISUAIS (metadados): Órgão → Ano → (Agenda Anual | Mês → Reunião). */
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
  | { tipo: "reuniao"; orgaoId: string; ano: number; mes: number; reuniaoId: string };

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
  pessoa: string;
  tipo: "" | TipoDeDocumento;
  origem: "" | OrigemDoDocumento;
  de: string;
  ate: string;
  ordem: "recentes" | "antigos" | "nome";
}

export const FILTROS_INICIAIS: FiltrosDaTela = {
  busca: "",
  orgao: "",
  reuniao: "",
  tema: "",
  agenda: "",
  ano: "",
  mes: "",
  pessoa: "",
  tipo: "",
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
    ["authorUserId", f.pessoa],
    ["type", f.tipo],
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
  const limpo: FiltrosDaTela = { ...base, orgao: "", reuniao: "", tema, agenda: "", ano: "", mes: "" };
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
  const reuniao = ano?.months.find((m) => m.month === pasta.mes)?.meetings.find((r) => r.id === pasta.reuniaoId);
  trilha.push(reuniao ? rotuloDaReuniaoNaArvore(reuniao) : language === "pt" ? "Reunião" : "Meeting");
  return trilha;
}

/** "DD/MM — Título" no fuso da reunião (sem nível de Dia na árvore). */
export function rotuloDaReuniaoNaArvore(r: { title: string; startAt: string; timezone: string }): string {
  return `${dataNoFuso(r.startAt, r.timezone).slice(0, 5)} — ${r.title}`;
}

export function rotuloDoTipo(tipo: TipoDeDocumento, language: "en" | "pt"): string {
  if (tipo === "anexo") return language === "pt" ? "Anexo" : "Attachment";
  if (tipo === "ata") return language === "pt" ? "Ata" : "Minutes";
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
} {
  const gerais: DocumentoDoPgcp[] = [];
  const atas: DocumentoDoPgcp[] = [];
  const temas: Array<{ tema: { id: string; title: string }; docs: DocumentoDoPgcp[] }> = [];
  for (const d of docs) {
    if (d.type === "ata") atas.push(d);
    else if (d.topic) {
      const grupo = temas.find((t) => t.tema.id === d.topic!.id);
      if (grupo) grupo.docs.push(d);
      else temas.push({ tema: d.topic, docs: [d] });
    } else if (d.type === "anexo") gerais.push(d);
  }
  return { gerais, temas, atas };
}
