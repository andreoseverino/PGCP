import type { PoolClient } from "pg";
import { contarDocumentos } from "../documents/service.js";
import pool from "../database.js";
import { transacaoAmbiente } from "../transacao-ambiente.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { marcarComoDesatualizada } from "../calendar/service.js";
import { exigeResincronizacao } from "../calendar/mapper.js";
import {
  MODALIDADES,
  parseAgendaItemInput,
  parseParticipantInput,
  prepararParticipantes,
  urlHttpOpcional,
  type AgendaItemInput,
  type MeetingActor,
  type Modalidade,
  type ParticipantInput
} from "./create.js";
import { resolverLocalParaReuniao } from "../meeting-locations/service.js";
import { parseRecorrenciaDoTema, type RecorrenciaDoTema } from "./topic-recurrence.js";
import {
  aplicarListaDeParticipantes,
  exigirQueNaoParticipa,
  parseListaDeParticipantes,
  type ListaDeParticipantes,
} from "./participants-sync.js";
import { parseDescricao } from "./rich-text.js";
import { travarReuniaoParaVersao, versionarReuniaoSeMudou } from "./versions.js";
import { exigirPautaDaReuniao } from "./agendas.js";
import { montarTituloDaReuniao, parseTipoDeSessao, type TipoDeSessao } from "./title.js";
import { findMeeting, type MeetingDetail } from "./service.js";
import { reabrirValidacaoSePreReuniao } from "./agenda-validation.js";
import {
  desvincularParticipanteDoTema,
  excluirMeetingParticipant,
  findOrCreateMeetingParticipant,
  garantirResponsavelComoParticipante,
  inserirMeetingParticipant,
  snapshotTopicParticipantsIntoItem,
  vincularParticipanteNaPauta,
} from "./agenda-item-participants.js";
import { exigirProntaParaIniciar, startMeetingWhenAgendaItemCompletes } from "./meeting-start.js";

/**
 * Mutacoes direcionadas do nucleo da reuniao.
 *
 * Nenhuma operacao aqui reconstroi colecoes. Trocar participantes ou pautas por
 * "apaga tudo e insere de novo" mudaria os UUIDs a cada gravacao, e esses ids
 * vao ser referenciados por FUP (`action_items.origin_agenda_item_id`) e pelos
 * apresentadores. Um id que muda sozinho quebra o vinculo em silencio.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transicoes formais que o produto realmente executa hoje. O Stepper visual
 * (Preparacao, Em Reuniao, Registro, Ata, Finalizado) continua DERIVADO e nunca
 * chega aqui; `draft`, `needs_approval`, `approved` e `closed` existem no CHECK
 * por compatibilidade e nao voltam ao fluxo novo.
 */
const STATUS_PERMITIDOS = ["scheduled", "in_progress", "done"] as const;
type StatusPermitido = (typeof STATUS_PERMITIDOS)[number];

function assertUuid(valor: string, campo: string): string {
  if (!UUID_PATTERN.test(valor)) {
    throw new HttpError(400, `${campo} inválido.`);
  }
  return valor.toLowerCase();
}

/** Executa dentro de uma transacao e devolve o detalhe relido do banco. */
async function emTransacao<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  // Dentro da transação de quem chamou (ex.: Agenda Anual com a agenda travada):
  // mesmo cliente, sem BEGIN/COMMIT; o ROLLBACK é de quem abriu.
  const ambienteAtual = transacaoAmbiente();
  if (ambienteAtual) {
    try {
      return await fn(ambienteAtual);
    } catch (error) {
      throw traduzirErro(error);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw traduzirErro(error);
  } finally {
    client.release();
  }
}

/**
 * `emTransacao` + VERSÃO da reunião (034) no fim da MESMA transação: a foto vê
 * o que a mutação gravou, e falha em qualquer ponto desfaz as duas coisas.
 * Sem mudança real de conteúdo, nenhuma versão nasce.
 */
function emTransacaoVersionada<T>(
  meetingId: string,
  actor: MeetingActor,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return emTransacao(async (client) => {
    // Reunião travada PRIMEIRO: toda mutação versionada segue a mesma ordem
    // de locks (reunião -> filhos), e a versão final não disputa número.
    await travarReuniaoParaVersao(client, meetingId);
    const resultado = await fn(client);
    await versionarReuniaoSeMudou(client, meetingId, actor);
    return resultado;
  });
}

function traduzirErro(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") {
    return new HttpError(409, "A mesma pessoa foi informada mais de uma vez nesta reunião.");
  }
  // FK inválida: tipo/natureza informados não existem no cadastro.
  if (code === "23503") {
    return new HttpError(400, "Tipo ou natureza de pauta informado não existe no cadastro.");
  }
  return error;
}

/** Confirma que a reuniao existe antes de qualquer escrita nos filhos. */
async function exigirReuniao(client: PoolClient, meetingId: string): Promise<string> {
  const { rows } = await client.query<{ title: string }>(
    "SELECT title FROM meetings WHERE id = $1",
    [meetingId],
  );
  if (rows.length === 0) throw new HttpError(404, "Reunião não encontrada.");
  return rows[0]!.title;
}

/**
 * Idem, TRAVANDO a reuniao ate o fim da transacao.
 *
 * Exigido por todo caminho que faz find-or-create de participante: nao ha
 * exclusao mutua na aplicacao, e duas chamadas concorrentes a mesma reuniao
 * chegariam juntas ao SELECT, nao achariam ninguem e inseririam a mesma pessoa
 * duas vezes. O lock na linha da reuniao serializa isso.
 */
async function exigirReuniaoTravada(client: PoolClient, meetingId: string): Promise<string> {
  const { rows } = await client.query<{ title: string }>(
    "SELECT title FROM meetings WHERE id = $1 FOR UPDATE",
    [meetingId],
  );
  if (rows.length === 0) throw new HttpError(404, "Reunião não encontrada.");
  return rows[0]!.title;
}

// -----------------------------------------------------------------------------
// Cabecalho e status
// -----------------------------------------------------------------------------

