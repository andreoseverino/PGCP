import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import {
  PDF_CONTENT_TYPE,
  formatarQuando,
  gerarPdfDePautas,
  nomeDoArquivo,
  type ReuniaoDoDocumento,
} from "./document.js";

/**
 * Testes do gerador de PDF.
 *
 * O risco real nao e "a funcao devolveu um Buffer": e produzir um arquivo que o
 * leitor de PDF recusa, ou que perde acentuacao. A verificacao e ESTRUTURAL —
 * as invariantes que o formato exige — mais a extracao do texto dos fluxos de
 * conteudo, que prova que o dado do dominio realmente chegou na pagina.
 */

const BASE: ReuniaoDoDocumento = {
  titulo: "Reunião do Comitê Executivo",
  descricao: "Avaliar o plano de investimentos do próximo exercício.",
  orgao: "Comitê Executivo",
  organizador: "Secretaria de Governança",
  inicioEm: "2026-03-12T17:00:00.000Z",
  fimEm: "2026-03-12T19:00:00.000Z",
  fuso: "America/Sao_Paulo",
  local: "Sala do Conselho",
  participantes: ["Ana Souza", "Bruno Lima"],
  pautas: [],
};

function pauta(i: number) {
  return {
    posicao: i,
    titulo: `Pauta ${i}`,
    descricao: i % 2 === 0 ? `Descrição da pauta ${i}` : null,
    responsavel: i % 3 === 0 ? `Responsável ${i}` : null,
    apresentador: i % 4 === 0 ? `Apresentador ${i}` : null,
    horaInicio: "14:00",
    duracaoMinutos: 15,
    temaCircular: false,
    tipo: null,
    natureza: null,
    temaFup: false,
  };
}

const comPautas = (n: number): ReuniaoDoDocumento => ({
  ...BASE,
  pautas: Array.from({ length: n }, (_, i) => pauta(i + 1)),
});

/** Invariantes do formato. Devolve a lista de problemas (vazia = ok). */
function validarEstrutura(pdf: Buffer): string[] {
  const problemas: string[] = [];
  const texto = pdf.toString("latin1");

  if (!texto.startsWith("%PDF-")) problemas.push("nao comeca com %PDF-");
  // `%%EOF` fecha o arquivo; sem ele o leitor considera truncado.
  if (!texto.trimEnd().endsWith("%%EOF")) problemas.push("nao termina com %%EOF");
  if (!texto.includes("/Type /Catalog") && !texto.includes("/Type/Catalog")) {
    problemas.push("sem catalogo");
  }
  if (!/\/Type\s*\/Pages/.test(texto)) problemas.push("sem arvore de paginas");
  if (!/\/Type\s*\/Page[^s]/.test(texto)) problemas.push("sem pagina");
  // A tabela de referencia cruzada e o indice que o leitor usa para navegar.
  if (!texto.includes("xref") && !/\/Type\s*\/ObjStm/.test(texto)) {
    problemas.push("sem xref nem stream de objetos");
  }
  if (!texto.includes("trailer") && !/\/Root/.test(texto)) problemas.push("sem trailer/Root");

  return problemas;
}

