/**
 * Estado das integracoes do PGCP.
 *
 * Duas garantias:
 *
 *  1. NENHUM segredo sai daqui. Variaveis `secret: true` produzem apenas
 *     `configured: true/false`. Valores publicos podem ser devolvidos.
 *  2. NENHUM status positivo e inventado. Sem verificacao possivel, o estado e
 *     "nao verificado" (`connected: null`) — nunca "conectado".
 */

import { checkDatabaseConnection } from "../database.js";
import { getLastSuccessfulAuthAt } from "../entra/auth-events.js";
import { GraphError, getGraphConfig, missingGraphConfig, probeDirectoryAccess } from "../graph/client.js";
import {
  INHERITS_ENTRA,
  INTEGRATIONS,
  ENTRA_SHARED_ENV,
  findIntegration,
  type EnvVarSpec,
  type IntegrationId,
  type IntegrationSpec,
} from "./registry.js";

/** Estado consolidado exibido no painel. */
export type IntegrationState =
  /** Verificada agora e respondendo. */
  | "connected"
  /** Parametros presentes, mas nao verificada (ou sem verificacao possivel). */
  | "configured"
  /** Falta parametro obrigatorio. */
  | "not_configured"
  /** Verificada e falhou. */
  | "error";

export interface EnvVarStatus {
  name: string;
  secret: boolean;
  required: boolean;
  configured: boolean;
  description: string;
  /** Agrupamento dentro da integracao (ex.: qual App Registration). */
  group?: string;
  /** Presente apenas para variaveis publicas. Ausente quando `secret`. */
  value?: string;
  /** Origem da configuracao quando herdada de outra integracao. */
  inheritedFrom?: IntegrationId;
}

/**
 * Etapa individual de verificacao. Existe porque "configurado", "alcancavel" e
 * "funcionando" sao afirmacoes diferentes, e colapsar as tres num unico selo
 * produz status otimista falso.
 */
export interface IntegrationCheck {
  label: string;
  state: "ok" | "pending" | "failed";
  detail: string;
}

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  description: string;
  category: IntegrationSpec["category"];
  environment: string;
  state: IntegrationState;
  configured: boolean;
  /** `null` = nunca verificada nesta execucao da API. */
  connected: boolean | null;
  /** Existe verificacao real disponivel hoje. */
  testable: boolean;
  /** ISO 8601 da ultima verificacao, ou `null`. */
  lastCheckedAt: string | null;
  /** Mensagem legivel. Explica o que falta, sem jargao de stack trace. */
  message: string;
  /** Variaveis obrigatorias ausentes. Apenas nomes. */
  missing: string[];
  env: EnvVarStatus[];
  pending: string;
  roadmapStage: string;
  /** Etapas de verificacao, quando a integracao tem mais de um nivel. */
  checks?: IntegrationCheck[];
}

interface ProbeResult {
  connected: boolean;
  message: string;
}

/** Ultimo resultado por integracao. Em memoria: reiniciar a API zera. */
const lastProbe = new Map<IntegrationId, { at: string; result: ProbeResult }>();

function environment(): string {
  return process.env.NODE_ENV ?? "development";
}

function isSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/** Variaveis efetivas da integracao, incluindo as herdadas do Entra. */
function effectiveEnv(spec: IntegrationSpec): EnvVarStatus[] {
  const own: EnvVarStatus[] = spec.env.map((variable) => describe(variable));

  if (!INHERITS_ENTRA.includes(spec.id)) return own;

  const inherited = ENTRA_SHARED_ENV.map((variable) => {
    // O secret e opcional para quem so VALIDA token, mas obrigatorio para quem
    // ADQUIRE token de aplicacao. A obrigatoriedade e da integracao, nao da
    // variavel — por isso o ajuste acontece aqui e nao no catalogo.
    const obrigatorio =
      variable.required || (spec.needsAppToken === true && variable.name === "ENTRA_API_CLIENT_SECRET");

    return {
      ...describe({ ...variable, required: obrigatorio }),
      inheritedFrom: "entra" as IntegrationId,
    };
  });

  return [...inherited, ...own];
}

