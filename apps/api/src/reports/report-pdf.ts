import PDFDocument from "pdfkit";
import { LOGO, LOGO_LADO, MARCA } from "../agenda-pdf/brand.js";

/**
 * RELATÓRIO PDF DO PGCP — base comum dos documentos tabulares gerados pelo
 * servidor (versão da reunião, exportação do calendário).
 *
 * Mesma identidade dos PDFs já existentes (logo e paleta de `brand.ts`,
 * cabeçalho e rodapé numerado da Agenda Anual). Só fontes padrão do PDF
 * (Helvetica): nada embutido, nada baixado.
 *
 * Todo texto entra como TEXTO (pdfkit não interpreta HTML): conteúdo vindo do
 * usuário nunca vira marcação aqui.
 */

export type Doc = PDFKit.PDFDocument;

export const FUSO_DOS_DOCUMENTOS = "America/Sao_Paulo";
export const PDF_CONTENT_TYPE = "application/pdf";

const MARGEM = 46;
const RODAPE_ALTURA = 30;

export const larguraUtil = (doc: Doc) => doc.page.width - MARGEM * 2;
const limiteInferior = (doc: Doc) => doc.page.height - MARGEM - RODAPE_ALTURA;

export function limpo(valor: string | null | undefined): string {
  return (valor ?? "").replace(/\s+/g, " ").trim();
}

export function limitar(valor: string | null | undefined, maximo: number): string {
  const t = limpo(valor);
  return t.length <= maximo ? t : `${t.slice(0, maximo - 1)}…`;
}

/** Formata no fuso informado; fuso inválido cai para UTC em vez de quebrar o documento. */
export function noFuso(iso: string, fuso: string, opcoes: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: fuso }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: "UTC" }).format(new Date(iso));
  }
}

export const dataHoraBrasilia = (iso: string) =>
  noFuso(iso, FUSO_DOS_DOCUMENTOS, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Nome de arquivo seguro: só ASCII, sem separador de caminho, tamanho limitado. */
export function nomeDeArquivo(partes: Array<string | number>, extensao: "pdf" | "xlsx"): string {
  const base = partes
    .map((p) =>
      String(p)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("-")
    .slice(0, 100)
    .replace(/-+$/, "");
  return `${base || "pgcp"}.${extensao}`;
}

export interface CabecalhoDoRelatorio {
  /** Rótulo no canto (ex.: "VERSÃO 3 DA REUNIÃO"). */
  tipo: string;
  /** Linha pequena acima do título (ex.: órgão). */
  sobretitulo: string;
  titulo: string;
  emitidoEm: string;
  paisagem?: boolean;
}

/** Cria o documento e devolve a promessa dos bytes (resolvida no `doc.end()`). */
export function novoRelatorio(meta: CabecalhoDoRelatorio): { doc: Doc; bytes: Promise<Buffer> } {
  const doc = new PDFDocument({
    size: "A4",
    layout: meta.paisagem ? "landscape" : "portrait",
    margins: { top: MARGEM, bottom: MARGEM + RODAPE_ALTURA, left: MARGEM, right: MARGEM },
    bufferPages: true,
    info: { Title: limitar(`${meta.tipo} — ${meta.titulo}`, 200), Author: "PGCP", Subject: meta.tipo },
  });
  const pedacos: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (p: Buffer) => pedacos.push(p));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(pedacos)));
  });
  cabecalho(doc, meta);
  return { doc, bytes };
}

function filete(doc: Doc, y: number, cor: string, espessura: number, x0 = MARGEM, x1 = doc.page.width - MARGEM): void {
  doc.save().moveTo(x0, y).lineTo(x1, y).lineWidth(espessura).strokeColor(cor).stroke().restore();
}

