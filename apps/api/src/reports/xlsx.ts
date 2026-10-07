import { crc32, deflateRawSync } from "node:zlib";

/**
 * PLANILHA .XLSX MÍNIMA — uma aba, cabeçalho em negrito, filtro automático e
 * linha de cabeçalho congelada. Sem dependência externa: o formato é um ZIP de
 * XMLs (Office Open XML), montado aqui com `zlib` do próprio Node.
 *
 * SEGURANÇA DO CONTEÚDO
 *   - Todo texto vai como `inlineStr`: um valor que começa com "=" continua
 *     TEXTO, nunca vira fórmula (sem "CSV/formula injection").
 *   - Caracteres que o XML 1.0 não aceita (controle) são removidos; o resto é
 *     escapado.
 *   - Data e hora vão como NÚMERO com formato de data/hora do Excel, para a
 *     planilha filtrar e ordenar de verdade.
 */

export type CelulaXlsx =
  | string
  | number
  | null
  | { data: { ano: number; mes: number; dia: number } }
  | { hora: { hora: number; minuto: number } };

export interface ColunaXlsx {
  titulo: string;
  /** Largura em caracteres. */
  largura: number;
}

const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export { MIME_XLSX };

function xml(texto: string): string {
  return texto
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Letra(s) da coluna: 0 -> A, 25 -> Z, 26 -> AA. */
export function letraDaColuna(indice: number): string {
  let n = indice + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Número de série do Excel (sistema 1900) para uma data de calendário. */
export function serialDaData(d: { ano: number; mes: number; dia: number }): number {
  return Date.UTC(d.ano, d.mes - 1, d.dia) / 86_400_000 + 25_569;
}

const ESTILO = { cabecalho: 1, data: 2, hora: 3 } as const;

function celula(valor: CelulaXlsx, ref: string): string {
  if (valor === null || valor === "") return "";
  if (typeof valor === "number") return Number.isFinite(valor) ? `<c r="${ref}"><v>${valor}</v></c>` : "";
  if (typeof valor === "string") return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
  if ("data" in valor) return `<c r="${ref}" s="${ESTILO.data}"><v>${serialDaData(valor.data)}</v></c>`;
  return `<c r="${ref}" s="${ESTILO.hora}"><v>${(valor.hora.hora * 60 + valor.hora.minuto) / 1440}</v></c>`;
}

function planilha(colunas: ColunaXlsx[], linhas: CelulaXlsx[][]): string {
  const ultima = letraDaColuna(colunas.length - 1);
  const cabecalho = colunas
    .map((c, i) => `<c r="${letraDaColuna(i)}1" s="${ESTILO.cabecalho}" t="inlineStr"><is><t>${xml(c.titulo)}</t></is></c>`)
    .join("");
  const corpo = linhas
    .map((linha, l) => {
      const n = l + 2;
      return `<row r="${n}">${linha.map((v, i) => celula(v, `${letraDaColuna(i)}${n}`)).join("")}</row>`;
    })
    .join("");
  const larguras = colunas
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, Math.min(80, c.largura))}" customWidth="1"/>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${larguras}</cols>` +
    `<sheetData><row r="1">${cabecalho}</row>${corpo}</sheetData>` +
    `<autoFilter ref="A1:${ultima}${Math.max(1, linhas.length + 1)}"/>` +
    `</worksheet>`
  );
}

const ESTILOS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

function arquivosDoPacote(nomeDaAba: string, folha: string): Array<[string, string]> {
  const aba = xml(nomeDaAba.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Planilha");
  return [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${aba}" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ],
    ["xl/styles.xml", ESTILOS],
    ["xl/worksheets/sheet1.xml", folha],
  ];
}

/** ZIP (PKWARE) com deflate. Datas do ZIP fixas: o conteúdo é que importa. */
function zip(arquivos: Array<[string, string]>): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  const DATA_DOS = 0x5921; // 2024-09-01
  for (const [nome, conteudo] of arquivos) {
    const nomeBytes = Buffer.from(nome, "utf8");
    const dados = Buffer.from(conteudo, "utf8");
    const comprimido = deflateRawSync(dados);
    const crc = crc32(dados) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DATA_DOS, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nomeBytes, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DATA_DOS, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nomeBytes);

    deslocamento += local.length + nomeBytes.length + comprimido.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  fim.writeUInt16LE(0, 20);
  return Buffer.concat([...locais, diretorio, fim]);
}

export function gerarXlsx(nomeDaAba: string, colunas: ColunaXlsx[], linhas: CelulaXlsx[][]): Buffer {
  return zip(arquivosDoPacote(nomeDaAba, planilha(colunas, linhas)));
}
