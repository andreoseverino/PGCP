/**
 * DESCRIÇÃO DA REUNIÃO — texto rico mínimo no navegador.
 *
 * O SERVIDOR É A AUTORIDADE (`apps/api/src/meetings/rich-text.ts`): todo HTML
 * recebido é saneado lá antes de ir ao banco e ao convite do Outlook. Esta
 * cópia do MESMO algoritmo existe para duas coisas do lado do cliente:
 *
 *   - EXIBIR com segurança (defesa em profundidade: o que chega da API é
 *     reescrito de novo antes de ir ao `dangerouslySetInnerHTML`);
 *   - normalizar o que o editor (`contentEditable`) produz, para comparar e
 *     montar o template sem depender do HTML cru do navegador.
 *
 * `rich-text.test.ts` compara as duas cópias com os mesmos vetores: se uma
 * mudar sem a outra, o teste quebra.
 *
 * Lista fechada: p, br, strong, em, ul, ol, li — SEM atributos.
 */

const PERMITIDAS = new Set(["p", "br", "strong", "em", "ul", "ol", "li"]);
const TRADUZIDAS: Record<string, string> = {
  b: "strong",
  i: "em",
  div: "p",
  h1: "p",
  h2: "p",
  h3: "p",
  h4: "p",
  h5: "p",
  h6: "p",
  blockquote: "p"
};
const DESCARTADAS_COM_CONTEUDO = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math",
  "head", "title", "textarea", "select", "xmp", "noembed", "noframes", "plaintext"
]);
const BLOCOS = new Set(["p", "ul", "ol", "li"]);

const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/;

export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodificar(texto: string): string {
  return texto.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (todo, corpo: string) => {
    if (corpo[0] === "#") {
      const codigo = corpo[1] === "x" || corpo[1] === "X" ? parseInt(corpo.slice(2), 16) : parseInt(corpo.slice(1), 10);
      if (!Number.isFinite(codigo) || codigo < 32 || codigo > 0x10ffff || (codigo >= 0xd800 && codigo <= 0xdfff)) return "";
      return String.fromCodePoint(codigo);
    }
    return ENTIDADES[corpo.toLowerCase()] ?? todo;
  });
}

export function pareceHtml(valor: string): boolean {
  return /<\/?(p|br|strong|em|b|i|u|ul|ol|li|div|span)\b[^>]*>/i.test(valor);
}

