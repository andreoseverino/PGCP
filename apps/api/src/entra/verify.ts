/**
 * Verificacao do access token emitido pelo Entra ID para a API do PGCP.
 *
 * Divisao proposital:
 *
 *   `jose`         -> assinatura, `iss`, `aud`, `exp`, `nbf`. Criptografia e
 *                     rotacao de chave sao problema de biblioteca, nao nosso.
 *   `validateClaims` -> `aud`, `tid`, `oid`, `scp`, `azp`. Funcao PURA, por isso
 *                     testavel sem token real nem rede.
 *
 * IDENTIDADE: `tid` + `oid`. Nunca `email`, `preferred_username`, `upn` ou
 * `sub` — os tres primeiros sao atributos mutaveis e `sub` e pairwise (muda
 * entre aplicacoes, portanto nao identifica a pessoa).
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { EntraConfig } from "./config.js";

export type AuthFailureCode =
  | "missing_token"
  | "malformed_token"
  | "not_configured"
  | "invalid_token"
  | "wrong_audience"
  | "wrong_tenant"
  | "missing_object_id"
  | "unauthorized_client"
  | "insufficient_scope";

export interface AuthFailure {
  ok: false;
  code: AuthFailureCode;
  /** Mensagem para o cliente. Sem stack, sem detalhe de criptografia. */
  message: string;
}

/** Identidade extraida do token validado. */
export interface AuthenticatedPrincipal {
  /** `tid` — tenant Microsoft. */
  entraTenantId: string;
  /** `oid` — identidade estavel da pessoa no tenant. */
  entraObjectId: string;
  /** Atributo de exibicao. Pode mudar; nunca usar como chave. */
  name: string | null;
  /** `preferred_username`. Atributo de exibicao, nao identidade. */
  username: string | null;
  /**
   * Claim `email`, quando o App Registration o emite. ATRIBUTO — nunca chave.
   * Opcional por natureza: nem todo token traz, e o PGCP nao pode depender dele
   * para reconhecer quem e a pessoa.
   */
  email: string | null;
  /** Scopes delegados presentes no token. */
  scopes: string[];
  /**
   * App Roles do PGCP API atribuidos a ESTE usuario, do claim `roles`.
   *
   * Num token DELEGADO, `roles` carrega os papeis que o Enterprise Application
   * atribuiu a pessoa (diretamente ou por grupo). E o mecanismo do Entra para
   * autorizacao funcional — e o unico que o PGCP usa.
   *
   * NUNCA derivar papel de nome, e-mail, `jobTitle` ou pertencimento a grupo
   * consultado a parte: o token ja diz, assinado, e qualquer outra fonte seria
   * uma segunda verdade que o Entra nao endossa.
   */
  appRoles: string[];
}

export type AuthResult = { ok: true; principal: AuthenticatedPrincipal } | AuthFailure;

/** HTTP de cada falha. 403 = autenticado, porem nao autorizado. */
export function statusForFailure(code: AuthFailureCode): number {
  switch (code) {
    case "unauthorized_client":
    case "insufficient_scope":
      return 403;
    case "not_configured":
      return 503;
    default:
      return 401;
  }
}

// -----------------------------------------------------------------------------
// JWKS
// -----------------------------------------------------------------------------

/**
 * Um JWKS remoto por tenant.
 *
 * `createRemoteJWKSet` ja resolve o que importa: busca sob demanda, cache em
 * memoria, refetch quando aparece um `kid` desconhecido (rotacao de chave) e
 * `cooldownDuration` para que token forjado com `kid` aleatorio nao vire vetor
 * de DoS contra o endpoint da Microsoft. Reimplementar isso a mao seria pior.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(tenantId: string) {
  const cached = jwksCache.get(tenantId);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    {
      cacheMaxAge: 24 * 60 * 60 * 1000,
      cooldownDuration: 30 * 1000,
      timeoutDuration: 5000,
    },
  );

  jwksCache.set(tenantId, jwks);
  return jwks;
}

// -----------------------------------------------------------------------------
// Validacao dos claims (pura)
// -----------------------------------------------------------------------------

/**
 * `roles` vem como array de strings.
 *
 * Ausente quando a pessoa nao tem nenhum papel atribuido — que e o caso comum e
 * NAO e erro: usuario sem papel continua entrando, vendo o proprio calendario e
 * participando de reuniao.
 */
