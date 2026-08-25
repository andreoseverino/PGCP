import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { prepararIntegracao } from "../calendar/service.js";
import { findMeeting, type MeetingDetail } from "./service.js";

/**
 * Criacao de reuniao — reuniao, participantes e pautas em UMA transacao.
 *
 * As tres coisas nascem do mesmo ato na tela: agendar. Grava-las em chamadas
 * separadas permitiria uma reuniao existir sem pauta e sem quem a assiste,
 * estado que nenhuma parte do produto sabe interpretar. Ou tudo entra, ou nada
 * entra.
 *
 * NENHUMA chamada ao Microsoft Graph acontece aqui. O cliente ja escolheu as
 * pessoas no diretorio antes de enviar; o que chega e o `oid` e o snapshot do
 * nome, e isso basta para gravar.
 */

/** Status de toda reuniao recem-agendada. O cliente nao escolhe. */
const INITIAL_STATUS = "scheduled";

/**
 * Estado inicial de toda pauta. E o DEFAULT da coluna, repetido aqui so para
 * deixar explicito que "presenting" nunca e estado inicial: apresentar e um
 * fato da sessao ao vivo, nao um atributo do agendamento.
 */
const INITIAL_EXECUTION_STATUS = "pending";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MAX_PARTICIPANTS = 200;
const MAX_AGENDA_ITEMS = 100;

// -----------------------------------------------------------------------------
// Contrato de entrada
// -----------------------------------------------------------------------------

/**
 * Participante enviado pelo cliente.
 *
 * `entraTenantId` NAO existe aqui de proposito: o tenant e decidido pelo
 * servidor, a partir do token ja validado. Aceitar tenant do request deixaria
 * o cliente afirmar identidades de outra organizacao.
 */
export interface ParticipantInput {
  /** `users.id` de quem ja tem conta no PGCP. */
  userId?: string;
  /** `oid` no Entra. O tenant e acrescentado pelo servidor. */
  entraObjectId?: string;
  /** Snapshot do nome. Obrigatorio para quem nao tem `userId`. */
  displayName?: string;
  email?: string;
  /** Quando ausente, e derivado — ver `derivarTipo`. */
  participantType?: "internal" | "external";
  roleInMeeting?: string;
  isConfirmed?: boolean;
}

export interface AgendaItemInput {
  title: string;
  /**
   * Pauta da Biblioteca que originou este item. Preserva a IDENTIDADE da pauta
   * ao importa-la: sem isso, duas pautas homonimas ficariam indistinguiveis e o
   * vinculo teria de ser adivinhado pelo titulo.
   *
   * NULL = item criado direto na reuniao, sem origem na biblioteca.
   */
  agendaTopicId?: string;
  durationMinutes?: number;
  /** Hora local do dia, HH:mm. */
  scheduledStartTime?: string;
  /** Pessoa, area, orgao ou coletivo. */
  responsibleLabel?: string;
  /** Preenchido apenas quando o responsavel e pessoa do diretorio. */
  responsibleEntraObjectId?: string;
}

/**
 * Organizador da reuniao — pessoa em cuja caixa o evento do Outlook nascera.
 *
 * NAO e quem cadastrou. A assessora cadastra; o Presidente organiza.
 *
 * Identidade primaria: `entraObjectId` (o tenant vem do token, nunca do corpo).
 * `userId` so aparece quando a pessoa tambem tem conta no PGCP — e organizar
 * NAO exige conta aqui.
 *
 * `displayName` e `email` sao snapshot: exibicao e endereco de entrega. Nunca
 * servem para reconciliar quem e a pessoa.
 */
export interface OrganizerInput {
  entraObjectId?: string;
  displayName?: string;
  email?: string;
}

