/**
 * Cliente do Microsoft Graph — ponto UNICO de acesso ao diretorio corporativo.
 *
 *   PGCP API --client credentials--> Entra ID --token de aplicacao--> Graph
 *
 * Fluxo APP-ONLY: nao ha usuario na sessao. E o unico que exige
 * `ENTRA_API_CLIENT_SECRET`.
 *
 * App-only tambem para CALENDARIO (etapa 5.2), e nao On-Behalf-Of: sincronizar
 * calendario nao pode depender de a sessao do organizador estar aberta. Retry,
 * reconciliacao e operacao assincrona precisam funcionar sem exigir que aquela
 * pessoa especifica esteja logada naquele instante. A caixa alvo e determinada
 * por `meetings.organizer_user_id` -> `users` -> identidade Entra, e as chamadas
 * usam `/users/{id}/...`, nunca `/me/...` — nao ha "me" em app-only.
 *
 * AUTORIZACAO DE CALENDARIO: `Application Calendars.ReadWrite` atribuida pelo
 * **Exchange Online RBAC for Applications**, com Resource Scope limitando as
 * mailboxes alcancaveis.
 *
 * NAO conceder `Calendars.ReadWrite` (Application) no App Registration do Entra.
 * As duas autorizacoes sao ADITIVAS: um grant tenant-wide no Entra passaria por
 * cima do Resource Scope do Exchange e devolveria a aplicacao o acesso irrestrito
 * que o escopo existe para impedir.
 *
 * `User.Read.All` (Application, Entra) continua sendo o modelo do DIRETORIO e
 * nao muda: diretorio e calendario sao capacidades distintas.
 *
 * Configuracao de infraestrutura, feita pelo time Exchange — ver
 * docs/integracoes.md.
 *
 * REGRAS:
 *   - o segredo nunca sai daqui;
 *   - o token nunca sai daqui, nem em log, nem em resposta HTTP;
 *   - nenhuma rota adquire token por conta propria.
 */

import { ConfidentialClientApplication, type AuthenticationResult } from "@azure/msal-node";

const GRAPH_DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";

/**
 * `.default` significa "todas as permissoes de aplicacao ja consentidas para
 * este App Registration". Em client credentials nao se pede scope granular:
 * o consentimento do admin e que define o alcance.
 */
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

