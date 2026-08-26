/**
 * Ponto unico de configuracao da API.
 *
 * A URL base nunca deve ser repetida em componentes: qualquer chamada passa
 * por `apiRequest`.
 */
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3333";

/**
 * Falha de uma chamada a API, com o status HTTP preservado.
 *
 * O status importa para autenticacao: 401, 403 e 503 exigem tratamentos
 * diferentes na tela, e sem ele so restaria comparar texto de mensagem.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Codigo simbolico devolvido pela API, quando houver. */
    readonly code?: string,
    /** Corpo bruto da resposta de erro, quando a falha carrega contexto extra. */
    readonly body?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Fornecedor do access token.
 *
 * A camada de API nao conhece o MSAL: quem sabe adquirir token se registra aqui
 * na inicializacao. Isso evita `acquireTokenSilent` espalhado por componente e
 * mantem `lib/api.ts` testavel sem browser nem Entra.
 */
type AccessTokenProvider = () => Promise<string>;

let accessTokenProvider: AccessTokenProvider | null = null;

export function setAccessTokenProvider(provider: AccessTokenProvider | null): void {
  accessTokenProvider = provider;
}

export interface ApiRequestInit extends RequestInit {
  /**
   * Anexa `Authorization: Bearer <token>`.
   *
   * Padrao `false` para que `/health` — a unica rota publica da API — continue
   * funcionando sem sessao e para que nenhuma chamada dispare aquisicao de
   * token, que pode exigir interacao, sem necessidade. Toda rota de negocio
   * passa `auth: true`.
   */
  auth?: boolean;
}

/**
 * Faz a chamada e normaliza a falha: sempre lanca `ApiError` com mensagem
 * apresentavel, vinda do campo `error` da API quando existir.
 */
export async function apiRequest<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { auth = false, ...requestInit } = init ?? {};

  const headers: Record<string, string> = {
    ...(requestInit.body ? { "Content-Type": "application/json" } : {}),
    ...(requestInit.headers as Record<string, string> | undefined),
  };

  if (auth) {
    if (!accessTokenProvider) {
      throw new ApiError(401, "Sessão não autenticada.", "no_token_provider");
    }
    // Falha de aquisicao sobe como esta: o chamador distingue cancelamento de
    // sessao expirada olhando o `AuthError`.
    headers.Authorization = `Bearer ${await accessTokenProvider()}`;
  }

  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, { ...requestInit, headers });
  } catch (error) {
    /*
     * Cancelamento NAO e falha de rede. Quem aborta (busca com debounce,
     * componente desmontado) precisa distinguir isso de "API fora do ar" para
     * nao exibir erro por uma requisicao que ele mesmo descartou.
     */
    if (error instanceof DOMException && error.name === "AbortError") throw error;

    // Falha de rede: API fora do ar, DNS, CORS bloqueado.
    throw new ApiError(0, "Não foi possível conectar ao servidor. Verifique se a API está no ar.");
  }

  if (!response.ok) {
    let message = `Falha na requisição (HTTP ${response.status}).`;
    let code: string | undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = (await response.json()) as Record<string, unknown>;
      if (typeof body?.error === "string") message = body.error;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      // Resposta sem JSON: mantem a mensagem padrao.
    }
    throw new ApiError(response.status, message, code, body);
  }

  // 204 No Content nao tem corpo para desserializar.
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