export interface CreateMeetingInput {
  governanceBodyId: string;
  /** Ausente = o proprio ator organiza. Ver `parseCreateInput`. */
  organizer?: OrganizerInput;
  title: string;
  description?: string;
  /** Instante ISO-8601 com fuso. */
  startAt: string;
  endAt: string;
  /** Identificador IANA. Abreviacoes como EST e BRT sao recusadas. */
  timezone: string;
  location?: string;
  meetingLink?: string;
  recurrence?: string;
  pendingRequirements?: string;
  participants: ParticipantInput[];
  agendaItems: AgendaItemInput[];
}

/** Quem executa a criacao. Vem do token, nunca do corpo da requisicao. */
export interface MeetingActor {
  userId: string;
  name: string;
  /** Tenant validado na verificacao do token. */
  entraTenantId: string;
}

// -----------------------------------------------------------------------------
// Leitura e validacao do corpo
// -----------------------------------------------------------------------------

function objeto(valor: unknown, onde: string): Record<string, unknown> {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new HttpError(400, `${onde} deve ser um objeto.`);
  }
  return valor as Record<string, unknown>;
}

function textoObrigatorio(valor: unknown, campo: string, max = 500): string {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new HttpError(400, `O campo '${campo}' é obrigatório.`);
  }
  const limpo = valor.trim();
  if (limpo.length > max) {
    throw new HttpError(400, `O campo '${campo}' deve ter no máximo ${max} caracteres.`);
  }
  return limpo;
}

/** Texto ausente e texto em branco viram `undefined` — nao string vazia. */
function textoOpcional(valor: unknown, campo: string, max = 2000): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== "string") {
    throw new HttpError(400, `O campo '${campo}' deve ser um texto.`);
  }
  const limpo = valor.trim();
  if (limpo.length === 0) return undefined;
  if (limpo.length > max) {
    throw new HttpError(400, `O campo '${campo}' deve ter no máximo ${max} caracteres.`);
  }
  return limpo;
}

function uuidOpcional(valor: unknown, campo: string): string | undefined {
  const texto = textoOpcional(valor, campo, 36);
  if (texto === undefined) return undefined;
  if (!UUID_PATTERN.test(texto)) {
    throw new HttpError(400, `O campo '${campo}' deve ser um UUID.`);
  }
  return texto.toLowerCase();
}

/**
 * URL de reuniao — SOMENTE `http`/`https`.
 *
 * O link e renderizado como `href` de um `<a>` clicavel na tela. Sem esta
 * checagem, `javascript:...` ou `data:...` gravados aqui viram XSS armazenado:
 * qualquer pessoa que abrir a reuniao e clicar em "Ingressar" executa o script.
 * Barrar o esquema na entrada e a barreira do servidor; a tela ainda revalida
 * antes de renderizar, mas a autoridade e aqui.
 */
