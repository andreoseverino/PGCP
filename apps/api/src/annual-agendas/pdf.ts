import PDFDocument from "pdfkit";
import { LOGO, LOGO_LADO, MARCA } from "../agenda-pdf/brand.js";

/**
 * PDF da AGENDA ANUAL — programacao de reunioes de um orgao no ano.
 *
 * Mesma identidade do PDF de validacao de pautas (`agenda-pdf/`): tokens de
 * `brand.ts`, logo, Helvetica (WinAnsi cobre o portugues), rodape paginado.
 * Tudo vem do dominio; nada e inventado. A data exibida e a VIGENTE — a da
 * reuniao quando ja reservada (pode ter sido ajustada pelo Pipeline).
 */

export interface ReuniaoDaAgendaNoPdf {
  titulo: string;
  /** Instantes UTC ISO-8601 e fuso IANA. */
  inicioEm: string;
  fimEm: string;
  fuso: string;
  /** Ja existe reuniao/evento para a data. */
  reservada: boolean;
}

export interface AgendaAnualNoPdf {
  titulo: string;
  ano: number;
  orgao: string;
  status: "draft" | "pending_approval" | "approved";
  /** Instante de emissao (ISO). */
  emitidoEm: string;
  reunioes: ReuniaoDaAgendaNoPdf[];
}

const ROTULO_DO_STATUS: Record<AgendaAnualNoPdf["status"], string> = {
  draft: "Em elaboração",
  pending_approval: "Aguardando aprovação",
  approved: "Aprovada",
};

const MARGEM = 56;
const RODAPE_ALTURA = 40;
type Doc = PDFKit.PDFDocument;

const larguraUtil = (doc: Doc) => doc.page.width - MARGEM * 2;
const limiteInferior = (doc: Doc) => doc.page.height - MARGEM - RODAPE_ALTURA;

function limitar(valor: string, maximo: number): string {
  const limpo = valor.replace(/\s+/g, " ").trim();
  return limpo.length <= maximo ? limpo : `${limpo.slice(0, maximo - 1)}…`;
}

/** Formata no FUSO da reuniao; fuso invalido cai para UTC em vez de 500. */
function noFuso(iso: string, fuso: string, opcoes: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: fuso }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: "UTC" }).format(new Date(iso));
  }
}

/** Linha da tabela, pura para ser testada sem gerar PDF. */
export function linhaDaReuniao(reuniao: ReuniaoDaAgendaNoPdf): {
  mes: string;
  data: string;
  horario: string;
  titulo: string;
  reserva: string;
} {
  const mes = noFuso(reuniao.inicioEm, reuniao.fuso, { month: "long" });
  return {
    mes: mes.charAt(0).toUpperCase() + mes.slice(1),
    data: noFuso(reuniao.inicioEm, reuniao.fuso, { weekday: "short", day: "2-digit", month: "2-digit" }),
    horario: `${noFuso(reuniao.inicioEm, reuniao.fuso, { hour: "2-digit", minute: "2-digit" })} – ${noFuso(
      reuniao.fimEm,
      reuniao.fuso,
      { hour: "2-digit", minute: "2-digit" },
    )}`,
    titulo: reuniao.titulo,
    reserva: reuniao.reservada ? "Reservada" : "A reservar",
  };
}

function cabecalho(doc: Doc, agenda: AgendaAnualNoPdf): void {
  const topo = doc.y;
  doc.image(LOGO, MARGEM, topo, { width: LOGO_LADO, height: LOGO_LADO });
  const xTexto = MARGEM + LOGO_LADO + 14;

  doc.font("Helvetica-Bold").fontSize(11).fillColor(MARCA.primaria).text("PGCP", xTexto, topo + 4, { lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(MARCA.tintaFraca)
    .text("Plataforma Corporativa de Gestão de Pautas", xTexto, topo + 19, { lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MARCA.tintaFraca)
    .text("AGENDA ANUAL", MARGEM, topo + 12, {
      width: larguraUtil(doc),
      align: "right",
      characterSpacing: 0.8,
      lineBreak: false,
    });

  doc.y = topo + LOGO_LADO + 18;
  doc.strokeColor(MARCA.primaria).lineWidth(2.5).moveTo(MARGEM, doc.y).lineTo(MARGEM + 64, doc.y).stroke();
  doc.strokeColor(MARCA.linha).lineWidth(2.5).moveTo(MARGEM + 64, doc.y).lineTo(doc.page.width - MARGEM, doc.y).stroke();
  doc.y += 18;

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MARCA.primaria)
    .text(limitar(agenda.orgao, 90).toUpperCase(), MARGEM, doc.y, { width: larguraUtil(doc), characterSpacing: 0.8 });
  doc.moveDown(0.4);
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(MARCA.profunda)
    .text(`${limitar(agenda.titulo, 160)} — ${agenda.ano}`, MARGEM, doc.y, { width: larguraUtil(doc) });
  doc.moveDown(0.5);

  const emissao = noFuso(agenda.emitidoEm, "America/Sao_Paulo", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const [nome, valor] of [
    ["Status", ROTULO_DO_STATUS[agenda.status]],
    ["Reuniões previstas", String(agenda.reunioes.length)],
    ["Emitido em", `${emissao} (America/Sao_Paulo)`],
  ] as const) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MARCA.tintaSuave).text(`${nome}: `, MARGEM, doc.y, { continued: true });
    doc.font("Helvetica").fillColor(MARCA.tinta).text(valor);
  }
  doc.moveDown(1);
}