export interface UpdateMeetingInput {
  title?: string;
  /** Tipo (030): com ele, o título é recomposto pelo servidor. */
  sessionType?: TipoDeSessao;
  description?: string | null;
  governanceBodyId?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  meetingLink?: string | null;
  recurrence?: string | null;
  pendingRequirements?: string | null;
  status?: StatusPermitido;
  /**
   * Habilita a reuniao online DENTRO do proprio evento de calendario.
   *
   * So AFIRMA. Nao existe `null` aqui: depois que o Graph provisiona a reuniao,
   * ela nao volta atras, e aceitar o desligamento faria o PGCP registrar um
   * estado que o calendario contradiz. O gatilho da 014 recusa de qualquer modo.
   */
  onlineMeetingProvider?: "teamsForBusiness";
  /**
   * Modalidade e local (025/038). A coerencia final (presencial exige local,
   * online nao tem) depende do estado atual e e conferida em `updateMeeting`.
   * O local e o id do cadastro; a copia (nome/endereco) e montada no servidor.
   */
  modality?: Modalidade;
  physicalLocationId?: string | null;
  /**
   * LISTA COMPLETA de participantes desejada (edição da reunião). Ausente =
   * participantes intocados. Aplicada na mesma transação: uma versão e uma
   * sincronização do convite para a edição inteira.
   */
  participants?: ListaDeParticipantes;
}

/**
 * Le o corpo do PATCH. Lista fechada: qualquer campo fora dela e recusado em
 * vez de ignorado — aceitar em silencio faria a tela acreditar que gravou algo
 * que o servidor jogou fora.
 *
 * FORA por decisao: `id`, `organizerUserId`, `createdAt`, contadores,
 * `participants`, `agendaItems`, notas, ata e estagios do stepper.
 */
