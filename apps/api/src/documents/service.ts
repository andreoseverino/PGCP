import { createHash, randomUUID } from "node:crypto";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { clausulaDeReuniaoVisivel, type EspectadorPgcp } from "../meetings/visibility.js";
import type { MeetingActor } from "../meetings/create.js";
import { exigirArmazenamento } from "./storage.js";
import { chaveDoObjeto, descricaoOpcional, validarArquivo } from "./file-rules.js";

/**
 * DOCUMENTOS — biblioteca central.
 *
 * Fontes, todas listadas pela MESMA consulta (PostgreSQL é a fonte de verdade;
 * o bucket nunca é listado):
 *
 *   anexo          `documents` (033): arquivo ENVIADO por usuário, guardado no
 *                  AWS S3, ligado à reunião e, opcionalmente, ao TEMA DAQUELA
 *                  REUNIÃO (`meeting_agenda_items`).
 *   Ata            `meeting_minutes` com conteúdo → PDF gerado pela rota da Ata.
 *   Agenda Anual   versão vigente enviada/aprovada (`annual_agenda_versions`,
 *                  snapshot imutável) → PDF gerado pela rota do documento.
 *
 * Atas e Agendas continuam GERADAS sob demanda do dado imutável/persistido (sem
 * cópia de bytes): guardá-las no S3 é a próxima etapa, com `source = 'pgcp'`.
 *
 * LEITURA: política de reunião (`clausulaDeReuniaoVisivel`) e de Agenda Anual
 * (usuário ativo). O download de anexo passa pela API, que autoriza pelo
 * CONTEXTO do documento — trocar o id não dá acesso a nada além do que a pessoa
 * já pode ler. Órgão do contexto global é filtro, não autorização.
 */

/*
 * Tipos (10/2026): além de anexo, Ata e versão da Agenda Anual, entram os
 * PDFs que o PGCP já gera — cada VERSÃO DA REUNIÃO (034), as PAUTAS APROVADAS
 * e a VERSÃO ATUAL (prévia) da Agenda Anual. Pastas: Órgão → Ano → Mês → Dia →
 * Reunião; e Órgão → Ano → Agenda Anual (versão atual + versão aprovada).
 */
export type TipoDeDocumento = "anexo" | "ata" | "agenda_anual" | "versao_reuniao" | "pautas" | "agenda_previa";
const TIPOS: readonly TipoDeDocumento[] = ["anexo", "ata", "agenda_anual", "versao_reuniao", "pautas", "agenda_previa"];
const ORIGENS = ["user", "pgcp"] as const;
type Origem = (typeof ORIGENS)[number];
const ORDENS = ["recentes", "antigos", "nome", "nome_desc"] as const;
type Ordem = (typeof ORDENS)[number];

/**
 * FORMATO do arquivo (visão "tipo" da Biblioteca, como no Drive), derivado da
 * EXTENSÃO — a mesma fonte com que o servidor decide o MIME no upload
 * (`file-rules.ts`), então é confiável. Gerados (Ata, Agenda Anual) são PDF.
 * O tipo de NEGÓCIO (anexo/Ata/Agenda Anual) continua em `type`.
 */
export const FORMATOS = ["pdf", "documento", "planilha", "apresentacao", "imagem", "video", "outros"] as const;
export type Formato = (typeof FORMATOS)[number];
const EXTENSOES_DO_FORMATO: Record<Exclude<Formato, "outros">, readonly string[]> = {
  pdf: ["pdf"],
  documento: ["doc", "docx", "odt", "rtf", "txt"],
  planilha: ["xls", "xlsx", "ods", "csv"],
  apresentacao: ["ppt", "pptx", "odp"],
  imagem: ["png", "jpg", "jpeg", "gif", "webp"],
  video: ["mp4", "mov", "webm"],
};
const TODAS_AS_EXTENSOES_CONHECIDAS = Object.values(EXTENSOES_DO_FORMATO).flat();

export function formatoDaExtensao(extensao: string | null | undefined): Formato {
  const e = (extensao ?? "").toLowerCase();
  for (const [formato, lista] of Object.entries(EXTENSOES_DO_FORMATO)) {
    if (lista.includes(e)) return formato as Formato;
  }
  return "outros";
}