const COLUNAS = [
  { titulo: "Mês", largura: 70 },
  { titulo: "Data", largura: 80 },
  { titulo: "Horário", largura: 80 },
  { titulo: "Reunião", largura: 0 }, // ocupa o resto
  { titulo: "Reserva", largura: 62 },
] as const;

function larguras(doc: Doc): number[] {
  const fixas = COLUNAS.reduce((soma, c) => soma + c.largura, 0);
  return COLUNAS.map((c) => (c.largura === 0 ? larguraUtil(doc) - fixas : c.largura));
}

function cabecalhoDaTabela(doc: Doc): void {
  const y = doc.y;
  doc.rect(MARGEM, y - 4, larguraUtil(doc), 18).fill("#EEF3F6");
  let x = MARGEM + 4;
  const ls = larguras(doc);
  COLUNAS.forEach((coluna, i) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MARCA.primaria).text(coluna.titulo.toUpperCase(), x, y, {
      width: ls[i]! - 8,
      lineBreak: false,
    });
    x += ls[i]!;
  });
  doc.y = y + 20;
}

function linha(doc: Doc, reuniao: ReuniaoDaAgendaNoPdf): void {
  const valores = linhaDaReuniao(reuniao);
  const celulas = [valores.mes, valores.data, valores.horario, limitar(valores.titulo, 200), valores.reserva];
  const ls = larguras(doc);

  doc.font("Helvetica").fontSize(9);
  const altura = Math.max(
    ...celulas.map((texto, i) => doc.heightOfString(texto, { width: ls[i]! - 8 })),
  ) + 8;

  if (doc.y + altura > limiteInferior(doc)) {
    doc.addPage();
    cabecalhoDaTabela(doc);
  }

  const y = doc.y;
  let x = MARGEM + 4;
  celulas.forEach((texto, i) => {
    doc
      .font(i === 3 ? "Helvetica-Bold" : "Helvetica")
      .fontSize(9)
      .fillColor(i === 4 && !reuniao.reservada ? MARCA.tintaFraca : MARCA.tinta)
      .text(texto, x, y, { width: ls[i]! - 8 });
    x += ls[i]!;
  });
  doc.y = y + altura;
  doc.strokeColor(MARCA.linha).lineWidth(0.6).moveTo(MARGEM, doc.y - 3).lineTo(doc.page.width - MARGEM, doc.y - 3).stroke();
}

function numerar(doc: Doc, titulo: string): void {
  const faixa = doc.bufferedPageRange();
  for (let i = 0; i < faixa.count; i++) {
    doc.switchToPage(faixa.start + i);
    // Rodape abaixo da margem: zera a margem durante a escrita (ver agenda-pdf).
    const margem = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGEM - RODAPE_ALTURA + 14;
    doc.strokeColor(MARCA.linha).lineWidth(1).moveTo(MARGEM, y - 8).lineTo(doc.page.width - MARGEM, y - 8).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(MARCA.tintaFraca).text(limitar(titulo, 70), MARGEM, y, {
      width: larguraUtil(doc) - 90,
      lineBreak: false,
      ellipsis: true,
    });
    doc.text(`Página ${i + 1} de ${faixa.count}`, doc.page.width - MARGEM - 90, y, {
      width: 90,
      align: "right",
      lineBreak: false,
    });
    doc.page.margins.bottom = margem;
  }
}

export function gerarPdfDaAgendaAnual(agenda: AgendaAnualNoPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGEM, bottom: MARGEM + RODAPE_ALTURA, left: MARGEM, right: MARGEM },
      bufferPages: true,
      info: {
        Title: `Agenda Anual ${agenda.ano} — ${limitar(agenda.titulo, 120)}`,
        Author: "PGCP",
        Subject: "Agenda Anual de reuniões",
      },
    });

    const pedacos: Buffer[] = [];
    doc.on("data", (p: Buffer) => pedacos.push(p));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(pedacos)));

    try {
      cabecalho(doc, agenda);
      if (agenda.reunioes.length === 0) {
        doc
          .font("Helvetica-Oblique")
          .fontSize(9.5)
          .fillColor(MARCA.tintaFraca)
          .text("Nenhuma reunião planejada nesta Agenda Anual.", MARGEM, doc.y, { width: larguraUtil(doc) });
      } else {
        cabecalhoDaTabela(doc);
        const ordenadas = [...agenda.reunioes].sort((a, b) => a.inicioEm.localeCompare(b.inicioEm));
        for (const reuniao of ordenadas) linha(doc, reuniao);
      }
      numerar(doc, `Agenda Anual ${agenda.ano} — ${agenda.titulo}`);
      doc.end();
    } catch (erro) {
      reject(erro);
    }
  });
}

export function nomeDoArquivoDaAgendaAnual(titulo: string, ano: number): string {
  const base = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `agenda-anual-${ano}-${base || "orgao"}.pdf`;
}
