/**
 * Diretório corporativo — consulta ao Microsoft Graph via API do PGCP.
 *
 * O navegador NUNCA fala com o Graph: não há token do Graph, client secret nem
 * credencial Microsoft no frontend. A chamada sai autenticada para a API do
 * PGCP, que detém o token de aplicação.
 *
 * Ponto único de acesso ao diretório no frontend. Os selects de participantes,
 * responsável pela pauta e biblioteca vão reutilizar `searchDirectoryUsers`
 * quando forem migrados — nenhum componente deve chamar `/directory/users`
 * diretamente.
 */

import { ApiError, apiRequest } from "./api";

/** Tamanho mínimo do termo. Espelha a validação da API; evita ida inútil. */
export const DIRECTORY_MIN_QUERY = 3;

export interface DirectoryUser {
  /** `id` do Graph — é o `entra_object_id` da pessoa. */
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  /** "Member" | "Guest" | outro. Pode vir nulo — não classificar por conta própria. */
  userType: string | null;
  /** Conta habilitada no DIRETÓRIO. Não confundir com `users.is_active` do PGCP. */
  accountEnabled: boolean | null;
}

export interface DirectorySearchResponse {
  users: DirectoryUser[];
  count: number;
  limit: number;
  /** Havia mais resultados do que o teto permite trazer. */
  truncated: boolean;
}

/**
 * Busca pessoas no diretório.
 *
 * `signal` permite cancelar a consulta anterior quando o usuário continua
 * digitando — sem isso, uma resposta lenta poderia sobrescrever uma mais nova.
 */
export function searchDirectoryUsers(
  query: string,
  signal?: AbortSignal
): Promise<DirectorySearchResponse> {
  return apiRequest<DirectorySearchResponse>(
    `/directory/users?q=${encodeURIComponent(query.trim())}`,
    { auth: true, signal }
  );
}

/** E-mail exibível. O UPN cobre contas sem `mail` preenchido no diretório. */
export function directoryEmail(user: DirectoryUser): string | null {
  return user.mail ?? user.userPrincipalName ?? null;
}

/**
 * Interno × externo, a partir do `userType` do Graph.
 *
 * `null` quando o diretório não informa: preferimos omitir a etiqueta a chutar
 * uma classificação que pode estar errada.
 */
export function directoryUserKind(
  user: DirectoryUser,
  language: "en" | "pt"
): string | null {
  const pt = language === "pt";
  switch (user.userType) {
    case "Member":
      return pt ? "Interno" : "Internal";
    case "Guest":
      return pt ? "Externo" : "External";
    default:
      return null;
  }
}

/** Mensagem humana para a falha da busca. Nunca expõe detalhe técnico. */
export function describeDirectoryError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";

  if (!(error instanceof ApiError)) {
    return pt
      ? "Não foi possível consultar o diretório. Tente novamente."
      : "Could not query the directory. Try again.";
  }

  switch (error.status) {
    case 400:
      return pt
        ? `Informe ao menos ${DIRECTORY_MIN_QUERY} caracteres para buscar.`
        : `Type at least ${DIRECTORY_MIN_QUERY} characters to search.`;
    case 401:
      return pt
        ? "Sua sessão expirou. Entre novamente para consultar o diretório."
        : "Your session expired. Sign in again to query the directory.";
    case 403:
      return pt
        ? "Sua conta não tem acesso à consulta do diretório corporativo."
        : "Your account cannot query the corporate directory.";
    case 429:
    case 503:
      // Throttling do Graph e indisponibilidade chegam aqui. O número de
      // segundos do Retry-After fica no header; a tela não exibe dado técnico.
      return pt
        ? "O diretório está temporariamente limitando consultas. Tente novamente em alguns segundos."
        : "The directory is temporarily throttling requests. Try again in a few seconds.";
    case 0:
      return pt
        ? "Não foi possível conectar à API do PGCP."
        : "Could not reach the PGCP API.";
    default:
      return error.message;
  }
}
