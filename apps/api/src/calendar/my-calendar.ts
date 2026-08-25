import { ConfidentialClientApplication } from "@azure/msal-node";
import { HttpError } from "../http-error.js";
import { GraphError, getGraphConfig, graphGet, missingGraphConfig } from "../graph/client.js";

/**
 * Meu Calendário — leitura do calendário do PRÓPRIO usuário.
 *
 * Fluxo On-Behalf-Of, e nao app-only:
 *
 *   navegador --access_as_user--> API PGCP --OBO--> Entra --token delegado--> Graph
 *                                                             |
 *                                            GET /me/calendarView
 *
 * Por que OBO aqui e app-only no agendamento: sao capacidades diferentes.
 *
 *   ler a PROPRIA agenda    -> a pessoa esta na sessao, e o Graph sabe quem e
 *                              ela. `/me` resolve sozinho, sem o PGCP precisar
 *                              de acesso a caixa nenhuma.
 *   agendar em caixa alheia -> nao pode depender da sessao do organizador, que
 *                              nem esta logado. App-only + Exchange RBAC.
 *
 * O navegador NUNCA recebe token do Graph. Ele manda o token da API do PGCP; a
 * troca acontece aqui e o resultado nao sai deste modulo.
 *
 * PERMISSAO: `Calendars.Read` DELEGADA no App Registration da API. Nao
 * `Calendars.ReadWrite` — quem apenas visualiza nao precisa escrever.
 *
 * NADA DISSO E PERSISTIDO. A agenda pessoal e visualizacao sob demanda; nao
 * existe tabela copiando evento pessoal para o PostgreSQL. O unico vinculo que
 * o PGCP guarda e o das proprias reunioes, em `meeting_calendar_integrations`.
 */

/** Escopo delegado pedido na troca OBO. */
const CALENDAR_READ_SCOPE = "https://graph.microsoft.com/Calendars.Read";

/** Teto de eventos por página. A agenda nao e um dump. */
export const CALENDAR_MAX_PAGE = 100;
export const CALENDAR_DEFAULT_PAGE = 50;
/** Janela maxima consultavel de uma vez. */
const MAX_RANGE_DAYS = 62;

let oboClient: ConfidentialClientApplication | null = null;
let oboClientKey = "";

function getOboClient(config: { tenantId: string; clientId: string; clientSecret: string }) {
  const chave = `${config.tenantId}:${config.clientId}`;
  if (!oboClient || oboClientKey !== chave) {
    // Mesma biblioteca e mesma credencial do cliente app-only; instancia
    // propria porque o fluxo e outro. Nao ha segunda aquisicao de segredo.
    oboClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        clientSecret: config.clientSecret,
      },
    });
    oboClientKey = chave;
  }
  return oboClient;
}

/**
 * Troca o token da API pelo token delegado do Graph.
 *
 * O token de entrada e o que o navegador enviou; o de saida nunca deixa este
 * modulo, nao e logado e nao e guardado.
 */
async function acquireOboToken(userToken: string): Promise<string> {
  const config = getGraphConfig();
  if (!config) {
    throw new HttpError(
      503,
      `Integração com o Microsoft Graph não configurada. Faltam: ${missingGraphConfig().join(", ")}.`,
    );
  }

  try {
    const resultado = await getOboClient(config).acquireTokenOnBehalfOf({
      oboAssertion: userToken,
      scopes: [CALENDAR_READ_SCOPE],
    });

    if (!resultado?.accessToken) {
      throw new GraphError("O Entra ID não devolveu token delegado.", "no_obo_token");
    }
    return resultado.accessToken;
  } catch (error) {
    if (error instanceof GraphError || error instanceof HttpError) throw error;

    const detalhe = error instanceof Error ? error.message : String(error);
    // Mensagem do MSAL pode citar o client id; nunca o segredo nem o token.
    console.error("[calendar] falha na troca On-Behalf-Of:", detalhe);

    if (/AADSTS65001|consent/i.test(detalhe)) {
      throw new GraphError(
        "A permissão delegada Calendars.Read ainda não foi concedida para esta aplicação. " +
          "Sem ela o PGCP não consegue ler o seu calendário.",
        "consent_required",
        403,
      );
    }
    if (/AADSTS500131|AADSTS50013|assertion/i.test(detalhe)) {
      throw new GraphError("A credencial da sessão não foi aceita na troca de token.", "invalid_assertion", 401);
    }
    throw new GraphError("Não foi possível obter autorização para ler o calendário.", "obo_error", 502);
  }
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

export interface MyCalendarEvent {
  id: string;
  subject: string | null;
  start: string | null;
  end: string | null;
  timezone: string | null;
  location: string | null;
  /** Nome de exibicao do organizador. Snapshot, nunca identidade. */
  organizer: string | null;
  isOnlineMeeting: boolean;
  /** Link de entrada, quando o evento e reuniao online. */
  joinUrl: string | null;
  webLink: string | null;
}

export interface MyCalendarPage {
  events: MyCalendarEvent[];
  /** Cursor opaco do proprio Graph (`@odata.nextLink`). `null` quando acabou. */
  nextLink: string | null;
}

interface GraphEvent {
  id?: string;
  subject?: string | null;
  start?: { dateTime?: string; timeZone?: string } | null;
  end?: { dateTime?: string; timeZone?: string } | null;
  location?: { displayName?: string | null } | null;
  organizer?: { emailAddress?: { name?: string | null } | null } | null;
  isOnlineMeeting?: boolean | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  webLink?: string | null;
}

/*
 * `$select` fechado: so o que a tela desenha.
 *
 * O payload do Graph traz corpo do evento, lista completa de participantes,
 * anexos e categorias — dado de agenda pessoal que a API do PGCP nao tem por
 * que atravessar. Pedir menos e a forma mais simples de nao vazar demais.
 */
const EVENT_SELECT =
  "id,subject,start,end,location,organizer,isOnlineMeeting,onlineMeeting,webLink";

function montar(evento: GraphEvent): MyCalendarEvent {
  return {
    id: evento.id ?? "",
    subject: evento.subject ?? null,
    start: evento.start?.dateTime ?? null,
    end: evento.end?.dateTime ?? null,
    timezone: evento.start?.timeZone ?? null,
    location: evento.location?.displayName ?? null,
    organizer: evento.organizer?.emailAddress?.name ?? null,
    isOnlineMeeting: evento.isOnlineMeeting === true,
    /*
     * `onlineMeeting.joinUrl` e a forma atual. `onlineMeetingUrl` e legado e
     * nao e lido aqui: quando os dois existem, o legado pode apontar para uma
     * URL antiga do mesmo evento.
     */
    joinUrl: evento.onlineMeeting?.joinUrl ?? null,
    webLink: evento.webLink ?? null,
  };
}

/** Instante ISO valido? Round-trip recusa data impossivel que `Date` aceitaria. */
function parseInstante(valor: unknown, campo: string): Date {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new HttpError(400, `O parâmetro '${campo}' é obrigatório.`);
  }
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) {
    throw new HttpError(400, `O parâmetro '${campo}' deve ser uma data ISO 8601 válida.`);
  }
  return data;
}