export interface FiltrosDeDocumentos {
  /** Busca por palavras (todas precisam aparecer): nome, reunião, tema, órgão, mês, ano, extensão. */
  q?: string;
  governanceBodyId?: string;
  meetingId?: string;
  /** Tema DA REUNIÃO (`meeting_agenda_items.id`). */
  agendaItemId?: string;
  /** Tema da Biblioteca TRATADO na reunião do documento. */
  topicId?: string;
  annualAgendaId?: string;
  /** Ano do CONTEXTO (reunião no fuso dela; Agenda: o ano da Agenda) — pastas da árvore. */
  year?: number;
  /** Mês (1–12) da REUNIÃO no fuso dela — pastas da árvore. Exclui Agenda Anual. */
  month?: number;
  /** Dia (1–31) da REUNIÃO no fuso dela — pasta de dia da árvore. */
  day?: number;
  /** Quem enviou (anexo) / emitiu (Agenda) / editou por último (Ata). */
  authorUserId?: string;
  type?: TipoDeDocumento;
  /** Formato do arquivo (PDF, Documento, Planilha...). */
  format?: Formato;
  /** Só os favoritos de QUEM PEDE (preferência pessoal, 037). */
  favorites?: boolean;
  source?: Origem;
  /** Data do DOCUMENTO, dia `AAAA-MM-DD` em Brasília. */
  dateFrom?: string;
  dateTo?: string;
  sort: Ordem;
  limit: number;
  offset: number;
}

export interface DocumentoDoPgcp {
  /** Estável e opaco ("doc:<uuid>", "ata:<reunião>", "agenda:<versão>"); não é caminho de arquivo. */
  id: string;
  type: TipoDeDocumento;
  source: Origem;
  name: string;
  /** Extensão em minúsculas (anexo: do arquivo; gerados: "pdf"). */
  extension: string;
  /** Tamanho em bytes quando conhecido (anexo); gerados: `null`. */
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
  /** Versão da reunião (034) — só no tipo `versao_reuniao` (download pelo PDF da versão). */
  meetingVersion: { id: string; number: number } | null;
  author: { id: string; name: string } | null;
  documentAt: string;
  /** Formato derivado da extensão (ver `formatoDaExtensao`). */
  format: Formato;
  /** Favorito de quem pediu a lista (037). */
  favorite: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const PERMITIDOS = [
  "q", "governanceBodyId", "meetingId", "agendaItemId", "topicId", "annualAgendaId", "authorUserId",
  "type", "source", "dateFrom", "dateTo", "year", "month", "day", "sort", "limit", "offset", "format", "favorites",
];
export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 200;
const MAX_PALAVRAS = 8;

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
  const faixa = (k: string, min: number, max: number) => {
    const v = texto(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `O filtro '${k}' é inválido.`);
    return n;
  };
  const tipo = texto("type");
  if (tipo !== undefined && !(TIPOS as readonly string[]).includes(tipo)) throw new HttpError(400, "Tipo de documento inválido.");
  const origem = texto("source");
  if (origem !== undefined && !(ORIGENS as readonly string[]).includes(origem)) throw new HttpError(400, "Origem inválida.");
  const formato = texto("format");
  if (formato !== undefined && !(FORMATOS as readonly string[]).includes(formato)) throw new HttpError(400, "Formato inválido.");
  const favoritos = texto("favorites");
  if (favoritos !== undefined && favoritos !== "true") throw new HttpError(400, "O filtro 'favorites' só aceita 'true'.");
  const ordem = texto("sort") ?? "recentes";
  if (!(ORDENS as readonly string[]).includes(ordem)) throw new HttpError(400, "Ordenação inválida.");
  const q = texto("q");
  if (q !== undefined && q.length > 200) throw new HttpError(400, "Busca muito longa.");
  return {
    q,
    governanceBodyId: uuid("governanceBodyId"),
    meetingId: uuid("meetingId"),
    agendaItemId: uuid("agendaItemId"),
    topicId: uuid("topicId"),
    annualAgendaId: uuid("annualAgendaId"),
    authorUserId: uuid("authorUserId"),
    year: faixa("year", 2000, 2100),
    month: faixa("month", 1, 12),
    day: faixa("day", 1, 31),
    type: tipo as TipoDeDocumento | undefined,
    format: formato as Formato | undefined,
    favorites: favoritos === "true" ? true : undefined,
    source: origem as Origem | undefined,
    dateFrom: dia("dateFrom"),
    dateTo: dia("dateTo"),
    sort: ordem as Ordem,
    limit: inteiro("limit", LIMITE_PADRAO, LIMITE_MAXIMO) || LIMITE_PADRAO,
    offset: inteiro("offset", 0, 100_000),
  };
}

/** Palavras da busca (minúsculas, sem duplicar, no máximo 8). */
export function palavrasDaBusca(q: string | undefined): string[] {
  if (!q) return [];
  return [...new Set(q.toLocaleLowerCase("pt-BR").split(/\s+/).filter(Boolean))].slice(0, MAX_PALAVRAS);
}

const escaparLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

const ROTULO_DA_ATA: Record<string, string> = {
  draft: "Ata em elaboração",
  under_review: "Ata em revisão",
  approved: "Ata aprovada",
  closed: "Ata encerrada",
};

const MESES_SQL = `(ARRAY['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'])`;

/**
 * Todos os documentos visíveis, numa CTE (sem N+1). `$1` = reservado para a
 * cláusula de visibilidade (via `bind`). Colunas iguais nos três ramos.
 */
function cteDosDocumentos(visivel: string): string {
  const mesDaReuniao = `${MESES_SQL}[extract(month FROM (m.start_at AT TIME ZONE m.timezone))::int]`;
  const anoDaReuniao = `extract(year FROM (m.start_at AT TIME ZONE m.timezone))::int`;
  const numeroDoMes = `extract(month FROM (m.start_at AT TIME ZONE m.timezone))::int`;
  const diaDaReuniao = `extract(day FROM (m.start_at AT TIME ZONE m.timezone))::int`;
  return `
     WITH d AS (
       SELECT 'doc:' || doc.id AS id, doc.id AS document_id, 'anexo'::text AS type, doc.source,
              doc.original_filename AS name, lower(substring(doc.original_filename FROM '\\.([^.]+)$')) AS extension,
              doc.size_bytes, doc.description, 'Enviado'::text AS doc_status,
              m.governance_body_id, gb.name AS governance_body_name,
              m.id AS meeting_id, m.title AS meeting_title, m.start_at AS meeting_start_at, m.timezone AS meeting_timezone,
              m.annual_agenda_id AS meeting_annual_agenda_id, TRUE AS released,
              i.id AS topic_id, i.title AS topic_title, i.agenda_topic_id AS library_topic_id,
              NULL::uuid AS annual_agenda_id, NULL::int AS annual_agenda_year, NULL::int AS version,
              doc.uploaded_by_user_id AS author_id, ud.name AS author_name,
              doc.created_at AS document_at,
              ${anoDaReuniao} AS context_year, ${numeroDoMes} AS context_month, ${mesDaReuniao} AS month_name,
              ${diaDaReuniao} AS context_day, NULL::uuid AS meeting_version_id
         FROM documents doc
         JOIN meetings m ON m.id = doc.meeting_id
         JOIN governance_bodies gb ON gb.id = m.governance_body_id
         LEFT JOIN meeting_agenda_items i ON i.id = doc.meeting_agenda_item_id AND i.meeting_id = doc.meeting_id
         LEFT JOIN users ud ON ud.id = doc.uploaded_by_user_id
        WHERE ${visivel}
       UNION ALL
       SELECT 'ata:' || m.id, NULL::uuid, 'ata', 'pgcp',
              'Ata — ' || m.title, 'pdf', NULL::bigint, NULL::text, mm.status,
              m.governance_body_id, gb.name,
              m.id, m.title, m.start_at, m.timezone,
              m.annual_agenda_id, TRUE,
              NULL::uuid, NULL::text, NULL::uuid,
              NULL::uuid, NULL::int, NULL::int,
              mm.updated_by_user_id, ua.name,
              mm.updated_at,
              ${anoDaReuniao}, ${numeroDoMes}, ${mesDaReuniao}, ${diaDaReuniao}, NULL::uuid
         FROM meeting_minutes mm
         JOIN meetings m ON m.id = mm.meeting_id
         JOIN governance_bodies gb ON gb.id = m.governance_body_id
         LEFT JOIN users ua ON ua.id = mm.updated_by_user_id
        WHERE btrim(mm.content) <> '' AND ${visivel}
       UNION ALL
       -- Cada VERSÃO DA REUNIÃO (034): PDF gerado do snapshot imutável.
       SELECT 'versao:' || mv.id, NULL::uuid, 'versao_reuniao', 'pgcp',
              'Versão ' || mv.version || ' — ' || m.title, 'pdf', NULL::bigint, mv.change_summary, 'versao',
              m.governance_body_id, gb.name,
              m.id, m.title, m.start_at, m.timezone,
              m.annual_agenda_id, TRUE,
              NULL::uuid, NULL::text, NULL::uuid,
              NULL::uuid, NULL::int, mv.version,
              mv.created_by_user_id, umv.name,
              mv.created_at,
              ${anoDaReuniao}, ${numeroDoMes}, ${mesDaReuniao}, ${diaDaReuniao}, mv.id
         FROM meeting_versions mv
         JOIN meetings m ON m.id = mv.meeting_id
         JOIN governance_bodies gb ON gb.id = m.governance_body_id
         LEFT JOIN users umv ON umv.id = mv.created_by_user_id
        WHERE ${visivel}
       UNION ALL
       -- PAUTAS APROVADAS: PDF das pautas (mesmo gerador da antiga validação).
       SELECT 'pautas:' || m.id, NULL::uuid, 'pautas', 'pgcp',
              'Pautas aprovadas — ' || m.title, 'pdf', NULL::bigint, NULL::text, 'approved',
              m.governance_body_id, gb.name,
              m.id, m.title, m.start_at, m.timezone,
              m.annual_agenda_id, TRUE,
              NULL::uuid, NULL::text, NULL::uuid,
              NULL::uuid, NULL::int, NULL::int,
              m.agenda_approved_by_user_id, upa.name,
              m.agenda_approved_at,
              ${anoDaReuniao}, ${numeroDoMes}, ${mesDaReuniao}, ${diaDaReuniao}, NULL::uuid
         FROM meetings m
         JOIN governance_bodies gb ON gb.id = m.governance_body_id
         LEFT JOIN users upa ON upa.id = m.agenda_approved_by_user_id
        WHERE m.agenda_validation_status = 'approved' AND ${visivel}
       UNION ALL
       -- AGENDA ANUAL — VERSÃO ATUAL (prévia, estado de agora): toda agenda formalizada.
       SELECT 'previa:' || a.id, NULL::uuid, 'agenda_previa', 'pgcp',
              'Agenda Anual ' || a.year || ' — ' || a.title || ' (versão atual)', 'pdf', NULL::bigint, NULL::text, a.status,
              a.governance_body_id, gb.name,
              NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL,
              a.id, a.year, NULL::int,
              NULL::uuid, NULL::text,
              a.updated_at,
              a.year, NULL::int, NULL, NULL::int, NULL::uuid
         FROM annual_agendas a
         JOIN governance_bodies gb ON gb.id = a.governance_body_id
       UNION ALL
       SELECT 'agenda:' || v.id, NULL::uuid, 'agenda_anual', 'pgcp',
              'Agenda Anual ' || a.year || ' — ' || a.title
                || CASE WHEN v.approved_at IS NOT NULL THEN ' (versão aprovada)' ELSE '' END, 'pdf', NULL::bigint, NULL::text,
              CASE WHEN v.approved_at IS NOT NULL THEN 'approved' ELSE 'pending_approval' END,
              a.governance_body_id, gb.name,
              NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL,
              a.id, a.year, v.version,
              v.sent_by_user_id, uv.name,
              coalesce(v.approved_at, v.sent_at),
              a.year, NULL::int, NULL, NULL::int, NULL::uuid
         FROM annual_agenda_versions v
         JOIN annual_agendas a ON a.id = v.annual_agenda_id
         JOIN governance_bodies gb ON gb.id = a.governance_body_id
         LEFT JOIN users uv ON uv.id = v.sent_by_user_id
        -- Só a versão VIGENTE (a que GET /annual-agendas/:id/document entrega).
        WHERE v.withdrawn_at IS NULL
          AND v.version = (SELECT max(v2.version) FROM annual_agenda_versions v2
                            WHERE v2.annual_agenda_id = a.id AND v2.withdrawn_at IS NULL)
     )`;
}

