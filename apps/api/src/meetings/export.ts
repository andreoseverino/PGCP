import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { clausulaDeReuniaoVisivel, type EspectadorPgcp } from "./visibility.js";
import { parseListFilters } from "./service.js";
import { descreverLocalFisico, lerLocalDaReuniao, type LocalFisico } from "./locations.js";
import { gerarXlsx, MIME_XLSX, type CelulaXlsx } from "../reports/xlsx.js";
import { finalizar, nomeDeArquivo, novoRelatorio, PDF_CONTENT_TYPE, tabela, campos, secao } from "../reports/report-pdf.js";

/**
 * EXPORTAÇÃO DO CALENDÁRIO (PDF ou Excel).
 *
 * O arquivo reflete EXATAMENTE o conjunto filtrado: mesmo recorte de data da
 * listagem (`parseListFilters` — dia LOCAL da reunião, no fuso dela) e o mesmo
 * filtro de órgão do contexto global. Sem período = calendário completo.
 *
 * O QUE SAI: data, horário, reunião, órgão, tipo, status, modalidade/local,
 * participantes (NOMES, nunca e-mail), quantidade de temas, convite e origem.
 * O QUE NÃO SAI: descrição, conteúdo de temas, Ata, Anotações, e-mails,
 * identificadores internos. Exportar não pode vazar mais do que a tela mostra.
 *
 * LEITURA, mesma política do Calendário (`visibility.ts`, Política A): usuário
 * PGCP ativo; a cláusula de visibilidade entra no WHERE para que uma regra
 * futura mais restrita valha aqui sem tocar este módulo. Sem trilha em
 * `audit_logs`: leitura não é ato de governança (mesma regra de todo GET).
 */

export type FormatoDeExportacao = "pdf" | "xlsx";

export interface FiltrosDeExportacao {
  formato: FormatoDeExportacao;
  governanceBodyId?: string;
  dateFrom?: string;
  dateTo?: string;
  /**
   * Recorte INTERNO (nunca vem da query de `/meetings/export`): só reuniões
   * em que este tema da Biblioteca está na pauta — exportação do tema.
   * Nesse recorte a reunião cancelada ENTRA (marcada "Cancelada"): é
   * histórico do tema, não calendário operacional.
   */
  agendaTopicId?: string;
  /** Recorte INTERNO: só estas reuniões (seleção feita no modal do tema). */
  meetingIds?: string[];
}

/** Teto de linhas: acima disso, a pessoa refina o período. */
export const MAX_REUNIOES_EXPORTADAS = 2000;

const PERMITIDOS = new Set(["format", "governanceBodyId", "dateFrom", "dateTo"]);