export function parseUpdateInput(body: unknown): UpdateMeetingInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }

  const dados = body as Record<string, unknown>;
  const permitidos = new Set([
    "title", "description", "governanceBodyId", "startAt", "endAt", "timezone", "sessionType",
    "meetingLink", "recurrence", "pendingRequirements", "status",
    // Habilitar a reuniao online. O gatilho da 014 impede desligar depois que o
    // Graph provisionou — desmarcar aqui nao desfaria nada do outro lado.
    "onlineMeetingProvider",
    // Modalidade e local fisico (025). Trocar e editar a reuniao: o evento
    // existente e atualizado (PATCH), nunca recriado.
    "modality", "physicalLocationId",
    // Lista completa de participantes (edição no modal). Mesmas regras da aba
    // Participantes do Pipeline; ver participants-sync.ts.
    "participants",
  ]);

  for (const chave of Object.keys(dados)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser alterado por este endpoint.`);
    }
  }

  const saida: UpdateMeetingInput = {};

  const texto = (chave: keyof UpdateMeetingInput, max: number, obrigatorio = false) => {
    if (!(chave in dados)) return undefined;
    const valor = dados[chave];
    if (valor === null && !obrigatorio) return null;
    if (typeof valor !== "string") throw new HttpError(400, `O campo '${chave}' deve ser um texto.`);
    const limpo = valor.trim();
    if (limpo.length === 0) {
      if (obrigatorio) throw new HttpError(400, `O campo '${chave}' não pode ser vazio.`);
      return null;
    }
    if (limpo.length > max) throw new HttpError(400, `O campo '${chave}' excede ${max} caracteres.`);
    return limpo;
  };

  const titulo = texto("title", 300, true);
  if (titulo !== undefined) saida.title = titulo as string;
  if ("sessionType" in dados) saida.sessionType = parseTipoDeSessao(dados.sessionType);

  // Descrição: texto rico saneado pelo servidor (rich-text.ts), nunca gravado como veio.
  const descricao = parseDescricao(dados.description);
  if (descricao !== undefined) saida.description = descricao;

  for (const [chave, max] of [
    ["recurrence", 100], ["pendingRequirements", 2000],
  ] as const) {
    const valor = texto(chave, max);
    if (valor !== undefined) (saida as Record<string, unknown>)[chave] = valor;
  }

  /*
   * `meetingLink` passa pelo mesmo saneamento de texto, mas com a checagem de
   * esquema http(s) — o link vira `href` clicavel na tela, e um `javascript:`
   * gravado aqui seria XSS armazenado. `null` (limpar o link) continua aceito.
   */
  if ("meetingLink" in dados) {
    const bruto = texto("meetingLink", 2000);
    saida.meetingLink = bruto === null || bruto === undefined ? null : urlHttpOpcional(bruto, "meetingLink", 2000) ?? null;
  }

  if ("governanceBodyId" in dados) {
    const valor = texto("governanceBodyId", 36, true);
    saida.governanceBodyId = assertUuid(valor as string, "governanceBodyId");
  }

  for (const chave of ["startAt", "endAt"] as const) {
    if (!(chave in dados)) continue;
    const valor = texto(chave, 40, true) as string;
    if (Number.isNaN(new Date(valor).getTime())) {
      throw new HttpError(400, `O campo '${chave}' deve ser uma data/hora ISO-8601 válida.`);
    }
    saida[chave] = new Date(valor).toISOString();
  }

  if ("timezone" in dados) {
    const valor = texto("timezone", 64, true) as string;
    if (valor !== "UTC" && !valor.includes("/")) {
      throw new HttpError(400, "O campo 'timezone' deve ser um identificador IANA, não uma abreviação.");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: valor });
    } catch {
      throw new HttpError(400, `Fuso horário desconhecido: '${valor}'.`);
    }
    saida.timezone = valor;
  }

  if ("status" in dados) {
    const valor = dados.status;
    if (!STATUS_PERMITIDOS.includes(valor as StatusPermitido)) {
      throw new HttpError(
        400,
        `O campo 'status' aceita apenas: ${STATUS_PERMITIDOS.join(", ")}.`,
      );
    }
    saida.status = valor as StatusPermitido;
  }

  if ("onlineMeetingProvider" in dados) {
    const valor = dados.onlineMeetingProvider;
    if (valor !== "teamsForBusiness") {
      throw new HttpError(
        400,
        "O campo 'onlineMeetingProvider' aceita apenas 'teamsForBusiness'. A reunião online não pode ser desfeita por este endpoint.",
      );
    }
    saida.onlineMeetingProvider = valor;
  }

  if ("modality" in dados) {
    if (!(MODALIDADES as readonly unknown[]).includes(dados.modality)) {
      throw new HttpError(400, "O campo 'modality' aceita apenas 'online' ou 'in_person'.");
    }
    saida.modality = dados.modality as Modalidade;
  }

  if ("physicalLocationId" in dados) {
    const valor = texto("physicalLocationId", 36);
    if (valor && !UUID_LOCAL.test(valor)) {
      throw new HttpError(400, "O campo 'physicalLocationId' deve ser um UUID.");
    }
    // Existencia e status (ativo) sao conferidos no banco, em `updateMeeting`.
    saida.physicalLocationId = valor ? valor.toLowerCase() : null;
  }

  if ("participants" in dados) saida.participants = parseListaDeParticipantes(dados.participants);

  if (Object.keys(saida).length === 0) {
    throw new HttpError(400, "Nenhum campo alterável foi informado.");
  }

  return saida;
}

const UUID_LOCAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerencia final de modalidade/local depois do PATCH, a partir do estado
 * atual. Mesma regra do CHECK da 038, com mensagem util em vez de violacao
 * crua. Trocar para online limpa o local (o PATCH pode omiti-lo).
 */
export function resolverModalidadeDoPatch(
  atual: { modality: Modalidade; physicalLocationId: string | null },
  input: Pick<UpdateMeetingInput, "modality" | "physicalLocationId">,
): { modality: Modalidade; physicalLocationId: string | null } {
  const modality = input.modality ?? atual.modality;
  if (modality === "online") {
    if (input.physicalLocationId) {
      throw new HttpError(400, "Reunião online não tem local físico: remova 'physicalLocationId'.");
    }
    return { modality, physicalLocationId: null };
  }
  const physicalLocationId =
    input.physicalLocationId !== undefined ? input.physicalLocationId : atual.physicalLocationId;
  if (!physicalLocationId) {
    throw new HttpError(400, "Reunião presencial exige o local ('physicalLocationId').");
  }
  return { modality, physicalLocationId };
}

const COLUNA_DE: Record<Exclude<keyof UpdateMeetingInput, "participants">, string> = {
  title: "title",
  sessionType: "session_type",
  description: "description",
  governanceBodyId: "governance_body_id",
  startAt: "start_at",
  endAt: "end_at",
  timezone: "timezone",
  meetingLink: "meeting_link",
  recurrence: "recurrence",
  pendingRequirements: "pending_requirements",
  status: "status",
  onlineMeetingProvider: "online_meeting_provider",
  modality: "modality",
  // Gravado a parte, junto com a copia (`physical_location_snapshot`).
  physicalLocationId: "physical_location_id",
};

export async function updateMeeting(
  meetingId: string,
  input: UpdateMeetingInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");

  // Participantes não são coluna: aplicados à parte, na MESMA transação/versão.
  const { participants: listaDeParticipantes, ...campos } = input;
  input = campos;

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const atual = await client.query<{
      start_at: Date;
      end_at: Date;
      modality: Modalidade;
      physical_location_id: string | null;
      governance_body_id: string;
      annual_agenda_id: string | null;
      session_type: TipoDeSessao | null;
    }>(
      `SELECT start_at, end_at, modality, physical_location_id, governance_body_id, annual_agenda_id, session_type
         FROM meetings WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    if (atual.rows.length === 0) throw new HttpError(404, "Reunião não encontrada.");

    // Título padronizado (030): com tipo, o título é do servidor.
    if (input.title !== undefined && (input.sessionType ?? atual.rows[0]!.session_type)) {
      throw new HttpError(400, "O título desta reunião é gerado automaticamente pelos campos; altere hora, formato, órgão ou tipo.");
    }

    // Reunião numa Agenda Anual pertence ao órgão da agenda (028). Trocar o
    // órgão a deixaria no planejamento de outro órgão — desassocie antes.
    if (
      input.governanceBodyId !== undefined &&
      input.governanceBodyId !== atual.rows[0]!.governance_body_id &&
      atual.rows[0]!.annual_agenda_id
    ) {
      throw new HttpError(
        409,
        "Esta reunião faz parte de uma Agenda Anual do órgão atual. Desassocie-a na Agenda Anual antes de trocar o órgão colegiado.",
      );
    }

    // O CHECK do banco cobre isso, mas conferir aqui devolve 400 explicativo em
    // vez de 500 com violacao crua — inclusive quando so um dos dois muda.
    const inicio = input.startAt ? new Date(input.startAt) : atual.rows[0]!.start_at;
    const fim = input.endAt ? new Date(input.endAt) : atual.rows[0]!.end_at;
    if (fim.getTime() <= inicio.getTime()) {
      throw new HttpError(400, "O horário de término deve ser depois do horário de início.");
    }

    /*
     * Modalidade/local: normaliza o par final. O local so muda quando a
     * ESCOLHA muda — manter o mesmo id preserva a copia gravada (endereco
     * historico), mesmo que o cadastro tenha sido editado ou inativado depois.
     * Local NOVO precisa existir e estar ativo; a copia e montada aqui.
     */
    let localNovo: { id: string | null; copia: string | null } | null = null;
    if (input.modality !== undefined || input.physicalLocationId !== undefined) {
      const final = resolverModalidadeDoPatch(
        {
          modality: atual.rows[0]!.modality,
          physicalLocationId: atual.rows[0]!.physical_location_id,
        },
        input,
      );
      const { physicalLocationId: _escolhido, ...resto } = input;
      input = { ...resto, modality: final.modality };
      if (final.physicalLocationId !== atual.rows[0]!.physical_location_id) {
        const local = final.physicalLocationId
          ? await resolverLocalParaReuniao(client, final.physicalLocationId)
          : null;
        localNovo = { id: local?.id ?? null, copia: local ? JSON.stringify(local) : null };
      }
    }

    // Iniciar exige convite enviado (aprovação das pautas não é mais exigida). Sob o lock acima.
    if (input.status === "in_progress") {
      await exigirProntaParaIniciar(client, meetingId);
    }

    if (input.governanceBodyId) {
      const { rows } = await client.query("SELECT id FROM governance_bodies WHERE id = $1", [
        input.governanceBodyId,
      ]);
      if (rows.length === 0) throw new HttpError(404, "Órgão de governança não encontrado.");
    }

    const atribuicoes: string[] = [];
    const valores: unknown[] = [meetingId];
    for (const [chave, valor] of Object.entries(input)) {
      valores.push(valor);
      atribuicoes.push(`${COLUNA_DE[chave as keyof typeof COLUNA_DE]} = $${valores.length}`);
    }
    if (localNovo) {
      valores.push(localNovo.id, localNovo.copia);
      atribuicoes.push(
        `physical_location_id = $${valores.length - 1}`,
        `physical_location_snapshot = $${valores.length}::jsonb`,
      );
    }

    // Só participantes no corpo: nenhuma coluna da reunião muda.
    const temCampos = atribuicoes.length > 0;
    let { rows } = temCampos
      ? await client.query<{ title: string }>(
          `UPDATE meetings SET ${atribuicoes.join(", ")} WHERE id = $1 RETURNING title`,
          valores,
        )
      : await client.query<{ title: string }>("SELECT title FROM meetings WHERE id = $1", [meetingId]);

    /*
     * PARTICIPANTES (lista completa): mesmas peças da aba Participantes do
     * Pipeline, dentro DESTA transação. Cada inclusão/remoção tem a sua linha
     * de auditoria e marca o convite como desatualizado; a versão (034) e a
     * sincronização do Outlook acontecem UMA vez, no fim da edição. Lista
     * igual à atual = nada muda (sem trilha, sem versão, sem convite).
     */
    if (listaDeParticipantes) {
      await aplicarListaDeParticipantes(client, meetingId, listaDeParticipantes, actor, rows[0]!.title);
    }
    if (!temCampos) return;

    // Recompõe o título padronizado com os valores FINAIS (hora, fuso, órgão,
    // formato, tipo). A versão aprovada da Agenda Anual não muda: está no
    // snapshot. Título novo desatualiza o convite como qualquer outro campo.
    const camposAlterados = Object.keys(input);
    if (localNovo) camposAlterados.push("physicalLocationId");
    const recomposto = await recomporTituloPadronizado(client, meetingId);
    if (recomposto && recomposto !== rows[0]!.title) {
      ({ rows } = await client.query<{ title: string }>(
        "UPDATE meetings SET title = $2 WHERE id = $1 RETURNING title",
        [meetingId, recomposto],
      ));
      camposAlterados.push("title");
    }

    /*
     * O evento no calendario ficou desatualizado?
     *
     * So os campos que aparecem no convite contam. Mudar `status`, `recurrence`
     * ou `pendingRequirements` nao altera nada que o convidado veja, e marcar
     * `stale` por isso pediria uma resincronizacao que nao mudaria o evento.
     *
     * Na mesma transacao da alteracao: a reuniao nunca fica editada com a
     * integracao ainda afirmando `synced`.
     */
    if (exigeResincronizacao(camposAlterados)) {
      await marcarComoDesatualizada(client, meetingId);
    }

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      // Distingue a transicao formal da edicao de dados: quem lê a trilha
      // precisa saber qual das duas aconteceu sem abrir o registro.
      action: input.status ? "Status da reunião alterado" : "Reunião atualizada",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: rows[0]!.title,
      status: "success",
    });
  });

  // Dentro de uma transação ambiente, lê pelo mesmo cliente (vê o que acabou de gravar).
  return findMeeting(meetingId, transacaoAmbiente() ?? pool);
}

