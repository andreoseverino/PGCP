/**
 * Catalogo declarativo das integracoes do PGCP.
 *
 * Fonte UNICA da verdade sobre o que existe, o que cada integracao precisa e o
 * que e segredo. O painel de Configuracoes -> Integracoes e derivado daqui:
 * nenhuma integracao pode existir apenas em codigo ou no .env.
 *
 * REGRA DE SEGURANCA: variaveis marcadas `secret: true` NUNCA tem seu valor
 * lido para fora deste modulo. O frontend recebe apenas `configured: true/false`.
 */

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

/** Como a integracao pode ser verificada hoje. */
export type ProbeKind =
  /** Nao ha verificacao possivel sem credencial/token ainda inexistente. */
  | "none"
  /** Consulta real ao recurso (ex.: SELECT 1 no PostgreSQL). */
  | "live"
  /** Alcancabilidade real do provedor, sem validar credencial. */
  | "reachability"
  /** Apenas validacao do formato da configuracao, sem rede. */
  | "config";

export interface EnvVarSpec {
  /** Nome exato da variavel de ambiente. */
  name: string;
  /** Valor e segredo? Se sim, jamais sai da API. */
  secret: boolean;
  /** Obrigatoria para a integracao ser considerada configurada. */
  required: boolean;
  /** Para que serve. Aparece no painel. */
  description: string;
  /**
   * Agrupamento dentro da integracao. Usado pelo Entra para separar o que
   * pertence ao App Registration do SPA do que pertence ao da API — sao dois
   * registros distintos e confundi-los e a principal fonte de erro aqui.
   */
  group?: string;
}

export interface IntegrationSpec {
  id: IntegrationId;
  /** Nome exibido no painel. */
  name: string;
  /** Uma linha sobre o papel da integracao. */
  description: string;
  /** Agrupamento conceitual no painel. */
  category: "Identidade" | "Microsoft 365" | "Infraestrutura" | "Assinatura" | "Observabilidade";
  env: EnvVarSpec[];
  /**
   * Usa token de APLICACAO (client credentials). Torna
   * `ENTRA_API_CLIENT_SECRET` obrigatorio para esta integracao, mesmo sendo
   * opcional para quem so valida token recebido.
   */
  needsAppToken?: boolean;
  probe: ProbeKind;
  /**
   * O que ainda falta para a integracao funcionar de verdade. Texto honesto,
   * exibido quando a integracao esta configurada mas nao operante.
   */
  pending: string;
  /** Etapa do roadmap PGCP CONECTADO em que entra em operacao. */
  roadmapStage: string;
}

const GROUP_TENANT = "Tenant";
const GROUP_API = "PGCP API — confidential client";
const GROUP_SPA = "PGCP Web / SPA — public client";

/**
 * Configuracao do Entra herdada por Graph, Outlook, Teams e Mail: todas usam o
 * App Registration da API do PGCP. Repetir as variaveis por integracao criaria
 * varias fontes para o mesmo dado, entao as dependentes declaram apenas o que
 * lhes e proprio e herdam estas via `INHERITS_ENTRA`.
 */
export const ENTRA_SHARED_ENV: EnvVarSpec[] = [
  {
    name: "ENTRA_TENANT_ID",
    secret: false,
    required: true,
    group: GROUP_TENANT,
    description: "Directory (tenant) ID. Corresponde ao claim tid e define o issuer aceito.",
  },
  {
    name: "ENTRA_API_CLIENT_ID",
    secret: false,
    required: true,
    group: GROUP_API,
    description: "Application (client) ID da PGCP API. É o aud esperado no access token v2.",
  },
  {
    name: "ENTRA_API_CLIENT_SECRET",
    secret: true,
    required: false,
    group: GROUP_API,
    description:
      "Secret da PGCP API. NÃO é necessário para validar token (o JWKS é público); passa a ser exigido no On-Behalf-Of, na Etapa 5.",
  },
];

/**
 * Variaveis exclusivas do Entra — nao herdadas pelas integracoes dependentes.
 *
 * Ordem importa: o painel agrupa runs CONSECUTIVOS de `group`, entao as do
 * GROUP_API vem antes da do GROUP_SPA para nao partir o grupo em dois blocos.
 */