function read(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** Variaveis obrigatorias para falar com o Graph. */
export const REQUIRED_GRAPH_VARS = [
  "ENTRA_TENANT_ID",
  "ENTRA_API_CLIENT_ID",
  "ENTRA_API_CLIENT_SECRET",
] as const;

export function missingGraphConfig(): string[] {
  return REQUIRED_GRAPH_VARS.filter((name) => read(name) === undefined);
}

/** Configuracao completa, ou `null` quando falta variavel obrigatoria. */
export function getGraphConfig(): GraphConfig | null {
  const tenantId = read("ENTRA_TENANT_ID");
  const clientId = read("ENTRA_API_CLIENT_ID");
  const clientSecret = read("ENTRA_API_CLIENT_SECRET");

  if (!tenantId || !clientId || !clientSecret) return null;

  return {
    tenantId,
    clientId,
    clientSecret,
    baseUrl: (read("GRAPH_BASE_URL") ?? GRAPH_DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

// -----------------------------------------------------------------------------
// Token de aplicacao
// -----------------------------------------------------------------------------

/**
 * Uma instancia por configuracao. O MSAL mantem cache interno e so vai a rede
 * quando o token esta perto de expirar — chamar `acquireToken` a cada
 * requisicao nao gera uma ida ao Entra a cada vez.
 *
 * A chave inclui o client id para que trocar de App Registration em
 * desenvolvimento nao reaproveite a instancia antiga.
 */
const clients = new Map<string, ConfidentialClientApplication>();

function getClient(config: GraphConfig): ConfidentialClientApplication {
  const chave = `${config.tenantId}:${config.clientId}`;
  const existente = clients.get(chave);
  if (existente) return existente;

  const client = new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret,
    },
  });

  clients.set(chave, client);
  return client;
}

export class GraphError extends Error {
  constructor(
    message: string,
    /** Codigo do Graph/Entra, quando disponivel. Nunca contem token. */
    readonly code?: string,
    readonly status?: number,
    /** Segundos ate poder tentar de novo, quando o Graph informa. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** Token de aplicacao. NAO exportado: ninguem fora deste modulo precisa dele. */
async function acquireAppToken(config: GraphConfig): Promise<string> {
  let result: AuthenticationResult | null;

  try {
    result = await getClient(config).acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
  } catch (error) {
    // Mensagem do MSAL pode citar o client id; nunca o segredo. Ainda assim,
    // so o codigo do erro atravessa para o chamador.
    const detalhe = error instanceof Error ? error.message : String(error);
    console.error("[graph] falha ao adquirir token de aplicação:", detalhe);

    if (/AADSTS7000215|invalid_client/i.test(detalhe)) {
      throw new GraphError(
        "Credencial da aplicação rejeitada pelo Entra ID. Verifique o ENTRA_API_CLIENT_SECRET (pode ter expirado).",
        "invalid_client",
      );
    }
    if (/AADSTS700016|unauthorized_client/i.test(detalhe)) {
      throw new GraphError(
        "Aplicação não encontrada no tenant. Verifique ENTRA_API_CLIENT_ID e ENTRA_TENANT_ID.",
        "unauthorized_client",
      );
    }
    throw new GraphError("Não foi possível obter autorização junto ao Entra ID.", "token_error");
  }

  if (!result?.accessToken) {
    throw new GraphError("O Entra ID não devolveu token de aplicação.", "no_token");
  }

  return result.accessToken;
}

// -----------------------------------------------------------------------------
// Chamada ao Graph
// -----------------------------------------------------------------------------

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

/** Espera maxima que aceitamos DENTRO de uma requisicao HTTP. */
const MAX_INLINE_RETRY_SECONDS = 5;
/** Tentativas extras apos o 429 inicial. */
const MAX_RETRIES = 2;
/** Backoff quando o Graph nao informa `Retry-After`. */
const FALLBACK_BACKOFF_SECONDS = [1, 2];

const sleep = (segundos: number) => new Promise((r) => setTimeout(r, segundos * 1000));

/** `Retry-After` em segundos. Aceita o formato numerico; ignora HTTP-date. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const segundos = Number(header.trim());
  return Number.isFinite(segundos) && segundos >= 0 ? segundos : undefined;
}

/** Rotulo para log. Sem querystring: o termo de busca nao vai para o log. */
const rotuloParaLog = (url: string) => url.split("?")[0];

export interface GraphRequestOptions {
  /** Cabecalhos extras (ex.: `ConsistencyLevel: eventual` exigido por `$search`). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Padrao GET. */
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Corpo JSON. Serializado aqui; nunca aparece em log. */
  body?: unknown;
  /**
   * Token DELEGADO ja obtido por quem chama (fluxo On-Behalf-Of).
   *
   * Quando presente, substitui o token de aplicacao — sem isto a chamada
   * delegada seria feita com a identidade da APLICACAO, que e outra pessoa.
   * Continua sem sair deste modulo e sem aparecer em log.
   */
  accessToken?: string;
}

/**
 * GET autenticado no Graph, com tratamento de throttling.
 *
 * `urlOrPath` aceita caminho relativo a `baseUrl` (`/users?...`) ou URL
 * absoluta — o `@odata.nextLink` vem absoluto do proprio Graph.
 *
 * O token e injetado aqui e em nenhum outro lugar.
 *
 * 429: `Retry-After` e respeitado INTEGRALMENTE. Ate 5s, aguarda e tenta de
 * novo (no maximo 2 vezes). Acima disso, nao seguramos a requisicao HTTP: o
 * throttling e propagado com o tempo informado, e quem chama decide. Truncar a
 * espera e tentar antes da hora so agrava o bloqueio.
 */
export async function graphGet<T>(
  config: GraphConfig,
  urlOrPath: string,
  options: GraphRequestOptions = {},
): Promise<T> {
  return graphRequest<T>(config, urlOrPath, options);
}

/**
 * Chamada autenticada ao Graph, de qualquer metodo.
 *
 * O token e injetado aqui e em nenhum outro lugar, e nunca e logado. O corpo da
 * requisicao e da resposta tambem nao: log carrega caminho, status e codigo de
 * erro — o suficiente para diagnosticar sem despejar dado de calendario.
 *
 * Escrita (POST/PATCH) NAO e repetida automaticamente fora do caso 429, em que
 * o proprio Graph diz que a requisicao nao foi processada. Reenviar uma criacao
 * por conta propria e responsabilidade de quem tem a chave de idempotencia.
 */
export async function graphRequest<T>(
  config: GraphConfig,
  urlOrPath: string,
  options: GraphRequestOptions = {},
): Promise<T> {
  const { headers = {}, timeoutMs = 10000, method = "GET", body, accessToken } = options;
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${config.baseUrl}${urlOrPath}`;

  for (let tentativa = 0; ; tentativa++) {
    // Token delegado quando quem chama ja o obteve; senao, o da aplicacao.
    const token = accessToken ?? (await acquireAppToken(config));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new GraphError("Não foi possível alcançar o Microsoft Graph. Verifique a rede.", "network_error");
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      /*
       * SUCESSO SEM CORPO E SUCESSO.
       *
       * Nem toda resposta boa do Graph traz JSON:
       *
       *   204 No Content  DELETE de evento
       *   202 Accepted    `/me/sendMail` — a mensagem foi ACEITA para envio
       *
       * Este trecho tratava apenas o 204 e chamava `response.json()` no resto.
       * Com o 202 do `sendMail`, o corpo vazio virava
       * `SyntaxError: Unexpected end of JSON input` DEPOIS de a Microsoft ja ter
       * aceitado a mensagem — o e-mail saia e quem chamou recebia excecao.
       *
       * Ler como TEXTO e so entao decidir cobre os tres casos de uma vez, sem
       * depender de a Microsoft manter a lista de status que devolvem corpo:
       * corpo vazio -> `undefined`; corpo presente -> JSON.
       */
      const texto = await response.text();
      if (texto.length === 0) return undefined as T;

      try {
        return JSON.parse(texto) as T;
      } catch {
        /*
         * Resposta bem-sucedida com corpo que nao e JSON. Nao ha o que
         * entregar, mas a OPERACAO deu certo — transformar isso em erro
         * repetiria o defeito que este bloco corrige.
         */
        console.warn(`[graph] ${rotuloParaLog(url)} respondeu ${response.status} com corpo nao-JSON`);
        return undefined as T;
      }
    }

    // --- 429: decidir entre aguardar e propagar -----------------------------
    if (response.status === 429) {
      const informado = parseRetryAfter(response.headers.get("retry-after"));
      const espera = informado ?? FALLBACK_BACKOFF_SECONDS[Math.min(tentativa, FALLBACK_BACKOFF_SECONDS.length - 1)]!;
      const podeAguardar = espera <= MAX_INLINE_RETRY_SECONDS && tentativa < MAX_RETRIES;

      console.warn(
        `[graph] ${rotuloParaLog(url)} throttled (429); Retry-After=${informado ?? "ausente"}s; ` +
          (podeAguardar ? `aguardando ${espera}s (tentativa ${tentativa + 1}/${MAX_RETRIES})` : "propagando"),
      );

      if (podeAguardar) {
        await sleep(espera);
        continue;
      }

      throw new GraphError(
        informado !== undefined
          ? `O Microsoft Graph está limitando as requisições. Tente novamente em ${informado} segundo(s).`
          : "O Microsoft Graph está limitando as requisições. Tente novamente em instantes.",
        "throttled",
        429,
        informado,
      );
    }

    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await response.json()) as GraphErrorBody;
      code = body.error?.code;
      message = body.error?.message;
    } catch {
      // Resposta sem JSON: sobra o status.
    }

    console.error(
      `[graph] ${method} ${rotuloParaLog(url)} respondeu ${response.status}${code ? ` (${code})` : ""}`,
    );

    // Traduz as falhas que tem correcao clara no App Registration.
    if (response.status === 403 || code === "Authorization_RequestDenied") {
      /*
       * Duas autorizacoes diferentes chegam aqui como 403, e o `code` do Graph
       * distingue: `Authorization_RequestDenied` vem do Entra (falta a permissao
       * de aplicacao); `ErrorAccessDenied` vem do Exchange (a permissao existe,
       * mas a mailbox nao esta no Resource Scope). Dizer a coisa errada faria o
       * administrador mexer na camada errada.
       */
      const doExchange = code === "ErrorAccessDenied";
      throw new GraphError(
        doExchange
          ? "O Exchange Online recusou o acesso a esta caixa. Confirme a atribuição de 'Application Calendars.ReadWrite' " +
            "ao service principal do PGCP e se a caixa está dentro do Resource Scope configurado."
          : "O Graph recusou a operação por falta de permissão de aplicação. Para diretório, confirme User.Read.All " +
            "(Application). Para calendário, a autorização é do Exchange Online RBAC for Applications, não do App Registration.",
        "forbidden",
        403,
      );
    }
    if (response.status === 401) {
      throw new GraphError("O Graph rejeitou o token da aplicação.", "unauthorized", 401);
    }
    if (response.status >= 500) {
      throw new GraphError(
        "O Microsoft Graph está indisponível no momento. Tente novamente em instantes.",
        code ?? "graph_unavailable",
        response.status,
      );
    }

    throw new GraphError(
      message ? `O Graph respondeu com erro: ${message}` : `O Graph respondeu HTTP ${response.status}.`,
      code ?? "graph_error",
      response.status,
    );
  }
}

// -----------------------------------------------------------------------------
// Verificacao de conectividade
// -----------------------------------------------------------------------------

/** Campos minimos do diretorio. Nao ha `$select` mais enxuto que prove acesso. */
const DIRECTORY_SELECT = "id,displayName,mail,userPrincipalName,jobTitle,userType,accountEnabled";

interface GraphUsersResponse {
  value?: Array<Record<string, unknown>>;
}

export interface GraphProbeResult {
  /** Base efetivamente usada. Publica. */
  baseUrl: string;
  /** Campos pedidos no `$select`. Publico. */
  selectedFields: string[];
  /** Se o diretorio devolveu ao menos um registro. NENHUM dado pessoal sai daqui. */
  directoryReadable: boolean;
}

/**
 * Prova acesso real ao diretorio.
 *
 * `$top=1` de proposito: baixar o tenant inteiro para testar conectividade
 * seria desperdicio e exposicao desnecessaria. O retorno NAO carrega nenhum
 * campo do usuario consultado — apenas o fato de a consulta ter funcionado.
 */
export async function probeDirectoryAccess(config: GraphConfig): Promise<GraphProbeResult> {
  const resposta = await graphGet<GraphUsersResponse>(
    config,
    `/users?$select=${DIRECTORY_SELECT}&$top=1`,
  );

  return {
    baseUrl: config.baseUrl,
    selectedFields: DIRECTORY_SELECT.split(","),
    directoryReadable: Array.isArray(resposta.value) && resposta.value.length > 0,
  };
}

// -----------------------------------------------------------------------------
// Busca de pessoas no diretorio
// -----------------------------------------------------------------------------

/** Teto de resultados. Busca interativa, nao exportacao de diretorio. */
export const DIRECTORY_SEARCH_LIMIT = 25;

/** Quantas vezes seguimos `@odata.nextLink`. Pagina parcial e comum. */
const MAX_PAGE_FOLLOWS = 2;

export const SEARCH_TERM_MIN = 3;
export const SEARCH_TERM_MAX = 64;

/** Pessoa do diretorio. Somente os campos que o PGCP usa. */
export interface DirectoryUser {
  /** `id` do Graph — e o futuro `entra_object_id`. */
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  userType: string | null;
  /** Estado da conta CORPORATIVA. Nao confundir com `users.is_active` do PGCP. */
  accountEnabled: boolean | null;
}

/** Somente os campos necessários para resolver um endereço corporativo. */
export type DirectoryAddress = Pick<DirectoryUser, "id" | "mail" | "userPrincipalName">;

interface GraphBatchRequest {
  id: string;
  method: "GET";
  url: string;
}

interface GraphBatchResponseItem {
  id: string;
  status: number;
  body?: Partial<DirectoryAddress>;
}

interface GraphBatchResponse {
  responses?: GraphBatchResponseItem[];
}

type DirectoryBatchRequester = (
  config: GraphConfig,
  requests: GraphBatchRequest[],
) => Promise<GraphBatchResponse>;

const requestDirectoryBatch: DirectoryBatchRequester = (config, requests) =>
  graphRequest<GraphBatchResponse>(config, "/$batch", {
    method: "POST",
    body: { requests },
  });

/** Limite documentado pelo Graph para requisições dentro de um JSON batch. */
const GRAPH_BATCH_LIMIT = 20;

/**
 * Recupera mail/UPN por identidade forte, sem busca por nome e sem N+1.
 *
 * O mapa é indexado pelo OID normalizado em minúsculas. O corpo do batch, que
 * contém os OIDs, fica encapsulado em `graphRequest` e nunca é registrado.
 * `requester` existe para que os testes não acessem o Graph real.
 */
export async function getDirectoryAddressesByObjectIds(
  config: GraphConfig,
  objectIds: readonly string[],
  requester: DirectoryBatchRequester = requestDirectoryBatch,
): Promise<Map<string, DirectoryAddress>> {
  const unicos = new Map<string, string>();
  for (const raw of objectIds) {
    const objectId = raw.trim();
    const chave = objectId.toLowerCase();
    if (objectId && !unicos.has(chave)) unicos.set(chave, objectId);
  }

  const entradas = [...unicos.entries()];
  const encontrados = new Map<string, DirectoryAddress>();

  for (let inicio = 0; inicio < entradas.length; inicio += GRAPH_BATCH_LIMIT) {
    const lote = entradas.slice(inicio, inicio + GRAPH_BATCH_LIMIT);
    const requests: GraphBatchRequest[] = lote.map(([, objectId], indice) => ({
      id: String(indice),
      method: "GET",
      url: `/users/${encodeURIComponent(objectId)}?$select=id,mail,userPrincipalName`,
    }));
    const resposta = await requester(config, requests);
    const porId = new Map((resposta.responses ?? []).map((item) => [item.id, item]));

    for (let indice = 0; indice < lote.length; indice += 1) {
      const [chave] = lote[indice]!;
      const item = porId.get(String(indice));
      if (!item) {
        throw new GraphError(
          "O Microsoft Graph devolveu uma resposta incompleta ao resolver endereços corporativos.",
          "directory_batch_incomplete",
        );
      }
      if (item.status === 404) continue;
      if (item.status !== 200) {
        throw new GraphError(
          "O Microsoft Graph não conseguiu resolver os endereços corporativos.",
          "directory_batch_failed",
          item.status,
        );
      }

      const id = typeof item.body?.id === "string" ? item.body.id.trim() : "";
      if (!id || id.toLowerCase() !== chave) {
        throw new GraphError(
          "O Microsoft Graph devolveu uma identidade inesperada ao resolver endereços corporativos.",
          "directory_identity_mismatch",
        );
      }

      encontrados.set(chave, {
        id,
        mail: typeof item.body?.mail === "string" ? item.body.mail : null,
        userPrincipalName:
          typeof item.body?.userPrincipalName === "string" ? item.body.userPrincipalName : null,
      });
    }
  }

  return encontrados;
}

export type SearchTermError = "too_short" | "too_long" | "invalid_characters";

export type SearchTermValidation =
  | { ok: true; term: string }
  | { ok: false; reason: SearchTermError };

/**
 * Valida o termo de busca.
 *
 * Sem allowlist de pontuacao: UPN de convidado carrega `#` (`fulano_dominio.com#EXT#@tenant`),
 * e nomes trazem apostrofo e hifen. Barrar pontuacao inviabilizaria busca legitima.
 *
 * A protecao contra alterar a estrutura do `$search` vem do escape (ver
 * `escapeSearchTerm`) somado a recusa de caracteres de controle — incluindo CR
 * e LF, que poderiam quebrar cabecalho ou linha da consulta.
 *
 * O minimo de 3 caracteres impede que uma letra devolva fatia larga do diretorio.
 */
export function validateSearchTerm(raw: unknown): SearchTermValidation {
  const term = typeof raw === "string" ? raw.trim() : "";

  if (term.length < SEARCH_TERM_MIN) return { ok: false, reason: "too_short" };
  if (term.length > SEARCH_TERM_MAX) return { ok: false, reason: "too_long" };
  // eslint-disable-next-line no-control-regex
  // Controle C0 e DEL — inclui CR e LF, que quebrariam a consulta.
  if (/[\u0000-\u001F\u007F]/.test(term)) return { ok: false, reason: "invalid_characters" };

  return { ok: true, term };
}

/**
 * Escapa o termo para dentro das aspas do `$search`.
 *
 * Barra invertida PRIMEIRO: inverter a ordem faria o escape da aspa ser
 * re-escapado e reabriria a saida da string.
 */
export function escapeSearchTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface GraphSearchResponse {
  value?: DirectoryUser[];
  "@odata.nextLink"?: string;
}

export interface DirectorySearchResult {
  users: DirectoryUser[];
  /** Havia mais resultados do que o teto permitiu trazer. */
  truncated: boolean;
}

/**
 * Busca pessoas no diretorio corporativo.
 *
 * `$search` em vez de `$filter=startswith(...)`: prefixo nao encontra quem
 * digita o sobrenome. `$search` e tokenizado e e o caminho recomendado para
 * busca de pessoas — exige `ConsistencyLevel: eventual` e `$count=true`.
 *
 * A filtragem acontece NO GRAPH. Nada e baixado para filtrar em memoria.
 *
 * Somente leitura: nenhuma linha de `users` e criada, alterada ou reconciliada.
 */
export async function searchDirectoryUsers(
  config: GraphConfig,
  term: string,
  limit = DIRECTORY_SEARCH_LIMIT,
): Promise<DirectorySearchResult> {
  const escapado = escapeSearchTerm(term);
  const expressao = ["displayName", "mail", "userPrincipalName"]
    .map((campo) => `"${campo}:${escapado}"`)
    .join(" OR ");

  const query = [
    `$search=${encodeURIComponent(expressao)}`,
    `$select=${DIRECTORY_SELECT}`,
    "$count=true",
    `$top=${limit}`,
  ].join("&");

  const headers = { ConsistencyLevel: "eventual" };

  const encontrados: DirectoryUser[] = [];
  let url: string | undefined = `/users?${query}`;
  let paginas = 0;
  let havia_mais = false;

  while (url && encontrados.length < limit) {
    const pagina: GraphSearchResponse = await graphGet<GraphSearchResponse>(config, url, { headers });
    encontrados.push(...(pagina.value ?? []));

    url = pagina["@odata.nextLink"];
    paginas += 1;

    // Pagina parcial e normal no Graph; percorrer o diretorio nao e.
    if (url && paginas > MAX_PAGE_FOLLOWS) {
      havia_mais = true;
      break;
    }
  }

  return {
    users: encontrados.slice(0, limit),
    truncated: havia_mais || encontrados.length > limit,
  };
}

/** Literal de string OData: aspa simples duplicada, sem outra transformacao. */
export function odataString(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

type DirectoryGetter = (config: GraphConfig, url: string) => Promise<GraphSearchResponse>;

/**
 * Pessoas do diretorio com ESTE e-mail (`mail` ou `userPrincipalName`).
 *
 * Uma chamada, feita so ao GRAVAR um participante externo — nunca ao renderizar
 * lista. Usa a mesma permissao do diretorio (`User.Read.All`, Application).
 * `getter` existe para o teste nao tocar o Graph real.
 */
export async function findDirectoryUsersByEmail(
  config: GraphConfig,
  email: string,
  getter: DirectoryGetter = (c, url) => graphGet<GraphSearchResponse>(c, url),
): Promise<DirectoryUser[]> {
  const literal = odataString(email.trim());
  const filtro = `mail eq ${literal} or userPrincipalName eq ${literal}`;
  const url = `/users?$filter=${encodeURIComponent(filtro)}&$select=${DIRECTORY_SELECT}&$top=5`;
  const pagina = await getter(config, url);
  return pagina.value ?? [];
}