/** Título padronizado com os valores gravados; `null` = reunião sem tipo (legado). */
async function recomporTituloPadronizado(client: PoolClient, meetingId: string): Promise<string | null> {
  const { rows } = await client.query<{
    start_at: Date;
    timezone: string;
    modality: "online" | "in_person";
    session_type: TipoDeSessao | null;
    orgao: string;
  }>(
    `SELECT m.start_at, m.timezone, m.modality, m.session_type, gb.name AS orgao
       FROM meetings m JOIN governance_bodies gb ON gb.id = m.governance_body_id
      WHERE m.id = $1`,
    [meetingId],
  );
  const r = rows[0];
  if (!r?.session_type) return null;
  return montarTituloDaReuniao({
    startAt: r.start_at.toISOString(),
    timezone: r.timezone,
    orgao: r.orgao,
    tipo: r.session_type,
    modalidade: r.modality,
  });
}

// -----------------------------------------------------------------------------
// Participantes
// -----------------------------------------------------------------------------

export async function addParticipant(
  meetingId: string,
  input: ParticipantInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const titulo = await exigirReuniao(client, meetingId);

    // Mesma validação e mesma reconciliação do POST da reunião — importadas,
    // não recopiadas. Duas cópias divergiriam na primeira correção.
    const [preparado] = await prepararParticipantes(client, [input], actor.entraTenantId);

    // Já está na reunião? O índice parcial pegaria, mas 409 com texto é melhor
    // resposta do que uma violação traduzida. Mesma checagem da edição em lista.
    await exigirQueNaoParticipa(client, meetingId, preparado!);

    // INSERT + calendário desatualizado + auditoria: fonte única, reutilizada
    // pelo fluxo de participante-por-pauta.
    await inserirMeetingParticipant(client, meetingId, preparado!, actor, titulo);
  });

  return findMeeting(meetingId, transacaoAmbiente() ?? pool);
}

export async function removeParticipant(
  meetingId: string,
  participantId: string,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(participantId, "Identificador do participante");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const titulo = await exigirReuniao(client, meetingId);

    // DELETE + calendário desatualizado + auditoria: fonte única, reutilizada
    // pela remoção via pauta. `meeting_id` no WHERE evita apagar de outra reunião.
    const rowCount = await excluirMeetingParticipant(client, meetingId, participantId, actor, titulo);
    if (rowCount === 0) throw new HttpError(404, "Participante não encontrado nesta reunião.");
  });

  return findMeeting(meetingId, transacaoAmbiente() ?? pool);
}

// -----------------------------------------------------------------------------
// Pautas
// -----------------------------------------------------------------------------