function describe(variable: EnvVarSpec): EnvVarStatus {
  const configured = isSet(variable.name);
  const status: EnvVarStatus = {
    name: variable.name,
    secret: variable.secret,
    required: variable.required,
    description: variable.description,
    configured,
  };

  if (variable.group) status.group = variable.group;

  // Valor so acompanha variavel publica. Segredo nunca — nem mascarado, porque
  // o tamanho da mascara ja seria informacao sobre o segredo.
  if (!variable.secret && configured) {
    status.value = process.env[variable.name]!.trim();
  }

  return status;
}

// -----------------------------------------------------------------------------
// Verificacoes reais
// -----------------------------------------------------------------------------

/** Aborta a requisicao para o probe nao pendurar a resposta do painel. */
async function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probePostgres(): Promise<ProbeResult> {
  const connected = await checkDatabaseConnection();
  return {
    connected,
    message: connected
      ? `Conectado ao banco "${process.env.DB_NAME}" em ${process.env.DB_HOST}:${process.env.DB_PORT}.`
      : "Nao foi possivel conectar. Verifique se o PostgreSQL esta no ar e se as credenciais estao corretas.",
  };
}

/**
 * Alcancabilidade do tenant via documento de descoberta OIDC.
 *
 * Chamada publica e sem credencial: prova que o tenant existe e responde, NAO
 * que client id e secret sao validos. A mensagem diz isso explicitamente para
 * ninguem ler "conectado" como "login funcionando".
 */
async function probeEntra(): Promise<ProbeResult> {
  const tenant = process.env.ENTRA_TENANT_ID?.trim();
  if (!tenant) {
    return { connected: false, message: "ENTRA_TENANT_ID nao configurado." };
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      return {
        connected: false,
        message: `O tenant informado nao respondeu como esperado (HTTP ${response.status}). Confira o ENTRA_TENANT_ID.`,
      };
    }

    // Confere que o metadata traz o `jwks_uri` — e exatamente dele que o
    // middleware de autenticacao busca as chaves de assinatura.
    const metadata = (await response.json()) as { jwks_uri?: unknown };
    if (typeof metadata.jwks_uri !== "string") {
      return {
        connected: false,
        message: "O tenant respondeu, mas o documento de descoberta nao expoe jwks_uri.",
      };
    }

    return {
      connected: true,
      message:
        "Tenant acessivel e JWKS publicado — a API tem como validar assinatura de token. " +
        "Client ids e secret NAO foram validados: isso so se prova emitindo um token de verdade.",
    };
  } catch {
    return {
      connected: false,
      message: "Nao foi possivel alcancar o Microsoft Entra ID. Verifique a rede e o tenant informado.",
    };
  }
}

/** Alcancabilidade do host de OAuth do DocuSign. Nao valida credencial. */
async function probeDocuSign(): Promise<ProbeResult> {
  const host = process.env.DOCUSIGN_OAUTH_BASE_PATH?.trim();
  if (!host) {
    return { connected: false, message: "DOCUSIGN_OAUTH_BASE_PATH nao configurado." };
  }

  const base = host.startsWith("http") ? host : `https://${host}`;

  try {
    const response = await fetchWithTimeout(`${base}/.well-known/openid-configuration`);
    if (!response.ok) {
      return {
        connected: false,
        message: `O host de OAuth nao respondeu como esperado (HTTP ${response.status}). Confira o DOCUSIGN_OAUTH_BASE_PATH.`,
      };
    }
    return {
      connected: true,
      message:
        "Host de OAuth acessivel. Conta e credenciais NAO foram validadas: " +
        "falta escolher o grant e implementar o cliente eSignature.",
    };
  } catch {
    return {
      connected: false,
      message: "Nao foi possivel alcancar o DocuSign. Verifique a rede e o host de OAuth informado.",
    };
  }
}

