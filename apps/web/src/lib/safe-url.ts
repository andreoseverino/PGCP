/**
 * Saneamento de URL para uso como `href` de link clicável.
 *
 * Defesa em profundidade: o servidor já recusa link que não seja http(s) na
 * criação e na edição da reunião. Mas dado antigo, importado ou gravado por
 * outro caminho pode chegar à tela, e um `href="javascript:..."` executa
 * script no clique — o React NÃO bloqueia esse esquema, apenas avisa no
 * console. Esta função é a última barreira antes do DOM.
 *
 * Aceita SOMENTE `http:` e `https:`. Qualquer outra coisa (javascript:, data:,
 * vbscript:, URL malformada) vira `undefined`, e o chamador decide o fallback
 * — tipicamente não renderizar o botão de ingressar.
 */
export function hrefSeguro(valor: string | null | undefined): string | undefined {
  if (typeof valor !== "string") return undefined;
  const limpo = valor.trim();
  if (limpo.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(limpo);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? limpo : undefined;
}
