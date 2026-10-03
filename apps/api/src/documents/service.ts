import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { clausulaDeReuniaoVisivel, type EspectadorPgcp } from "../meetings/visibility.js";
import { liberadaParaPipelineSql } from "../meetings/pipeline-release.js";

/**
 * DOCUMENTOS — biblioteca central (MVP, leitura).
 *
 * O PGCP ainda NÃO armazena arquivos enviados por usuários: não há upload,
 * tabela de anexos nem storage configurado (decisão de infraestrutura
 * pendente). Esta biblioteca reúne os documentos que o PGCP JÁ persiste e
 * entrega por rotas próprias, sem copiar nada:
 *
 *   Ata                 `meeting_minutes` (com conteúdo) → `GET /meetings/:id/minutes/pdf`
 *   Agenda Anual        versão vigente enviada/aprovada (`annual_agenda_versions`,
 *                       snapshot imutável) → `GET /annual-agendas/:id/document`
 *
 * Prévia da Agenda Anual NÃO entra: muda a cada edição, não é documento.
 *
 * LEITURA: a mesma política das reuniões (`clausulaDeReuniaoVisivel`) e da
 * Agenda Anual (usuário PGCP ativo). O download continua nas rotas de origem,
 * com a autorização delas — esta rota só LISTA. Órgão do contexto global é
 * filtro, não autorização.
 */

export type TipoDeDocumento = "ata" | "agenda_anual";
const TIPOS: readonly TipoDeDocumento[] = ["ata", "agenda_anual"];
const ORDENS = ["recentes", "antigos", "nome"] as const;
type Ordem = (typeof ORDENS)[number];

export interface FiltrosDeDocumentos {
  q?: string;
  governanceBodyId?: string;
  meetingId?: string;
  /** Tema da Biblioteca TRATADO na reunião do documento (documento da reunião, não do tema). */
  topicId?: string;
  /** Autoria: quem enviou a versão (Agenda) / quem editou por último (Ata). */
  authorUserId?: string;
  type?: TipoDeDocumento;
  /** Data do DOCUMENTO (envio/aprovação/última edição), dia `AAAA-MM-DD` em Brasília. */
  dateFrom?: string;
  dateTo?: string;
  sort: Ordem;
  limit: number;
  offset: number;
}