export function textoParaHtml(texto: string): string {
  return texto
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p.split("\n").map(escaparHtml).join("<br>")}</p>`)
    .join("");
}

export function sanitizarHtml(entrada: string): string {
  const saida: string[] = [];
  const pilha: string[] = [];
  let i = 0;

  const fechar = (tag: string) => {
    const pos = pilha.lastIndexOf(tag);
    if (pos < 0) return;
    while (pilha.length > pos) saida.push(`</${pilha.pop()}>`);
  };
  const dentroDeLista = () => pilha.some((t) => t === "ul" || t === "ol");

  while (i < entrada.length) {
    const resto = entrada.slice(i);
    if (resto[0] !== "<") {
      const fim = resto.indexOf("<");
      const pedaco = fim < 0 ? resto : resto.slice(0, fim);
      saida.push(escaparHtml(decodificar(pedaco)));
      i += pedaco.length;
      continue;
    }
    const especial = /^<!--[\s\S]*?(?:-->|$)|^<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|^<![^>]*(?:>|$)|^<\?[^>]*(?:>|$)/.exec(resto);
    if (especial) {
      i += especial[0].length;
      continue;
    }
    const tag = TAG.exec(resto);
    if (!tag) {
      saida.push("&lt;");
      i += 1;
      continue;
    }
    i += tag[0].length;
    const fechamento = tag[1] === "/";
    const nomeOriginal = tag[2]!.toLowerCase();

    if (DESCARTADAS_COM_CONTEUDO.has(nomeOriginal)) {
      if (!fechamento && tag[4] !== "/") {
        const fimDoBloco = new RegExp(`</${nomeOriginal}\\s*>`, "i").exec(entrada.slice(i));
        i = fimDoBloco ? i + fimDoBloco.index + fimDoBloco[0].length : entrada.length;
      }
      continue;
    }

    const nome = TRADUZIDAS[nomeOriginal] ?? nomeOriginal;
    if (!PERMITIDAS.has(nome)) continue;

    if (nome === "br") {
      saida.push("<br>");
      continue;
    }
    if (fechamento) {
      fechar(nome);
      continue;
    }
    if (nome === "li" && !dentroDeLista()) {
      if (pilha.includes("p")) fechar("p");
      saida.push("<p>");
      pilha.push("p");
      continue;
    }
    if (BLOCOS.has(nome) && pilha.includes("p")) fechar("p");
    if (nome === "li") {
      const ultimaLista = Math.max(pilha.lastIndexOf("ul"), pilha.lastIndexOf("ol"));
      if (pilha.lastIndexOf("li") > ultimaLista) fechar("li");
    }
    saida.push(`<${nome}>`);
    pilha.push(nome);
  }

  while (pilha.length > 0) saida.push(`</${pilha.pop()}>`);
  return saida.join("");
}

export function textoDaDescricao(html: string | null | undefined): string {
  if (!html) return "";
  const comQuebras = (pareceHtml(html) ? sanitizarHtml(html) : escaparHtml(html))
    .replace(/<br>/g, "\n")
    .replace(/<li>/g, "\n• ")
    .replace(/<\/(p|ul|ol)>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodificar(comQuebras)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Valor gravado (HTML novo ou texto puro legado) -> HTML seguro para exibir. */
export function descricaoComoHtml(valor: string | null | undefined): string {
  if (!valor) return "";
  return pareceHtml(valor) ? sanitizarHtml(valor) : textoParaHtml(valor);
}

// -----------------------------------------------------------------------------
// Template inicial
// -----------------------------------------------------------------------------

export interface DadosDoTemplate {
  titulo: string;
  /** `YYYY-MM-DD` (dia local da reunião). */
  data: string;
  inicio: string;
  fim: string;
  orgao: string;
  /** Temas, quando já existirem (na criação, normalmente nenhum). */
  temas?: string[];
}

const dataBr = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd.split("-").reverse().join("/") : ymd);
const campo = (rotulo: string, valor: string) =>
  `<p><strong>${escaparHtml(rotulo)}:</strong> ${escaparHtml(valor.trim() || "—")}</p>`;

/**
 * Ponto de partida da descrição, montado com os dados da própria reunião. Só
 * marcação da lista permitida: o que sai daqui é igual ao que o servidor grava.
 */
export function montarDescricaoInicial(d: DadosDoTemplate, language: "pt" | "en" = "pt"): string {
  const pt = language === "pt";
  const temas = (d.temas ?? []).map((t) => t.trim()).filter(Boolean);
  return [
    campo(pt ? "Reunião" : "Meeting", d.titulo),
    campo(pt ? "Data" : "Date", dataBr(d.data)),
    campo(pt ? "Horário" : "Time", `${d.inicio} ${pt ? "às" : "to"} ${d.fim}`),
    campo(pt ? "Órgão de Governança" : "Governance body", d.orgao),
    `<p><strong>${pt ? "Pautas/Temas" : "Agenda/Topics"}:</strong></p>`,
    temas.length > 0
      ? `<ul>${temas.map((t) => `<li>${escaparHtml(t)}</li>`).join("")}</ul>`
      : `<p>${pt ? "A definir." : "To be defined."}</p>`,
    `<p><strong>${pt ? "Informações adicionais" : "Additional information"}:</strong></p>`,
    "<p><br></p>"
  ].join("");
}

/**
 * Data, horário, órgão ou título mudaram depois: a descrição só acompanha se
 * ainda for EXATAMENTE o template gerado com os valores anteriores. Texto que
 * a pessoa editou nunca é sobrescrito — devolve `null` e a tela avisa.
 */
export function descricaoAposMudanca(
  atual: string | null | undefined,
  antes: DadosDoTemplate,
  depois: DadosDoTemplate,
  language: "pt" | "en" = "pt"
): { descricao: string; atualizada: boolean } | null {
  const normalizada = sanitizarHtml(descricaoComoHtml(atual ?? ""));
  if (normalizada === sanitizarHtml(montarDescricaoInicial(depois, language))) {
    return { descricao: atual ?? "", atualizada: false };
  }
  if (normalizada === sanitizarHtml(montarDescricaoInicial(antes, language))) {
    return { descricao: montarDescricaoInicial(depois, language), atualizada: true };
  }
  return null;
}
