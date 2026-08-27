import PDFDocument from "pdfkit";
import { LOGO, LOGO_LADO, MARCA } from "./brand.js";

/**
 * Gera o PDF de VALIDACAO DE PAUTAS.
 *
 * Documento unico e especifico do PGCP — nao e uma biblioteca de relatorios.
 * So texto: sem imagem, grafico ou formulario.
 *
 * Estrutura: cabecalho com o nome da reuniao, bloco de informacoes gerais,
 * participantes e uma secao por pauta, com paginacao.
 *
 * TODO CAMPO VEM DO DOMINIO. Nada e inventado; quando um dado nao existe, a
 * linha simplesmente nao aparece. Em particular, `meeting_agenda_items` NAO tem
 * coluna de descricao — a descricao exibida vem de `agenda_topics.description`
 * quando a pauta foi puxada da Biblioteca, e some quando foi digitada livre.
 *
 * ACENTUACAO: as fontes padrao do PDF (Helvetica) usam WinAnsiEncoding, que
 * cobre Latin-1 por inteiro — acento, cedilha e til do portugues saem corretos
 * sem embutir arquivo de fonte no pacote.
 */

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export interface PautaDoDocumento {
  posicao: number;
  titulo: string;
  /** De `agenda_topics.description`. Nulo quando a pauta nao veio da Biblioteca. */
  descricao: string | null;
  responsavel: string | null;
  apresentador: string | null;
  /** Tema circular NESTA reuniao. So aparece no PDF quando `true`. */
  temaCircular: boolean;
  /** Ficha cadastral (snapshot 019, com fallback ao mestre). Nulo => não exibe. */
  tipo: string | null;
  natureza: string | null;
  /** "Tema de FUP" — só aparece quando `true` (classificação). */
  temaFup: boolean;
  /** Participantes POR PAUTA (nomes). Vazio => linha não aparece. */
  participantes: string[];
  /** Hora local do dia da reuniao (HH:mm). */
  horaInicio: string | null;
  duracaoMinutos: number | null;
}

export interface ReuniaoDoDocumento {
  titulo: string;
  descricao: string | null;
  orgao: string;
  organizador: string | null;
  /** Instante UTC ISO-8601. */
  inicioEm: string;
  fimEm: string;
  /** IANA, ex.: America/Sao_Paulo. */
  fuso: string;
  local: string | null;
  participantes: string[];
  pautas: PautaDoDocumento[];
}

// ---------------------------------------------------------------------------
// Aparencia
// ---------------------------------------------------------------------------

/**
 * Cores do documento, vindas dos tokens da interface (ver `brand.ts`).
 * Nenhuma cor e escolhida aqui.
 */
const CORES = {
  tinta: MARCA.profunda,
  tintaSuave: MARCA.tintaSuave,
  tintaFraca: MARCA.tintaFraca,
  destaque: MARCA.primaria,
  linha: MARCA.linha,
} as const;

/** A4 em pontos, com margem confortavel para leitura corporativa. */
const MARGEM = 56;
const RODAPE_ALTURA = 40;

/**
 * Corta texto absurdamente longo.
 *
 * O `pdfkit` ja quebra linha sozinho dentro da largura, entao isto NAO existe
 * para evitar estouro horizontal — existe para uma descricao de dez mil
 * caracteres nao virar quinze paginas de uma pauta so. O documento serve para
 * VALIDAR pauta, nao para substituir o sistema.
 */
function limitar(valor: string, maximo: number): string {
  const limpo = valor.replace(/\s+/g, " ").trim();
  return limpo.length <= maximo ? limpo : `${limpo.slice(0, maximo - 1)}…`;
}

/**
 * Data e hora no FUSO DA REUNIAO, nunca no do servidor.
 *
 * A reuniao guarda o instante em UTC e o IANA separado; exibir em horario do
 * servidor mostraria a hora errada para quem le. Fuso invalido cai para UTC em
 * vez de derrubar a geracao — um documento com fuso errado ainda serve para
 * validar pauta; um erro 500 nao.
 */
