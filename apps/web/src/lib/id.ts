/**
 * Gera um identificador estável para entidades criadas no cliente.
 *
 * Usa `crypto.randomUUID()` quando disponível — o formato é o mesmo `uuid`
 * das tabelas do PostgreSQL, então esses IDs migram sem conversão quando
 * as reuniões forem para o banco.
 *
 * O fallback cobre contextos sem `crypto.randomUUID` (navegadores antigos ou
 * origem não segura); mantém o formato UUID v4 apenas por consistência.
 */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
