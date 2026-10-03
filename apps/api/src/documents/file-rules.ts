import { HttpError } from "../http-error.js";

/**
 * REGRAS DE ARQUIVO para upload de documentos — puras.
 *
 * O MIME vem da EXTENSÃO PERMITIDA, decidido aqui — o informado pelo navegador
 * é ignorado. Além da extensão, os primeiros bytes precisam bater com o
 * formato (PDF, ZIP do Office Open XML, OLE do Office antigo): detecção real,
 * porém LEVE — não abre o conteúdo nem procura macro/malware. Antivírus e
 * inspeção profunda são pendência corporativa (não há infraestrutura hoje).
 *
 * Fora por decisão: executáveis/scripts, HTML/SVG (conteúdo ativo), Office com
 * macro (.pptm/.docm/.xlsm) e CSV (fórmula executada ao abrir no Excel).
 */

type Formato = "pdf" | "ooxml" | "ole";

const PERMITIDOS: Record<string, { mime: string; formato: Formato }> = {
  pdf: { mime: "application/pdf", formato: "pdf" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", formato: "ooxml" },
  ppt: { mime: "application/vnd.ms-powerpoint", formato: "ole" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", formato: "ooxml" },
  doc: { mime: "application/msword", formato: "ole" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", formato: "ooxml" },
  xls: { mime: "application/vnd.ms-excel", formato: "ole" },
};

export const EXTENSOES_PERMITIDAS = Object.keys(PERMITIDOS);

/** Extensões que nunca podem aparecer, nem "escondidas" antes da última (a.exe.pdf). */
const PERIGOSAS = new Set([
  "exe", "dll", "com", "bat", "cmd", "msi", "scr", "ps1", "psm1", "vbs", "vbe", "js", "jse", "mjs", "wsf", "hta",
  "jar", "sh", "app", "lnk", "html", "htm", "xhtml", "svg", "svgz", "php", "asp", "aspx", "jsp",
  "pptm", "docm", "xlsm", "potm", "dotm", "xltm", "ppam", "xlam", "csv",
]);

const ASSINATURAS: Record<Formato, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  ooxml: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP)
  ole: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
};

/** Teto padrão conservador (20 MB); ajustável por `DOCUMENT_MAX_SIZE_BYTES`. */
export const TAMANHO_MAXIMO_PADRAO = 20 * 1024 * 1024;
const TAMANHO_MAXIMO_ABSOLUTO = 100 * 1024 * 1024;

/** Configuração CENTRAL do tamanho máximo (bytes). Valor inválido cai no padrão. */
export function tamanhoMaximo(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DOCUMENT_MAX_SIZE_BYTES);
  return Number.isInteger(n) && n > 0 && n <= TAMANHO_MAXIMO_ABSOLUTO ? n : TAMANHO_MAXIMO_PADRAO;
}

export function descreverTamanho(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Nome para EXIBIÇÃO: o original, sem caminho, sem caracteres de controle,
 * espaços normalizados. Nunca vai para a chave do S3.
 */
export function nomeOriginalSeguro(bruto: unknown): string {
  if (typeof bruto !== "string") throw new HttpError(400, "Informe o nome do arquivo.");
  // Qualquer caminho (C:\x\..\a.pdf, ../../a.pdf) vira só o nome final.
  const semCaminho = bruto.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(semCaminho)) throw new HttpError(400, "O nome do arquivo contém caracteres inválidos.");
  const nome = semCaminho.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!nome || nome === "." || nome === ".." || nome.startsWith(".")) throw new HttpError(400, "O nome do arquivo é inválido.");
  if (nome.length > 255) throw new HttpError(400, "O nome do arquivo é longo demais (máximo 255 caracteres).");
  return nome;
}

export interface ArquivoValidado {
  nome: string;
  extensao: string;
  mime: string;
}

/** Valida nome, extensão, tamanho e assinatura. Devolve o MIME DECIDIDO PELO SERVIDOR. */
export function validarArquivo(nomeBruto: unknown, conteudo: Buffer, maximo = tamanhoMaximo()): ArquivoValidado {
  const nome = nomeOriginalSeguro(nomeBruto);
  const partes = nome.toLowerCase().split(".");
  if (partes.length < 2) throw new HttpError(400, `Arquivo sem extensão. Permitidos: ${EXTENSOES_PERMITIDAS.join(", ")}.`);
  const extensao = partes.at(-1)!;
  if (partes.slice(1).some((p) => PERIGOSAS.has(p.trim()))) {
    throw new HttpError(400, "Este tipo de arquivo não é permitido no PGCP.");
  }
  const regra = PERMITIDOS[extensao];
  if (!regra) throw new HttpError(400, `Tipo de arquivo não permitido. Permitidos: ${EXTENSOES_PERMITIDAS.join(", ")}.`);
  if (conteudo.length === 0) throw new HttpError(400, "O arquivo está vazio.");
  if (conteudo.length > maximo) throw new HttpError(413, `O arquivo excede o tamanho máximo de ${descreverTamanho(maximo)}.`);
  const assinatura = ASSINATURAS[regra.formato];
  if (conteudo.length < assinatura.length || assinatura.some((b, i) => conteudo[i] !== b)) {
    throw new HttpError(400, "O conteúdo do arquivo não corresponde à extensão informada.");
  }
  return { nome, extensao, mime: regra.mime };
}

/** Descrição opcional: texto curto, sem caracteres de controle. */
export function descricaoOpcional(bruta: unknown): string | null {
  if (bruta === undefined || bruta === null || bruta === "") return null;
  if (typeof bruta !== "string") throw new HttpError(400, "Descrição inválida.");
  const t = bruta.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > 500) throw new HttpError(400, "A descrição aceita no máximo 500 caracteres.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new HttpError(400, "A descrição contém caracteres inválidos.");
  return t;
}

/**
 * Chave do objeto: SÓ ids estáveis + extensão (nunca nome de reunião, pessoa,
 * e-mail nem o nome original do arquivo, que fica só no PostgreSQL).
 */
export function chaveDoObjeto(c: { meetingId: string; agendaItemId: string | null; documentId: string; extensao: string }): string {
  const base = c.agendaItemId ? `meetings/${c.meetingId}/topics/${c.agendaItemId}` : `meetings/${c.meetingId}/documents`;
  return `${base}/${c.documentId}/arquivo.${c.extensao}`;
}

/**
 * `Content-Disposition` seguro: nome ASCII de reserva (sem aspas, barras nem
 * controle) + `filename*` UTF-8 para o nome original com acentos.
 */
export function contentDisposition(nome: string): string {
  const ascii =
    nome
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\/;]/g, "_")
      .trim() || "documento";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
}