function parseAppRoles(payload: JWTPayload): string[] {
  const raw = payload["roles"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((papel): papel is string => typeof papel === "string" && papel.length > 0);
}

/** `scp` vem como string separada por espaco. */
function readScopes(payload: JWTPayload): string[] {
  const raw = payload["scp"];
  if (typeof raw !== "string") return [];
  return raw.split(" ").map((scope) => scope.trim()).filter(Boolean);
}

function readString(payload: JWTPayload, claim: string): string | null {
  const value = payload[claim];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Claims especificos do PGCP. Executado DEPOIS da verificacao criptografica.
 *
 * `aud` e reconferido aqui, mesmo o `jose` ja tendo checado: e a garantia de que
 * um token do Microsoft Graph nunca e aceito como credencial do PGCP, e essa e
 * a verificacao que mais importa acertar. Redundancia deliberada.
 */
export function validateClaims(payload: JWTPayload, config: EntraConfig): AuthResult {
  if (payload.aud !== config.apiClientId) {
    return {
      ok: false,
      code: "wrong_audience",
      message: "Token não destinado à API do PGCP.",
    };
  }

  if (readString(payload, "tid") !== config.tenantId) {
    return { ok: false, code: "wrong_tenant", message: "Token emitido por outro tenant." };
  }

  const entraObjectId = readString(payload, "oid");
  if (!entraObjectId) {
    return {
      ok: false,
      code: "missing_object_id",
      message: "Token sem identificador de objeto (oid).",
    };
  }

  // `azp` identifica a aplicacao que obteve o token. Hoje somente o PGCP Web
  // esta autorizado; com mais clientes isto passa a ser uma allowlist.
  if (readString(payload, "azp") !== config.spaClientId) {
    return {
      ok: false,
      code: "unauthorized_client",
      message: "Aplicação cliente não autorizada a acessar a API do PGCP.",
    };
  }

  const scopes = readScopes(payload);
  if (!scopes.includes(config.scopeName)) {
    return {
      ok: false,
      code: "insufficient_scope",
      message: `Token sem o escopo obrigatório "${config.scopeName}".`,
    };
  }

  return {
    ok: true,
    principal: {
      entraTenantId: config.tenantId,
      entraObjectId,
      name: readString(payload, "name"),
      username: readString(payload, "preferred_username"),
      email: readString(payload, "email"),
      scopes,
      // Papeis do PGCP API atribuidos a esta pessoa. Vazio e legitimo.
      appRoles: parseAppRoles(payload),
    },
  };
}

// -----------------------------------------------------------------------------
// Verificacao completa
// -----------------------------------------------------------------------------

/**
 * Extrai o token de `Authorization: Bearer <jwt>`.
 *
 * Esquema comparado sem diferenciar caixa (RFC 7235) e exigindo exatamente duas
 * partes: "Bearer a b" nao e token valido.
 */
export function extractBearerToken(header: string | undefined): AuthFailure | string {
  if (!header || header.trim().length === 0) {
    return { ok: false, code: "missing_token", message: "Credencial ausente." };
  }

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer" || parts[1]!.length === 0) {
    return {
      ok: false,
      code: "malformed_token",
      message: "Formato inválido. Esperado: Authorization: Bearer <token>.",
    };
  }

  return parts[1]!;
}

/** Verifica assinatura e claims. Nao registra o token nem partes dele em log. */
export async function verifyAccessToken(token: string, config: EntraConfig): Promise<AuthResult> {
  let payload: JWTPayload;

  try {
    const result = await jwtVerify(token, getJwks(config.tenantId), {
      issuer: config.issuer,
      audience: config.apiClientId,
      algorithms: ["RS256"],
      // Tolera relogio dessincronizado sem abrir janela relevante.
      clockTolerance: "60s",
    });
    payload = result.payload;
  } catch (error) {
    // Motivo detalhado fica no servidor; o cliente recebe texto generico para
    // nao virar oraculo sobre qual verificacao falhou.
    console.warn("[entra] token rejeitado:", error instanceof Error ? error.message : error);
    return { ok: false, code: "invalid_token", message: "Credencial inválida ou expirada." };
  }

  return validateClaims(payload, config);
}