/** Query string FECHADA; datas e órgão validados pelo mesmo parser da listagem. */
export function parseFiltrosDeExportacao(query: Record<string, unknown>): FiltrosDeExportacao {
  for (const chave of Object.keys(query)) {
    if (!PERMITIDOS.has(chave)) throw new HttpError(400, `O parâmetro '${chave}' não é suportado.`);
  }
  const formato = query.format;
  if (formato !== "pdf" && formato !== "xlsx") {
    throw new HttpError(400, "Informe o formato da exportação: 'pdf' ou 'xlsx'.");
  }
  const { governanceBodyId, dateFrom, dateTo } = parseListFilters({
    governanceBodyId: query.governanceBodyId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
  return { formato, governanceBodyId, dateFrom, dateTo };
}

export interface ReuniaoExportada {
  id: string;
  titulo: string;
  orgao: string;
  inicio: Date;
  fim: Date;
  fuso: string;
  status: string;
  tipo: string | null;
  modalidade: "online" | "in_person";
  /** Copia congelada do local (038). */
  local: LocalFisico | null;
  origem: string;
  convite: string | null;
  participantes: string[];
  externos: number;
  temas: number;
  /** Reunião cancelada (036). Só aparece no recorte por tema. */
  cancelada?: boolean;
}

export async function consultarReunioesParaExportacao(
  filtros: FiltrosDeExportacao,
  espectador: EspectadorPgcp,
): Promise<ReuniaoExportada[]> {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // Calendário operacional: reunião cancelada (036) não entra — salvo no
  // recorte por tema, que é histórico.
  const condicoes = [clausulaDeReuniaoVisivel("m", espectador, bind)];
  if (filtros.agendaTopicId) {
    condicoes.push(
      `EXISTS (SELECT 1 FROM meeting_agenda_items ait WHERE ait.meeting_id = m.id AND ait.agenda_topic_id = ${bind(filtros.agendaTopicId)})`,
    );
  } else {
    condicoes.push("m.cancelled_at IS NULL");
  }
  if (filtros.meetingIds) condicoes.push(`m.id = ANY(${bind(filtros.meetingIds)}::uuid[])`);
  if (filtros.governanceBodyId) condicoes.push(`m.governance_body_id = ${bind(filtros.governanceBodyId)}`);
  if (filtros.dateFrom) condicoes.push(`(m.start_at AT TIME ZONE m.timezone)::date >= ${bind(filtros.dateFrom)}::date`);
  if (filtros.dateTo) condicoes.push(`(m.start_at AT TIME ZONE m.timezone)::date <= ${bind(filtros.dateTo)}::date`);

  const { rows } = await pool.query<{
    id: string;
    title: string;
    orgao: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    status: string;
    session_type: string | null;
    modality: "online" | "in_person";
    physical_location_snapshot: unknown;
    origin: string;
    sync_status: string | null;
    participantes: string[] | null;
    externos: number;
    temas: number;
    cancelada: boolean;
  }>(
    `SELECT m.id, m.title, gb.name AS orgao, m.start_at, m.end_at, m.timezone, m.status, m.session_type,
            m.modality, m.physical_location_snapshot, m.origin, (m.cancelled_at IS NOT NULL) AS cancelada,
            (SELECT ci.sync_status FROM meeting_calendar_integrations ci
              WHERE ci.meeting_id = m.id AND ci.provider = 'outlook') AS sync_status,
            (SELECT array_agg(coalesce(mp.display_name, u.name, '(sem nome)') ORDER BY coalesce(mp.display_name, u.name))
               FROM meeting_participants mp LEFT JOIN users u ON u.id = mp.user_id
              WHERE mp.meeting_id = m.id) AS participantes,
            (SELECT count(*) FROM meeting_participants mp
              WHERE mp.meeting_id = m.id AND mp.participant_type = 'external')::int AS externos,
            (SELECT count(*) FROM meeting_agenda_items ai
              WHERE ai.meeting_id = m.id AND ai.execution_status <> 'postponed')::int AS temas
       FROM meetings m
       JOIN governance_bodies gb ON gb.id = m.governance_body_id
      WHERE ${condicoes.join(" AND ")}
      ORDER BY m.start_at, m.id
      LIMIT ${bind(MAX_REUNIOES_EXPORTADAS + 1)}`,
    params,
  );
  if (rows.length > MAX_REUNIOES_EXPORTADAS) {
    throw new HttpError(
      413,
      `O período escolhido tem mais de ${MAX_REUNIOES_EXPORTADAS} reuniões. Escolha um intervalo menor para exportar.`,
    );
  }
  return rows.map((r) => ({
    id: r.id,
    titulo: r.title,
    orgao: r.orgao,
    inicio: r.start_at,
    fim: r.end_at,
    fuso: r.timezone,
    status: r.status,
    tipo: r.session_type,
    modalidade: r.modality,
    local: r.modality === "in_person" ? lerLocalDaReuniao(r.physical_location_snapshot) : null,
    origem: r.origin,
    convite: r.sync_status,
    participantes: r.participantes ?? [],
    externos: r.externos,
    temas: r.temas,
    cancelada: r.cancelada,
  }));
}

// ---------------------------------------------------------------------------
// Apresentação (pura)
// ---------------------------------------------------------------------------

const STATUS: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  needs_approval: "Agendada",
  approved: "Agendada",
  in_progress: "Em andamento",
  done: "Realizada",
  closed: "Encerrada",
};
const CONVITE: Record<string, string> = {
  pending: "Pendente",
  synced: "Enviado",
  stale: "Enviado (atualização pendente)",
  failed: "Falhou",
};

function partesLocais(instante: Date, fuso: string) {
  let partes: Intl.DateTimeFormatPart[];
  try {
    partes = new Intl.DateTimeFormat("en-CA", {
      timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(instante);
  } catch {
    partes = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(instante);
  }
  const p = (t: string) => Number(partes.find((x) => x.type === t)?.value ?? "0");
  return { ano: p("year"), mes: p("month"), dia: p("day"), hora: p("hour") % 24, minuto: p("minute") };
}

const doisDigitos = (n: number) => String(n).padStart(2, "0");

export function linhaDaExportacao(r: ReuniaoExportada) {
  const i = partesLocais(r.inicio, r.fuso);
  const f = partesLocais(r.fim, r.fuso);
  const local = r.modalidade === "in_person" ? (r.local ? descreverLocalFisico(r.local) : "Presencial") : null;
  return {
    data: `${doisDigitos(i.dia)}/${doisDigitos(i.mes)}/${i.ano}`,
    dataPartes: { ano: i.ano, mes: i.mes, dia: i.dia },
    inicio: `${doisDigitos(i.hora)}:${doisDigitos(i.minuto)}`,
    inicioPartes: { hora: i.hora, minuto: i.minuto },
    fim: `${doisDigitos(f.hora)}:${doisDigitos(f.minuto)}`,
    fimPartes: { hora: f.hora, minuto: f.minuto },
    reuniao: r.titulo,
    orgao: r.orgao,
    tipo: r.tipo === "ordinary" ? "Ordinária" : r.tipo === "extraordinary" ? "Extraordinária" : "",
    status: r.cancelada ? "Cancelada" : STATUS[r.status] ?? r.status,
    modalidade: r.modalidade === "in_person" ? "Presencial" : "Online",
    local: local ?? "",
    participantes: r.participantes.join("; "),
    qtdParticipantes: r.participantes.length,
    qtdExternos: r.externos,
    temas: r.temas,
    convite: r.convite ? CONVITE[r.convite] ?? r.convite : "Sem integração",
    origem: r.origem === "annual_agenda" ? "Agenda Anual" : "Calendário",
    fuso: r.fuso,
  };
}

export function descreverPeriodo(f: Pick<FiltrosDeExportacao, "dateFrom" | "dateTo">): string {
  const br = (iso: string) => iso.split("-").reverse().join("/");
  if (f.dateFrom && f.dateTo) return `${br(f.dateFrom)} a ${br(f.dateTo)}`;
  if (f.dateFrom) return `A partir de ${br(f.dateFrom)}`;
  if (f.dateTo) return `Até ${br(f.dateTo)}`;
  return "Todo o calendário";
}

export function nomeDoArquivoDaExportacao(f: FiltrosDeExportacao): string {
  const periodo = f.dateFrom || f.dateTo ? `${f.dateFrom ?? "inicio"}-a-${f.dateTo ?? "fim"}` : "completo";
  return nomeDeArquivo(["calendario-pgcp", periodo], f.formato);
}

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------

export function gerarXlsxDoCalendario(reunioes: ReuniaoExportada[]): Buffer {
  const colunas = [
    { titulo: "Data", largura: 12 },
    { titulo: "Horário inicial", largura: 10 },
    { titulo: "Horário final", largura: 10 },
    { titulo: "Reunião", largura: 60 },
    { titulo: "Órgão de Governança", largura: 32 },
    { titulo: "Tipo", largura: 14 },
    { titulo: "Status", largura: 14 },
    { titulo: "Modalidade", largura: 11 },
    { titulo: "Local", largura: 26 },
    { titulo: "Participantes", largura: 60 },
    { titulo: "Qtd. participantes", largura: 10 },
    { titulo: "Qtd. externos", largura: 10 },
    { titulo: "Qtd. temas", largura: 9 },
    { titulo: "Convite Outlook/Teams", largura: 22 },
    { titulo: "Origem", largura: 13 },
    { titulo: "Fuso horário", largura: 18 },
  ];
  const linhas: CelulaXlsx[][] = reunioes.map((r) => {
    const l = linhaDaExportacao(r);
    return [
      { data: l.dataPartes },
      { hora: l.inicioPartes },
      { hora: l.fimPartes },
      l.reuniao,
      l.orgao,
      l.tipo,
      l.status,
      l.modalidade,
      l.local,
      l.participantes,
      l.qtdParticipantes,
      l.qtdExternos,
      l.temas,
      l.convite,
      l.origem,
      l.fuso,
    ];
  });
  return gerarXlsx("Calendário", colunas, linhas);
}

export function gerarPdfDoCalendario(
  reunioes: ReuniaoExportada[],
  contexto: { periodo: string; orgao: string | null; tema?: string },
): Promise<Buffer> {
  // Exportação do TEMA (Biblioteca): mesmo layout, cabeçalho do tema.
  const titulo = contexto.tema ? `Reuniões do tema — ${contexto.tema}` : `Calendário — ${contexto.periodo}`;
  const { doc, bytes } = novoRelatorio({
    tipo: contexto.tema ? "REUNIÕES DO TEMA" : "CALENDÁRIO DE REUNIÕES",
    sobretitulo: contexto.orgao ?? "Todos os órgãos de governança",
    titulo,
    emitidoEm: new Date().toISOString(),
    paisagem: true,
  });
  secao(doc, "Filtros");
  campos(doc, [
    ...(contexto.tema ? ([["Tema", contexto.tema]] as [string, string][]) : []),
    ["Período", contexto.periodo],
    ["Órgão de governança", contexto.orgao ?? "Todos"],
    ["Reuniões", String(reunioes.length)],
  ]);
  secao(doc, "Reuniões");
  tabela(
    doc,
    [
      { titulo: "Data", largura: 0.08 },
      { titulo: "Horário", largura: 0.09 },
      { titulo: "Reunião", largura: 0.27 },
      { titulo: "Órgão", largura: 0.15 },
      { titulo: "Status", largura: 0.08 },
      { titulo: "Modalidade", largura: 0.1 },
      { titulo: "Participantes", largura: 0.23 },
    ],
    reunioes.map((r) => {
      const l = linhaDaExportacao(r);
      const pessoas = l.qtdParticipantes === 0
        ? "—"
        : `${l.qtdParticipantes}${l.qtdExternos ? ` (${l.qtdExternos} externo${l.qtdExternos > 1 ? "s" : ""})` : ""}: ${r.participantes.join(", ")}`;
      return [
        l.data,
        `${l.inicio}–${l.fim}`,
        [l.reuniao, l.tipo].filter(Boolean).join("\n"),
        l.orgao,
        l.status,
        [l.modalidade, l.local].filter(Boolean).join(" — "),
        pessoas.length > 400 ? `${pessoas.slice(0, 399)}…` : pessoas,
      ];
    }),
    "Nenhuma reunião no período.",
  );
  finalizar(doc, titulo);
  return bytes;
}

export async function exportarCalendario(
  filtros: FiltrosDeExportacao,
  espectador: EspectadorPgcp,
): Promise<{ conteudo: Buffer; tipo: string; nome: string }> {
  const reunioes = await consultarReunioesParaExportacao(filtros, espectador);
  const nome = nomeDoArquivoDaExportacao(filtros);
  if (filtros.formato === "xlsx") {
    return { conteudo: gerarXlsxDoCalendario(reunioes), tipo: MIME_XLSX, nome };
  }
  let orgao: string | null = null;
  if (filtros.governanceBodyId) {
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM governance_bodies WHERE id = $1", [filtros.governanceBodyId]);
    if (!rows[0]) throw new HttpError(404, "Órgão de governança não encontrado.");
    orgao = rows[0].name;
  }
  const conteudo = await gerarPdfDoCalendario(reunioes, { periodo: descreverPeriodo(filtros), orgao });
  return { conteudo, tipo: PDF_CONTENT_TYPE, nome };
}
