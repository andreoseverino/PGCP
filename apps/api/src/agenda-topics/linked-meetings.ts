import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { clausulaDeReuniaoVisivel, type EspectadorPgcp } from "../meetings/visibility.js";
import { descreverLocalFisico, lerLocalDaReuniao } from "../meetings/locations.js";
import {
  consultarReunioesParaExportacao,
  gerarPdfDoCalendario,
  gerarXlsxDoCalendario,
  MAX_REUNIOES_EXPORTADAS,
  type FormatoDeExportacao,
} from "../meetings/export.js";
import { MIME_XLSX } from "../reports/xlsx.js";
import { nomeDeArquivo, PDF_CONTENT_TYPE } from "../reports/report-pdf.js";
import { assertValidId } from "./service.js";

/**
 * REUNIÕES DE UM TEMA DA BIBLIOTECA — o selo "N reuniões" do card abre um
 * modal com TODAS as reuniões em que o tema está na pauta (passadas, futuras
 * e canceladas), com busca, seleção e exportação (PDF/Excel).
 *
 * Leitura: mesma política do Calendário (`visibility.ts`). A exportação usa o
 * MESMO gerador do Calendário — o que sai no arquivo é o que já sai lá (sem
 * descrição, sem e-mail).
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
  /** Descrição do local físico; `null` em reunião online. */
  location: string | null;
  /** Desfecho do tema NESTA reunião (`meeting_agenda_items.execution_status`). */
  executionStatus: string;
  participantsCount: number;
}

async function garantirTema(topicId: string): Promise<string> {
  assertValidId(topicId);
  const { rows } = await pool.query<{ title: string }>("SELECT title FROM agenda_topics WHERE id = $1", [topicId]);
  if (!rows[0]) throw new HttpError(404, "Tema não encontrado na Biblioteca.");
  return rows[0].title;
}

export async function listarReunioesDoTema(topicId: string, espectador: EspectadorPgcp): Promise<ReuniaoDoTema[]> {
  await garantirTema(topicId);
  const params: unknown[] = [topicId];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // Uma linha por REUNIÃO: se o tema aparece duas vezes na mesma pauta, vale
  // o primeiro item (ordem da pauta).
  const { rows } = await pool.query<{
    meeting_id: string;
    title: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    orgao: string;
    status: string;
    cancelada: boolean;
    session_type: string | null;
    modality: "online" | "in_person";
    physical_location_snapshot: unknown;
    execution_status: string;
    participantes: number;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.id)
              m.id AS meeting_id, m.title, m.start_at, m.end_at, m.timezone, gb.name AS orgao, m.status,
              (m.cancelled_at IS NOT NULL) AS cancelada, m.session_type, m.modality, m.physical_location_snapshot,
              ai.execution_status,
              (SELECT count(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id)::int AS participantes
         FROM meeting_agenda_items ai
         JOIN meetings m ON m.id = ai.meeting_id
         JOIN governance_bodies gb ON gb.id = m.governance_body_id
        WHERE ai.agenda_topic_id = $1 AND ${clausulaDeReuniaoVisivel("m", espectador, bind)}
        ORDER BY m.id, ai.position, ai.id
     ) r
     ORDER BY r.start_at DESC, r.meeting_id`,
    params,
  );
  return rows.map((r) => {
    const local = r.modality === "in_person" ? lerLocalDaReuniao(r.physical_location_snapshot) : null;
    return {
      meetingId: r.meeting_id,
      title: r.title,
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
      timezone: r.timezone,
      governanceBody: r.orgao,
      status: r.status,
      cancelled: r.cancelada,
      sessionType: r.session_type,
      modality: r.modality,
      location: r.modality === "in_person" ? (local ? descreverLocalFisico(local) : "Presencial") : null,
      executionStatus: r.execution_status,
      participantsCount: r.participantes,
    };
  });
}

export interface FiltrosDaExportacaoDoTema {
  formato: FormatoDeExportacao;
  /** Seleção do modal; ausente = todas as reuniões do tema. */
  meetingIds?: string[];
}

const PERMITIDOS = new Set(["format", "meetingIds"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query string FECHADA: formato obrigatório; `meetingIds` = UUIDs separados por vírgula. */
export function parseFiltrosDaExportacaoDoTema(query: Record<string, unknown>): FiltrosDaExportacaoDoTema {
  for (const chave of Object.keys(query)) {
    if (!PERMITIDOS.has(chave)) throw new HttpError(400, `O parâmetro '${chave}' não é suportado.`);
  }
  const formato = query.format;
  if (formato !== "pdf" && formato !== "xlsx") {
    throw new HttpError(400, "Informe o formato da exportação: 'pdf' ou 'xlsx'.");
  }
  if (query.meetingIds === undefined) return { formato };
  if (typeof query.meetingIds !== "string") throw new HttpError(400, "'meetingIds' inválido.");
  const ids = [...new Set(query.meetingIds.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new HttpError(400, "Selecione ao menos uma reunião para exportar.");
  if (ids.length > MAX_REUNIOES_EXPORTADAS) throw new HttpError(400, "Reuniões demais na seleção.");
  if (!ids.every((id) => UUID.test(id))) throw new HttpError(400, "'meetingIds' contém identificador inválido.");
  return { formato, meetingIds: ids };
}

export async function exportarReunioesDoTema(
  topicId: string,
  filtros: FiltrosDaExportacaoDoTema,
  espectador: EspectadorPgcp,
): Promise<{ conteudo: Buffer; tipo: string; nome: string }> {
  const tema = await garantirTema(topicId);
  const reunioes = await consultarReunioesParaExportacao(
    { formato: filtros.formato, agendaTopicId: topicId, meetingIds: filtros.meetingIds },
    espectador,
  );
  const nome = nomeDeArquivo(["reunioes-do-tema", tema], filtros.formato);
  if (filtros.formato === "xlsx") {
    return { conteudo: gerarXlsxDoCalendario(reunioes), tipo: MIME_XLSX, nome };
  }
  const periodo = filtros.meetingIds ? `${reunioes.length} reunião(ões) selecionada(s)` : "Todas as reuniões do tema";
  const conteudo = await gerarPdfDoCalendario(reunioes, { periodo, orgao: null, tema });
  return { conteudo, tipo: PDF_CONTENT_TYPE, nome };
}