/** Quantas paginas o documento declara. */
function contarPaginas(pdf: Buffer): number {
  const texto = pdf.toString("latin1");
  const declarado = texto.match(/\/Count\s+(\d+)/);
  if (declarado) return Number(declarado[1]);
  return (texto.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * Texto visivel do PDF.
 *
 * Os fluxos de conteudo vem comprimidos com Flate. Descomprimimos cada um e
 * lemos as strings de texto, que o `pdfkit` escreve em HEXADECIMAL — `<41e7e36f>`
 * dentro de um array `TJ` — e nao entre parenteses.
 *
 * Cada byte e um codepoint WinAnsi, que para o alfabeto latino coincide com
 * Latin-1. Decodificar como `latin1` devolve exatamente o texto original, e e
 * isso que prova que a acentuacao sobreviveu: `e7` -> "ç", `e3` -> "ã".
 */
function extrairTexto(pdf: Buffer): string {
  let acumulado = "";

  // Fluxos comprimidos.
  const marcador = Buffer.from("stream");
  let cursor = 0;
  while (true) {
    const inicio = pdf.indexOf(marcador, cursor);
    if (inicio === -1) break;
    let corpo = inicio + marcador.length;
    if (pdf[corpo] === 0x0d) corpo++;
    if (pdf[corpo] === 0x0a) corpo++;
    const fimMarcador = Buffer.from("endstream");
    const fim = pdf.indexOf(fimMarcador, corpo);
    if (fim === -1) break;
    try {
      acumulado += inflateSync(pdf.subarray(corpo, fim)).toString("latin1");
    } catch {
      // Nem todo stream e Flate (fonte embutida, por exemplo). Ignorar.
    }
    /*
     * Avanca para DEPOIS de "endstream" inteiro. Parar em `fim + 1` faria a
     * proxima busca casar o "stream" que existe DENTRO de "endstream", e o
     * loop pularia um stream a cada dois.
     */
    cursor = fim + fimMarcador.length;
  }

  const partes: string[] = [];

  // Strings hexadecimais: a forma que o `pdfkit` usa.
  for (const encontrado of acumulado.matchAll(/<([0-9a-fA-F]{2,})>/g)) {
    const hex = encontrado[1]!;
    if (hex.length % 2 !== 0) continue;
    partes.push(Buffer.from(hex, "hex").toString("latin1"));
  }

  // Strings literais entre parenteses, caso apareçam.
  for (const encontrado of acumulado.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) {
    partes.push(
      encontrado[1]!
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8))),
    );
  }

  /*
   * Juntadas SEM separador: o `pdfkit` aplica kerning e fatia uma mesma
   * palavra em varios chunks dentro do mesmo `TJ` — `[<41> 40 <76> 20 <616c>]`
   * e "Av" + "al". Inserir espaco entre eles quebraria justamente as palavras
   * que queremos encontrar.
   */
  return partes.join("");
}

// --- validade e volume -------------------------------------------------------

test("gera PDF valido para 0, 1 e varias pautas", async () => {
  for (const quantidade of [0, 1, 3, 12, 40]) {
    const pdf = await gerarPdfDePautas(comPautas(quantidade));
    assert.deepEqual(
      validarEstrutura(pdf),
      [],
      `${quantidade} pautas: estrutura invalida`,
    );
    assert.ok(pdf.length > 500, `${quantidade} pautas: arquivo pequeno demais`);
  }
});

test("reuniao sem pauta nenhuma diz isso, em vez de terminar sem explicacao", async () => {
  const pdf = await gerarPdfDePautas(comPautas(0));
  assert.deepEqual(validarEstrutura(pdf), []);
  assert.ok(
    extrairTexto(pdf).includes("Nenhuma pauta cadastrada"),
    "o aprovador precisa VER que nao ha pauta",
  );
});

test("o rodape NAO infla o documento com paginas em branco", async () => {
  /*
   * Regressao real, encontrada abrindo o PDF: o rodape fica abaixo da margem
   * inferior, e o `pdfkit` tratava isso como estouro de conteudo, adicionando
   * uma pagina por rodape escrito. O documento saia com o dobro de paginas, as
   * extras vazias, e nenhuma pagina real numerada.
   *
   * O teste ancora a contagem no conteudo: 4 pautas curtas cabem folgado em
   * duas paginas. Se voltar a inflar, isto quebra.
   */
  const pdf = await gerarPdfDePautas(comPautas(4));
  const paginas = contarPaginas(pdf);
  assert.ok(paginas <= 2, `4 pautas curtas nao deveriam gerar ${paginas} paginas`);
});

test("TODA pagina recebe o rodape numerado", async () => {
  const pdf = await gerarPdfDePautas(comPautas(12));
  const total = contarPaginas(pdf);
  const texto = extrairTexto(pdf);

  for (let n = 1; n <= total; n++) {
    assert.ok(
      texto.includes(`Página${n}de${total}`) || texto.includes(`Página ${n} de ${total}`),
      `pagina ${n} de ${total} sem rodape numerado`,
    );
  }
});