const ENTRA_OWN_ENV: EnvVarSpec[] = [
  {
    name: "ENTRA_API_APP_ID_URI",
    secret: false,
    required: false,
    group: GROUP_API,
    description:
      'Application ID URI (api://<api-client-id>). Serve para montar o scope no frontend e para documentação — NUNCA é aceito como aud.',
  },
  {
    name: "ENTRA_API_SCOPE_NAME",
    secret: false,
    required: false,
    group: GROUP_API,
    description: 'Nome do scope delegado exigido em scp. Padrão: access_as_user.',
  },
  {
    name: "ENTRA_SPA_CLIENT_ID",
    secret: false,
    required: true,
    group: GROUP_SPA,
    description:
      "Application (client) ID do PGCP Web. É o azp esperado: somente este cliente pode obter token para a API.",
  },
];

/** Integracoes que reutilizam o App Registration do Entra. */
export const INHERITS_ENTRA: IntegrationId[] = ["graph", "outlook", "teams-meeting", "teams-messages", "mail"];

export const INTEGRATIONS: IntegrationSpec[] = [
  {
    id: "entra",
    name: "Microsoft Entra ID",
    description:
      "Identidade corporativa e single sign-on. Dois App Registrations no mesmo tenant: o PGCP Web adquire o token, a PGCP API o valida.",
    category: "Identidade",
    env: [...ENTRA_SHARED_ENV, ...ENTRA_OWN_ENV],
    probe: "reachability",
    pending:
      "Validação de token na API: PRONTA (GET /me exige access token válido). " +
      "Falta o MSAL no browser (Etapa 2.5) e a resolução do usuário em users por tid + oid (Etapa 2.3). " +
      "Identidade Microsoft é o par tid + oid — e-mail, preferred_username e upn são atributos mutáveis.",
    roadmapStage: "Etapa 2",
  },
  {
    id: "graph",
    name: "Microsoft Graph",
    description: "Diretorio corporativo: nome, e-mail, cargo e foto dos usuarios. Consultado sob demanda.",
    category: "Microsoft 365",
    env: [
      {
        name: "GRAPH_BASE_URL",
        secret: false,
        required: false,
        description: "Base da API Graph. Padrao: https://graph.microsoft.com/v1.0",
      },
    ],
    needsAppToken: true,
    probe: "live",
    pending:
      "Busca sob demanda pronta (client credentials + User.Read.All Application), e o mock de diretorio no localStorage foi removido. " +
      "Falta persistir a escolha: responsavel de pauta e participante guardam o entra_object_id so no estado do navegador, nada e gravado no PostgreSQL. Faltam tambem as fotos.",
    roadmapStage: "Etapa 3",
  },
  {
    id: "outlook",
    name: "Outlook / Calendario",
    description: "Evento de calendario da reuniao: data, horario e convite aos participantes.",
    category: "Microsoft 365",
    env: [],
    // Usa o MESMO token de aplicacao do diretorio. Com isso `configured` passa a
    // refletir a credencial Graph, e nao o fato de esta integracao nao declarar
    // variavel propria.
    needsAppToken: true,
    /*
     * `none` de proposito: verificar a autorizacao de calendario exigiria tocar
     * a caixa de alguem, e uma sonda que so confirma o token diria "conectado"
     * sobre uma capacidade que ainda nao existe. Diretorio e calendario sao
     * capacidades diferentes e nao se provam com a mesma chamada.
     */
    probe: "none",
    pending:
      "Homologado com evento real: criacao, atualizacao e convite. A autorizacao vem do Exchange Online RBAC for Applications " +
      "('Application Calendars.ReadWrite' com Resource Scope), NAO de consentimento no App Registration do Entra. " +
      "O Resource Scope limita quais mailboxes podem ser ORGANIZADORAS; convidado nao precisa estar nele.",
    roadmapStage: "Etapa 5",
  },
  {
    id: "teams-meeting",
    name: "Teams — Reuniao online",
    description:
      "Reuniao online provisionada NO PROPRIO evento do Outlook. Nao e um segundo calendario nem uma segunda integracao.",
    category: "Microsoft 365",
    env: [],
    probe: "none",
    pending:
      "Extensao do MESMO evento de calendario, nao uma reuniao paralela: `isOnlineMeeting` + `onlineMeetingProvider` no " +
      "proprio evento fazem o Graph provisionar a reuniao e devolver `onlineMeeting.joinUrl`. Homologado com reuniao real. " +
      "Nao usa `/communications/onlineMeetings`, que criaria um recurso independente do calendario. " +
      "Irreversivel: provisionada a reuniao online, ela nao volta a ser offline nem troca de provider.",
    roadmapStage: "Etapa 5",
  },
  {
    id: "teams-messages",
    name: "Teams — Mensagens",
    description: 'Acoes "Chamar" e "Mensagem" da aba Anotacoes. Hoje ambas sao simuladas.',
    category: "Microsoft 365",
    env: [],
    probe: "none",
    pending:
      "Requer token, permissao de chat e definicao do destino (chat 1:1 ou canal). " +
      "Envio real so apos autenticacao e consentimento — nao simular.",
    roadmapStage: "Etapa 7",
  },
  {
    id: "mail",
    name: "E-mail (Graph Mail)",
    description: "E-mail operacional: lembretes e cobrancas. Distinto do convite de calendario.",
    category: "Microsoft 365",
    env: [
      {
        name: "MAIL_SENDER_ADDRESS",
        secret: false,
        required: true,
        description: "Caixa remetente institucional usada para enviar e-mail em nome do PGCP.",
      },
    ],
    probe: "none",
    pending: "Requer token e permissao Mail.Send. O convite da reuniao continua sendo do Outlook, nao daqui.",
    roadmapStage: "Etapa 7",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Banco de dados de negocio do PGCP. Fonte definitiva de reunioes, pautas, FUP, Ata e auditoria.",
    category: "Infraestrutura",
    env: [
      { name: "DB_HOST", secret: false, required: true, description: "Host do servidor PostgreSQL." },
      { name: "DB_PORT", secret: false, required: true, description: "Porta do servidor. 5434 no dev local." },
      { name: "DB_NAME", secret: false, required: true, description: "Nome do banco." },
      { name: "DB_USER", secret: false, required: true, description: "Usuario da aplicacao." },
      { name: "DB_PASSWORD", secret: true, required: true, description: "Senha do usuario da aplicacao." },
      { name: "DB_SSL", secret: false, required: false, description: 'TLS obrigatorio. "true" em ambiente gerenciado.' },
    ],
    probe: "live",
    pending: "",
    roadmapStage: "Em operacao",
  },
  {
    id: "docusign",
    name: "DocuSign eSignature",
    description: "Assinatura eletronica da Ata. Ainda nao ligado ao fluxo de aprovacao.",
    category: "Assinatura",
    env: [
      {
        name: "DOCUSIGN_CLIENT_ID",
        secret: false,
        required: true,
        description: "Integration Key da aplicacao DocuSign.",
      },
      {
        name: "DOCUSIGN_CLIENT_SECRET",
        secret: true,
        required: true,
        description: "Secret Key da aplicacao DocuSign.",
      },
      {
        name: "DOCUSIGN_ACCOUNT_ID",
        secret: false,
        required: true,
        description: "API Account ID da conta DocuSign.",
      },
      {
        name: "DOCUSIGN_OAUTH_BASE_PATH",
        secret: false,
        required: true,
        description: "Host de OAuth. account-d.docusign.com em demo, account.docusign.com em producao.",
      },
      {
        name: "DOCUSIGN_BASE_PATH",
        secret: false,
        required: false,
        description: "Base da API eSignature. Padrao: https://demo.docusign.net/restapi",
      },
      {
        name: "DOCUSIGN_REDIRECT_URI",
        secret: false,
        required: false,
        description: "Redirect URI registrada. Necessaria no Authorization Code Grant.",
      },
    ],
    probe: "reachability",
    pending:
      "Falta escolher e implementar o grant (JWT Grant para servico, sem interacao humana, e o candidato) " +
      "e o cliente eSignature. A ligacao com a Ata sera tarefa propria.",
    roadmapStage: "Etapa 7",
  },
  {
    id: "observability",
    name: "Observabilidade tecnica",
    description:
      "Telemetria de erro, latencia e dependencias externas. Distinta da auditoria funcional (audit_logs).",
    category: "Observabilidade",
    env: [
      {
        name: "APPLICATIONINSIGHTS_CONNECTION_STRING",
        secret: true,
        required: true,
        description: "Connection string do Application Insights. Contem InstrumentationKey — tratada como segredo.",
      },
    ],
    probe: "config",
    pending: "Falta o exportador OpenTelemetry na API. Sem ele nada e enviado, mesmo com a variavel preenchida.",
    roadmapStage: "Etapa 8",
  },
];

export function findIntegration(id: string): IntegrationSpec | undefined {
  return INTEGRATIONS.find((integration) => integration.id === id);
}
