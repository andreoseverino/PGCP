/**
 * Paginação client-side.
 *
 * `GET /meetings` NÃO pagina: o contrato aceita apenas um teto (`limit`, ver
 * `api/src/meetings/service.ts`) e devolve a lista inteira de uma vez. Quem
 * corta a página, portanto, é a tela — e o corte vive aqui, em funções puras,
 * para poder ser afirmado sem montar React.
 *
 * Nada aqui conhece reunião: é aritmética de página sobre uma lista já
 * filtrada e já ordenada por quem chama.
 */

/** As únicas quantidades por página oferecidas ao usuário. */
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

/** Padrão do produto. Não havia regra explícita anterior — a lista era estática. */
export const DEFAULT_PAGE_SIZE: PageSize = 10;

export interface Page<T> {
  /** Os itens visíveis nesta página. */
  items: T[];
  /** Página efetivamente usada, já corrigida para existir. */
  page: number;
  pageSize: number;
  totalItems: number;
  /** Nunca zero: lista vazia continua sendo "página 1 de 1". */
  totalPages: number;
  /** Posição 1-based do primeiro e do último item da página. 0 se vazia. */
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/**
 * Devolve a página pedida, corrigindo-a quando ela não existe mais.
 *
 * Trocar o filtro ou a quantidade por página encolhe o total; pedir a página 7
 * de uma lista que agora tem 2 mostraria uma tela vazia sem explicação. Aqui a
 * página é sempre grampeada ao intervalo válido, e `page` diz qual foi usada.
 */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.trunc(pageSize)) : 1;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const current = clampPage(page, totalPages);

  const start = (current - 1) * size;
  const visiveis = items.slice(start, start + size);

  return {
    items: visiveis,
    page: current,
    pageSize: size,
    totalItems,
    totalPages,
    from: totalItems === 0 ? 0 : start + 1,
    to: totalItems === 0 ? 0 : start + visiveis.length,
    hasPrevious: current > 1,
    hasNext: current < totalPages
  };
}

/** Grampeia a página ao intervalo `[1, totalPages]`. */
export function clampPage(page: number, totalPages: number): number {
  const limite = Number.isFinite(totalPages) ? Math.max(1, Math.trunc(totalPages)) : 1;
  if (!Number.isFinite(page)) return 1;
  return Math.min(limite, Math.max(1, Math.trunc(page)));
}

/**
 * Janela contígua de números de página em torno da atual.
 *
 * Mantém os controles compactos quando há muitas páginas, sem esconder onde o
 * usuário está.
 */
export function pageWindow(current: number, totalPages: number, max = 5): number[] {
  const total = Number.isFinite(totalPages) ? Math.max(1, Math.trunc(totalPages)) : 1;
  const tamanho = Math.min(Math.max(1, Math.trunc(max)), total);
  const atual = clampPage(current, total);

  let inicio = atual - Math.floor(tamanho / 2);
  if (inicio < 1) inicio = 1;
  if (inicio + tamanho - 1 > total) inicio = total - tamanho + 1;

  return Array.from({ length: tamanho }, (_, i) => inicio + i);
}

/** `10` | `20` | `50` a partir de um valor de `<select>`; qualquer outra coisa cai no padrão. */
export function parsePageSize(value: string | number): PageSize {
  const numero = typeof value === "number" ? value : Number(value);
  const opcao = PAGE_SIZE_OPTIONS.find((o) => o === numero);
  return opcao ?? DEFAULT_PAGE_SIZE;
}
