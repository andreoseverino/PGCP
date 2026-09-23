import PDFDocument from "pdfkit";
import { MARCA } from "../agenda-pdf/brand.js";

/**
 * Gera o PDF da ATA DE REUNIAO.
 *
 * SEM identidade visual de software — nem logo, nem marca "PGCP". A Ata sai
 * do sistema para circular como documento formal da instituicao; carregar a
 * marca da ferramenta que a gerou nao e o que a Secretaria pediu. So a paleta
 * de cor (`brand.ts`) e reaproveitada, por ser a mesma tinta institucional em
 * qualquer PDF do PGCP — nao um elemento de marca do software em si.
 *
 * O CONTEUDO E TEXTO PURO, ja pronto (vem de `meeting_minutes.content` ou do
 * esqueleto gerado no cliente). Este modulo so tipografa e pagina; nao
 * interpreta, resume nem reescreve nada do que esta na Ata — o mesmo principio
 * de "nenhum fato inventado" que rege o esqueleto.
 *
 * FONTE: Courier (uma das 14 fontes padrao do PDF, sem precisar embutir
 * arquivo). E o mesmo estilo "maquina de escrever" do editor na tela
 * (`font-mono` em `MeetingDetailView.tsx`) — a Ata real da Secretaria e
 * datilografada nesse padrao, e o PDF exportado tem que bater com o que a
 * pessoa via enquanto escrevia.
 */

const CORES = {
  tinta: MARCA.tinta,
  tintaSuave: MARCA.tintaSuave,
  tintaFraca: MARCA.tintaFraca,
  linha: MARCA.linha,
} as const;

const MARGEM = 56;
const RODAPE_ALTURA = 40;

export interface ReuniaoDaAta {
  titulo: string;
  orgao: string;
  /** Instante UTC ISO-8601. */
  inicioEm: string;
  fimEm: string;
  /** IANA, ex.: America/Sao_Paulo. */
  fuso: string;
  /** Texto puro da Ata. Pode estar vazio (reuniao sem Ata ainda). */
  conteudo: string;
}

type Doc = PDFKit.PDFDocument;

const larguraUtil = (doc: Doc): number => doc.page.width - MARGEM * 2;

function limitar(valor: string, maximo: number): string {
  const limpo = valor.replace(/\s+/g, " ").trim();
  return limpo.length <= maximo ? limpo : `${limpo.slice(0, maximo - 1)}…`;
}

/**
 * Designacao regulatoria da Cielo como Instituicao de Pagamento (Banco
 * Central). Texto fixo, centralizado, antes de qualquer outra coisa na
 * pagina — exigencia do modelo padrao de Ata, nao dado de negocio da reuniao.
 */
const INSTITUICAO_DE_PAGAMENTO = "INSTITUIÇÃO DE PAGAMENTO";

/**
 * Cabecalho da Ata.
 *
 * DELIBERADAMENTE SEM marca do PGCP, logo, orgao, titulo ou data em destaque:
 * a Ata e o documento formal que sai para fora do sistema, e a Secretaria
 * pediu que ele nao carregasse identidade de software nenhum — nem o nome da
 * ferramenta. Data, hora e orgao ja aparecem no CORPO do texto (secao
 * "DATA, HORA E LOCAL:"); repetir aqui seria duplicar, nao informar.
 *
 * So a designacao regulatoria fixa, centralizada.
 */
function desenharCabecalho(doc: Doc, _reuniao: ReuniaoDaAta): void {
  doc
    .font("Courier-Bold")
    .fontSize(10)
    .fillColor(CORES.tinta)
    .text(INSTITUICAO_DE_PAGAMENTO, MARGEM, doc.y, {
      width: larguraUtil(doc),
      align: "center",
      characterSpacing: 0.5,
    });

  doc.moveDown(1.2);
}

/**
 * Titulos de secao da Ata — negrito e sublinhado no corpo do PDF.
 *
 * MESMA lista de `MINUTES_TEMPLATE_HEADERS` em
 * `apps/web/src/lib/meeting-minutes-adapters.ts` (pt e en). Duas declaracoes,
 * uma por camada — o mesmo padrao que o resto do contrato front/back ja usa
 * neste projeto (ver `packages/contracts/README.md`).
 *
 * Casamento e por PREFIXO da linha, nao por linha inteira: o gerador nunca
 * quebra "MESA:" do texto que segue — e "MESA: Presidente da Mesa: ..." numa
 * so linha. So o prefixo casado sai em negrito/sublinhado; o resto da MESMA
 * linha continua em peso normal.
 */
const TITULOS_DA_ATA = [
  "DATA, HORA E LOCAL:",
  "DATE, TIME AND LOCATION:",
  "MESA:",
  "BOARD:",
  "PRESENÇA:",
  "ATTENDANCE:",
  "ORDEM DO DIA:",
  "AGENDA:",
  "DELIBERAÇÕES:",
  "RESOLUTIONS:",
  "DOCUMENTOS ANEXOS:",
  "ATTACHED DOCUMENTS:",
  "APROVAÇÃO E ASSINATURA DA ATA:",
  "MINUTES APPROVAL AND SIGNATURE:",
];

/**
 * Casa "(01)", "(02)" etc. — a numeracao da ORDEM DO DIA. So esses trechos
 * saem em negrito dentro da linha; o resto (o titulo da pauta e o ";") fica
 * em peso normal. `buildMinutesTemplate`, no frontend, e quem gera a linha
 * nesse formato — este regex so decide COMO desenhar, nunca o que gerar.
 */