export interface DocumentoDoPgcp {
  /** Estável e opaco ("ata:<reunião>", "agenda:<versão>"); não é caminho de arquivo. */
  id: string;
  type: TipoDeDocumento;
  name: string;
  format: "PDF";
  /** Situação do documento (Ata: rascunho/em revisão...; Agenda: enviada/aprovada). */
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
  /** Data do documento (ISO): envio/aprovação da versão; última edição da Ata. */
  documentAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const PERMITIDOS = ["q", "governanceBodyId", "meetingId", "topicId", "authorUserId", "type", "dateFrom", "dateTo", "sort", "limit", "offset"];
export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 200;

/** Query string FECHADA: parâmetro desconhecido ou inválido → 400. */
export function parseFiltrosDeDocumentos(query: Record<string, unknown>): FiltrosDeDocumentos {
  for (const chave of Object.keys(query)) {
    if (!PERMITIDOS.includes(chave)) throw new HttpError(400, `O filtro '${chave}' não é suportado.`);
  }
  const texto = (k: string): string | undefined => {
    const v = query[k];
    if (v === undefined || v === "") return undefined;
    if (typeof v !== "string") throw new HttpError(400, `O filtro '${k}' é inválido.`);
    return v.trim();
  };
  const uuid = (k: string) => {
    const v = texto(k);
    if (v !== undefined && !UUID.test(v)) throw new HttpError(400, `O filtro '${k}' é inválido.`);
    return v?.toLowerCase();
  };
  const dia = (k: string) => {
    const v = texto(k);
    if (v !== undefined && (!DIA.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new HttpError(400, `A data '${k}' é inválida.`);
    return v;
  };
  const inteiro = (k: string, padrao: number, max: number) => {
    const v = texto(k);
    if (v === undefined) return padrao;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, `O filtro '${k}' é inválido.`);
    return n;
  };
  const tipo = texto("type");
  if (tipo !== undefined && !(TIPOS as readonly string[]).includes(tipo)) throw new HttpError(400, "Tipo de documento inválido.");
  const ordem = texto("sort") ?? "recentes";
  if (!(ORDENS as readonly string[]).includes(ordem)) throw new HttpError(400, "Ordenação inválida.");
  const q = texto("q");
  if (q !== undefined && q.length > 200) throw new HttpError(400, "Busca muito longa.");
  return {
    q,
    governanceBodyId: uuid("governanceBodyId"),
    meetingId: uuid("meetingId"),
    topicId: uuid("topicId"),
    authorUserId: uuid("authorUserId"),
    type: tipo as TipoDeDocumento | undefined,
    dateFrom: dia("dateFrom"),
    dateTo: dia("dateTo"),
    sort: ordem as Ordem,
    limit: inteiro("limit", LIMITE_PADRAO, LIMITE_MAXIMO) || LIMITE_PADRAO,
    offset: inteiro("offset", 0, 100_000),
  };
}

const ROTULO_DA_ATA: Record<string, string> = {
  draft: "Ata em elaboração",
  under_review: "Ata em revisão",
  approved: "Ata aprovada",
  closed: "Ata encerrada",
};

interface Linha {
  id: string;
  type: TipoDeDocumento;
  name: string;
  doc_status: string;
  governance_body_id: string;
  governance_body_name: string;
  meeting_id: string | null;
  meeting_title: string | null;
  meeting_start_at: Date | null;
  meeting_timezone: string | null;
  meeting_annual_agenda_id: string | null;
  released: boolean | null;
  annual_agenda_id: string | null;
  annual_agenda_year: number | null;
  version: number | null;
  author_id: string | null;
  author_name: string | null;
  document_at: Date;
  total: number;
}

/** Lista os documentos visíveis, filtrados e paginados — UMA consulta. */
export async function listarDocumentos(
  filtros: FiltrosDeDocumentos,
  espectador: EspectadorPgcp,
): Promise<{ documents: DocumentoDoPgcp[]; total: number }> {
  const valores: unknown[] = [];
  const bind = (v: unknown) => {
    valores.push(v);
    return `$${valores.length}`;
  };
  const visivel = clausulaDeReuniaoVisivel("m", espectador, bind);

  const onde: string[] = [];
  if (filtros.q) onde.push(`d.name ILIKE ${bind(`%${filtros.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
  if (filtros.governanceBodyId) onde.push(`d.governance_body_id = ${bind(filtros.governanceBodyId)}`);
  if (filtros.meetingId) onde.push(`d.meeting_id = ${bind(filtros.meetingId)}`);
  if (filtros.topicId) {
    onde.push(`d.meeting_id IN (SELECT i.meeting_id FROM meeting_agenda_items i WHERE i.agenda_topic_id = ${bind(filtros.topicId)})`);
  }
  if (filtros.authorUserId) onde.push(`d.author_id = ${bind(filtros.authorUserId)}`);
  if (filtros.type) onde.push(`d.type = ${bind(filtros.type)}`);
  // Dia do documento no horário de Brasília (o mesmo dos PDFs do PGCP).
  if (filtros.dateFrom) onde.push(`(d.document_at AT TIME ZONE 'America/Sao_Paulo')::date >= ${bind(filtros.dateFrom)}::date`);
  if (filtros.dateTo) onde.push(`(d.document_at AT TIME ZONE 'America/Sao_Paulo')::date <= ${bind(filtros.dateTo)}::date`);

  const ordem =
    filtros.sort === "nome" ? "d.name, d.id" : filtros.sort === "antigos" ? "d.document_at, d.id" : "d.document_at DESC, d.id";

  const { rows } = await pool.query<Linha>(
    `WITH d AS (
       SELECT 'ata:' || m.id AS id, 'ata'::text AS type,
              'Ata — ' || m.title AS name, mm.status AS doc_status,
              m.governance_body_id, gb.name AS governance_body_name,
              m.id AS meeting_id, m.title AS meeting_title, m.start_at AS meeting_start_at, m.timezone AS meeting_timezone,
              m.annual_agenda_id AS meeting_annual_agenda_id, ${liberadaParaPipelineSql("m")} AS released,
              NULL::uuid AS annual_agenda_id, NULL::int AS annual_agenda_year, NULL::int AS version,
              mm.updated_by_user_id AS author_id, ua.name AS author_name,
              mm.updated_at AS document_at
         FROM meeting_minutes mm
         JOIN meetings m ON m.id = mm.meeting_id
         JOIN governance_bodies gb ON gb.id = m.governance_body_id
         LEFT JOIN users ua ON ua.id = mm.updated_by_user_id
        WHERE btrim(mm.content) <> '' AND ${visivel}
       UNION ALL
       SELECT 'agenda:' || v.id, 'agenda_anual',
              'Agenda Anual ' || a.year || ' — ' || a.title, CASE WHEN v.approved_at IS NOT NULL THEN 'approved' ELSE 'pending_approval' END,
              a.governance_body_id, gb.name,
              NULL, NULL, NULL, NULL, NULL, NULL,
              a.id, a.year, v.version,
              v.sent_by_user_id, uv.name,
              coalesce(v.approved_at, v.sent_at)
         FROM annual_agenda_versions v
         JOIN annual_agendas a ON a.id = v.annual_agenda_id
         JOIN governance_bodies gb ON gb.id = a.governance_body_id
         LEFT JOIN users uv ON uv.id = v.sent_by_user_id
        -- Só a versão VIGENTE (a que GET /annual-agendas/:id/document entrega).
        WHERE v.withdrawn_at IS NULL
          AND v.version = (SELECT max(v2.version) FROM annual_agenda_versions v2
                            WHERE v2.annual_agenda_id = a.id AND v2.withdrawn_at IS NULL)
     )
     SELECT d.*, count(*) OVER ()::int AS total
       FROM d
      ${onde.length ? `WHERE ${onde.join(" AND ")}` : ""}
      ORDER BY ${ordem}
      LIMIT ${bind(filtros.limit)} OFFSET ${bind(filtros.offset)}`,
    valores,
  );

  return {
    total: rows[0]?.total ?? 0,
    documents: rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      format: "PDF",
      status:
        r.type === "ata"
          ? ROTULO_DA_ATA[r.doc_status] ?? "Ata"
          : r.doc_status === "approved"
            ? `Aprovada (versão ${r.version})`
            : `Enviada para aprovação (versão ${r.version})`,
      governanceBody: { id: r.governance_body_id, name: r.governance_body_name },
      meeting: r.meeting_id
        ? {
            id: r.meeting_id,
            title: r.meeting_title!,
            startAt: r.meeting_start_at!.toISOString(),
            timezone: r.meeting_timezone!,
            annualAgendaId: r.meeting_annual_agenda_id,
            releasedToPipeline: r.released === true,
          }
        : null,
      annualAgenda: r.annual_agenda_id ? { id: r.annual_agenda_id, year: r.annual_agenda_year!, version: r.version! } : null,
      author: r.author_id ? { id: r.author_id, name: r.author_name ?? "" } : null,
      documentAt: r.document_at.toISOString(),
    })),
  };
}