export async function addAgendaItem(
  meetingId: string,
  input: AgendaItemInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    // Travada: a pauta pode acrescentar o responsavel a lista de participantes.
    const titulo = await exigirReuniaoTravada(client, meetingId);

    // Importar da Biblioteca preserva a IDENTIDADE da pauta: o vinculo e o
    // UUID, nunca o titulo. Nenhuma agenda_topic nova e criada aqui.
    if (input.agendaTopicId) {
      const { rows } = await client.query("SELECT id FROM agenda_topics WHERE id = $1", [
        input.agendaTopicId,
      ]);
      if (rows.length === 0) {
        throw new HttpError(404, "Pauta não encontrada na biblioteca.");
      }

      // Barreira de verdade contra o mesmo tema entrando duas vezes na mesma
      // reuniao. Esconder o botao na tela (ja feito) e cortesia; isto e o que
      // impede de fato, inclusive num clique duplo ou numa chamada direta.
      const { rows: existentes } = await client.query(
        "SELECT 1 FROM meeting_agenda_items WHERE meeting_id = $1 AND agenda_topic_id = $2",
        [meetingId, input.agendaTopicId],
      );
      if (existentes.length > 0) {
        throw new HttpError(409, "Esta pauta da Biblioteca já está vinculada a esta reunião.");
      }
    }

    // Tema dentro de pauta: a pauta precisa ser DESTA reuniao (IDOR).
    if (input.agendaId) {
      await exigirPautaDaReuniao(client, meetingId, input.agendaId);
    }

    // Entra no fim da lista. `coalesce` cobre a reunião sem pauta nenhuma.
    const { rows: pos } = await client.query<{ proxima: number }>(
      "SELECT coalesce(max(position), 0) + 1 AS proxima FROM meeting_agenda_items WHERE meeting_id = $1",
      [meetingId],
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO meeting_agenda_items
              (meeting_id, agenda_topic_id, title, position, scheduled_start_time,
               duration_minutes, execution_status, responsible_label,
               responsible_entra_tenant_id, responsible_entra_object_id,
               is_circular_theme,
               agenda_topic_type_id, agenda_topic_nature_id, description, generates_action_item,
               meeting_agenda_id, recurrence)
            VALUES ($1, $9, $2, $3, $4, $5, 'pending', $6, $7, $8,
               COALESCE($10::boolean, (SELECT is_circular_theme FROM agenda_topics WHERE id = $9), false),
               COALESCE($11::uuid,    (SELECT agenda_topic_type_id   FROM agenda_topics WHERE id = $9)),
               COALESCE($12::uuid,    (SELECT agenda_topic_nature_id FROM agenda_topics WHERE id = $9)),
               COALESCE($13::text,    (SELECT description            FROM agenda_topics WHERE id = $9)),
               COALESCE($14::boolean, (SELECT generates_action_item  FROM agenda_topics WHERE id = $9), false),
               $15,
               CASE WHEN $16::boolean THEN $17::text
                    ELSE (SELECT recurrence FROM agenda_topics WHERE id = $9) END)
         RETURNING id`,
      [
        meetingId,
        input.title,
        pos[0]!.proxima,
        input.scheduledStartTime ?? null,
        input.durationMinutes ?? null,
        input.responsibleLabel ?? null,
        input.responsibleEntraObjectId ? actor.entraTenantId : null,
        input.responsibleEntraObjectId ?? null,
        input.agendaTopicId ?? null,
        // Ausente + vínculo com a Biblioteca => herda o padrão do tema mestre
        // (snapshot). Ausente sem vínculo => false. Valor explícito manda.
        input.isCircularTheme ?? null,
        // Ficha (019): ausente + vínculo => herda do tema; explícito manda.
        input.agendaTopicTypeId ?? null,
        input.agendaTopicNatureId ?? null,
        input.description ?? null,
        input.generatesActionItem ?? null,
        input.agendaId ?? null,
        // Recorrência (039): informada manda (inclusive null); ausente herda do tema.
        input.recurrence !== undefined,
        input.recurrence ?? null,
      ],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Tema adicionado",
      entityType: "meeting_agenda_item",
      entityId: rows[0]!.id,
      entityLabel: titulo,
      status: "success",
    });

    // Vínculo com a Biblioteca: snapshot dos participantes do tema para a pauta
    // (find-or-create em meeting_participants + vínculo). Depois, independente.
    if (input.agendaTopicId) {
      await snapshotTopicParticipantsIntoItem(
        client,
        meetingId,
        rows[0]!.id,
        input.agendaTopicId,
        actor,
        titulo,
      );
    }

    // INVARIANTE: responsável pessoa participa da reunião e desta pauta. Mesma
    // transação — ou item, participante e vínculo existem, ou nenhum.
    await garantirResponsavelComoParticipante(
      client,
      meetingId,
      rows[0]!.id,
      input,
      actor,
      titulo,
    );

    // Alteracao ESTRUTURAL: reabre a validacao se ainda for planejamento.
    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

/**
 * Estados de execucao que o BANCO aceita gravar.
 *
 * `presenting` existe no CHECK desde 001, mas e EFEMERO por decisao de
 * produto: apresentar e um fato da sessao ao vivo, sem horario de inicio
 * persistido e sem como retomar o cronometro depois de um reload. Persistir
 * transformaria um estado de tela num estado compartilhado entre navegadores.
 *
 * O CHECK do banco fica como esta — a API e a barreira. Remover o valor de la
 * exigiria migration para tirar algo que nenhuma linha usa.
 */
export const EXECUTION_STATUSES = ["pending", "completed", "postponed"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface AgendaItemPatch {
  title?: string;
  /** Move o TEMA para outra PAUTA da mesma reuniao; `null` = sem pauta. */
  agendaId?: string | null;
  durationMinutes?: number | null;
  scheduledStartTime?: string | null;
  responsibleLabel?: string | null;
  responsibleEntraObjectId?: string | null;
  executionStatus?: ExecutionStatus;
  /** Tema circular NESTA reuniao. So boolean; nunca toca a Biblioteca. */
  isCircularTheme?: boolean;
  /** Recorrência NESTA reunião (039). `null` = não se repete; nunca toca a Biblioteca. */
  recurrence?: RecorrenciaDoTema | null;
  /** Ficha cadastral (019). `null` limpa; nunca toca a Biblioteca. */
  agendaTopicTypeId?: string | null;
  agendaTopicNatureId?: string | null;
  description?: string | null;
  /** "Tema de FUP" — apenas classificacao. Nao cria action_item. */
  generatesActionItem?: boolean;
}

/**
 * Le o PATCH de uma pauta. PARCIAL de proposito: marcar uma pauta como
 * concluida nao pode obrigar a reenviar titulo, duracao e responsavel — um
 * reenvio incompleto apagaria campos que ninguem pediu para mudar.
 *
 * `position` fica de fora: ordem tem endpoint proprio, transacional.
 */
export function parseAgendaItemPatch(body: unknown): AgendaItemPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;

  const permitidos = new Set([
    "title", "durationMinutes", "scheduledStartTime",
    "responsibleLabel", "responsibleEntraObjectId", "executionStatus",
    "isCircularTheme", "recurrence",
    "agendaTopicTypeId", "agendaTopicNatureId", "description", "generatesActionItem",
    "agendaId",
  ]);
  for (const chave of Object.keys(dados)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser alterado por este endpoint.`);
    }
  }

  const saida: AgendaItemPatch = {};

  if ("title" in dados) {
    if (typeof dados.title !== "string" || dados.title.trim().length === 0) {
      throw new HttpError(400, "O campo 'title' não pode ser vazio.");
    }
    if (dados.title.trim().length > 300) throw new HttpError(400, "O campo 'title' excede 300 caracteres.");
    saida.title = dados.title.trim();
  }

  if ("durationMinutes" in dados) {
    const valor = dados.durationMinutes;
    if (valor === null) saida.durationMinutes = null;
    else if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0 || valor > 24 * 60) {
      throw new HttpError(400, "'durationMinutes' deve ser um inteiro de minutos entre 0 e 1440.");
    } else saida.durationMinutes = valor;
  }

  if ("scheduledStartTime" in dados) {
    const valor = dados.scheduledStartTime;
    if (valor === null) saida.scheduledStartTime = null;
    else if (typeof valor !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(valor)) {
      throw new HttpError(400, "'scheduledStartTime' deve estar no formato HH:mm.");
    } else saida.scheduledStartTime = valor;
  }

  if ("responsibleLabel" in dados) {
    const valor = dados.responsibleLabel;
    if (valor === null || typeof valor !== "string" || valor.trim().length === 0) {
      saida.responsibleLabel = null;
    } else if (valor.trim().length > 200) {
      throw new HttpError(400, "'responsibleLabel' excede 200 caracteres.");
    } else {
      saida.responsibleLabel = valor.trim();
    }
  }

  if ("responsibleEntraObjectId" in dados) {
    const valor = dados.responsibleEntraObjectId;
    if (valor === null) saida.responsibleEntraObjectId = null;
    else {
      if (typeof valor !== "string") throw new HttpError(400, "'responsibleEntraObjectId' deve ser um UUID.");
      saida.responsibleEntraObjectId = assertUuid(valor, "responsibleEntraObjectId");
    }
  }

  if (dados.responsibleEntraTenantId !== undefined) {
    throw new HttpError(400, "'responsibleEntraTenantId' não é aceito: o tenant vem da autenticação.");
  }

  if ("executionStatus" in dados) {
    const valor = dados.executionStatus;
    if (!EXECUTION_STATUSES.includes(valor as ExecutionStatus)) {
      // A mensagem nomeia 'presenting' porque e o erro provavel: valido no
      // CHECK do banco, invalido no produto.
      throw new HttpError(
        400,
        `'executionStatus' aceita apenas: ${EXECUTION_STATUSES.join(", ")}. ` +
          "'presenting' é estado de sessão e não é persistido.",
      );
    }
    saida.executionStatus = valor as ExecutionStatus;
  }

  if ("isCircularTheme" in dados) {
    // SÓ boolean de verdade. String/número/objeto recusados — sem coerção.
    if (typeof dados.isCircularTheme !== "boolean") {
      throw new HttpError(400, "'isCircularTheme' deve ser booleano (true ou false).");
    }
    saida.isCircularTheme = dados.isCircularTheme;
  }

  if ("recurrence" in dados) saida.recurrence = parseRecorrenciaDoTema(dados.recurrence);

  // Ficha cadastral (019). `null` limpa. UUID validado por forma; a existência é
  // garantida pela FK (23503 -> 400 no traduzirErro).
  if ("agendaTopicTypeId" in dados) {
    const valor = dados.agendaTopicTypeId;
    if (valor === null) saida.agendaTopicTypeId = null;
    else {
      if (typeof valor !== "string") throw new HttpError(400, "'agendaTopicTypeId' deve ser um UUID.");
      saida.agendaTopicTypeId = assertUuid(valor, "agendaTopicTypeId");
    }
  }
  if ("agendaTopicNatureId" in dados) {
    const valor = dados.agendaTopicNatureId;
    if (valor === null) saida.agendaTopicNatureId = null;
    else {
      if (typeof valor !== "string") throw new HttpError(400, "'agendaTopicNatureId' deve ser um UUID.");
      saida.agendaTopicNatureId = assertUuid(valor, "agendaTopicNatureId");
    }
  }
  if ("description" in dados) {
    const valor = dados.description;
    if (valor === null || (typeof valor === "string" && valor.trim().length === 0)) {
      saida.description = null;
    } else if (typeof valor !== "string") {
      throw new HttpError(400, "'description' deve ser um texto.");
    } else if (valor.trim().length > 5000) {
      throw new HttpError(400, "'description' excede 5000 caracteres.");
    } else {
      saida.description = valor.trim();
    }
  }
  if ("generatesActionItem" in dados) {
    if (typeof dados.generatesActionItem !== "boolean") {
      throw new HttpError(400, "'generatesActionItem' deve ser booleano (true ou false).");
    }
    saida.generatesActionItem = dados.generatesActionItem;
  }

  if ("agendaId" in dados) {
    const valor = dados.agendaId;
    if (valor === null) saida.agendaId = null;
    else {
      if (typeof valor !== "string") throw new HttpError(400, "'agendaId' deve ser um UUID.");
      saida.agendaId = assertUuid(valor, "agendaId");
    }
  }

  // Identidade sem rotulo nao entra — mesma regra da criacao.
  if (saida.responsibleEntraObjectId && !saida.responsibleLabel) {
    throw new HttpError(400, "Informe 'responsibleLabel' junto de 'responsibleEntraObjectId'.");
  }

  if (Object.keys(saida).length === 0) {
    throw new HttpError(400, "Nenhum campo alterável foi informado.");
  }

  return saida;
}