/**
 * Valida o FORMATO da connection string do Application Insights. Nao envia
 * telemetria nem abre conexao: fabricar um evento so para o botao ficar verde
 * poluiria a telemetria real.
 */
async function probeObservability(): Promise<ProbeResult> {
  const raw = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (!raw) {
    return { connected: false, message: "APPLICATIONINSIGHTS_CONNECTION_STRING nao configurada." };
  }

  const parts = new Map(
    raw
      .split(";")
      .map((piece) => piece.split("="))
      .filter((pair): pair is [string, string] => pair.length >= 2)
      .map(([key, ...rest]) => [key.trim().toLowerCase(), rest.join("=").trim()]),
  );

  if (!parts.has("instrumentationkey")) {
    return {
      connected: false,
      message: "A connection string nao contem InstrumentationKey. Copie o valor completo do recurso no Azure.",
    };
  }

  return {
    connected: true,
    message:
      "Connection string em formato valido. Nada e enviado ainda: falta o exportador OpenTelemetry na API (Etapa 8).",
  };
}

/**
 * Consulta REAL ao diretorio: adquire token de aplicacao e le um registro com
 * `$top=1`. Prova as tres coisas de uma vez — credencial aceita, permissao
 * concedida com consentimento do administrador, e diretorio acessivel.
 *
 * A mensagem NAO carrega nenhum dado pessoal do usuario consultado.
 */
async function probeGraph(): Promise<ProbeResult> {
  const config = getGraphConfig();
  if (!config) {
    return { connected: false, message: `Configuração incompleta: ${missingGraphConfig().join(", ")}.` };
  }

  try {
    const resultado = await probeDirectoryAccess(config);
    return {
      connected: true,
      message: resultado.directoryReadable
        ? `Conectado ao Microsoft Graph. Diretório acessível em ${resultado.baseUrl}, com os campos: ${resultado.selectedFields.join(", ")}.`
        : `Conectado ao Microsoft Graph em ${resultado.baseUrl}, mas o diretório não retornou nenhum usuário.`,
    };
  } catch (error) {
    if (error instanceof GraphError) {
      return { connected: false, message: error.message };
    }
    console.error("[integrations] falha inesperada no probe do Graph:", error);
    return { connected: false, message: "Falha inesperada ao consultar o Microsoft Graph." };
  }
}

const PROBES: Partial<Record<IntegrationId, () => Promise<ProbeResult>>> = {
  postgres: probePostgres,
  entra: probeEntra,
  graph: probeGraph,
  docusign: probeDocuSign,
  observability: probeObservability,
};

// -----------------------------------------------------------------------------
// Montagem do status
// -----------------------------------------------------------------------------

function baseMessage(spec: IntegrationSpec, missing: string[]): string {
  if (missing.length > 0) {
    return `Nao configurado. Faltam: ${missing.join(", ")}.`;
  }
  if (spec.probe === "none") {
    return `Parametros presentes, sem verificacao disponivel. ${spec.pending}`;
  }
  return "Configurado. Use Testar conexao para verificar.";
}

function build(spec: IntegrationSpec): IntegrationStatus {
  const env = effectiveEnv(spec);
  const missing = env.filter((variable) => variable.required && !variable.configured).map((v) => v.name);
  const configured = missing.length === 0;
  const cached = lastProbe.get(spec.id);
  const testable = configured && spec.probe !== "none" && PROBES[spec.id] !== undefined;

  let state: IntegrationState = configured ? "configured" : "not_configured";
  let connected: boolean | null = null;
  let message = baseMessage(spec, missing);

  // Resultado de verificacao so vale enquanto a configuracao continua completa.
  if (cached && configured) {
    connected = cached.result.connected;
    state = connected ? "connected" : "error";
    message = cached.result.message;
  }

  const status: IntegrationStatus = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    environment: environment(),
    state,
    configured,
    connected,
    testable,
    lastCheckedAt: cached && configured ? cached.at : null,
    message,
    missing,
    env,
    pending: spec.pending,
    roadmapStage: spec.roadmapStage,
  };

  return spec.id === "entra" ? applyEntraChecks(status, cached?.result.connected ?? null) : status;
}