function cabecalho(doc: Doc, meta: CabecalhoDoRelatorio): void {
  const topo = MARGEM;
  doc.image(LOGO, MARGEM, topo, { width: LOGO_LADO, height: LOGO_LADO });
  const xTexto = MARGEM + LOGO_LADO + 12;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(MARCA.primaria).text("PGCP", xTexto, topo + 3, { lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(MARCA.tintaFraca)
    .text("Plataforma Corporativa de Gestão de Pautas", xTexto, topo + 19, { lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor(MARCA.media)
    .text(meta.tipo, MARGEM, topo + 4, { width: larguraUtil(doc), align: "right", characterSpacing: 0.8, lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(MARCA.tintaFraca)
    .text(`Emitido em ${dataHoraBrasilia(meta.emitidoEm)} (horário de Brasília)`, MARGEM, topo + 19, {
      width: larguraUtil(doc),
      align: "right",
      lineBreak: false,
    });
  const y = topo + LOGO_LADO + 12;
  filete(doc, y, MARCA.primaria, 2.5, MARGEM, MARGEM + 64);
  filete(doc, y, MARCA.linha, 2.5, MARGEM + 64);
  doc.y = y + 16;
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MARCA.primaria)
    .text(limitar(meta.sobretitulo, 140).toUpperCase(), MARGEM, doc.y, { width: larguraUtil(doc), characterSpacing: 1 });
  doc.y += 3;
  doc
    .font("Helvetica-Bold")
    .fontSize(17)
    .fillColor(MARCA.profunda)
    .text(limitar(meta.titulo, 220), MARGEM, doc.y, { width: larguraUtil(doc) });
  doc.y += 10;
}

/** Quebra a página se o bloco não couber. */
export function garantirEspaco(doc: Doc, altura: number): void {
  if (doc.y + altura > limiteInferior(doc)) {
    doc.addPage();
    doc.y = MARGEM;
  }
}

export function secao(doc: Doc, texto: string): void {
  // Título nunca fica sozinho no pé da página: leva junto umas linhas.
  garantirEspaco(doc, 90);
  doc.y += 6;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(MARCA.primaria)
    .text(texto.toUpperCase(), MARGEM, doc.y, { width: larguraUtil(doc), characterSpacing: 0.8 });
  filete(doc, doc.y + 2, MARCA.linha, 1);
  doc.y += 8;
}

/** Pares rótulo/valor, um por linha; valor vazio vira "—". */
export function campos(doc: Doc, pares: Array<[string, string | null | undefined]>): void {
  const largura = larguraUtil(doc);
  const colunaRotulo = 150;
  for (const [rotulo, valor] of pares) {
    const texto = limpo(valor) || "—";
    doc.font("Helvetica").fontSize(9);
    const altura = doc.heightOfString(texto, { width: largura - colunaRotulo }) + 4;
    garantirEspaco(doc, altura);
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MARCA.tintaFraca).text(rotulo, MARGEM, y + 1, { width: colunaRotulo - 8 });
    doc.font("Helvetica").fontSize(9).fillColor(MARCA.tinta).text(texto, MARGEM + colunaRotulo, y, { width: largura - colunaRotulo });
    doc.y = Math.max(doc.y, y + altura);
  }
}

/** Texto corrido (ex.: descrição). Quebras de linha preservadas. */
export function paragrafo(doc: Doc, texto: string, vazio = "—"): void {
  const t = (texto ?? "").trim() || vazio;
  doc.font("Helvetica").fontSize(9).fillColor(MARCA.tinta);
  for (const linha of t.split("\n")) {
    const altura = doc.heightOfString(linha || " ", { width: larguraUtil(doc) });
    garantirEspaco(doc, altura);
    doc.text(linha || " ", MARGEM, doc.y, { width: larguraUtil(doc) });
  }
  doc.y += 4;
}

export interface ColunaDaTabela {
  titulo: string;
  /** Fração da largura útil (as frações somam 1). */
  largura: number;
}

/** Texto de célula: espaços normalizados POR LINHA (quebras intencionais ficam). */
function textoDaCelula(valor: string): string {
  return (valor ?? "").split("\n").map(limpo).filter(Boolean).join("\n") || "—";
}

/** Tabela simples com cabeçalho repetido a cada página. */
export function tabela(doc: Doc, colunas: ColunaDaTabela[], linhas: string[][], vazio = "Nenhum registro."): void {
  const largura = larguraUtil(doc);
  const larguras = colunas.map((c) => c.largura * largura);
  const desenharCabecalho = () => {
    garantirEspaco(doc, 40);
    const y = doc.y;
    doc.rect(MARGEM, y, largura, 18).fill(MARCA.fundoSuave);
    let x = MARGEM;
    colunas.forEach((c, i) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MARCA.media).text(c.titulo.toUpperCase(), x + 4, y + 5, {
        width: larguras[i]! - 8,
        lineBreak: false,
        ellipsis: true,
      });
      x += larguras[i]!;
    });
    doc.y = y + 20;
  };

  desenharCabecalho();
  if (linhas.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MARCA.tintaFraca).text(vazio, MARGEM + 4, doc.y, { width: largura - 8 });
    doc.y += 4;
    return;
  }
  for (const linha of linhas) {
    doc.font("Helvetica").fontSize(8.5);
    const altura =
      Math.max(...linha.map((celula, i) => doc.heightOfString(textoDaCelula(celula), { width: larguras[i]! - 8 }))) + 8;
    if (doc.y + altura > limiteInferior(doc)) {
      doc.addPage();
      doc.y = MARGEM;
      desenharCabecalho();
    }
    const y = doc.y;
    let x = MARGEM;
    linha.forEach((celula, i) => {
      doc.font("Helvetica").fontSize(8.5).fillColor(MARCA.tinta).text(textoDaCelula(celula), x + 4, y + 4, { width: larguras[i]! - 8 });
      x += larguras[i]!;
    });
    filete(doc, y + altura, MARCA.linha, 0.5);
    doc.y = y + altura + 1;
  }
  doc.y += 4;
}

/** Rodapé numerado em todas as páginas e fecha o documento. */
export function finalizar(doc: Doc, textoDoRodape: string): void {
  const faixa = doc.bufferedPageRange();
  for (let i = 0; i < faixa.count; i++) {
    doc.switchToPage(faixa.start + i);
    const margem = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGEM - RODAPE_ALTURA + 12;
    filete(doc, y - 7, MARCA.linha, 1);
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(MARCA.tintaFraca)
      .text(`PGCP · ${limitar(textoDoRodape, 110)} · Documento gerado eletronicamente`, MARGEM, y, {
        width: larguraUtil(doc) - 90,
        lineBreak: false,
        ellipsis: true,
      });
    doc.text(`Página ${i + 1} de ${faixa.count}`, doc.page.width - MARGEM - 90, y, { width: 90, align: "right", lineBreak: false });
    doc.page.margins.bottom = margem;
  }
  doc.end();
}
