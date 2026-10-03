import PDFDocument from "pdfkit";
import { LOGO, LOGO_LADO, MARCA } from "../agenda-pdf/brand.js";

/**
 * PDF da AGENDA ANUAL — documento executivo das reuniões de um órgão no ano.
 *
 * Mesma identidade do PDF de validação de pautas (`agenda-pdf/`): tokens de
 * `brand.ts`, logo, Helvetica (WinAnsi cobre o português), rodapé paginado.
 *
 * Tudo vem do domínio, nada é inventado: a PRÉVIA sai do estado atual; a
 * VERSÃO (enviada/aprovada) sai SÓ do snapshot gravado. Campo ausente
 * (snapshot antigo) é simplesmente omitido.
 *
 * Estrutura: cabeçalho → identificação → faixa (prévia/versão) → uma seção por
 * reunião (data em destaque, título, horário) → "TEMAS DA REUNIÃO" → um bloco
 * por tema (nome; horário · duração; responsável; tipo · natureza · circular;
 * objetivo; participantes "Nome (e-mail)").
 *
 * Regras de apresentação, puras e testadas: `conteudoDaReuniao`,
 * `formatarTema`, `pessoaComEmail`, `cabecalhoDaReuniao`, `rotuloDoDocumento`.
 */

export interface ReuniaoDaAgendaNoPdf {
  titulo: string;
  /** Instantes UTC ISO-8601 e fuso IANA. */
  inicioEm: string;
  fimEm: string;
  fuso: string;
  /** Já existe reunião para a data (`false` = data planejada, legado da reserva). */
  reservada: boolean;
  /** Conteúdo: Reunião -> Pauta -> Tema (028). Ausente = só a data. */
  pautas?: Array<{ titulo: string; temas: TemaNoPdf[] }>;
  temasSemPauta?: TemaNoPdf[];
}

export interface PessoaNoPdf {
  nome: string;
  email?: string | null;
}

/** Tema no PDF: só o título (snapshots muito antigos) ou a ficha que existir. */
export type TemaNoPdf =
  | string
  | {
      titulo: string;
      inicio?: string;
      fim?: string | null;
      duracao?: number | null;
      /** Nomes (snapshots anteriores ao e-mail). */
      participantes?: string[];
      /** Nome + e-mail (preferido quando existe). */
      pessoas?: PessoaNoPdf[];
      responsavel?: string | null;
      responsavelEmail?: string | null;
      tipo?: string | null;
      natureza?: string | null;
      circular?: boolean;
      descricao?: string | null;
    };

/**
 * Que documento é este. PRÉVIA reflete o estado atual e muda; VERSÃO é o
 * snapshot enviado ao aprovador (e, se for o caso, aprovado) — não muda.
 */
export type DocumentoDaAgendaNoPdf =
  | { tipo: "previa" }
  | {
      tipo: "versao";
      numero: number;
      enviadaEm: string;
      enviadaA: string;
      aprovadaEm: string | null;
      /** Quem registrou a aprovação no PGCP (se houver). */
      aprovadaPor?: string | null;
    };

export interface AgendaAnualNoPdf {
  titulo: string;
  ano: number;
  orgao: string;
  status: "draft" | "pending_approval" | "approved";
  /** Instante de emissão (ISO). */
  emitidoEm: string;
  reunioes: ReuniaoDaAgendaNoPdf[];
  /** Ausente = prévia (compatibilidade). */
  documento?: DocumentoDaAgendaNoPdf;
}

const ROTULO_DO_STATUS: Record<AgendaAnualNoPdf["status"], string> = {
  draft: "Em elaboração",
  pending_approval: "Aguardando aprovação",
  approved: "Aprovada",
};

/** Data/hora de emissão e de envio/aprovação: horário de Brasília, como no resto do produto. */
const FUSO_DO_DOCUMENTO = "America/Sao_Paulo";

// =============================================================================
// Regras de apresentação (puras)
// =============================================================================

function limpo(valor: string | null | undefined): string {
  return (valor ?? "").replace(/\s+/g, " ").trim();
}

function limitar(valor: string, maximo: number): string {
  const t = limpo(valor);
  return t.length <= maximo ? t : `${t.slice(0, maximo - 1)}…`;
}