export interface MyCalendarQuery {
  start: string;
  end: string;
  limit: number;
  nextLink?: string;
}

export function parseMyCalendarQuery(query: Record<string, unknown>): MyCalendarQuery {
  const permitidos = new Set(["start", "end", "limit", "nextLink"]);
  for (const chave of Object.keys(query)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O parâmetro '${chave}' não é aceito por este endpoint.`);
    }
  }

  const inicio = parseInstante(query.start, "start");
  const fim = parseInstante(query.end, "end");

  if (fim.getTime() <= inicio.getTime()) {
    throw new HttpError(400, "'end' deve ser posterior a 'start'.");
  }
  const dias = (fim.getTime() - inicio.getTime()) / 86_400_000;
  if (dias > MAX_RANGE_DAYS) {
    throw new HttpError(400, `A janela consultada não pode passar de ${MAX_RANGE_DAYS} dias.`);
  }

  let limit = CALENDAR_DEFAULT_PAGE;
  if (query.limit !== undefined) {
    const bruto = Number(query.limit);
    if (!Number.isInteger(bruto) || bruto < 1) {
      throw new HttpError(400, "O parâmetro 'limit' deve ser um inteiro maior que zero.");
    }
    limit = Math.min(bruto, CALENDAR_MAX_PAGE);
  }

  let nextLink: string | undefined;
  if (query.nextLink !== undefined) {
    if (typeof query.nextLink !== "string" || !query.nextLink.startsWith("https://graph.microsoft.com/")) {
      // Continuacao so pode apontar para o proprio Graph: aceitar URL arbitraria
      // transformaria este endpoint num proxy de saida.
      throw new HttpError(400, "Continuação inválida.");
    }
    nextLink = query.nextLink;
  }

  return { start: inicio.toISOString(), end: fim.toISOString(), limit, nextLink };
}

/**
 * Agenda do proprio usuario no intervalo pedido.
 *
 * `/me/calendarView` — e nao `/me/events` — porque `calendarView` expande
 * ocorrencias de serie recorrente dentro da janela. Com `/events`, uma reuniao
 * semanal apareceria uma vez so, na data da serie.
 */
export async function listMyCalendar(
  userToken: string,
  query: MyCalendarQuery,
): Promise<MyCalendarPage> {
  const config = getGraphConfig();
  if (!config) {
    throw new HttpError(
      503,
      `Integração com o Microsoft Graph não configurada. Faltam: ${missingGraphConfig().join(", ")}.`,
    );
  }

  const oboToken = await acquireOboToken(userToken);

  const caminho =
    query.nextLink ??
    `/me/calendarView?startDateTime=${encodeURIComponent(query.start)}` +
      `&endDateTime=${encodeURIComponent(query.end)}` +
      `&$select=${EVENT_SELECT}&$orderby=start/dateTime&$top=${query.limit}`;

  /*
   * `graphGet` injetaria o token de APLICACAO. Aqui a chamada e delegada, entao
   * o token vai explicitamente no cabecalho e o cliente compartilhado cuida do
   * resto — retry de 429, traducao de erro, timeout.
   */
  const resposta = await graphGet<{ value?: GraphEvent[]; "@odata.nextLink"?: string }>(
    config,
    caminho,
    {
      // Token DELEGADO, explicito: sem ele a chamada sairia com a identidade da
      // aplicacao e `/me` resolveria para outra coisa.
      accessToken: oboToken,
      headers: {
        // Hora local do fuso pedido pelo cliente do calendario. Sem isto o
        // Graph devolve UTC e a tela precisaria reconverter.
        Prefer: 'outlook.timezone="America/Sao_Paulo"',
      },
    },
  );

  return {
    events: (resposta.value ?? []).map(montar),
    nextLink: resposta["@odata.nextLink"] ?? null,
  };
}