interface Linha {
  id: string;
  document_id: string | null;
  type: TipoDeDocumento;
  source: Origem;
  name: string;
  extension: string | null;
  size_bytes: string | number | null;
  description: string | null;
  doc_status: string;
  governance_body_id: string;
  governance_body_name: string;
  meeting_id: string | null;
  meeting_title: string | null;
  meeting_start_at: Date | null;
  meeting_timezone: string | null;
  meeting_annual_agenda_id: string | null;
  released: boolean | null;
  topic_id: string | null;
  topic_title: string | null;
  annual_agenda_id: string | null;
  annual_agenda_year: number | null;
  version: number | null;
  author_id: string | null;
  author_name: string | null;
  document_at: Date;
  meeting_version_id: string | null;
  favorite: boolean;
  total: number;
}

function paraDocumento(r: Linha): DocumentoDoPgcp {
  return {
    id: r.id,
    type: r.type,
    source: r.source,
    name: r.name,
    extension: r.extension ?? "",
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    description: r.description,
    status:
      r.type === "anexo"
        ? "Enviado por usuário"
        : r.type === "ata"
          ? ROTULO_DA_ATA[r.doc_status] ?? "Ata"
          : r.type === "versao_reuniao"
            ? `Versão ${r.version} da reunião`
            : r.type === "pautas"
              ? "Pautas aprovadas"
              : r.type === "agenda_previa"
                ? "Versão atual (estado de agora)"
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
    topic: r.topic_id ? { id: r.topic_id, title: r.topic_title ?? "" } : null,
    annualAgenda: r.annual_agenda_id ? { id: r.annual_agenda_id, year: r.annual_agenda_year!, version: r.version ?? 0 } : null,
    meetingVersion: r.meeting_version_id ? { id: r.meeting_version_id, number: r.version ?? 0 } : null,
    author: r.author_id ? { id: r.author_id, name: r.author_name ?? "" } : null,
    documentAt: r.document_at.toISOString(),
    format: formatoDaExtensao(r.extension),
    favorite: r.favorite === true,
  };
}