const NUMERO_DA_ORDEM_DO_DIA = /(\(\d{2}\))/g;

/** Um trecho da linha e como desenha-lo. */
interface Segmento {
  texto: string;
  negrito: boolean;
  sublinhado: boolean;
}

/** Quebra o RESTANTE de uma linha (sem o titulo) em trechos "(NN)" / normal. */
function segmentarNumeros(texto: string): Segmento[] {
  if (texto.length === 0) return [];
  if (!/\(\d{2}\)/.test(texto)) return [{ texto, negrito: false, sublinhado: false }];

  return texto
    .split(NUMERO_DA_ORDEM_DO_DIA)
    .filter((parte) => parte.length > 0)
    .map((parte) => ({
      texto: parte,
      negrito: /^\(\d{2}\)$/.test(parte),
      sublinhado: false,
    }));
}

/**
 * Quebra uma linha inteira em trechos de estilo diferente: o titulo de
 * secao (se a linha comecar com um), em negrito e sublinhado, seguido do
 * restante — que ainda pode ter numeracao da ORDEM DO DIA em negrito.
 */
function segmentarLinha(linha: string): Segmento[] {
  const titulo = TITULOS_DA_ATA.find((t) => linha.startsWith(t));
  if (!titulo) return segmentarNumeros(linha);

  const resto = linha.slice(titulo.length);
  return [{ texto: titulo, negrito: true, sublinhado: true }, ...segmentarNumeros(resto)];
}

/**
 * Desenha os trechos de uma linha, emendados na MESMA linha visual mesmo com
 * fontes diferentes — `continued: true` e a forma do `pdfkit` de fazer isso;
 * sem ele, cada `.text()` pularia para a linha seguinte.
 *
 * Linha vazia (sem segmento nenhum) ainda precisa avancar o cursor — por
 * isso desenha um espaco em vez de nao desenhar nada.
 */
function desenharSegmentos(doc: Doc, segmentos: Segmento[]): void {
  if (segmentos.length === 0) {
    doc
      .font("Courier")
      .fontSize(10)
      .fillColor(CORES.tinta)
      .text(" ", MARGEM, doc.y, { width: larguraUtil(doc), lineGap: 3 });
    return;
  }

  segmentos.forEach((segmento, indice) => {
    const ultimoSegmento = indice === segmentos.length - 1;

    doc
      .font(segmento.negrito ? "Courier-Bold" : "Courier")
      .fontSize(segmento.sublinhado ? 10.5 : 10)
      .fillColor(CORES.tinta);

    const opcoes = { underline: segmento.sublinhado, continued: !ultimoSegmento, lineGap: 3 };

    if (indice === 0) {
      doc.text(segmento.texto, MARGEM, doc.y, { width: larguraUtil(doc), ...opcoes });
    } else {
      doc.text(segmento.texto, opcoes);
    }
  });
}

/**
 * Corpo da Ata, linha a linha. `pdfkit` pagina sozinho quando o conteudo
 * estoura a margem inferior — nao ha calculo de altura manual aqui.
 */
function desenharCorpo(doc: Doc, conteudo: string): void {
  for (const linhaBruta of conteudo.split("\n")) {
    desenharSegmentos(doc, segmentarLinha(linhaBruta.trimEnd()));
  }
}

/**
 * Numeracao "Pagina X de Y" — mesma tecnica do PDF de pautas: `bufferPages`
 * segura as paginas ate o total ser conhecido, e a margem inferior e zerada
 * so durante a escrita do rodape para o `pdfkit` nao interpretar isso como
 * estouro de conteudo e criar uma pagina extra.
 */
function numerarPaginas(doc: Doc): void {
  const faixa = doc.bufferedPageRange();
  const total = faixa.count;

  for (let indice = 0; indice < total; indice++) {
    doc.switchToPage(faixa.start + indice);

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
      .font("Courier")
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

/** Monta o PDF inteiro em memoria. */
export function gerarPdfDaAta(reuniao: ReuniaoDaAta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGEM, bottom: MARGEM + RODAPE_ALTURA, left: MARGEM, right: MARGEM },
      bufferPages: true,
      info: {
        Title: `Ata — ${limitar(reuniao.titulo, 120)}`,
        Author: "PGCP",
        Subject: "Ata de reunião",
      },
    });

    const pedacos: Buffer[] = [];
    doc.on("data", (pedaco: Buffer) => pedacos.push(pedaco));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(pedacos)));

    try {
      desenharCabecalho(doc, reuniao);

      const texto = reuniao.conteudo.trim();
      if (texto.length === 0) {
        doc
          .font("Courier-Oblique")
          .fontSize(9.5)
          .fillColor(CORES.tintaFraca)
          .text("Esta reunião ainda não tem Ata registrada.", MARGEM, doc.y, {
            width: larguraUtil(doc),
          });
      } else {
        desenharCorpo(doc, reuniao.conteudo);
      }

      numerarPaginas(doc);
      doc.end();
    } catch (erro) {
      reject(erro);
    }
  });
}

/** MIME do arquivo. */
export const PDF_CONTENT_TYPE = "application/pdf";

/** Nome do arquivo baixado. Sem caractere que atrapalhe em Windows ou navegador. */
export function nomeDoArquivoDaAta(titulo: string): string {
  const base = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `Ata-${base || "reuniao"}.pdf`;
}