/**
 * O Entra tem tres niveis, e so o terceiro autoriza dizer "Conectado".
 *
 * Variaveis preenchidas nao provam que os dois App Registrations estao
 * corretos; um tenant que responde tampouco. A unica evidencia real e um access
 * token ACEITO por esta API — `aud`, `azp`, `tid` e `scp` conferidos. Enquanto
 * isso nao acontecer, o estado volta para "nao verificado", mesmo que o probe
 * de alcancabilidade tenha passado.
 */
function applyEntraChecks(status: IntegrationStatus, tenantReachable: boolean | null): IntegrationStatus {
  const loginAt = getLastSuccessfulAuthAt();

  const checks: IntegrationCheck[] = [
    {
      label: "Configuração disponível",
      state: status.configured ? "ok" : "failed",
      detail: status.configured
        ? "Tenant e os dois client ids (API e SPA) presentes."
        : `Faltam: ${status.missing.join(", ")}.`,
    },
    {
      label: "Tenant alcançável",
      state: tenantReachable === null ? "pending" : tenantReachable ? "ok" : "failed",
      detail:
        tenantReachable === null
          ? "Use Testar conexão para verificar o tenant e o JWKS."
          : tenantReachable
            ? "Documento de descoberta e JWKS publicados."
            : "O tenant não respondeu como esperado.",
    },
    {
      label: "Login real validado",
      state: loginAt ? "ok" : "pending",
      detail: loginAt
        ? `Um access token do PGCP Web foi aceito em ${loginAt}.`
        : "Nenhum access token aceito ainda. Requer login pelo PGCP Web (Etapa 2.5).",
    },
  ];

  if (loginAt) {
    return { ...status, checks, state: "connected", connected: true, message: "Login corporativo validado." };
  }

  // Alcancabilidade sozinha NAO e conexao: volta para "nao verificado".
  return {
    ...status,
    checks,
    state: status.configured ? "configured" : "not_configured",
    connected: null,
    message: status.configured
      ? "Configurado. Nenhum login corporativo validado ainda."
      : status.message,
  };
}

/** Status de todas as integracoes, sem executar verificacao. */
export function listIntegrationStatus(): IntegrationStatus[] {
  return INTEGRATIONS.map(build);
}

/** Status de uma integracao, sem executar verificacao. */
export function getIntegrationStatus(id: string): IntegrationStatus | undefined {
  const spec = findIntegration(id);
  return spec ? build(spec) : undefined;
}

/**
 * Executa a verificacao real e devolve o status atualizado.
 *
 * `undefined` quando a integracao nao existe. Quando existe mas nao ha
 * verificacao possivel, devolve o status intocado — sem marcar como conectada.
 */
export async function testIntegration(id: string): Promise<IntegrationStatus | undefined> {
  const spec = findIntegration(id);
  if (!spec) return undefined;

  const probe = PROBES[spec.id];
  const current = build(spec);

  // Sem configuracao completa nao ha o que testar, e sem probe nao ha como.
  if (!probe || !current.configured) return current;

  try {
    lastProbe.set(spec.id, { at: new Date().toISOString(), result: await probe() });
  } catch (error) {
    console.error(`[integrations] falha inesperada ao testar ${spec.id}:`, error);
    lastProbe.set(spec.id, {
      at: new Date().toISOString(),
      result: { connected: false, message: "Falha inesperada ao executar a verificacao." },
    });
  }

  return build(spec);
}
