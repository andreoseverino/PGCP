/**
 * DOCUMENTOS — regras PURAS da biblioteca central (sem rede; testáveis em Node).
 * Cliente HTTP em `documents.ts`.
 *
 * O PGCP ainda não armazena arquivos enviados: a biblioteca reúne os
 * documentos que ele já persiste (Atas, versões da Agenda Anual) e baixa pelas
 * rotas de origem. Órgão do contexto global é filtro, não autorização.
 */

export type TipoDeDocumento = "ata" | "agenda_anual";

export interface DocumentoDoPgcp {
  id: string;
  type: TipoDeDocumento;
  name: string;
  format: "PDF";
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
  annualAgenda: { id: string; year: number; version: number } | null;
  author: { id: string; name: string } | null;
  documentAt: string;
}

export interface FiltrosDaTela {
  busca: string;
  orgao: string;
  reuniao: string;
  tema: string;
  pessoa: string;
  tipo: "" | TipoDeDocumento;
  de: string;
  ate: string;
  ordem: "recentes" | "antigos" | "nome";
}

export const FILTROS_INICIAIS: FiltrosDaTela = {
  busca: "",
  orgao: "",
  reuniao: "",
  tema: "",
  pessoa: "",
  tipo: "",
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
    ["topicId", f.tema],
    ["authorUserId", f.pessoa],
    ["type", f.tipo],
    ["dateFrom", f.de],
    ["dateTo", f.ate]
  ];
  for (const [k, v] of por) if (v) p.set(k, v);
  if (f.ordem !== "recentes") p.set("sort", f.ordem);
  p.set("limit", String(pagina.limit));
  if (pagina.offset > 0) p.set("offset", String(pagina.offset));
  return p.toString();
}

export function rotuloDoTipo(tipo: TipoDeDocumento, language: "en" | "pt"): string {
  if (tipo === "ata") return language === "pt" ? "Ata" : "Minutes";
  return language === "pt" ? "Agenda Anual" : "Annual plan";
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
