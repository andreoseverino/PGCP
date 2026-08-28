import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  clampPage,
  pageWindow,
  paginate,
  parsePageSize
} from "./pagination";

/**
 * A paginação da tela de Reuniões era decorativa: os botões "1 2 3" eram
 * estáticos e a lista renderizava TODAS as reuniões filtradas. O que se afirma
 * aqui é a aritmética que passou a cortar a página — e, principalmente, que
 * pedir uma página que não existe mais devolve uma página válida em vez de uma
 * tela vazia.
 */

const lista = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// --- padrão do produto -------------------------------------------------------

test("padrão é 10 itens por página, e as opções são 10/20/50", () => {
  assert.equal(DEFAULT_PAGE_SIZE, 10);
  assert.deepEqual([...PAGE_SIZE_OPTIONS], [10, 20, 50]);
});

test("valor de <select> fora das opções cai no padrão", () => {
  assert.equal(parsePageSize("10"), 10);
  assert.equal(parsePageSize("20"), 20);
  assert.equal(parsePageSize("50"), 50);
  assert.equal(parsePageSize("37"), 10);
  assert.equal(parsePageSize("abacaxi"), 10);
});

// --- tamanhos de lista -------------------------------------------------------

test("lista vazia continua sendo página 1 de 1, sem intervalo", () => {
  const p = paginate([], 1, 10);
  assert.deepEqual(p.items, []);
  assert.equal(p.page, 1);
  assert.equal(p.totalPages, 1);
  assert.equal(p.totalItems, 0);
  assert.equal(p.from, 0);
  assert.equal(p.to, 0);
  assert.equal(p.hasPrevious, false);
  assert.equal(p.hasNext, false);
});

test("menos de 10 itens: uma página só, sem próxima", () => {
  const p = paginate(lista(7), 1, 10);
  assert.equal(p.items.length, 7);
  assert.equal(p.totalPages, 1);
  assert.equal(p.from, 1);
  assert.equal(p.to, 7);
  assert.equal(p.hasNext, false);
});

test("exatamente 10 itens não cria uma segunda página vazia", () => {
  const p = paginate(lista(10), 1, 10);
  assert.equal(p.items.length, 10);
  assert.equal(p.totalPages, 1);
  assert.equal(p.hasNext, false);
});

test("mais de 10 itens: última página fica incompleta e é a correta", () => {
  const total = lista(37);
  const primeira = paginate(total, 1, 10);
  assert.deepEqual(primeira.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(primeira.totalPages, 4);
  assert.equal(primeira.from, 1);
  assert.equal(primeira.to, 10);
  assert.equal(primeira.hasPrevious, false);
  assert.equal(primeira.hasNext, true);

  const ultima = paginate(total, 4, 10);
  assert.deepEqual(ultima.items, [31, 32, 33, 34, 35, 36, 37]);
  assert.equal(ultima.from, 31);
  assert.equal(ultima.to, 37);
  assert.equal(ultima.hasPrevious, true);
  assert.equal(ultima.hasNext, false);
});

test("próxima e anterior avançam e voltam exatamente uma janela", () => {
  const total = lista(37);
  const p2 = paginate(total, paginate(total, 1, 10).page + 1, 10);
  assert.deepEqual(p2.items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

  const voltando = paginate(total, p2.page - 1, 10);
  assert.deepEqual(voltando.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

// --- 10 / 20 / 50 ------------------------------------------------------------

test("10, 20 e 50 limitam a página e recalculam o total de páginas", () => {
  const total = lista(63);

  const dez = paginate(total, 1, 10);
  assert.equal(dez.items.length, 10);
  assert.equal(dez.totalPages, 7);

  const vinte = paginate(total, 1, 20);
  assert.equal(vinte.items.length, 20);
  assert.equal(vinte.totalPages, 4);

  const cinquenta = paginate(total, 1, 50);
  assert.equal(cinquenta.items.length, 50);
  assert.equal(cinquenta.totalPages, 2);
  assert.equal(paginate(total, 2, 50).items.length, 13);
});

test("mais de 20 e mais de 50 continuam paginando em vez de mostrar tudo", () => {
  assert.equal(paginate(lista(21), 1, 20).items.length, 20);
  assert.equal(paginate(lista(21), 1, 20).totalPages, 2);
  assert.equal(paginate(lista(51), 1, 50).items.length, 50);
  assert.equal(paginate(lista(51), 1, 50).totalPages, 2);
});

// --- correção de página inexistente -----------------------------------------

test("aumentar itens por página devolve uma página que existe", () => {
  // Estava na página 5 de 10 itens; ao trocar para 50, só sobra 1 página.
  const p = paginate(lista(37), 5, 50);
  assert.equal(p.page, 1);
  assert.equal(p.totalPages, 1);
  assert.equal(p.items.length, 37);
});

test("filtro que encolhe a lista traz a página atual de volta para uma válida", () => {
  const p = paginate(lista(3), 7, 10);
  assert.equal(p.page, 1);
  assert.deepEqual(p.items, [1, 2, 3]);
});

test("clampPage grampeia às bordas e sobrevive a valor inválido", () => {
  assert.equal(clampPage(0, 4), 1);
  assert.equal(clampPage(-3, 4), 1);
  assert.equal(clampPage(9, 4), 4);
  assert.equal(clampPage(2, 4), 2);
  assert.equal(clampPage(Number.NaN, 4), 1);
  assert.equal(clampPage(2, 0), 1);
});

// --- janela de botões --------------------------------------------------------

test("janela de páginas é contígua, centrada e nunca sai do intervalo", () => {
  assert.deepEqual(pageWindow(1, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(1, 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(7, 10), [5, 6, 7, 8, 9]);
  assert.deepEqual(pageWindow(10, 10), [6, 7, 8, 9, 10]);
  assert.deepEqual(pageWindow(1, 1), [1]);
});

// --- a tela realmente usa o corte ------------------------------------------

test("a tabela de Reuniões renderiza a página, não a lista filtrada inteira", () => {
  /*
   * O defeito original não estava na aritmética — não havia aritmética. Os
   * botões "1 2 3" eram estáticos e o `<tbody>` percorria TODAS as reuniões
   * filtradas. Este teste trava o religamento: sem montar React, afirma sobre a
   * fonte que o corte de página é o que alimenta a tabela.
   *
   * Comentários saem antes da varredura: `paginate` citado em prosa não é
   * código executado.
   */
  const fonte = readFileSync(new URL("../components/MeetingsView.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // O corte existe e nasce da MESMA ordem que a tela já exibia.
  assert.match(fonte, /paginate\(orderedMeetings, currentPage, pageSize\)/);
  assert.match(fonte, /sortedMonthKeys\.flatMap\(/);

  // O corpo da tabela vem da página.
  assert.match(fonte, /pageGroups\.map\(/);
  assert.doesNotMatch(fonte, /sortedMonthKeys\.map\(\(monthKey\)/);

  // O seletor 10/20/50 controla o tamanho, e trocar o tamanho volta à página 1.
  assert.match(fonte, /PAGE_SIZE_OPTIONS\.map\(/);
  assert.match(fonte, /setPageSize\(parsePageSize\(e\.target\.value\)\);\s*\n\s*setCurrentPage\(1\);/);

  // Nenhum botão de página com número escrito à mão sobrou.
  assert.doesNotMatch(fonte, /text-xs">\s*\n\s*[123]\s*\n\s*<\/button>/);
});