export function formatarQuando(inicioIso: string, fimIso: string, fuso: string): string {
  const formatar = (iso: string, opcoes: Intl.DateTimeFormatOptions): string => {
    try {
      return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: fuso }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: "UTC" }).format(new Date(iso));
    }
  };

  const data = formatar(inicioIso, { day: "2-digit", month: "long", year: "numeric" });
  const hora = formatar(inicioIso, { hour: "2-digit", minute: "2-digit" });
  const horaFim = formatar(fimIso, { hour: "2-digit", minute: "2-digit" });
  return `${data} · ${hora} às ${horaFim} (${fuso})`;
}

// ---------------------------------------------------------------------------
// Geracao
// ---------------------------------------------------------------------------

type Doc = PDFKit.PDFDocument;

const larguraUtil = (doc: Doc): number => doc.page.width - MARGEM * 2;

/** Limite inferior do conteudo: acima do rodape, nunca por cima dele. */
const limiteInferior = (doc: Doc): number => doc.page.height - MARGEM - RODAPE_ALTURA;

/**
 * Garante espaco para o proximo bloco.
 *
 * Sem isto, um titulo de pauta cairia no fim de uma pagina e a ficha dela
 * comecaria na seguinte, separando coisas que se leem juntas.
 */
function garantirEspaco(doc: Doc, altura: number): void {
  if (doc.y + altura > limiteInferior(doc)) doc.addPage();
}

function rotulo(doc: Doc, texto: string): void {
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(CORES.destaque)
    .text(texto.toUpperCase(), MARGEM, doc.y, { width: larguraUtil(doc), characterSpacing: 0.8 });
  doc.moveDown(0.4);
}

function linhaHorizontal(doc: Doc): void {
  doc
    .strokeColor(CORES.linha)
    .lineWidth(1)
    .moveTo(MARGEM, doc.y)
    .lineTo(doc.page.width - MARGEM, doc.y)
    .stroke();
  doc.moveDown(0.8);
}

/**
 * Numeracao "Pagina X de Y".
 *
 * Escrita no fim, quando o total ja e conhecido: durante a montagem nao ha como
 * saber quantas paginas o conteudo vai ocupar. `switchToPage` volta em cada uma.
 */
function numerarPaginas(doc: Doc, titulo: string): void {
  // Congela a contagem ANTES do laco: `bufferedPageRange()` reflete o estado
  // atual, e reconsultar dentro do laco leria um total que ainda muda.
  const faixa = doc.bufferedPageRange();
  const total = faixa.count;

  for (let indice = 0; indice < total; indice++) {
    doc.switchToPage(faixa.start + indice);

    /*
     * ZERA A MARGEM INFERIOR ENQUANTO ESCREVE O RODAPE.
     *
     * O rodape fica ABAIXO da margem de baixo, que e onde ele deve ficar. Mas o
     * `pdfkit` trata escrita alem da margem como estouro de conteudo e ADICIONA
     * UMA PAGINA — o rodape ia parar numa pagina nova, que por sua vez entrava
     * na contagem e gerava outra. O documento saia com o dobro de paginas, as
     * extras em branco, e nenhuma pagina real numerada.
     *
     * Anular a margem durante a escrita e a forma suportada de dizer "isto e
     * ornamento de pagina, nao conteudo que flui".
     */
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - MARGEM - RODAPE_ALTURA + 14;

    doc
      .strokeColor(CORES.linha)
      .lineWidth(1)
      .moveTo(MARGEM, y - 8)
      .lineTo(doc.page.width - MARGEM, y - 8)
      .stroke();

    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(CORES.tintaFraca)
      .text(limitar(titulo, 70), MARGEM, y, {
        width: larguraUtil(doc) - 90,
        lineBreak: false,
        ellipsis: true,
      });

    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(CORES.tintaFraca)
      .text(`Página ${indice + 1} de ${total}`, doc.page.width - MARGEM - 90, y, {
        width: 90,
        align: "right",
        lineBreak: false,
      });

    doc.page.margins.bottom = margemInferior;
  }
}

/**
 * Cabecalho institucional.
 *
 * Logo da Cielo a esquerda, identificacao do documento a direita — a leitura
 * que um documento de governanca precisa dar em um segundo: de quem e, e o que
 * e. Abaixo, o orgao, o titulo da reuniao e quando ela acontece.
 *
 * O logo tem fundo solido (nao ha versao vetorial nem transparente no
 * repositorio), entao e desenhado como bloco quadrado proprio, sem sobreposicao.
 */
