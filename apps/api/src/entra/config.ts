/**
 * Configuracao do Microsoft Entra ID.
 *
 * Dois App Registrations distintos no MESMO tenant:
 *
 *   PGCP Web / SPA  -> public client, sem secret, PKCE. Adquire access token
 *                      cujo publico e a API do PGCP. Nao fala com o Graph.
 *   PGCP API        -> confidential client. Expoe o scope `access_as_user` e
 *                      valida os tokens recebidos.
 *
 * A API precisa conhecer o client id do SPA porque valida `azp`: so o PGCP Web
 * pode obter token para esta API.
 *
 * VALIDAR TOKEN NAO EXIGE SEGREDO — o JWKS e publico. `ENTRA_API_CLIENT_SECRET`
 * so passa a ser necessario no fluxo On-Behalf-Of (Etapa 5).
 */

export interface EntraConfig {
  tenantId: string;
  /** `aud` esperado. Token v2 traz o client id da API, nao o Application ID URI. */
  apiClientId: string;
  /** `azp` esperado: o unico cliente autorizado a pedir token para esta API. */
  spaClientId: string;
  /** Nome do scope delegado que precisa estar em `scp`. */
  scopeName: string;
  /** `iss` esperado, derivado do tenant. */
  issuer: string;
  /** Documento de descoberta OIDC do tenant. */
  metadataUrl: string;
}

function read(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Nome do scope. Valor de fabrica alinhado ao registro sugerido no Azure. */
export const DEFAULT_SCOPE_NAME = "access_as_user";

/**
 * Variaveis obrigatorias para autenticar. `ENTRA_API_APP_ID_URI` fica fora de
 * proposito: serve para montar o scope no frontend e para documentacao, nunca
 * para validar `aud`.
 */
export const REQUIRED_AUTH_VARS = ["ENTRA_TENANT_ID", "ENTRA_API_CLIENT_ID", "ENTRA_SPA_CLIENT_ID"] as const;

/** Variaveis obrigatorias ainda ausentes. Apenas nomes. */
export function missingAuthConfig(): string[] {
  return REQUIRED_AUTH_VARS.filter((name) => read(name) === undefined);
}

/**
 * Configuracao completa, ou `null` quando falta variavel obrigatoria.
 *
 * Lido a cada chamada de proposito: `tsx watch` recarrega o modulo, mas um
 * objeto congelado na importacao esconderia mudanca de .env durante o
 * desenvolvimento.
 */
export function getEntraConfig(): EntraConfig | null {
  const tenantId = read("ENTRA_TENANT_ID");
  const apiClientId = read("ENTRA_API_CLIENT_ID");
  const spaClientId = read("ENTRA_SPA_CLIENT_ID");

  if (!tenantId || !apiClientId || !spaClientId) return null;

  return {
    tenantId,
    apiClientId,
    spaClientId,
    scopeName: read("ENTRA_API_SCOPE_NAME") ?? DEFAULT_SCOPE_NAME,
    // Emissor do endpoint v2.0. O v1 usa https://sts.windows.net/{tid}/ — como
    // a API registration fixa requestedAccessTokenVersion=2, so o v2 e aceito.
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    metadataUrl: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
  };
}
