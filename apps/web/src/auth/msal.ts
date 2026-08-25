/**
 * Configuração do MSAL — ponto ÚNICO de contato com o Microsoft Entra ID.
 *
 * O navegador só adquire token para a **API do PGCP**. Não pede escopo do
 * Microsoft Graph: quem fala com o Graph é a API, via On-Behalf-Of (Etapa 5).
 *
 * Authorization Code + PKCE, provido pelo próprio MSAL. Sem fluxo implícito e
 * sem segredo — `VITE_*` vai para o bundle, e é justamente por isso que o SPA é
 * um public client.
 */

import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  BrowserAuthError,
  type AccountInfo,
  type Configuration
} from "@azure/msal-browser";

function read(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const env = import.meta.env as Record<string, unknown>;

const tenantId = read(env.VITE_ENTRA_TENANT_ID);
const spaClientId = read(env.VITE_ENTRA_SPA_CLIENT_ID);
const redirectUri = read(env.VITE_ENTRA_REDIRECT_URI) ?? window.location.origin;
const apiScope = read(env.VITE_ENTRA_API_SCOPE);

/** Nomes das variáveis obrigatórias ainda ausentes. Só nomes, nunca valores. */
export function missingEntraConfig(): string[] {
  const faltando: string[] = [];
  if (!tenantId) faltando.push("VITE_ENTRA_TENANT_ID");
  if (!spaClientId) faltando.push("VITE_ENTRA_SPA_CLIENT_ID");
  if (!apiScope) faltando.push("VITE_ENTRA_API_SCOPE");
  return faltando;
}

/** Entra utilizável nesta instalação. */
export const isEntraConfigured = (): boolean => missingEntraConfig().length === 0;

/**
 * Login mockado só existe quando explicitamente liberado E o Entra não está
 * configurado. Nunca os dois caminhos ao mesmo tempo: assim que o Entra
 * funciona, o bypass desaparece sozinho, sem depender de ninguém lembrar de
 * desligar a flag.
 */
export const isMockLoginAllowed = (): boolean =>
  !isEntraConfigured() && read(env.VITE_ALLOW_MOCK_LOGIN) !== "false";

/** Escopo único pedido pelo navegador: a API do PGCP. */
const apiScopes = apiScope ? [apiScope] : [];

const configuration: Configuration = {
  auth: {
    clientId: spaClientId ?? "",
    // Single tenant: a authority aponta para o tenant, não para /common.
    authority: `https://login.microsoftonline.com/${tenantId ?? "common"}`,
    redirectUri,
    postLogoutRedirectUri: redirectUri
  },
  cache: {
    // sessionStorage acompanha a convenção do projeto: sessão em
    // sessionStorage, dado de negócio em localStorage. Fechar o navegador
    // encerra a sessão. O MSAL é o ÚNICO responsável por guardar token —
    // nenhum código nosso escreve access token em storage.
    cacheLocation: "sessionStorage"
  }
};

/** Instância única. `null` quando o Entra não está configurado. */
export const msalInstance: PublicClientApplication | null = isEntraConfigured()
  ? new PublicClientApplication(configuration)
  : null;

/** MSAL v5 exige `initialize()` antes de qualquer operação. */
export async function initializeMsal(): Promise<void> {
  if (!msalInstance) return;
  await msalInstance.initialize();

  // Restaura a conta ativa entre recarregamentos da página.
  if (!msalInstance.getActiveAccount()) {
    const [primeira] = msalInstance.getAllAccounts();
    if (primeira) msalInstance.setActiveAccount(primeira);
  }
}

// -----------------------------------------------------------------------------
// Erros
// -----------------------------------------------------------------------------

export type AuthErrorKind =
  | "not_configured"
  | "cancelled"
  | "login_failed"
  | "token_unavailable"
  | "no_account";

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Usuário fechou o popup ou cancelou no consentimento. */
function isCancellation(error: unknown): boolean {
  if (error instanceof BrowserAuthError) {
    return ["user_cancelled", "popup_window_error", "empty_window_error"].includes(error.errorCode);
  }
  return error instanceof Error && /user_cancelled|AADSTS65004/i.test(error.message);
}

/** Mensagem apresentável. Nunca expõe token, tenant metadata ou stack. */
export function describeAuthError(error: unknown): { kind: AuthErrorKind; message: string } {
  if (error instanceof AuthError) return { kind: error.kind, message: error.message };

  if (isCancellation(error)) {
    return { kind: "cancelled", message: "Entrada cancelada." };
  }

  // Detalhe técnico fica no console do desenvolvedor, não na tela.
  console.warn("[auth] falha na autenticação:", error);
  return {
    kind: "login_failed",
    message: "Não foi possível concluir a entrada. Tente novamente ou procure a Secretaria de Governança."
  };
}

// -----------------------------------------------------------------------------
// Login / logout
// -----------------------------------------------------------------------------

/**
 * Login por POPUP, não redirect.
 *
 * Justificativa: o popup devolve o cancelamento como erro capturável, o que o
 * requisito de tratar "login cancelado" exige; a tela de login permanece
 * montada, então a mensagem de erro aparece no lugar certo sem precisar
 * restaurar estado; e não há plumbing de `handleRedirectPromise`.
 *
 * Contrapartida: bloqueador de popup. Trocar para redirect é mudar esta função
 * — nenhum componente chama o MSAL diretamente.
 */
export async function signIn(): Promise<AccountInfo> {
  if (!msalInstance) {
    throw new AuthError("not_configured", "Autenticação Microsoft não está configurada nesta instalação.");
  }

  const result = await msalInstance.loginPopup({
    scopes: apiScopes,
    // Deixa o Entra escolher a conta em vez de reaproveitar sessão silenciosamente.
    prompt: "select_account"
  });

  msalInstance.setActiveAccount(result.account);
  return result.account;
}

/**
 * Encerra a sessão MSAL. Não toca em `localStorage`: dado de negócio do PGCP
 * não pertence à autenticação e sair não pode significar perder trabalho.
 */
export async function signOut(): Promise<void> {
  if (!msalInstance) return;
  const account = msalInstance.getActiveAccount() ?? undefined;
  await msalInstance.logoutPopup({ account, postLogoutRedirectUri: redirectUri });
}

export function getActiveAccount(): AccountInfo | null {
  return msalInstance?.getActiveAccount() ?? null;
}

// -----------------------------------------------------------------------------
// Token
// -----------------------------------------------------------------------------

/**
 * Access token para a API do PGCP.
 *
 * Silencioso primeiro; interação apenas quando o MSAL declara que é
 * indispensável (expiração de refresh token, MFA, mudança de política).
 * O token NÃO é guardado por nós — o cache é do MSAL.
 */
export async function acquireApiToken(): Promise<string> {
  if (!msalInstance) {
    throw new AuthError("not_configured", "Autenticação Microsoft não está configurada nesta instalação.");
  }

  const account = msalInstance.getActiveAccount();
  if (!account) {
    throw new AuthError("no_account", "Sessão expirada. Entre novamente.");
  }

  try {
    const { accessToken } = await msalInstance.acquireTokenSilent({ scopes: apiScopes, account });
    if (!accessToken) {
      throw new AuthError("token_unavailable", "Não foi possível obter autorização para a API do PGCP.");
    }
    return accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      const { accessToken } = await msalInstance.acquireTokenPopup({ scopes: apiScopes, account });
      if (!accessToken) {
        throw new AuthError("token_unavailable", "Não foi possível obter autorização para a API do PGCP.");
      }
      return accessToken;
    }
    throw error;
  }
}