export function urlHttpOpcional(valor: unknown, campo: string, max = 2000): string | undefined {
  const texto = textoOpcional(valor, campo, max);
  if (texto === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(texto);
  } catch {
    throw new HttpError(400, `O campo '${campo}' deve ser uma URL http(s) válida.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `O campo '${campo}' deve usar o esquema http ou https.`);
  }
  return texto;
}

function instante(valor: unknown, campo: string): Date {
  const texto = textoObrigatorio(valor, campo, 40);
  const data = new Date(texto);
  if (Number.isNaN(data.getTime())) {
    throw new HttpError(400, `O campo '${campo}' deve ser uma data/hora ISO-8601 válida.`);
  }
  return data;
}

/**
 * Aceita apenas identificador IANA de area (`America/Sao_Paulo`) ou `UTC`.
 *
 * O ICU reconhece abreviacoes legadas como `EST`, entao validar so pelo `Intl`
 * deixaria passar exatamente o formato que o schema proibe — e `BRT`, que os
 * dados antigos usam, nao identifica fuso nenhum sem ambiguidade.
 */
function fusoHorario(valor: unknown): string {
  const texto = textoObrigatorio(valor, "timezone", 64);

  if (texto !== "UTC" && !texto.includes("/")) {
    throw new HttpError(
      400,
      "O campo 'timezone' deve ser um identificador IANA como America/Sao_Paulo, não uma abreviação.",
    );
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: texto });
  } catch {
    throw new HttpError(400, `Fuso horário desconhecido: '${texto}'.`);
  }

  return texto;
}

/**
 * Valida um participante do corpo da requisicao.
 *
 * `onde` e so o prefixo das mensagens de erro — na criacao e
 * `participants[0]`, ao adicionar um avulso e `participant`. Exportada para o
 * PATCH usar exatamente as mesmas regras: duas copias divergiriam na primeira
 * correcao.
 */
export function parseParticipantInput(bruto: unknown, onde = "participant"): ParticipantInput {
  const dados = objeto(bruto, onde);

  const userId = uuidOpcional(dados.userId, `${onde}.userId`);
  const entraObjectId = uuidOpcional(dados.entraObjectId, `${onde}.entraObjectId`);
  const displayName = textoOpcional(dados.displayName, `${onde}.displayName`, 200);
  const email = textoOpcional(dados.email, `${onde}.email`, 320);

  if (!userId && !entraObjectId && !displayName) {
    throw new HttpError(
      400,
      `${onde} precisa de ao menos 'userId', 'entraObjectId' ou 'displayName'.`,
    );
  }

  // A migration 003 exige nome junto da identidade Microsoft, e o CHECK de 001
  // exige nome para quem nao tem conta. Recusar aqui devolve 400 com texto
  // util, em vez de deixar o banco responder com uma violacao crua.
  if (!userId && !displayName) {
    throw new HttpError(400, `${onde} precisa de 'displayName' quando não há 'userId'.`);
  }

  if (dados.entraTenantId !== undefined) {
    throw new HttpError(
      400,
      `${onde} não pode informar 'entraTenantId': o tenant é definido pela autenticação.`,
    );
  }

  let participantType: ParticipantInput["participantType"];
  if (dados.participantType !== undefined) {
    if (dados.participantType !== "internal" && dados.participantType !== "external") {
      throw new HttpError(400, `${onde}.participantType deve ser 'internal' ou 'external'.`);
    }
    participantType = dados.participantType;
  }

  let isConfirmed: boolean | undefined;
  if (dados.isConfirmed !== undefined) {
    if (typeof dados.isConfirmed !== "boolean") {
      throw new HttpError(400, `${onde}.isConfirmed deve ser booleano.`);
    }
    isConfirmed = dados.isConfirmed;
  }

  return {
    userId,
    entraObjectId,
    displayName,
    email,
    participantType,
    roleInMeeting: textoOpcional(dados.roleInMeeting, `${onde}.roleInMeeting`, 200),
    isConfirmed,
  };
}

/** Valida uma pauta. Mesmo contrato na criacao e na edicao. */
export function parseAgendaItemInput(bruto: unknown, onde = "agendaItem"): AgendaItemInput {
  const dados = objeto(bruto, onde);

  let durationMinutes: number | undefined;
  if (dados.durationMinutes !== undefined && dados.durationMinutes !== null) {
    const valor = dados.durationMinutes;
    if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0 || valor > 24 * 60) {
      throw new HttpError(400, `${onde}.durationMinutes deve ser um inteiro de minutos entre 0 e 1440.`);
    }
    durationMinutes = valor;
  }

  const scheduledStartTime = textoOpcional(dados.scheduledStartTime, `${onde}.scheduledStartTime`, 5);
  if (scheduledStartTime !== undefined && !TIME_PATTERN.test(scheduledStartTime)) {
    throw new HttpError(400, `${onde}.scheduledStartTime deve estar no formato HH:mm.`);
  }

  const responsibleLabel = textoOpcional(dados.responsibleLabel, `${onde}.responsibleLabel`, 200);
  const responsibleEntraObjectId = uuidOpcional(
    dados.responsibleEntraObjectId,
    `${onde}.responsibleEntraObjectId`,
  );

  if (responsibleEntraObjectId && !responsibleLabel) {
    throw new HttpError(
      400,
      `${onde} precisa de 'responsibleLabel' quando informa 'responsibleEntraObjectId': o nome é o que a tela exibe sem consultar o diretório.`,
    );
  }

  if (dados.responsibleEntraTenantId !== undefined) {
    throw new HttpError(
      400,
      `${onde} não pode informar 'responsibleEntraTenantId': o tenant é definido pela autenticação.`,
    );
  }

  return {
    title: textoObrigatorio(dados.title, `${onde}.title`, 300),
    agendaTopicId: uuidOpcional(dados.agendaTopicId, `${onde}.agendaTopicId`),
    durationMinutes,
    scheduledStartTime,
    responsibleLabel,
    responsibleEntraObjectId,
  };
}

/**
 * Le e valida o corpo inteiro.
 *
 * Campos que o banco gera (`id`, `createdAt`), que sao derivados
 * (`participantsCount`), que pertencem a etapas seguintes (notas, ata,
 * assinaturas) ou que descrevem a sessao ao vivo (`status`, `executionStatus`)
 * simplesmente nao existem no contrato: sao ignorados sem virar dado.
 */
/**
 * Le o organizador informado.
 *
 * Ausente e legitimo e significa "eu mesmo": quem cadastra costuma ser o
 * organizador, e obrigar a repetir a propria identidade seria cerimonia inutil.
 * A tela, essa sim, mostra o campo preenchido e explicito.
 *
 * `entraTenantId` NAO e aceito: o tenant vem do token validado. Aceitar do
 * corpo permitiria apontar uma identidade de outro tenant.
 */
export function parseOrganizerInput(valor: unknown): OrganizerInput | undefined {
  if (valor === undefined || valor === null) return undefined;
  const dados = objeto(valor, "O campo 'organizer'");

  for (const proibido of ["entraTenantId", "userId"]) {
    if (dados[proibido] !== undefined) {
      throw new HttpError(
        400,
        `O campo 'organizer.${proibido}' não pode ser informado: a identidade é resolvida pelo servidor.`,
      );
    }
  }

  const entraObjectId = uuidOpcional(dados.entraObjectId, "organizer.entraObjectId");
  const displayName = textoOpcional(dados.displayName, "organizer.displayName", 300);
  const email = textoOpcional(dados.email, "organizer.email", 320);

  if (entraObjectId && !displayName) {
    // Identidade sem rotulo deixaria a reuniao sem como dizer quem organiza
    // para quem nao tem acesso ao diretorio.
    throw new HttpError(400, "Informe 'organizer.displayName' junto com 'organizer.entraObjectId'.");
  }

  if (!entraObjectId && (displayName || email)) {
    // Nome solto nao identifica ninguem, e o calendario precisa da caixa.
    throw new HttpError(
      400,
      "O organizador precisa ser escolhido no diretório corporativo: informe 'organizer.entraObjectId'.",
    );
  }

  return entraObjectId ? { entraObjectId, displayName, email } : undefined;
}

/**
 * Reuniao online de TODA reuniao do PGCP.
 *
 * Nao e configuracao nem preferencia: por decisao de produto, reuniao do PGCP e,
 * por definicao, um evento do Outlook com reuniao do Teams. O valor nao vem do
 * corpo da requisicao — um cliente antigo, um script ou uma chamada direta a API
 * criam reuniao com Teams do mesmo jeito, porque quem decide e o dominio.
 */
export const PROVIDER_REUNIAO_ONLINE = "teamsForBusiness" as const;

export function parseCreateInput(body: unknown): CreateMeetingInput {
  const dados = objeto(body, "O corpo da requisição");

  const startAt = instante(dados.startAt, "startAt");
  const endAt = instante(dados.endAt, "endAt");

  if (endAt.getTime() <= startAt.getTime()) {
    throw new HttpError(400, "'endAt' deve ser posterior a 'startAt'.");
  }

  const governanceBodyId = uuidOpcional(dados.governanceBodyId, "governanceBodyId");
  if (!governanceBodyId) {
    throw new HttpError(400, "O campo 'governanceBodyId' é obrigatório e deve ser um UUID.");
  }

  const lerLista = (valor: unknown, campo: string, max: number): unknown[] => {
    if (valor === undefined || valor === null) return [];
    if (!Array.isArray(valor)) {
      throw new HttpError(400, `O campo '${campo}' deve ser uma lista.`);
    }
    if (valor.length > max) {
      throw new HttpError(400, `O campo '${campo}' aceita no máximo ${max} itens.`);
    }
    return valor;
  };

  return {
    governanceBodyId,
    organizer: parseOrganizerInput(dados.organizer),
    title: textoObrigatorio(dados.title, "title", 300),
    description: textoOpcional(dados.description, "description", 5000),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone: fusoHorario(dados.timezone),
    location: textoOpcional(dados.location, "location", 300),
    meetingLink: urlHttpOpcional(dados.meetingLink, "meetingLink", 2000),
    recurrence: textoOpcional(dados.recurrence, "recurrence", 100),
    pendingRequirements: textoOpcional(dados.pendingRequirements, "pendingRequirements", 2000),
    participants: lerLista(dados.participants, "participants", MAX_PARTICIPANTS).map((p, i) =>
      parseParticipantInput(p, `participants[${i}]`),
    ),
    agendaItems: lerLista(dados.agendaItems, "agendaItems", MAX_AGENDA_ITEMS).map((a, i) =>
      parseAgendaItemInput(a, `agendaItems[${i}]`),
    ),
  };
}

// -----------------------------------------------------------------------------
// Organizador
// -----------------------------------------------------------------------------

interface OrganizadorResolvido {
  /** Preenchido SO quando o organizador tambem tem conta no PGCP. */
  userId: string | null;
  entraObjectId: string | null;
  displayName: string | null;
  email: string | null;
}

/**
 * Resolve quem organiza.
 *
 * Sem organizador informado, e o proprio ator — ele ja tem conta, identidade
 * Entra e nome, e nada precisa ser adivinhado.
 *
 * Com organizador informado, a identidade que vale e o par (tenant, oid). O
 * `users.id` e procurado por essa MESMA identidade, e so para enriquecer o
 * vinculo quando a pessoa tambem usa o PGCP. Nunca por nome, e-mail ou UPN — e
 * a ausencia de conta NAO impede organizar.
 *
 * Nenhum usuario e criado aqui: provisionar e ato de login.
 */
async function resolverOrganizador(
  client: PoolClient,
  informado: OrganizerInput | undefined,
  actor: MeetingActor,
): Promise<OrganizadorResolvido> {
  if (!informado?.entraObjectId) {
    const { rows } = await client.query<{ name: string; email: string; entra_object_id: string | null }>(
      "SELECT name, email, entra_object_id FROM users WHERE id = $1",
      [actor.userId],
    );
    const eu = rows[0];
    return {
      userId: actor.userId,
      entraObjectId: eu?.entra_object_id ?? null,
      displayName: eu?.name ?? actor.name,
      email: eu?.email ?? null,
    };
  }

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users
      WHERE entra_tenant_id = $1 AND entra_object_id = $2`,
    [actor.entraTenantId, informado.entraObjectId],
  );

  return {
    userId: rows[0]?.id ?? null,
    entraObjectId: informado.entraObjectId,
    displayName: informado.displayName ?? null,
    email: informado.email ?? null,
  };
}

// -----------------------------------------------------------------------------
// Preparo dos participantes
// -----------------------------------------------------------------------------

export interface ParticipanteResolvido {
  userId: string | null;
  entraObjectId: string | null;
  displayName: string | null;
  email: string | null;
  participantType: "internal" | "external";
  roleInMeeting: string | null;
  isConfirmed: boolean;
}

/**
 * Deriva `participant_type` quando o cliente nao informa.
 *
 * Regra: quem tem conta no PGCP ou identidade no diretorio corporativo e
 * `internal`; quem nao tem nenhuma das duas esta fora da organizacao.
 *
 * LIMITE CONHECIDO: um convidado (Guest) do Entra tem `oid` e seria
 * classificado como `internal`. O diretorio sabe distinguir — `userType` do
 * Graph — mas o cliente precisa enviar `participantType` explicitamente para
 * corrigir. Adivinhar a partir do dominio do e-mail seria pior.
 */
function derivarTipo(p: ParticipantInput): "internal" | "external" {
  if (p.participantType) return p.participantType;
  return p.userId || p.entraObjectId ? "internal" : "external";
}

/**
 * Recusa a mesma pessoa duas vezes na mesma reuniao.
 *
 * Tres chaves, na ordem de confiabilidade: `users.id`, o `oid` do Entra e —
 * so para quem nao tem identidade nenhuma — o e-mail, que e a chave usada pelo
 * indice parcial de convidados desde 001.
 *
 * NOME NAO E CHAVE. Dois homonimos do diretorio sao duas pessoas, e uni-los
 * apagaria uma delas da lista de presenca.
 */
function recusarDuplicados(participantes: ParticipanteResolvido[]): void {
  const vistos = { userId: new Set<string>(), oid: new Set<string>(), email: new Set<string>() };

  for (const p of participantes) {
    if (p.userId) {
      if (vistos.userId.has(p.userId)) {
        throw new HttpError(409, "A mesma pessoa do PGCP foi informada mais de uma vez.");
      }
      vistos.userId.add(p.userId);
    }

    if (p.entraObjectId) {
      if (vistos.oid.has(p.entraObjectId)) {
        throw new HttpError(409, "A mesma pessoa do diretório foi informada mais de uma vez.");
      }
      vistos.oid.add(p.entraObjectId);
    }

    if (!p.userId && !p.entraObjectId && p.email) {
      const chave = p.email.toLowerCase();
      if (vistos.email.has(chave)) {
        throw new HttpError(409, "O mesmo convidado externo foi informado mais de uma vez.");
      }
      vistos.email.add(chave);
    }
  }
}

/**
 * Liga o participante a `users` quando a pessoa JA existe — nunca provisiona.
 *
 * A busca e exclusivamente pelo par (tenant validado, oid). Procurar por
 * e-mail, nome ou UPN encontraria homonimos e enderecos reciclados, e a
 * migration 002 ja tirou desses campos qualquer papel de identidade.
 */
async function vincularUsuariosExistentes(
  client: PoolClient,
  participantes: ParticipanteResolvido[],
  tenantId: string,
): Promise<void> {
  const oids = participantes
    .filter((p) => p.entraObjectId && !p.userId)
    .map((p) => p.entraObjectId as string);

  if (oids.length === 0) return;

  const { rows } = await client.query<{ id: string; entra_object_id: string }>(
    `SELECT id, entra_object_id
       FROM users
      WHERE entra_tenant_id = $1
        AND entra_object_id = ANY($2::uuid[])`,
    [tenantId, oids],
  );

  const porOid = new Map(rows.map((row) => [row.entra_object_id, row.id]));

  for (const p of participantes) {
    if (p.userId || !p.entraObjectId) continue;
    p.userId = porOid.get(p.entraObjectId) ?? null;
  }
}

/**
 * Normaliza, valida contra `users` e deduplica um lote de participantes.
 *
 * Usada tanto pela criacao da reuniao quanto pela inclusao avulsa. NAO grava
 * nada: devolve as linhas prontas para o INSERT de quem chamou.
 */
export async function prepararParticipantes(
  client: PoolClient,
  entrada: ParticipantInput[],
  tenantId: string,
): Promise<ParticipanteResolvido[]> {
  const participantes: ParticipanteResolvido[] = entrada.map((p) => ({
    userId: p.userId ?? null,
    entraObjectId: p.entraObjectId ?? null,
    displayName: p.displayName ?? null,
    email: p.email ?? null,
    participantType: derivarTipo(p),
    roleInMeeting: p.roleInMeeting ?? null,
    isConfirmed: p.isConfirmed ?? false,
  }));

  // `userId` explicito precisa existir de verdade.
  const idsInformados = participantes.map((p) => p.userId).filter((id): id is string => id !== null);
  if (idsInformados.length > 0) {
    const { rows: encontrados } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE id = ANY($1::uuid[])",
      [idsInformados],
    );
    if (encontrados.length !== new Set(idsInformados).size) {
      throw new HttpError(400, "Um dos participantes informa um usuário do PGCP que não existe.");
    }
  }

  await vincularUsuariosExistentes(client, participantes, tenantId);

  // Depois do vinculo: alguem enviado por `userId` e alguem enviado por `oid`
  // podem ter virado a MESMA linha de users, e so agora isso e visivel.
  recusarDuplicados(participantes);

  return participantes;
}


