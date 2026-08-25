/**
 * Evidencia de que o login corporativo funcionou de verdade.
 *
 * Existe para o painel de Integracoes poder distinguir tres coisas que sao
 * frequentemente confundidas:
 *
 *   1. configuracao presente   -> variaveis preenchidas
 *   2. tenant alcancavel       -> a Microsoft responde e publica o JWKS
 *   3. login real validado     -> um access token foi ACEITO por esta API
 *
 * Sem (3) o painel nao pode dizer "Conectado". Ter variaveis preenchidas e um
 * tenant que responde nao prova que os App Registrations estao corretos.
 *
 * Estado em memoria, de proposito: reiniciar a API zera a evidencia, e uma
 * afirmacao dessas nao deve sobreviver a uma mudanca de configuracao. Nada do
 * token e guardado — apenas o instante.
 */

let lastSuccessAt: string | null = null;

/** Chamado pelo middleware quando um token e aceito. */
export function recordSuccessfulAuth(): void {
  lastSuccessAt = new Date().toISOString();
}

/** ISO 8601 do ultimo token aceito, ou `null` se nunca houve. */
export function getLastSuccessfulAuthAt(): string | null {
  return lastSuccessAt;
}