/** Rotulo da trilha para cada transicao de estado. */
const ACAO_DE_ESTADO: Record<ExecutionStatus, string> = {
  completed: "Pauta concluída",
  postponed: "Pauta postergada",
  pending: "Pauta reaberta",
};

export async function updateAgendaItem(
  meetingId: string,
  agendaItemId: string,
  input: AgendaItemPatch,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(agendaItemId, "Identificador da pauta");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    // Travada: trocar o responsavel pode acrescenta-lo aos participantes.
    const titulo = await exigirReuniaoTravada(client, meetingId);

    // UPDATE parcial, nunca DELETE + INSERT: o `id` sobrevive a edicao.
    const atribuicoes: string[] = [];
    const valores: unknown[] = [agendaItemId, meetingId];
    const bind = (coluna: string, valor: unknown) => {
      valores.push(valor);
      atribuicoes.push(`${coluna} = $${valores.length}`);
    };

    if (input.agendaId) {
      await exigirPautaDaReuniao(client, meetingId, input.agendaId);
    }
    if (input.agendaId !== undefined) bind("meeting_agenda_id", input.agendaId);
    if (input.title !== undefined) bind("title", input.title);
    if (input.durationMinutes !== undefined) bind("duration_minutes", input.durationMinutes);
    if (input.scheduledStartTime !== undefined) bind("scheduled_start_time", input.scheduledStartTime);
    if (input.executionStatus !== undefined) bind("execution_status", input.executionStatus);
    if (input.isCircularTheme !== undefined) bind("is_circular_theme", input.isCircularTheme);
    if (input.recurrence !== undefined) bind("recurrence", input.recurrence);
    // Ficha (019). UPDATE parcial na PRÓPRIA pauta — nunca toca a Biblioteca.
    if (input.agendaTopicTypeId !== undefined) bind("agenda_topic_type_id", input.agendaTopicTypeId);
    if (input.agendaTopicNatureId !== undefined) bind("agenda_topic_nature_id", input.agendaTopicNatureId);
    if (input.description !== undefined) bind("description", input.description);
    if (input.generatesActionItem !== undefined) bind("generates_action_item", input.generatesActionItem);

    // Rotulo e identidade andam juntos: mexer num sem o outro deixaria um `oid`
    // apontando para alguem cujo nome exibido ja e outro.
    if (input.responsibleLabel !== undefined || input.responsibleEntraObjectId !== undefined) {
      bind("responsible_label", input.responsibleLabel ?? null);
      bind("responsible_entra_object_id", input.responsibleEntraObjectId ?? null);
      bind("responsible_entra_tenant_id", input.responsibleEntraObjectId ? actor.entraTenantId : null);
    }

    // `meeting_id` no WHERE nao e redundante: sem ele, o id de uma pauta de
    // outra reuniao alteraria a linha errada.
    const { rowCount } = await client.query(
      `UPDATE meeting_agenda_items SET ${atribuicoes.join(", ")} WHERE id = $1 AND meeting_id = $2`,
      valores,
    );
    if (rowCount === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: input.executionStatus ? ACAO_DE_ESTADO[input.executionStatus] : "Pauta atualizada",
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: titulo,
      status: "success",
    });

    /*
     * Concluir qualquer pauta e evidencia de que a reuniao comecou. A pauta e
     * a transicao da reuniao ficam na MESMA transacao; reabrir (`pending`) nao
     * desfaz esse fato historico, e estados posteriores sao preservados pelo
     * UPDATE condicional do helper.
     */
    if (input.executionStatus === "completed") {
      await startMeetingWhenAgendaItemCompletes(client, meetingId, titulo, actor);
    }

    /*
     * INVARIANTE: o novo responsável, se for pessoa, entra na reunião e na
     * lista de participantes desta pauta.
     *
     * O ANTERIOR permanece participante — trocar quem responde por um assunto
     * não é dizer que a pessoa saiu da reunião, e desconvidá-la por conta
     * própria apagaria uma decisão que a Assessoria pode ter tomado por outro
     * motivo. Limpar o responsável (null) também não remove ninguém.
     */
    if (input.responsibleEntraObjectId !== undefined || input.responsibleLabel !== undefined) {
      await garantirResponsavelComoParticipante(
        client,
        meetingId,
        agendaItemId,
        input,
        actor,
        titulo,
      );
    }

    // So campos ESTRUTURAIS reabrem a validacao. Mudanca de execucao
    // (executionStatus) ou de horario nao invalida o que o aprovador viu — e,
    // de todo modo, execucao acontece com a reuniao ja em andamento (o gate na
    // funcao de reabertura bloqueia).
    const alterouEstrutura =
      input.agendaId !== undefined ||
      input.title !== undefined ||
      input.durationMinutes !== undefined ||
      input.responsibleLabel !== undefined ||
      input.responsibleEntraObjectId !== undefined ||
      input.isCircularTheme !== undefined ||
      input.agendaTopicTypeId !== undefined ||
      input.agendaTopicNatureId !== undefined ||
      input.description !== undefined ||
      input.generatesActionItem !== undefined;
    if (alterouEstrutura) {
      await reabrirValidacaoSePreReuniao(client, meetingId, actor);
    }
  });

  return findMeeting(meetingId);
}