/** Condição SQL do formato sobre `d.extension` (lista fechada, nunca texto do cliente). */
function condicaoDoFormato(formato: Formato, bind: (v: unknown) => string): string {
  if (formato === "outros") return `(d.extension IS NULL OR NOT (d.extension = ANY(${bind(TODAS_AS_EXTENSOES_CONHECIDAS)}::text[])))`;
  return `d.extension = ANY(${bind(EXTENSOES_DO_FORMATO[formato])}::text[])`;
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
  // Cada palavra precisa aparecer em algum dos campos do contexto.
  for (const p of palavrasDaBusca(filtros.q)) {
    onde.push(
      `lower(concat_ws(' ', d.name, d.meeting_title, d.topic_title, d.governance_body_name, d.extension, d.month_name, d.context_year::text)) LIKE ${bind(`%${escaparLike(p)}%`)}`,
    );
  }
  if (filtros.governanceBodyId) onde.push(`d.governance_body_id = ${bind(filtros.governanceBodyId)}`);
  if (filtros.meetingId) onde.push(`d.meeting_id = ${bind(filtros.meetingId)}`);
  if (filtros.agendaItemId) onde.push(`d.topic_id = ${bind(filtros.agendaItemId)}`);
  if (filtros.topicId) {
    onde.push(`d.meeting_id IN (SELECT i.meeting_id FROM meeting_agenda_items i WHERE i.agenda_topic_id = ${bind(filtros.topicId)})`);
  }
  if (filtros.annualAgendaId) onde.push(`d.annual_agenda_id = ${bind(filtros.annualAgendaId)}`);
  if (filtros.authorUserId) onde.push(`d.author_id = ${bind(filtros.authorUserId)}`);
  // Pastas da árvore: mesmo ano/mês que as agrupou (o da reunião, não o do upload).
  if (filtros.year !== undefined) onde.push(`d.context_year = ${bind(filtros.year)}`);
  if (filtros.month !== undefined) onde.push(`d.context_month = ${bind(filtros.month)}`);
  if (filtros.day !== undefined) onde.push(`d.context_day = ${bind(filtros.day)}`);
  if (filtros.type) onde.push(`d.type = ${bind(filtros.type)}`);
  if (filtros.format) onde.push(condicaoDoFormato(filtros.format, bind));
  if (filtros.source) onde.push(`d.source = ${bind(filtros.source)}`);
  // Favorito é de QUEM PEDE; a visibilidade continua sendo a da CTE.
  const favorito = `EXISTS (SELECT 1 FROM document_favorites f WHERE f.user_id = ${bind(espectador.userId)} AND f.document_key = d.id)`;
  if (filtros.favorites) onde.push(favorito);
  // Dia do documento no horário de Brasília (o mesmo dos PDFs do PGCP).
  if (filtros.dateFrom) onde.push(`(d.document_at AT TIME ZONE 'America/Sao_Paulo')::date >= ${bind(filtros.dateFrom)}::date`);
  if (filtros.dateTo) onde.push(`(d.document_at AT TIME ZONE 'America/Sao_Paulo')::date <= ${bind(filtros.dateTo)}::date`);

  const ordem =
    filtros.sort === "nome"
      ? "d.name, d.id"
      : filtros.sort === "nome_desc"
        ? "d.name DESC, d.id"
        : filtros.sort === "antigos"
          ? "d.document_at, d.id"
          : "d.document_at DESC, d.id";

  const { rows } = await pool.query<Linha>(
    `${cteDosDocumentos(visivel)}
     SELECT d.*, ${favorito} AS favorite, count(*) OVER ()::int AS total
       FROM d
      ${onde.length ? `WHERE ${onde.join(" AND ")}` : ""}
      ORDER BY ${ordem}
      LIMIT ${bind(filtros.limit)} OFFSET ${bind(filtros.offset)}`,
    valores,
  );
  return { total: rows[0]?.total ?? 0, documents: rows.map(paraDocumento) };
}

