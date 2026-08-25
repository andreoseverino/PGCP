/**
 * Deriva as iniciais a partir do nome: duas primeiras palavras, em maiúsculas.
 *
 *   Ana Prado      -> AP
 *   J. Ribeiro     -> JR
 *   Maria da Silva -> MD
 *
 * Iniciais nunca devem ser armazenadas: são sempre calculadas do nome, para
 * não existir a chance de divergirem dele.
 */
export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