export async function removeAgendaItem(
  meetingId: string,
  agendaItemId: string,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(agendaItemId, "Identificador da pauta");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const titulo = await exigirReuniao(client, meetingId);

    // Documento de governança não some junto com o tema (sem exclusão de
    // documentos nesta versão; a FK RESTRICT é a última barreira).
    if ((await contarDocumentos(client, { agendaItemId })) > 0) {
      throw new HttpError(409, "Este tema tem documentos anexados e não pode ser removido. Os documentos da reunião são preservados.");
    }

    const { rowCount } = await client.query(
      "DELETE FROM meeting_agenda_items WHERE id = $1 AND meeting_id = $2",
      [agendaItemId, meetingId],
    );
    if (rowCount === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");

    // Fecha o buraco deixado na sequência. Sem isso, `position` viraria
    // 1,2,4,5 e a próxima inclusão herdaria a numeração torta.
    await renumerarNaMesmaTransacao(client, meetingId, null);

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pauta removida",
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: titulo,
      status: "success",
    });

    // Alteracao ESTRUTURAL: reabre a validacao se ainda for planejamento.
    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

// -----------------------------------------------------------------------------
// Participantes POR PAUTA (Opção A) — rotas direcionadas
// -----------------------------------------------------------------------------

/** Confere que a pauta pertence À reunião. Evita IDOR entre reuniões. */
async function exigirPautaNaReuniao(
  client: PoolClient,
  meetingId: string,
  agendaItemId: string,
): Promise<void> {
  const { rows } = await client.query(
    "SELECT 1 FROM meeting_agenda_items WHERE id = $1 AND meeting_id = $2",
    [agendaItemId, meetingId],
  );
  if (rows.length === 0) throw new HttpError(404, "Pauta não encontrada nesta reunião.");
}

/**
 * Vincula uma pessoa a uma pauta (Opção A).
 *
 * Se a pessoa ainda não está na reunião, é ADICIONADA a ela pelo mesmo caminho da
 * aba Participantes (identidade, calendário desatualizado, auditoria). Serializa
 * o find-or-create bloqueando a reunião (`FOR UPDATE`) — não há UNIQUE de
 * identidade em `meeting_participants`, então o lock é o que evita corrida.
 */
export async function addAgendaItemParticipant(
  meetingId: string,
  agendaItemId: string,
  input: ParticipantInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(agendaItemId, "Identificador da pauta");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    // Lock da reunião: serializa o find-or-create do participante.
    const titulo = await exigirReuniaoTravada(client, meetingId);

    await exigirPautaNaReuniao(client, meetingId, agendaItemId);

    const { id } = await findOrCreateMeetingParticipant(client, meetingId, input, actor, titulo);
    const novo = await vincularParticipanteNaPauta(client, agendaItemId, id);
    if (!novo) throw new HttpError(409, "Esta pessoa já está vinculada a esta pauta.");

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Participante vinculado à pauta",
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: titulo,
      status: "success",
    });

    // Vincular participante é alteração ESTRUTURAL da pauta (§ validação).
    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