/** Formata no FUSO informado; fuso inválido cai para UTC em vez de 500. */
function noFuso(iso: string, fuso: string, opcoes: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: fuso }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: "UTC" }).format(new Date(iso));
  }
}

const dataHora = (iso: string) =>
  noFuso(iso, FUSO_DO_DOCUMENTO, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** "Nome (e-mail)" quando há e-mail; senão só o nome. Nunca "undefined"/"null"/vazio. */
export function pessoaComEmail(nome: string | null | undefined, email?: string | null): string {
  const n = limpo(nome);
  const e = limpo(email);
  if (!n) return e;
  return e && e.toLowerCase() !== n.toLowerCase() ? `${n} (${e})` : n;
}

export interface TemaFormatado {
  /** "01", "02"... — só apresentação, na ordem real do documento. */
  numero: string;
  titulo: string;
  /** "08:00–09:30 · 90 min" (ou parte disso). */
  horario: string | null;
  /** "Nome (e-mail)". */
  responsavel: string | null;
  /** "Tipo: X · Natureza: Y · Circular: Não". */
  classificacao: string | null;
  objetivo: string | null;
  participantes: string[];
}

export function formatarTema(tema: TemaNoPdf, indice: number): TemaFormatado {
  const numero = String(indice + 1).padStart(2, "0");
  if (typeof tema === "string") {
    return { numero, titulo: limpo(tema), horario: null, responsavel: null, classificacao: null, objetivo: null, participantes: [] };
  }
  const faixa = tema.inicio ? (tema.fim ? `${tema.inicio}–${tema.fim}` : tema.inicio) : null;
  const duracao = tema.duracao ? `${tema.duracao} min` : tema.inicio ? "sem duração" : null;
  const horario = [faixa, duracao].filter(Boolean).join(" · ") || null;

  const classificacao =
    [
      limpo(tema.tipo) ? `Tipo: ${limpo(tema.tipo)}` : null,
      limpo(tema.natureza) ? `Natureza: ${limpo(tema.natureza)}` : null,
      typeof tema.circular === "boolean" ? `Circular: ${tema.circular ? "Sim" : "Não"}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  // Preferência: pessoas com e-mail; snapshot antigo: só os nomes.
  const participantes = (tema.pessoas
    ? tema.pessoas.map((p) => pessoaComEmail(p.nome, p.email))
    : (tema.participantes ?? []).map((n) => pessoaComEmail(n))
  ).filter((p) => p.length > 0);

  return {
    numero,
    titulo: limpo(tema.titulo),
    horario,
    responsavel: pessoaComEmail(tema.responsavel, tema.responsavelEmail) || null,
    classificacao,
    // O objetivo vai inteiro (só normaliza espaços): o documento aprovado não trunca.
    objetivo: tema.descricao?.trim() ? tema.descricao.trim() : null,
    participantes,
  };
}

/**
 * Temas da reunião para o documento. Uma pauta só (o caso comum, inclusive a
 * pauta padrão criada pelo servidor) é estrutura interna: NÃO aparece — os
 * temas vêm direto. Com duas ou mais pautas, cada uma vira um grupo titulado
 * (sem o rótulo técnico "Pauta:"). Pauta vazia não ocupa espaço. A ordem é a
 * do snapshot (posição); a numeração segue a ordem impressa.
 */
export function conteudoDaReuniao(reuniao: ReuniaoDaAgendaNoPdf): {
  grupos: Array<{ titulo: string | null; temas: TemaFormatado[] }>;
  totalTemas: number;
} {
  const pautas = (reuniao.pautas ?? []).filter((p) => p.temas.length > 0);
  const semPauta = reuniao.temasSemPauta ?? [];
  const comTitulos = pautas.length + (semPauta.length > 0 ? 1 : 0) > 1;
  const brutos: Array<{ titulo: string | null; temas: TemaNoPdf[] }> = comTitulos
    ? [
        ...pautas.map((p) => ({ titulo: limpo(p.titulo) || null, temas: p.temas })),
        ...(semPauta.length > 0 ? [{ titulo: "Outros temas", temas: semPauta }] : []),
      ]
    : [{ titulo: null, temas: [...pautas.flatMap((p) => p.temas), ...semPauta] }];

  let i = 0;
  const grupos = brutos
    .filter((g) => g.temas.length > 0)
    .map((g) => ({ titulo: g.titulo, temas: g.temas.map((t) => formatarTema(t, i++)) }));
  return { grupos, totalTemas: i };
}

/** Destaque de data e linha de horário da reunião, no fuso DA REUNIÃO. */
export function cabecalhoDaReuniao(reuniao: ReuniaoDaAgendaNoPdf): {
  dia: string;
  mesAno: string;
  semana: string;
  titulo: string;
  horario: string;
  /** Só para data planejada sem reunião (legado da reserva); `null` no fluxo atual. */
  aviso: string | null;
} {
  const mes = noFuso(reuniao.inicioEm, reuniao.fuso, { month: "short" }).replace(".", "").toUpperCase();
  const semana = noFuso(reuniao.inicioEm, reuniao.fuso, { weekday: "long" });
  const hora = (iso: string) => noFuso(iso, reuniao.fuso, { hour: "2-digit", minute: "2-digit" });
  return {
    dia: noFuso(reuniao.inicioEm, reuniao.fuso, { day: "2-digit" }),
    mesAno: `${mes} ${noFuso(reuniao.inicioEm, reuniao.fuso, { year: "numeric" })}`,
    semana: semana.charAt(0).toUpperCase() + semana.slice(1),
    titulo: limpo(reuniao.titulo),
    horario: `${hora(reuniao.inicioEm)}–${hora(reuniao.fimEm)}`,
    aviso: reuniao.reservada ? null : "Data planejada — reunião ainda não criada",
  };
}

/** Rótulo curto do tipo de documento (canto do cabeçalho). */
export function tipoDoDocumento(documento: DocumentoDaAgendaNoPdf | undefined): string {
  if (!documento || documento.tipo === "previa") return "AGENDA ANUAL — PRÉVIA";
  return documento.aprovadaEm ? "AGENDA ANUAL — APROVADA" : "AGENDA ANUAL — ENVIADA PARA APROVAÇÃO";
}

/** Texto da faixa de identificação do documento. */
export function rotuloDoDocumento(documento: DocumentoDaAgendaNoPdf | undefined): string {
  if (!documento || documento.tipo === "previa") {
    return "PRÉVIA — Este documento reflete o estado atual e não representa a versão aprovada.";
  }
  const envio = `enviada em ${dataHora(documento.enviadaEm)} a ${documento.enviadaA}`;
  if (!documento.aprovadaEm) return `Versão ${documento.numero} — ${envio}; aguardando aprovação.`;
  const por = limpo(documento.aprovadaPor) ? ` (registrada por ${limpo(documento.aprovadaPor)})` : "";
  return `Versão ${documento.numero} — aprovada em ${dataHora(documento.aprovadaEm)}${por}; ${envio}.`;
}

// =============================================================================
// Desenho
// =============================================================================

const MARGEM = 50;
const RODAPE_ALTURA = 34;
const COLUNA_DATA = 74;
type Doc = PDFKit.PDFDocument;

const larguraUtil = (doc: Doc) => doc.page.width - MARGEM * 2;
const limiteInferior = (doc: Doc) => doc.page.height - MARGEM - RODAPE_ALTURA;
const cabe = (doc: Doc, altura: number) => doc.y + altura <= limiteInferior(doc);

/** Reunião em curso: numa quebra de página, o tema seguinte leva a referência dela. */
interface Contexto {
  reuniao: string | null;
}

function novaPagina(doc: Doc, ctx: Contexto): void {
  doc.addPage();
  doc.y = MARGEM;
  if (ctx.reuniao) {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(MARCA.tintaFraca)
      .text(`${limitar(ctx.reuniao, 110)} — continuação`, MARGEM, doc.y, { width: larguraUtil(doc) });
    doc.y += 10;
  }
}

function filete(doc: Doc, y: number, cor: string, espessura: number, x0 = MARGEM, x1 = doc.page.width - MARGEM): void {
  doc.strokeColor(cor).lineWidth(espessura).moveTo(x0, y).lineTo(x1, y).stroke();
}

function cabecalho(doc: Doc, agenda: AgendaAnualNoPdf): void {
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
    .fillColor(agenda.documento?.tipo === "versao" && agenda.documento.aprovadaEm ? MARCA.primaria : MARCA.media)
    .text(tipoDoDocumento(agenda.documento), MARGEM, topo + 4, {
      width: larguraUtil(doc),
      align: "right",
      characterSpacing: 0.8,
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(MARCA.tintaFraca)
    .text(`Emitido em ${dataHora(agenda.emitidoEm)} (horário de Brasília)`, MARGEM, topo + 19, {
      width: larguraUtil(doc),
      align: "right",
      lineBreak: false,
    });

  const y = topo + LOGO_LADO + 14;
  filete(doc, y, MARCA.primaria, 2.5, MARGEM, MARGEM + 64);
  filete(doc, y, MARCA.linha, 2.5, MARGEM + 64);
  doc.y = y + 18;

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MARCA.primaria)
    .text(`AGENDA ANUAL ${agenda.ano}`, MARGEM, doc.y, { width: larguraUtil(doc), characterSpacing: 1 });
  doc.y += 4;
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(MARCA.profunda)
    .text(limitar(agenda.titulo, 160), MARGEM, doc.y, { width: larguraUtil(doc) });
  doc.y += 12;

  identificacao(doc, agenda);
  faixaDoDocumento(doc, agenda.documento);
}

/** Quadro de identificação: 3 colunas × 2 linhas de rótulo/valor. */
function identificacao(doc: Doc, agenda: AgendaAnualNoPdf): void {
  const temas = agenda.reunioes.reduce((n, r) => n + conteudoDaReuniao(r).totalTemas, 0);
  const documento =
    !agenda.documento || agenda.documento.tipo === "previa"
      ? "Prévia"
      : `Versão ${agenda.documento.numero} — ${agenda.documento.aprovadaEm ? "aprovada" : "enviada"}`;
  const celulas: Array<[string, string]> = [
    ["Órgão colegiado", limitar(agenda.orgao, 60)],
    ["Ano", String(agenda.ano)],
    ["Status", ROTULO_DO_STATUS[agenda.status]],
    ["Documento", documento],
    ["Reuniões", String(agenda.reunioes.length)],
    ["Temas", String(temas)],
  ];
  const largura = larguraUtil(doc);
  const coluna = (largura - 24) / 3;
  const alturaLinha = 30;
  const y0 = doc.y;
  doc.rect(MARGEM, y0, largura, alturaLinha * 2 + 16).fill(MARCA.fundoSuave);
  celulas.forEach(([rotulo, valor], i) => {
    const x = MARGEM + 12 + (i % 3) * coluna;
    const y = y0 + 9 + Math.floor(i / 3) * alturaLinha;
    doc.font("Helvetica-Bold").fontSize(7).fillColor(MARCA.tintaFraca).text(rotulo.toUpperCase(), x, y, {
      width: coluna - 8,
      characterSpacing: 0.6,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(MARCA.profunda).text(valor, x, y + 10, {
      width: coluna - 8,
      lineBreak: false,
      ellipsis: true,
    });
  });
  doc.y = y0 + alturaLinha * 2 + 16 + 10;
}

/** Faixa discreta: PRÉVIA (âmbar) ou VERSÃO enviada/aprovada (azul/verde). */
function faixaDoDocumento(doc: Doc, documento: DocumentoDaAgendaNoPdf | undefined): void {
  const previa = !documento || documento.tipo === "previa";
  const aprovada = !previa && documento.tipo === "versao" && Boolean(documento.aprovadaEm);
  const cores = previa
    ? { fundo: "#FFF7ED", barra: "#D97706", texto: "#92400E" }
    : aprovada
      ? { fundo: "#ECFDF5", barra: "#059669", texto: "#065F46" }
      : { fundo: "#EFF6FF", barra: MARCA.primaria, texto: MARCA.media };
  const largura = larguraUtil(doc);
  const texto = rotuloDoDocumento(documento);
  doc.font("Helvetica").fontSize(8.5);
  const altura = doc.heightOfString(texto, { width: largura - 24 }) + 12;
  const y = doc.y;
  doc.rect(MARGEM, y, largura, altura).fill(cores.fundo);
  doc.rect(MARGEM, y, 3, altura).fill(cores.barra);
  doc.font("Helvetica").fontSize(8.5).fillColor(cores.texto).text(texto, MARGEM + 12, y + 6, { width: largura - 24 });
  doc.y = y + altura + 20;
}

/** Altura aproximada do bloco de um tema (para decidir a quebra antes de começar). */
function alturaDoTema(doc: Doc, t: TemaFormatado, largura: number): { inicio: number; total: number } {
  doc.font("Helvetica-Bold").fontSize(10.5);
  let inicio = doc.heightOfString(t.titulo, { width: largura }) + 2;
  doc.font("Helvetica").fontSize(8.5);
  if (t.horario) inicio += 12;
  if (t.responsavel) inicio += doc.heightOfString(`Responsável: ${t.responsavel}`, { width: largura }) + 2;
  if (t.classificacao) inicio += doc.heightOfString(t.classificacao, { width: largura }) + 2;
  let total = inicio + 6;
  if (t.objetivo) {
    doc.font("Helvetica").fontSize(9);
    total += 12 + doc.heightOfString(t.objetivo, { width: largura, lineGap: 1.5 }) + 6;
  }
  if (t.participantes.length > 0) total += 12 + Math.ceil(t.participantes.length / 2) * 12;
  return { inicio, total: total + 16 };
}

function rotuloDeSecao(doc: Doc, texto: string, x: number, largura: number): void {
  doc.font("Helvetica-Bold").fontSize(7).fillColor(MARCA.tintaFraca).text(texto, x, doc.y, {
    width: largura,
    characterSpacing: 0.8,
  });
  doc.y += 2;
}

function desenharTema(doc: Doc, t: TemaFormatado, ctx: Contexto, ultimo: boolean): void {
  const xNumero = MARGEM + 4;
  const x = MARGEM + 34;
  const largura = larguraUtil(doc) - 34;
  const { inicio, total } = alturaDoTema(doc, t, largura);
  // Mantém o cabeçalho do tema com o começo do conteúdo; nunca título sozinho no fim da página.
  if (!cabe(doc, Math.min(total, inicio + 46))) novaPagina(doc, ctx);

  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(MARCA.primaria).text(t.numero, xNumero, y, { width: 26, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(MARCA.profunda).text(t.titulo, x, y, { width: largura });
  doc.y += 1;
  if (t.horario) {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MARCA.media).text(t.horario, x, doc.y, { width: largura });
    doc.y += 2;
  }
  if (t.responsavel) {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MARCA.tintaSuave).text("Responsável: ", x, doc.y, { continued: true, width: largura });
    doc.font("Helvetica").fillColor(MARCA.tinta).text(t.responsavel);
    doc.y += 1;
  }
  if (t.classificacao) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MARCA.tintaSuave).text(t.classificacao, x, doc.y, { width: largura });
    doc.y += 1;
  }

  if (t.objetivo) {
    doc.y += 5;
    if (!cabe(doc, 26)) novaPagina(doc, ctx);
    rotuloDeSecao(doc, "OBJETIVO", x, largura);
    doc.font("Helvetica").fontSize(9).fillColor(MARCA.tinta).text(t.objetivo, x, doc.y, { width: largura, lineGap: 1.5 });
  }

  if (t.participantes.length > 0) {
    doc.y += 5;
    if (!cabe(doc, 26)) novaPagina(doc, ctx);
    rotuloDeSecao(doc, `PARTICIPANTES (${t.participantes.length})`, x, largura);
    // Duas colunas, linha a linha: um nome nunca é partido entre páginas.
    const coluna = (largura - 12) / 2;
    doc.font("Helvetica").fontSize(8.5);
    for (let i = 0; i < t.participantes.length; i += 2) {
      const par = t.participantes.slice(i, i + 2);
      const altura = Math.max(...par.map((p) => doc.heightOfString(`•  ${p}`, { width: coluna }))) + 2;
      if (!cabe(doc, altura)) novaPagina(doc, ctx);
      const yLinha = doc.y;
      par.forEach((p, j) => {
        doc.font("Helvetica").fontSize(8.5).fillColor(MARCA.tinta).text(`•  ${p}`, x + j * (coluna + 12), yLinha, { width: coluna });
      });
      doc.y = yLinha + altura;
    }
  }

  doc.y += ultimo ? 4 : 9;
  if (!ultimo) {
    filete(doc, doc.y, MARCA.linha, 0.6, x);
    doc.y += 10;
  }
}

function desenharReuniao(doc: Doc, reuniao: ReuniaoDaAgendaNoPdf, ctx: Contexto): void {
  const c = cabecalhoDaReuniao(reuniao);
  const { grupos, totalTemas } = conteudoDaReuniao(reuniao);
  const xTexto = MARGEM + COLUNA_DATA + 10;
  const largura = larguraUtil(doc) - COLUNA_DATA - 10;

  // Não começa uma reunião espremida no fim da página: cabeçalho + começo do 1º tema.
  doc.font("Helvetica-Bold").fontSize(13);
  const alturaTitulo = doc.heightOfString(c.titulo, { width: largura });
  if (!cabe(doc, alturaTitulo + 150)) {
    ctx.reuniao = null;
    novaPagina(doc, ctx);
  }
  ctx.reuniao = c.titulo;

  const y0 = doc.y;
  filete(doc, y0, MARCA.primaria, 1.5);
  const y = y0 + 10;
  // Coluna da data
  doc.font("Helvetica-Bold").fontSize(24).fillColor(MARCA.profunda).text(c.dia, MARGEM, y, { width: COLUNA_DATA, lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MARCA.primaria).text(c.mesAno, MARGEM, y + 27, {
    width: COLUNA_DATA,
    characterSpacing: 0.6,
    lineBreak: false,
  });
  doc.font("Helvetica").fontSize(7.5).fillColor(MARCA.tintaFraca).text(c.semana, MARGEM, y + 39, { width: COLUNA_DATA, lineBreak: false });
  // Título e horário
  doc.font("Helvetica-Bold").fontSize(13).fillColor(MARCA.profunda).text(c.titulo, xTexto, y, { width: largura });
  doc.y += 2;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MARCA.tintaSuave)
    .text(`${c.horario} · ${totalTemas} ${totalTemas === 1 ? "tema" : "temas"}`, xTexto, doc.y, { width: largura });
  if (c.aviso) {
    doc.font("Helvetica-Oblique").fontSize(8).fillColor(MARCA.tintaFraca).text(c.aviso, xTexto, doc.y + 2, { width: largura });
  }
  doc.y = Math.max(doc.y, y + 50) + 12;

  if (totalTemas === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MARCA.tintaFraca).text("Nenhum tema nesta reunião.", xTexto, doc.y, {
      width: largura,
    });
    doc.y += 22;
    ctx.reuniao = null;
    return;
  }

  rotuloDeSecao(doc, "TEMAS DA REUNIÃO", MARGEM, larguraUtil(doc));
  doc.y += 6;
  for (const grupo of grupos) {
    if (grupo.titulo) {
      if (!cabe(doc, 70)) novaPagina(doc, ctx);
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(MARCA.media).text(limitar(grupo.titulo, 120), MARGEM, doc.y, {
        width: larguraUtil(doc),
      });
      doc.y += 6;
    }
    grupo.temas.forEach((t, i) => desenharTema(doc, t, ctx, i === grupo.temas.length - 1));
    doc.y += grupo.titulo ? 6 : 0;
  }
  doc.y += 18;
  ctx.reuniao = null;
}

function rodape(doc: Doc, agenda: AgendaAnualNoPdf): void {
  const faixa = doc.bufferedPageRange();
  for (let i = 0; i < faixa.count; i++) {
    doc.switchToPage(faixa.start + i);
    // Rodapé abaixo da margem: zera a margem durante a escrita (ver agenda-pdf).
    const margem = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGEM - RODAPE_ALTURA + 14;
    filete(doc, y - 8, MARCA.linha, 1);
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(MARCA.tintaFraca)
      .text(`PGCP · Agenda Anual ${agenda.ano} — ${limitar(agenda.titulo, 60)} · Documento gerado eletronicamente`, MARGEM, y, {
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
          .text("Nenhuma reunião nesta Agenda Anual.", MARGEM, doc.y, { width: larguraUtil(doc) });
      } else {
        const ctx: Contexto = { reuniao: null };
        const ordenadas = [...agenda.reunioes].sort((a, b) => a.inicioEm.localeCompare(b.inicioEm));
        for (const reuniao of ordenadas) desenharReuniao(doc, reuniao, ctx);
      }
      rodape(doc, agenda);
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