// --- Árvore: Órgão → Ano → (Agenda Anual | Mês → Data + Reunião) ----------------

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

/**
 * Pastas VISUAIS, montadas dos metadados (nenhuma tabela de pasta, nenhuma
 * leitura do bucket). Só contextos com documento. Mês = mês LOCAL da reunião.
 */
export async function arvoreDeDocumentos(espectador: EspectadorPgcp, governanceBodyId?: string): Promise<ArvoreDeDocumentos> {
  const valores: unknown[] = [];
  const bind = (v: unknown) => {
    valores.push(v);
    return `$${valores.length}`;
  };
  const visivel = clausulaDeReuniaoVisivel("m", espectador, bind);
  const filtro = governanceBodyId ? `WHERE d.governance_body_id = ${bind(governanceBodyId)}` : "";
  const { rows } = await pool.query<{
    governance_body_id: string;
    governance_body_name: string;
    context_year: number;
    meeting_id: string | null;
    meeting_title: string | null;
    meeting_start_at: Date | null;
    meeting_timezone: string | null;
    released: boolean | null;
    annual_agenda_id: string | null;
    agenda_title: string | null;
    total: number;
  }>(
    `${cteDosDocumentos(visivel)}
     SELECT d.governance_body_id, d.governance_body_name, d.context_year,
            d.meeting_id, d.meeting_title, d.meeting_start_at, d.meeting_timezone, d.released,
            d.annual_agenda_id, (SELECT a.title FROM annual_agendas a WHERE a.id = d.annual_agenda_id) AS agenda_title,
            count(*)::int AS total
       FROM d ${filtro}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
      ORDER BY 2, 3 DESC, 6 NULLS FIRST`,
    valores,
  );

  const arvore: ArvoreDeDocumentos = { bodies: [] };
  for (const r of rows) {
    let orgao = arvore.bodies.find((b) => b.id === r.governance_body_id);
    if (!orgao) arvore.bodies.push((orgao = { id: r.governance_body_id, name: r.governance_body_name, total: 0, years: [] }));
    orgao.total += r.total;
    let ano = orgao.years.find((y) => y.year === r.context_year);
    if (!ano) orgao.years.push((ano = { year: r.context_year, annualAgendas: [], months: [] }));
    if (r.annual_agenda_id) {
      ano.annualAgendas.push({ id: r.annual_agenda_id, title: r.agenda_title ?? "", total: r.total });
      continue;
    }
    const mes = Number(
      new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: r.meeting_timezone! }).format(r.meeting_start_at!),
    );
    let pasta = ano.months.find((x) => x.month === mes);
    if (!pasta) ano.months.push((pasta = { month: mes, meetings: [] }));
    pasta.meetings.push({
      id: r.meeting_id!,
      title: r.meeting_title!,
      startAt: r.meeting_start_at!.toISOString(),
      timezone: r.meeting_timezone!,
      releasedToPipeline: r.released === true,
      total: r.total,
    });
  }
  for (const o of arvore.bodies) {
    o.years.sort((a, b) => b.year - a.year);
    for (const y of o.years) {
      y.months.sort((a, b) => a.month - b.month);
      for (const mm of y.months) mm.meetings.sort((a, b) => a.startAt.localeCompare(b.startAt));
    }
  }
  return arvore;
}

// --- Armazenamento (dados REAIS; sem quota inventada) ---------------------------

export interface ResumoDoArmazenamento {
  /** Documentos visíveis (anexos + gerados). */
  documents: number;
  /** Anexos enviados (têm arquivo no S3 e tamanho conhecido). */
  attachments: number;
  /** Soma de `size_bytes` dos anexos visíveis. Gerados não ocupam armazenamento. */
  attachmentBytes: number;
  /** Ata/Agenda Anual: gerados sob demanda do dado gravado, sem arquivo. */
  generated: number;
  byFormat: Array<{ format: Formato; documents: number; bytes: number }>;
}

/**
 * Resumo do que a pessoa PODE ver (mesma CTE da Biblioteca). Não existe quota
 * no PGCP: nenhum "limite" é devolvido.
 */