function desenharCabecalho(doc: Doc, reuniao: ReuniaoDoDocumento): void {
  const topo = doc.y;

  doc.image(LOGO, MARGEM, topo, { width: LOGO_LADO, height: LOGO_LADO });

  const xTexto = MARGEM + LOGO_LADO + 14;

  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(MARCA.primaria)
    .text("PGCP", xTexto, topo + 4, { lineBreak: false });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(CORES.tintaFraca)
    .text("Plataforma Corporativa de Gestão de Pautas", xTexto, topo + 19, { lineBreak: false });

  // Identificacao do documento, alinhada a direita do cabecalho.
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(CORES.tintaFraca)
    .text("VALIDAÇÃO DE PAUTAS", MARGEM, topo + 12, {
      width: larguraUtil(doc),
      align: "right",
      characterSpacing: 0.8,
      lineBreak: false,
    });

  doc.y = topo + LOGO_LADO + 18;

  // Filete institucional: fecha o cabecalho e separa da identificacao.
  doc
    .strokeColor(MARCA.primaria)
    .lineWidth(2.5)
    .moveTo(MARGEM, doc.y)
    .lineTo(MARGEM + 64, doc.y)
    .stroke();
  doc
    .strokeColor(CORES.linha)
    .lineWidth(2.5)
    .moveTo(MARGEM + 64, doc.y)
    .lineTo(doc.page.width - MARGEM, doc.y)
    .stroke();

  doc.y += 18;

  rotulo(doc, limitar(reuniao.orgao, 90));

  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(CORES.tinta)
    .text(limitar(reuniao.titulo, 200), MARGEM, doc.y, { width: larguraUtil(doc) });

  doc.moveDown(0.3);

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(CORES.tintaSuave)
    .text(formatarQuando(reuniao.inicioEm, reuniao.fimEm, reuniao.fuso), MARGEM, doc.y, {
      width: larguraUtil(doc),
    });

  doc.moveDown(0.8);
  linhaHorizontal(doc);
}

