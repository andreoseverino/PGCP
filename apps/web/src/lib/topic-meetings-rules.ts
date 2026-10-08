/**
 * Regras PURAS do modal "Reuniões do tema" (sem rede, testáveis em Node).
 * O cliente HTTP fica em `topic-meetings.ts`, que reexporta tudo daqui.
 */

export interface ReuniaoDoTema {
  meetingId: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  governanceBody: string;
  status: string;
  cancelled: boolean;
  sessionType: string | null;
  modality: "online" | "in_person";
  location: string | null;
  executionStatus: string;
  participantsCount: number;
}

export type FormatoDoArquivo = "pdf" | "xlsx";
export type RecorteTemporal = "todas" | "futuras" | "passadas";

/** `meetingIds` ausente = todas as reuniões do tema. */
export function consultaDaExportacaoDoTema(formato: FormatoDoArquivo, meetingIds?: string[]): string {
  const q = new URLSearchParams({ format: formato });
  if (meetingIds) q.set("meetingIds", meetingIds.join(","));
  return q.toString();
}

// -----------------------------------------------------------------------------
// Apresentação (pura)
// -----------------------------------------------------------------------------

const STATUS_PT: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  needs_approval: "Agendada",
  approved: "Agendada",
  in_progress: "Em andamento",
  done: "Realizada",
  closed: "Encerrada"
};
const STATUS_EN: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  needs_approval: "Scheduled",
  approved: "Scheduled",
  in_progress: "In progress",
  done: "Held",
  closed: "Closed"
};
const TEMA_PT: Record<string, string> = {
  pending: "A tratar",
  presenting: "Em apresentação",
  completed: "Concluído",
  postponed: "Postergado"
};
const TEMA_EN: Record<string, string> = {
  pending: "To discuss",
  presenting: "Presenting",
  completed: "Completed",
  postponed: "Postponed"
};

export function rotuloDoStatus(r: Pick<ReuniaoDoTema, "status" | "cancelled">, lang: "pt" | "en"): string {
  if (r.cancelled) return lang === "en" ? "Cancelled" : "Cancelada";
  return (lang === "en" ? STATUS_EN : STATUS_PT)[r.status] ?? r.status;
}

export function rotuloDoTemaNaReuniao(executionStatus: string, lang: "pt" | "en"): string {
  return (lang === "en" ? TEMA_EN : TEMA_PT)[executionStatus] ?? executionStatus;
}

/** Futura = ainda não terminou. */
export const ehFutura = (r: Pick<ReuniaoDoTema, "endAt">, agora: Date = new Date()) => new Date(r.endAt) > agora;

/** Data e horário LOCAIS da reunião (fuso dela): "dd/mm/aaaa", "hh:mm–hh:mm". */
export function dataEHorario(r: Pick<ReuniaoDoTema, "startAt" | "endAt" | "timezone">): { data: string; horario: string } {
  const fmt = (iso: string, opcoes: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("pt-BR", { timeZone: r.timezone, ...opcoes }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...opcoes }).format(new Date(iso));
    }
  };
  const hora: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  return {
    data: fmt(r.startAt, { day: "2-digit", month: "2-digit", year: "numeric" }),
    horario: `${fmt(r.startAt, hora)}–${fmt(r.endAt, hora)}`
  };
}

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Busca livre sobre o que a linha MOSTRA: título, comitê, data, horário,
 * status da reunião, status do tema, modalidade e local. Sem acento e sem
 * caixa; todos os termos precisam casar.
 */
export function filtrarReunioes(
  lista: ReuniaoDoTema[],
  busca: string,
  recorte: RecorteTemporal,
  lang: "pt" | "en",
  agora: Date = new Date()
): ReuniaoDoTema[] {
  const termos = normalizar(busca).split(/\s+/).filter(Boolean);
  return lista.filter((r) => {
    if (recorte === "futuras" && !ehFutura(r, agora)) return false;
    if (recorte === "passadas" && ehFutura(r, agora)) return false;
    if (termos.length === 0) return true;
    const { data, horario } = dataEHorario(r);
    const texto = normalizar(
      [
        r.title,
        r.governanceBody,
        data,
        horario,
        rotuloDoStatus(r, lang),
        rotuloDoTemaNaReuniao(r.executionStatus, lang),
        r.modality === "in_person" ? (lang === "en" ? "in person" : "presencial") : "online",
        r.location ?? "",
        r.sessionType === "extraordinary" ? (lang === "en" ? "extraordinary" : "extraordinaria") : r.sessionType === "ordinary" ? (lang === "en" ? "ordinary" : "ordinaria") : ""
      ].join(" ")
    );
    return termos.every((t) => texto.includes(t));
  });
}

/**
 * O que a exportação leva: a SELEÇÃO, se houver; senão, tudo o que a lista
 * mostra (busca/recorte aplicados). `undefined` = todas as reuniões do tema
 * (lista sem filtro e sem seleção) — o servidor resolve.
 */
export function idsParaExportar(
  todas: ReuniaoDoTema[],
  visiveis: ReuniaoDoTema[],
  selecionadas: ReadonlySet<string>
): string[] | undefined {
  if (selecionadas.size > 0) return todas.filter((r) => selecionadas.has(r.meetingId)).map((r) => r.meetingId);
  if (visiveis.length === todas.length) return undefined;
  return visiveis.map((r) => r.meetingId);
}

/** "Selecionar todas" age sobre as VISÍVEIS: marca todas, ou desmarca se já estão todas marcadas. */
export function alternarTodasVisiveis(selecionadas: ReadonlySet<string>, visiveis: ReuniaoDoTema[]): Set<string> {
  const proxima = new Set(selecionadas);
  const todasMarcadas = visiveis.length > 0 && visiveis.every((r) => proxima.has(r.meetingId));
  for (const r of visiveis) {
    if (todasMarcadas) proxima.delete(r.meetingId);
    else proxima.add(r.meetingId);
  }
  return proxima;
}