export async function resumoDoArmazenamento(espectador: EspectadorPgcp, governanceBodyId?: string): Promise<ResumoDoArmazenamento> {
  const valores: unknown[] = [];
  const bind = (v: unknown) => {
    valores.push(v);
    return `$${valores.length}`;
  };
  const visivel = clausulaDeReuniaoVisivel("m", espectador, bind);
  const filtro = governanceBodyId ? `WHERE d.governance_body_id = ${bind(governanceBodyId)}` : "";
  const { rows } = await pool.query<{ type: TipoDeDocumento; extension: string | null; n: number; bytes: string | null }>(
    `${cteDosDocumentos(visivel)}
     SELECT d.type, d.extension, count(*)::int AS n, sum(d.size_bytes)::text AS bytes
       FROM d ${filtro}
      GROUP BY 1, 2`,
    valores,
  );
  const porFormato = new Map<Formato, { documents: number; bytes: number }>();
  const resumo: ResumoDoArmazenamento = { documents: 0, attachments: 0, attachmentBytes: 0, generated: 0, byFormat: [] };
  for (const r of rows) {
    const bytes = r.bytes ? Number(r.bytes) : 0;
    resumo.documents += r.n;
    if (r.type === "anexo") {
      resumo.attachments += r.n;
      resumo.attachmentBytes += bytes;
    } else {
      resumo.generated += r.n;
    }
    const f = formatoDaExtensao(r.extension);
    const atual = porFormato.get(f) ?? { documents: 0, bytes: 0 };
    porFormato.set(f, { documents: atual.documents + r.n, bytes: atual.bytes + bytes });
  }
  resumo.byFormat = [...porFormato].map(([format, v]) => ({ format, ...v })).sort((a, b) => b.bytes - a.bytes || b.documents - a.documents);
  return resumo;
}

// --- Favoritos (preferência pessoal, 037) ------------------------------------------

const CHAVE_DO_DOCUMENTO = /^(doc|ata|agenda):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseChaveDoDocumento(valor: string): string {
  const chave = valor.trim().toLowerCase();
  if (!CHAVE_DO_DOCUMENTO.test(chave)) throw new HttpError(400, "Identificador do documento inválido.");
  return chave;
}

/**
 * Favorita SÓ o que a pessoa pode ver: a chave precisa existir na MESMA CTE da
 * Biblioteca (visibilidade aplicada). Fora do alcance = 404, sem revelar se
 * existe. Idempotente.
 */
export async function favoritarDocumento(chaveBruta: string, espectador: EspectadorPgcp): Promise<void> {
  const chave = parseChaveDoDocumento(chaveBruta);
  const valores: unknown[] = [];
  const bind = (v: unknown) => {
    valores.push(v);
    return `$${valores.length}`;
  };
  const visivel = clausulaDeReuniaoVisivel("m", espectador, bind);
  const { rows } = await pool.query(`${cteDosDocumentos(visivel)} SELECT 1 FROM d WHERE d.id = ${bind(chave)}`, valores);
  if (rows.length === 0) throw new HttpError(404, "Documento não encontrado.");
  await pool.query(
    "INSERT INTO document_favorites (user_id, document_key) VALUES ($1, $2) ON CONFLICT (user_id, document_key) DO NOTHING",
    [espectador.userId, chave],
  );
}

/** Desfavorita (só a preferência de quem pede). Idempotente. */
export async function desfavoritarDocumento(chaveBruta: string, espectador: EspectadorPgcp): Promise<void> {
  const chave = parseChaveDoDocumento(chaveBruta);
  await pool.query("DELETE FROM document_favorites WHERE user_id = $1 AND document_key = $2", [espectador.userId, chave]);
}

// --- Upload (anexo da reunião / do tema da reunião) ------------------------------

export interface NovoDocumento {
  nome: unknown;
  descricao?: unknown;
  /** Tema DESTA reunião (`meeting_agenda_items.id`), opcional. */
  agendaItemId?: unknown;
  conteudo: Buffer;
}

/**
 * validar → S3 → PostgreSQL (com trilha). Se o metadado não gravar, o objeto é
 * removido (compensação): o banco nunca aponta para arquivo inexistente e, no
 * pior caso (falha também na remoção), sobra um objeto órfão no bucket — sem
 * metadado, invisível e inacessível pela aplicação; o log registra a chave.
 */