// -----------------------------------------------------------------------------
// Criacao
// -----------------------------------------------------------------------------

export async function createMeeting(
  input: CreateMeetingInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  const client = await pool.connect();
  let meetingId: string;

  try {
    await client.query("BEGIN");

    // Toda pauta da Biblioteca informada precisa existir. A FK sozinha
    // devolveria 23503, e o cliente receberia 500 no lugar de uma resposta que
    // explica o problema.
    const topicosInformados = input.agendaItems
      .map((item) => item.agendaTopicId)
      .filter((id): id is string => Boolean(id));

    if (topicosInformados.length > 0) {
      const { rows: achados } = await client.query<{ id: string }>(
        "SELECT id FROM agenda_topics WHERE id = ANY($1::uuid[])",
        [topicosInformados],
      );
      if (achados.length !== new Set(topicosInformados).size) {
        throw new HttpError(404, "Uma das pautas informadas não existe na biblioteca.");
      }
    }

    // O orgao precisa existir. FK sozinha devolveria 23503, e o cliente
    // receberia 500 no lugar de uma resposta que explica o problema.
    const { rows: orgao } = await client.query<{ id: string }>(
      "SELECT id FROM governance_bodies WHERE id = $1",
      [input.governanceBodyId],
    );
    if (orgao.length === 0) {
      throw new HttpError(404, "Órgão de governança não encontrado.");
    }

    const participantes = await prepararParticipantes(client, input.participants, actor.entraTenantId);

    const organizador = await resolverOrganizador(client, input.organizer, actor);

    const { rows: criada } = await client.query<{ id: string }>(
      /*
       * TRES CONCEITOS DISTINTOS nesta linha:
       *
       *   created_by_user_id  quem executou o cadastro (ator do token)
       *   organizer_*         de quem e o calendario onde o evento nascera
       *   participantes       tratados a parte
       *
       * Sem organizador informado, o ator organiza — o caso comum. Com
       * organizador informado, a assessora cadastra e o Presidente organiza,
       * e as duas identidades ficam gravadas separadamente.
       *
       * `organizer_user_id` so e preenchido se a pessoa TAMBEM tiver conta no
       * PGCP; organizar nao exige conta. A identidade que vale para o
       * calendario e o par (tenant, oid).
       */
      `INSERT INTO meetings
              (governance_body_id, created_by_user_id,
               organizer_user_id, organizer_entra_tenant_id, organizer_entra_object_id,
               organizer_name, organizer_email,
               title, description,
               start_at, end_at, timezone, location, meeting_link,
               online_meeting_provider,
               status, recurrence, pending_requirements)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id`,
      [
        input.governanceBodyId,
        actor.userId,
        organizador.userId,
        organizador.entraObjectId ? actor.entraTenantId : null,
        organizador.entraObjectId,
        organizador.displayName,
        organizador.email,
        input.title,
        input.description ?? null,
        input.startAt,
        input.endAt,
        input.timezone,
        input.location ?? null,
        input.meetingLink ?? null,
        // Regra de dominio, nao entrada: o corpo nao tem como pedir reuniao sem
        // Teams porque essa reuniao nao existe no PGCP.
        PROVIDER_REUNIAO_ONLINE,
        INITIAL_STATUS,
        input.recurrence ?? null,
        input.pendingRequirements ?? null,
      ],
    );

    meetingId = criada[0]!.id;

    for (const p of participantes) {
      await client.query(
        `INSERT INTO meeting_participants
                (meeting_id, user_id, display_name, email, participant_type,
                 role_in_meeting, is_confirmed, entra_tenant_id, entra_object_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          meetingId,
          p.userId,
          p.displayName,
          p.email,
          p.participantType,
          p.roleInMeeting,
          p.isConfirmed,
          // O par so entra completo, e o tenant e sempre o da autenticacao.
          p.entraObjectId ? actor.entraTenantId : null,
          p.entraObjectId,
        ],
      );
    }

    // `position` vem da ordem enviada, comecando em 1. O indice do array serve
    // para ordenar e nada mais: a identidade da pauta e o UUID gerado pelo banco.
    let posicao = 0;
    for (const item of input.agendaItems) {
      posicao += 1;
      await client.query(
        `INSERT INTO meeting_agenda_items
                (meeting_id, agenda_topic_id, title, position, scheduled_start_time,
                 duration_minutes, execution_status, responsible_label,
                 responsible_entra_tenant_id, responsible_entra_object_id)
              VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          meetingId,
          item.title,
          posicao,
          item.scheduledStartTime ?? null,
          item.durationMinutes ?? null,
          INITIAL_EXECUTION_STATUS,
          item.responsibleLabel ?? null,
          item.responsibleEntraObjectId ? actor.entraTenantId : null,
          item.responsibleEntraObjectId ?? null,
          item.agendaTopicId ?? null,
        ],
      );
    }

    // Na MESMA transacao: ou o ato e a trilha existem juntos, ou nenhum dos
    // dois. `entity_label` guarda o titulo, nao a lista de participantes.
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Reunião criada",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: input.title,
      status: "success",
    });

    /*
     * Vinculo de calendario em `pending`, na MESMA transacao.
     *
     * Nasce aqui para que a chave de idempotencia exista ANTES de qualquer
     * tentativa de chamada ao Graph — sem ela, um timeout na primeira tentativa
     * nao teria como ser repetido sem risco de criar dois eventos.
     *
     * NENHUMA chamada externa acontece dentro da transacao: o Graph nao
     * participa dela, e segurar uma transacao do PostgreSQL esperando rede seria
     * prender conexao por conta de um sistema que nao controlamos.
     *
     * Sem organizador resolvido, nada e criado: a reuniao continua valida, so
     * nao tem caixa de destino. E o unico caso em que uma reuniao do PGCP nasce
     * sem projecao — e ele so acontece quando o organizador escolhido nao tem
     * identidade Microsoft, o que a tela nao permite hoje.
     */
    await prepararIntegracao(client, meetingId, organizador.entraObjectId);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // A conexao pode ja ter caido; o servidor descarta a transacao sozinho.
    });
    throw traduzirErroDeBanco(error);
  } finally {
    client.release();
  }

  // Fonte unica de representacao: a resposta do POST e literalmente o que o
  // GET /meetings/:id devolve. Duas montagens divergiriam com o tempo.
  return findMeeting(meetingId);
}

/**
 * Converte violacao conhecida do banco em resposta util.
 *
 * Os indices unicos da 4.1 sao a ultima barreira contra participante repetido:
 * a checagem na aplicacao cobre o que veio no mesmo request, e o banco cobre o
 * resto. Qualquer outro erro sobe intacto para virar 500 — sem SQL, sem nome de
 * constraint e sem stack chegando ao navegador.
 */
function traduzirErroDeBanco(error: unknown): unknown {
  if (error instanceof HttpError) return error;

  const codigo = (error as { code?: string } | null)?.code;
  if (codigo === "23505") {
    return new HttpError(409, "A mesma pessoa foi informada mais de uma vez nesta reunião.");
  }

  return error;
}