test("muitas pautas geram varias paginas, com paginacao", async () => {
  const pdf = await gerarPdfDePautas(comPautas(40));
  const paginas = contarPaginas(pdf);
  assert.ok(paginas > 1, `esperado mais de uma pagina, veio ${paginas}`);

  const texto = extrairTexto(pdf);
  assert.ok(/Página\s*1\s*de\s*\d+/.test(texto) || texto.includes("de " + paginas), "rodape numerado");
});

// --- conteudo do dominio -----------------------------------------------------

test("o documento carrega os dados reais da reuniao", async () => {
  const texto = extrairTexto(await gerarPdfDePautas(comPautas(2)));

  assert.ok(texto.includes("Reunião do Comitê Executivo"), "titulo");
  assert.ok(texto.includes("COMITÊ EXECUTIVO"), "orgao no rotulo");
  assert.ok(texto.includes("Sala do Conselho"), "local");
  assert.ok(texto.includes("Secretaria de Governança"), "organizador");
  assert.ok(texto.includes("Avaliar o plano de investimentos"), "objetivo");
  assert.ok(texto.includes("Ana Souza"), "participante");
  assert.ok(texto.includes("Pauta 1"), "pauta");
  assert.ok(texto.includes("30 minuto(s)"), "soma das duracoes");
});

test("acentuacao e caracteres especiais sobrevivem ao PDF", async () => {
  const especial = comPautas(1);
  especial.titulo = "Ação & Avaliação — Comitê";
  especial.pautas[0]!.titulo = "Órgão, coordenação e execução: çãõáéíóúâêô";
  especial.pautas[0]!.descricao = "Aspas \"duplas\", 'simples' e travessão —";

  const pdf = await gerarPdfDePautas(especial);
  assert.deepEqual(validarEstrutura(pdf), []);

  const texto = extrairTexto(pdf);
  assert.ok(texto.includes("Ação & Avaliação"), "acentos e & no titulo");
  assert.ok(texto.includes("çãõáéíóúâêô"), "conjunto completo de acentos");
});

test("campo ausente no dominio nao vira linha no documento", async () => {
  // A pauta 1 nao tem descricao, responsavel nem apresentador (ver `pauta()`).
  const texto = extrairTexto(await gerarPdfDePautas(comPautas(1)));
  assert.ok(!texto.includes("Responsável:"), "sem responsavel, sem a linha");
  assert.ok(!texto.includes("Apresentação:"), "sem apresentador, sem a linha");
  assert.ok(texto.includes("Duração:"), "duracao existe e aparece");
});

test("reuniao sem descricao, local nem organizador nao inventa texto", async () => {
  const magra: ReuniaoDoDocumento = {
    ...BASE,
    descricao: null,
    local: null,
    organizador: null,
    participantes: [],
    pautas: [pauta(1)],
  };
  const pdf = await gerarPdfDePautas(magra);
  assert.deepEqual(validarEstrutura(pdf), []);

  const texto = extrairTexto(pdf);
  assert.ok(!texto.includes("Local:"), "sem local, sem a linha");
  assert.ok(!texto.includes("Organização:"), "sem organizador, sem a linha");
  assert.ok(!texto.includes("Objetivo"), "sem descricao, sem a secao");
});

test("tema circular: 'Sim' aparece na pauta circular; 'Não' nunca aparece", async () => {
  const doc: ReuniaoDoDocumento = {
    ...BASE,
    pautas: [
      { ...pauta(1), temaCircular: true },
      { ...pauta(2), temaCircular: false },
    ],
  };
  const pdf = await gerarPdfDePautas(doc);
  assert.deepEqual(validarEstrutura(pdf), []);

  const texto = extrairTexto(pdf);
  assert.ok(texto.includes("Tema circular:"), "pauta circular gera a linha");
  assert.ok(texto.includes("Sim"), "valor 'Sim' presente");
  // A nao-circular nunca deve poluir o PDF com "Tema circular: Não".
  assert.ok(!texto.includes("Tema circular: Não"), "nao-circular nao escreve 'Não'");
});