/** Linha "Rotulo: valor". Omitida quando o valor nao existe no dominio. */
function campo(doc: Doc, nome: string, valor: string | null, maximo = 160): void {
  if (!valor) return;

  const largura = larguraUtil(doc);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(CORES.tintaFraca);
  const larguraNome = doc.widthOfString(`${nome}: `);

  garantirEspaco(doc, 18);
  const y = doc.y;

  doc.text(`${nome}: `, MARGEM, y, { continued: false, lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(CORES.tintaSuave)
    .text(limitar(valor, maximo), MARGEM + larguraNome, y, { width: largura - larguraNome });

  doc.moveDown(0.35);
}

function desenharInformacoesGerais(doc: Doc, reuniao: ReuniaoDoDocumento): void {
  rotulo(doc, "Informações gerais");

  campo(doc, "Órgão", reuniao.orgao, 120);
  campo(doc, "Organização", reuniao.organizador, 120);
  campo(doc, "Local", reuniao.local, 160);

  const total = reuniao.pautas.reduce((soma, pauta) => soma + (pauta.duracaoMinutos ?? 0), 0);
  if (total > 0) campo(doc, "Tempo previsto de pauta", `${total} minuto(s)`);
  campo(doc, "Pautas", `${reuniao.pautas.length}`);
  campo(doc, "Participantes", `${reuniao.participantes.length}`);

  if (reuniao.descricao) {
    doc.moveDown(0.5);
    garantirEspaco(doc, 40);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(CORES.tintaFraca).text("Objetivo", MARGEM, doc.y);
    doc.moveDown(0.2);
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(CORES.tintaSuave)
      .text(limitar(reuniao.descricao, 1500), MARGEM, doc.y, {
        width: larguraUtil(doc),
        align: "left",
      });
  }

  doc.moveDown(1);
}

function desenharParticipantes(doc: Doc, participantes: string[]): void {
  if (participantes.length === 0) return;

  garantirEspaco(doc, 60);
  rotulo(doc, "Participantes");

  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(CORES.tintaSuave)
    .text(participantes.map((nome) => limitar(nome, 80)).join(" · "), MARGEM, doc.y, {
      width: larguraUtil(doc),
    });

  doc.moveDown(1);
}

function desenharPauta(doc: Doc, pauta: PautaDoDocumento, total: number): void {
  // Cabecalho da pauta e a primeira linha da ficha precisam caber juntos.
  garantirEspaco(doc, 90);

  rotulo(doc, `Pauta ${pauta.posicao} de ${total}`);

  doc
    .font("Helvetica-Bold")
    .fontSize(12.5)
    .fillColor(CORES.tinta)
    .text(limitar(pauta.titulo, 300), MARGEM, doc.y, { width: larguraUtil(doc) });

  doc.moveDown(0.4);

  if (pauta.descricao) {
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(CORES.tintaSuave)
      .text(limitar(pauta.descricao, 2000), MARGEM, doc.y, { width: larguraUtil(doc) });
    doc.moveDown(0.5);
  }

  campo(doc, "Responsável", pauta.responsavel, 120);
  campo(doc, "Apresentação", pauta.apresentador, 120);
  campo(doc, "Tipo", pauta.tipo, 120);
  campo(doc, "Natureza", pauta.natureza, 120);
  // Só quando circular: `campo` pula valor nulo, então não polui o PDF com "Não".
  campo(doc, "Tema circular", pauta.temaCircular ? "Sim" : null);
  // "Tema de FUP" só quando marcado — classificação, sem poluir com "Não".
  campo(doc, "Tema de FUP", pauta.temaFup ? "Sim" : null);
  // Participantes da pauta (nomes). Sem participantes, a linha não aparece.
  campo(doc, "Participantes", pauta.participantes.length ? pauta.participantes.join(", ") : null, 120);
  campo(doc, "Início previsto", pauta.horaInicio);
  campo(
    doc,
    "Duração",
    pauta.duracaoMinutos === null ? null : `${pauta.duracaoMinutos} min`,
  );

  doc.moveDown(0.7);
  linhaHorizontal(doc);
}

/**
 * Monta o PDF inteiro em memoria.
 *
 * `bufferPages` e necessario para a numeracao: sem ele o `pdfkit` descarrega
 * cada pagina assim que ela termina, e voltar para escrever "de Y" seria
 * impossivel.
 */
export function gerarPdfDePautas(reuniao: ReuniaoDoDocumento): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGEM, bottom: MARGEM + RODAPE_ALTURA, left: MARGEM, right: MARGEM },
      bufferPages: true,
      info: {
        Title: `Pautas — ${limitar(reuniao.titulo, 120)}`,
        Author: "PGCP",
        Subject: "Validação de pautas",
      },
      // Sem `autoFirstPage: false`: a primeira pagina ja e a do cabecalho.
    });

    const pedacos: Buffer[] = [];
    doc.on("data", (pedaco: Buffer) => pedacos.push(pedaco));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(pedacos)));

    try {
      desenharCabecalho(doc, reuniao);
      desenharInformacoesGerais(doc, reuniao);
      desenharParticipantes(doc, reuniao.participantes);

      if (reuniao.pautas.length === 0) {
        // Reuniao sem pauta e improvavel no pedido de validacao, mas o
        // aprovador precisa VER que nao ha pauta, e nao receber um documento
        // que termina sem explicacao.
        rotulo(doc, "Pautas");
        doc
          .font("Helvetica-Oblique")
          .fontSize(9.5)
          .fillColor(CORES.tintaFraca)
          .text("Nenhuma pauta cadastrada para esta reunião.", MARGEM, doc.y, {
            width: larguraUtil(doc),
          });
      } else {
        for (const pauta of reuniao.pautas) {
          desenharPauta(doc, pauta, reuniao.pautas.length);
        }
      }

      numerarPaginas(doc, reuniao.titulo);
      doc.end();
    } catch (erro) {
      reject(erro);
    }
  });
}

/** MIME do anexo. */
export const PDF_CONTENT_TYPE = "application/pdf";

/** Nome do arquivo anexado. Sem caractere que atrapalhe em Windows ou e-mail. */
export function nomeDoArquivo(titulo: string): string {
  const base = titulo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `pautas-${base || "reuniao"}.pdf`;
}
