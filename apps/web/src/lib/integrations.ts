/**
 * Estado das integracoes, vindo da API.
 *
 * O frontend NAO conhece segredo nenhum: para variaveis secretas recebe apenas
 * `configured: true/false`. Tambem nao decide status — quem determina
 * conectado/erro/nao verificado e a API, com verificacao real.
 */

import { ApiError, apiRequest } from "./api";

export type IntegrationId =
  | "entra"
  | "graph"
  | "outlook"
  | "teams-meeting"
  | "teams-messages"
  | "mail"
  | "postgres"
  | "docusign"
  | "observability";

export type IntegrationState = "connected" | "configured" | "not_configured" | "error";

export interface EnvVarStatus {
  name: string;
  secret: boolean;
  required: boolean;
  configured: boolean;
  description: string;
  /** Agrupamento dentro da integração — no Entra, qual App Registration. */
  group?: string;
  /** Presente somente em variavel publica. */
  value?: string;
  inheritedFrom?: IntegrationId;
}

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  description: string;
  category: string;
  environment: string;
  state: IntegrationState;
  configured: boolean;
  /** `null` = nao verificado. Nunca assumir positivo. */
  connected: boolean | null;
  testable: boolean;
  lastCheckedAt: string | null;
  message: string;
  missing: string[];
  env: EnvVarStatus[];
  pending: string;
  roadmapStage: string;
  /**
   * Etapas de verificação, quando a integração tem mais de um nível. No Entra
   * separa "configuração disponível", "tenant alcançável" e "login real
   * validado" — só o último autoriza dizer Conectado.
   */
  checks?: IntegrationCheck[];
}

/** Etapa individual de verificação — ver `checks` em IntegrationStatus. */
export interface IntegrationCheck {
  label: string;
  state: "ok" | "pending" | "failed";
  detail: string;
}

export interface IntegrationsResponse {
  environment: string;
  integrations: IntegrationStatus[];
}

/*
 * AUTENTICADAS, as três.
 *
 * O painel nasceu quando `/integrations` era anônimo e as chamadas iam sem
 * `Authorization`. Desde a 5.4i as rotas exigem `PGCP.Admin`, e a requisição sem
 * token passou a receber 401 "Credencial ausente." — que a tela mostrava ao
 * lado de "Nenhuma integração no catálogo", como se o catálogo estivesse vazio.
 *
 * `auth: true` usa o MESMO provedor de token de `/me`, `/meetings` e
 * `/audit-logs`. Nenhum token é decodificado, guardado ou obtido por outro
 * caminho aqui.
 */
export function fetchIntegrations(): Promise<IntegrationsResponse> {
  return apiRequest<IntegrationsResponse>("/integrations", { auth: true });
}

/** Estado de UMA integração, sem disparar verificação. */
export function fetchIntegrationStatus(id: IntegrationId): Promise<IntegrationStatus> {
  return apiRequest<IntegrationStatus>(`/integrations/${id}/status`, { auth: true });
}

/** Dispara a verificacao real e devolve o status atualizado. */
export function testIntegration(id: IntegrationId): Promise<IntegrationStatus> {
  return apiRequest<IntegrationStatus>(`/integrations/${id}/test`, {
    auth: true,
    method: "POST"
  });
}

/** Rotulo do estado. "Nao verificado" quando configurada mas nunca testada. */
export function stateLabel(status: IntegrationStatus, language: "en" | "pt"): string {
  const pt = language === "pt";
  switch (status.state) {
    case "connected":
      return pt ? "Conectado" : "Connected";
    case "error":
      return pt ? "Erro" : "Error";
    case "not_configured":
      return pt ? "Não configurado" : "Not configured";
    case "configured":
      return status.connected === null
        ? pt
          ? "Não verificado"
          : "Not verified"
        : pt
          ? "Configurado"
          : "Configured";
  }
}

/** Cores do selo, alinhadas ao padrao visual das telas aprovadas. */
export function stateClasses(state: IntegrationState): string {
  switch (state) {
    case "connected":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "error":
      return "bg-red-50 text-red-700 border-red-200";
    case "not_configured":
      return "bg-slate-100 text-slate-600 border-slate-200";
    case "configured":
      return "bg-amber-50 text-amber-800 border-amber-200";
  }
}

export function stateDotClasses(state: IntegrationState): string {
  switch (state) {
    case "connected":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    case "not_configured":
      return "bg-slate-400";
    case "configured":
      return "bg-amber-500";
  }
}

/**
 * Falha do painel, em texto para a pessoa.
 *
 * Cada status diz uma coisa diferente e leva a uma ação diferente: 401 é
 * sessão, 403 é autorização, 0 é rede. Nenhum deles é "catálogo vazio".
 */
export function describeIntegrationsError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";

  if (error instanceof ApiError) {
    if (error.status === 401) {
      return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired. Sign in again.";
    }
    if (error.status === 403) {
      return pt
        ? "O painel de Integrações é restrito aos administradores do PGCP."
        : "The Integrations panel is restricted to PGCP administrators.";
    }
    if (error.status === 0) {
      return pt ? "Sem conexão com o servidor." : "No connection to the server.";
    }
  }

  return pt
    ? "Não foi possível carregar as integrações."
    : "Could not load the integrations.";
}