/**
 * Remove uma pessoa de um TEMA (`meeting_agenda_items`).
 *
 * REGRA VIGENTE (substitui a Opção A da 020): remove SOMENTE o vínculo com
 * este tema. A pessoa continua em `meeting_participants` e nos demais temas;
 * o convite do calendário não muda. Sair da reunião inteira é a remoção da aba
 * Participantes (`removeParticipant`), cujo cascade apaga todos os vínculos.
 * Nenhuma das duas apaga o cadastro de participante externo.
 */
export async function removeAgendaItemParticipant(
  meetingId: string,
  agendaItemId: string,
  meetingParticipantId: string,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");
  assertUuid(agendaItemId, "Identificador da pauta");
  assertUuid(meetingParticipantId, "Identificador do participante");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const titulo = await exigirReuniao(client, meetingId);
    await exigirPautaNaReuniao(client, meetingId, agendaItemId);

    // Só o vínculo com ESTE tema. A pessoa segue na reunião e nos demais temas.
    const rowCount = await desvincularParticipanteDoTema(
      client, meetingId, agendaItemId, meetingParticipantId, actor, titulo,
    );
    if (rowCount === 0) throw new HttpError(404, "Participante não está vinculado a este tema.");

    // Mudança ESTRUTURAL da pauta (§ validação).
    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

/** Lê o corpo do vínculo. Reaproveita o parser de participante (identidade + anti-mass-assignment). */
export function parseAgendaItemParticipantInput(body: unknown): ParticipantInput {
  return parseParticipantInput(body, "participante da pauta");
}

/**
 * Reescreve `position` de 1..N.
 *
 * `ordem` define a sequência desejada; `null` apenas compacta a atual.
 *
 * O UNIQUE (meeting_id, position) é DEFERRABLE INITIALLY IMMEDIATE — ou seja,
 * checado a cada comando por padrão. Sem `SET CONSTRAINTS DEFERRED`, trocar
 * duas pautas de lugar violaria a restrição no meio do caminho, mesmo que o
 * estado final seja válido. Adiar para o COMMIT é exatamente o motivo de a
 * constraint ter sido criada deferrable.
 */
async function renumerarNaMesmaTransacao(
  client: PoolClient,
  meetingId: string,
  ordem: string[] | null,
): Promise<void> {
  await client.query("SET CONSTRAINTS meeting_agenda_items_position_uk DEFERRED");

  const ids =
    ordem ??
    (
      await client.query<{ id: string }>(
        "SELECT id FROM meeting_agenda_items WHERE meeting_id = $1 ORDER BY position",
        [meetingId],
      )
    ).rows.map((r) => r.id);

  for (let i = 0; i < ids.length; i++) {
    await client.query(
      "UPDATE meeting_agenda_items SET position = $3 WHERE id = $1 AND meeting_id = $2",
      [ids[i], meetingId, i + 1],
    );
  }
}

export interface ReorderInput {
  /** Ids na ordem desejada. Precisa conter exatamente as pautas da reunião. */
  agendaItemIds: string[];
  /** Horários recalculados pela tela, por id. Opcional. */
  scheduledStartTimes?: Record<string, string>;
}

export function parseReorderInput(body: unknown): ReorderInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;

  if (!Array.isArray(dados.agendaItemIds) || dados.agendaItemIds.length === 0) {
    throw new HttpError(400, "O campo 'agendaItemIds' deve ser uma lista não vazia.");
  }

  const ids = dados.agendaItemIds.map((id, i) => {
    if (typeof id !== "string") throw new HttpError(400, `agendaItemIds[${i}] deve ser um UUID.`);
    return assertUuid(id, `agendaItemIds[${i}]`);
  });

  if (new Set(ids).size !== ids.length) {
    throw new HttpError(400, "'agendaItemIds' não pode repetir a mesma pauta.");
  }

  const horarios: Record<string, string> = {};
  if (dados.scheduledStartTimes !== undefined) {
    if (typeof dados.scheduledStartTimes !== "object" || dados.scheduledStartTimes === null) {
      throw new HttpError(400, "'scheduledStartTimes' deve ser um objeto.");
    }
    for (const [id, hora] of Object.entries(dados.scheduledStartTimes as Record<string, unknown>)) {
      if (typeof hora !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(hora)) {
        throw new HttpError(400, `Horário inválido para a pauta ${id}: use HH:mm.`);
      }
      horarios[assertUuid(id, "scheduledStartTimes")] = hora;
    }
  }

  return { agendaItemIds: ids, scheduledStartTimes: horarios };
}

export async function reorderAgendaItems(
  meetingId: string,
  input: ReorderInput,
  actor: MeetingActor,
): Promise<MeetingDetail> {
  assertUuid(meetingId, "Identificador");

  await emTransacaoVersionada(meetingId, actor, async (client) => {
    const titulo = await exigirReuniao(client, meetingId);

    const { rows: atuais } = await client.query<{ id: string }>(
      "SELECT id FROM meeting_agenda_items WHERE meeting_id = $1",
      [meetingId],
    );

    // A lista precisa ser uma permutação exata: aceitar um subconjunto deixaria
    // as pautas de fora com posições órfãs.
    const existentes = new Set(atuais.map((r) => r.id));
    if (
      existentes.size !== input.agendaItemIds.length ||
      input.agendaItemIds.some((id) => !existentes.has(id))
    ) {
      throw new HttpError(400, "A ordem enviada não corresponde às pautas desta reunião.");
    }

    await renumerarNaMesmaTransacao(client, meetingId, input.agendaItemIds);

    for (const [id, hora] of Object.entries(input.scheduledStartTimes ?? {})) {
      if (!existentes.has(id)) {
        throw new HttpError(400, "Horário informado para uma pauta que não é desta reunião.");
      }
      await client.query(
        "UPDATE meeting_agenda_items SET scheduled_start_time = $3 WHERE id = $1 AND meeting_id = $2",
        [id, meetingId, hora],
      );
    }

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Pautas reordenadas",
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: titulo,
      status: "success",
    });

    // Alteracao ESTRUTURAL: reabre a validacao se ainda for planejamento.
    await reabrirValidacaoSePreReuniao(client, meetingId, actor);
  });

  return findMeeting(meetingId);
}

export { parseAgendaItemInput, parseParticipantInput };
