import pool from "../database.js";
import { HttpError } from "../http-error.js";
import type { EspectadorPgcp } from "./visibility.js";
import { parseListFilters } from "./service.js";
import { consultarReunioesParaExportacao, linhaDaExportacao, type ReuniaoExportada } from "./export.js";
import { campos, finalizar, nomeDeArquivo, novoRelatorio, PDF_CONTENT_TYPE, secao, tabela } from "../reports/report-pdf.js";

/**
 * CRONOGRAMA ANUAL (PDF): visão do ano em GRADE — uma linha por órgão de
 * governança, uma coluna por mês, e em cada célula as datas/horários das
 * reuniões daquele mês. Planejamento em uma página.
 *
 * Mesmo conjunto da exportação do Calendário (`export.ts`): mesma política de
 * leitura/visibilidade, sem reunião cancelada, dia LOCAL da reunião (fuso
 * dela). Só data, hora e órgão — nada de título, participantes ou conteúdo.
 */

export interface FiltrosDoCronograma {
  ano: number;
  governanceBodyId?: string;
}

const PERMITIDOS = new Set(["year", "governanceBodyId"]);
export const MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

/** Query string FECHADA: ano obrigatório; órgão pelo mesmo parser da listagem. */
export function parseFiltrosDoCronograma(query: Record<string, unknown>): FiltrosDoCronograma {
  for (const chave of Object.keys(query)) {
    if (!PERMITIDOS.has(chave)) throw new HttpError(400, `O parâmetro '${chave}' não é suportado.`);
  }
  const ano = typeof query.year === "string" && /^\d{4}$/.test(query.year) ? Number(query.year) : NaN;
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) {
    throw new HttpError(400, "Informe o ano do cronograma (ex.: 2026).");
  }
  const { governanceBodyId } = parseListFilters({ governanceBodyId: query.governanceBodyId });
  return { ano, governanceBodyId };
}

export interface LinhaDoCronograma {
  orgao: string;
  /** 12 posições (jan..dez): "dd · hh:mm" de cada reunião, em ordem. */
  meses: string[][];
  total: number;
}

/** Monta a grade (pura). Órgãos em ordem alfabética; só os que têm reunião no ano. */
export function gradeDoCronograma(reunioes: ReuniaoExportada[], ano: number): LinhaDoCronograma[] {
  const porOrgao = new Map<string, LinhaDoCronograma>();
  for (const r of reunioes) {
    const l = linhaDaExportacao(r);
    if (l.dataPartes.ano !== ano) continue;
    let linha = porOrgao.get(r.orgao);
    if (!linha) {
      linha = { orgao: r.orgao, meses: MESES.map(() => []), total: 0 };
      porOrgao.set(r.orgao, linha);
    }
    const marca = r.tipo === "extraordinary" ? " (E)" : "";
    linha.meses[l.dataPartes.mes - 1]!.push(`${String(l.dataPartes.dia).padStart(2, "0")} · ${l.inicio}${marca}`);
    linha.total += 1;
  }
  return [...porOrgao.values()].sort((a, b) => a.orgao.localeCompare(b.orgao, "pt-BR"));
}

export function gerarPdfDoCronograma(
  linhas: LinhaDoCronograma[],
  contexto: { ano: number; orgao: string | null },
): Promise<Buffer> {
  const { doc, bytes } = novoRelatorio({
    tipo: "CRONOGRAMA ANUAL",
    sobretitulo: contexto.orgao ?? "Todos os órgãos de governança",
    titulo: `Cronograma de reuniões — ${contexto.ano}`,
    emitidoEm: new Date().toISOString(),
    paisagem: true,
  });
  secao(doc, "Filtros");
  campos(doc, [
    ["Ano", String(contexto.ano)],
    ["Órgão de governança", contexto.orgao ?? "Todos"],
    ["Reuniões", String(linhas.reduce((soma, l) => soma + l.total, 0))],
  ]);
  secao(doc, "Reuniões por mês (dia · horário de início; (E) = extraordinária)");
  tabela(
    doc,
    [
      { titulo: "Órgão", largura: 0.15 },
      ...MESES.map((m) => ({ titulo: m, largura: 0.065 })),
      { titulo: "Total", largura: 0.07 },
    ],
    linhas.map((l) => [l.orgao, ...l.meses.map((datas) => (datas.length ? datas.join("\n") : "—")), String(l.total)]),
    "Nenhuma reunião no ano.",
  );
  finalizar(doc, `Cronograma — ${contexto.ano}`);
  return bytes;
}

export async function exportarCronograma(
  filtros: FiltrosDoCronograma,
  espectador: EspectadorPgcp,
): Promise<{ conteudo: Buffer; tipo: string; nome: string }> {
  const reunioes = await consultarReunioesParaExportacao(
    { formato: "pdf", governanceBodyId: filtros.governanceBodyId, dateFrom: `${filtros.ano}-01-01`, dateTo: `${filtros.ano}-12-31` },
    espectador,
  );
  let orgao: string | null = null;
  if (filtros.governanceBodyId) {
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM governance_bodies WHERE id = $1", [filtros.governanceBodyId]);
    if (!rows[0]) throw new HttpError(404, "Órgão de governança não encontrado.");
    orgao = rows[0].name;
  }
  const conteudo = await gerarPdfDoCronograma(gradeDoCronograma(reunioes, filtros.ano), { ano: filtros.ano, orgao });
  return { conteudo, tipo: PDF_CONTENT_TYPE, nome: nomeDeArquivo(["cronograma-pgcp", filtros.ano, orgao ?? "todos"], "pdf") };
}