test("ficha (019): Tipo/Natureza aparecem quando existem; Tema de FUP só quando marcado", async () => {
  const doc: ReuniaoDoDocumento = {
    ...BASE,
    pautas: [
      { ...pauta(1), tipo: "Deliberativa", natureza: "Ordinária", temaFup: true },
      { ...pauta(2), tipo: null, natureza: null, temaFup: false },
    ],
  };
  const pdf = await gerarPdfDePautas(doc);
  assert.deepEqual(validarEstrutura(pdf), []);

  const texto = extrairTexto(pdf);
  assert.ok(texto.includes("Tipo:") && texto.includes("Deliberativa"), "Tipo exibido");
  assert.ok(texto.includes("Natureza:") && texto.includes("Ordinária"), "Natureza exibida");
  assert.ok(texto.includes("Tema de FUP:"), "FUP marcado gera a linha");
  // Item sem tipo/natureza e sem FUP não polui o documento.
  assert.ok(!texto.includes("Tema de FUP: Não"), "FUP não-marcado não escreve 'Não'");
});

// --- conteudo hostil ---------------------------------------------------------

test("texto do usuario nao quebra o documento", async () => {
  // Titulo de pauta e digitado por gente: parenteses e barra invertida sao
  // justamente os caracteres que delimitam string no PDF.
  const hostil = comPautas(1);
  hostil.titulo = "Reunião (com parênteses) e \\barra\\ invertida";
  hostil.pautas[0]!.titulo = ") Tj /F1 24 Tf (injetado";
  hostil.pautas[0]!.descricao = "endstream endobj trailer <</Root 1 0 R>>";
  hostil.participantes = ["(((", ")))", "\\\\\\"];

  const pdf = await gerarPdfDePautas(hostil);
  assert.deepEqual(validarEstrutura(pdf), [], "estrutura integra apesar do texto hostil");
  assert.equal(contarPaginas(pdf) >= 1, true);
});

test("texto muito longo e truncado e nao escapa da pagina", async () => {
  const longa = comPautas(1);
  longa.pautas[0]!.descricao = "palavra ".repeat(4000);
  longa.pautas[0]!.titulo = "T".repeat(2000);

  const pdf = await gerarPdfDePautas(longa);
  assert.deepEqual(validarEstrutura(pdf), []);
  // Truncado: nao vira um documento de dezenas de paginas por causa de uma pauta.
  assert.ok(contarPaginas(pdf) <= 4, `esperado documento curto, veio ${contarPaginas(pdf)} paginas`);
});

test("palavra unica gigante sem espaco nao estoura a largura", async () => {
  const semEspaco = comPautas(1);
  semEspaco.pautas[0]!.descricao = "X".repeat(1200);
  const pdf = await gerarPdfDePautas(semEspaco);
  assert.deepEqual(validarEstrutura(pdf), []);
});

// --- anexo -------------------------------------------------------------------

test("o anexo e declarado como PDF", () => {
  assert.equal(PDF_CONTENT_TYPE, "application/pdf");
});

test("o nome do arquivo termina em .pdf e e seguro", () => {
  assert.ok(nomeDoArquivo("Reunião do Comitê").endsWith(".pdf"));
  assert.equal(nomeDoArquivo("Reunião do Comitê"), "pautas-Reuniao-do-Comite.pdf");
  assert.equal(nomeDoArquivo('a/b\\c:d*e?f"g<h>i|j'), "pautas-a-b-c-d-e-f-g-h-i-j.pdf");
  assert.equal(nomeDoArquivo(""), "pautas-reuniao.pdf");
  assert.ok(nomeDoArquivo("x".repeat(300)).length < 80, "nome longo e cortado");
});

// --- data --------------------------------------------------------------------

test("a data sai no fuso da reuniao, nao no do servidor", () => {
  // 17:00 UTC = 14:00 em Sao Paulo (UTC-3).
  const texto = formatarQuando("2026-03-12T17:00:00.000Z", "2026-03-12T19:00:00.000Z", "America/Sao_Paulo");
  assert.ok(texto.includes("14:00"), `esperado 14:00, veio: ${texto}`);
  assert.ok(texto.includes("16:00"), "fim convertido junto");
  assert.ok(texto.includes("America/Sao_Paulo"));
});

test("fuso invalido nao derruba a geracao", () => {
  assert.doesNotThrow(() =>
    formatarQuando("2026-03-12T17:00:00.000Z", "2026-03-12T19:00:00.000Z", "Fuso/Inexistente"),
  );
});