export async function adicionarDocumentoDaReuniao(meetingId: string, novo: NovoDocumento, ator: MeetingActor) {
  if (!UUID.test(meetingId)) throw new HttpError(400, "Identificador da reunião inválido.");
  const arquivo = validarArquivo(novo.nome, novo.conteudo);
  const descricao = descricaoOpcional(novo.descricao);
  let agendaItemId: string | null = null;
  if (novo.agendaItemId !== undefined && novo.agendaItemId !== null && novo.agendaItemId !== "") {
    if (typeof novo.agendaItemId !== "string" || !UUID.test(novo.agendaItemId)) throw new HttpError(400, "Tema inválido.");
    agendaItemId = novo.agendaItemId.toLowerCase();
  }
  const armazenamento = exigirArmazenamento();

  // Contexto: reunião existe e o tema é DELA (a FK composta reforça no INSERT).
  const { rows: ctx } = await pool.query<{ title: string; item_title: string | null; item_ok: boolean }>(
    `SELECT m.title,
            (SELECT i.title FROM meeting_agenda_items i WHERE i.id = $2 AND i.meeting_id = m.id) AS item_title,
            ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM meeting_agenda_items i WHERE i.id = $2 AND i.meeting_id = m.id)) AS item_ok
       FROM meetings m WHERE m.id = $1`,
    [meetingId, agendaItemId],
  );
  if (!ctx[0]) throw new HttpError(404, "Reunião não encontrada.");
  if (!ctx[0].item_ok) throw new HttpError(404, "Tema não encontrado nesta reunião.");

  const id = randomUUID();
  const chave = chaveDoObjeto({ meetingId, agendaItemId, documentId: id, extensao: arquivo.extensao });
  const sha256 = createHash("sha256").update(novo.conteudo).digest("hex");

  await armazenamento.gravar(chave, novo.conteudo, arquivo.mime);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO documents (id, source, meeting_id, meeting_agenda_item_id, original_filename, description,
                              mime_type, size_bytes, sha256, object_key, uploaded_by_user_id)
            VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, meetingId, agendaItemId, arquivo.nome, descricao, arquivo.mime, novo.conteudo.length, sha256, chave, ator.userId],
    );
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: agendaItemId ? "Documento adicionado ao tema da reunião" : "Documento adicionado à reunião",
      entityType: "document",
      entityId: id,
      // Contexto + nome do arquivo; nunca conteúdo, chave do objeto ou URL.
      entityLabel: `${ctx[0].title.slice(0, 120)}${ctx[0].item_title ? ` — ${ctx[0].item_title.slice(0, 80)}` : ""} — ${arquivo.nome.slice(0, 120)}`,
      status: "success",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await armazenamento.remover(chave).catch(() => {
      console.error(`[documents] compensação falhou; objeto órfão sem metadado: ${chave}`);
    });
    const code = (error as { code?: string } | null)?.code;
    if (code === "23503") throw new HttpError(409, "A reunião ou o tema mudou durante o envio. Tente novamente.");
    throw error;
  } finally {
    client.release();
  }
  return { id: `doc:${id}`, documentId: id, name: arquivo.nome, sizeBytes: novo.conteudo.length };
}

// --- Download (anexo) -----------------------------------------------------------

/**
 * Lê o anexo depois de AUTORIZAR pelo contexto (mesma cláusula de leitura da
 * reunião). Id inexistente ou fora da visibilidade → 404 (não revela qual).
 */
export async function lerDocumento(documentId: string, espectador: EspectadorPgcp) {
  if (!UUID.test(documentId)) throw new HttpError(400, "Identificador do documento inválido.");
  const valores: unknown[] = [documentId];
  const bind = (v: unknown) => {
    valores.push(v);
    return `$${valores.length}`;
  };
  const { rows } = await pool.query<{ original_filename: string; mime_type: string; object_key: string; size_bytes: string }>(
    `SELECT d.original_filename, d.mime_type, d.object_key, d.size_bytes
       FROM documents d JOIN meetings m ON m.id = d.meeting_id
      WHERE d.id = $1 AND ${clausulaDeReuniaoVisivel("m", espectador, bind)}`,
    valores,
  );
  const doc = rows[0];
  if (!doc) throw new HttpError(404, "Documento não encontrado.");
  const conteudo = await exigirArmazenamento().ler(doc.object_key);
  return { nome: doc.original_filename, mime: doc.mime_type, conteudo };
}

/** Exclusões que perderiam documento: recusadas com mensagem clara (política: sem apagar). */
export async function contarDocumentos(
  executor: { query: typeof pool.query },
  filtro: { meetingId?: string; agendaItemId?: string },
): Promise<number> {
  const { rows } = await executor.query<{ n: number }>(
    filtro.agendaItemId
      ? "SELECT count(*)::int AS n FROM documents WHERE meeting_agenda_item_id = $1"
      : "SELECT count(*)::int AS n FROM documents WHERE meeting_id = $1",
    [filtro.agendaItemId ?? filtro.meetingId],
  );
  return rows[0]?.n ?? 0;
}
