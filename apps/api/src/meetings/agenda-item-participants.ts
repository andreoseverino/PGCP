import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { marcarComoDesatualizada } from "../calendar/service.js";
import {
  prepararParticipantes,
  type MeetingActor,
  type ParticipantInput,
  type ParticipanteResolvido,
} from "./create.js";
import {
  estaExcluidaDaReuniao,
  identidadeDe,
  limparExclusao,
  registrarExclusao,
} from "./participant-exclusions.js";

/**
 * Participantes POR PAUTA (Opção A) — núcleo reutilizável.
 *
 * INVARIANTE: quem participa de uma pauta existe também em `meeting_participants`.
 * O vínculo aponta para `meeting_participants` (não para o diretório), então isso
 * é estrutural. Ao adicionar alguém a uma pauta que ainda não está na reunião, o
 * PGCP o adiciona à reunião pelo MESMO caminho da aba Participantes — mesma
 * resolução de identidade, mesma marca de calendário desatualizado, mesma
 * auditoria. Nada de segundo fluxo.
 *
 * Este módulo NÃO importa `update.ts`: as rotas direcionadas (add/remove) vivem
 * lá e chamam estas peças, evitando ciclo de import.
 */

/**
 * Grava um NOVO participante da reunião. Idêntico ao INSERT da aba Participantes
 * (`addParticipant`), extraído para ter uma fonte só: mesma marca de calendário
 * e mesma trilha. NÃO deduplica — quem chama garante que a pessoa ainda não está.
 */
export async function inserirMeetingParticipant(
  client: PoolClient,
  meetingId: string,
  preparado: ParticipanteResolvido,
  actor: MeetingActor,
  titulo: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO meeting_participants
            (meeting_id, user_id, display_name, email, participant_type,
             role_in_meeting, is_confirmed, entra_tenant_id, entra_object_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
    [
      meetingId,
      preparado.userId,
      preparado.displayName,
      preparado.email,
      preparado.participantType,
      preparado.roleInMeeting,
      preparado.isConfirmed,
      preparado.entraObjectId ? actor.entraTenantId : null,
      preparado.entraObjectId,
    ],
  );

  // A lista de convidados mudou: o evento no calendário deixa de refletir a
  // reunião. MESMO comportamento da aba Participantes, na mesma transação.
  await marcarComoDesatualizada(client, meetingId);

  await recordAuditIn(client, {
    actorUserId: actor.userId,
    actorName: actor.name,
    action: "Participante adicionado",
    entityType: "meeting_participant",
    entityId: rows[0]!.id,
    entityLabel: titulo,
    status: "success",
  });

  // A pessoa está na reunião de novo: uma exceção antiga (031) deixa de valer.
  // Os caminhos AUTOMÁTICOS consultam a exceção antes e nem chegam aqui.
  const apagada = await limparExclusao(
    client,
    meetingId,
    await identidadeDe(client, preparado, actor.entraTenantId),
  );
  if (apagada) {
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Exceção de inclusão automática removida (pessoa incluída novamente)",
      entityType: "meeting_participant",
      entityId: rows[0]!.id,
      entityLabel: titulo,
      status: "success",
    });
  }

  return rows[0]!.id;
}

/**
 * FIND-OR-CREATE serializado do participante da reunião.
 *
 * Deduplicação SÓ por identificador estável (`user_id` / `entra_object_id`) — nunca
 * por `display_name` sozinho. Sem esses ids (participante textual), a pessoa é
 * sempre criada, como no modelo atual.
 *
 * A serialização contra corrida é responsabilidade do chamador: ele bloqueia a
 * reunião (`SELECT ... FROM meetings WHERE id = $1 FOR UPDATE`) antes de chamar,
 * então dois adds concorrentes à mesma reunião não criam a mesma pessoa duas
 * vezes. Não há UNIQUE de identidade em `meeting_participants` (dados legados),
 * por isso o lock — e não um índice novo — é o que garante a exclusão mútua.
 */
export async function findOrCreateMeetingParticipant(
  client: PoolClient,
  meetingId: string,
  input: ParticipantInput,
  actor: MeetingActor,
  titulo: string,
): Promise<{ id: string; criado: boolean }> {
  const [preparado] = await prepararParticipantes(client, [input], actor.entraTenantId);

  /*
   * Convidado SEM identidade (externo do PGCP) e reconhecido pelo e-mail —
   * mesma chave do indice parcial de convidados (001). Sem isto, vincular a
   * um tema um externo que ja esta na reuniao violaria o indice (409).
   */
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM meeting_participants
      WHERE meeting_id = $1
        AND ( ($2::uuid IS NOT NULL AND user_id = $2)
           OR ($3::uuid IS NOT NULL AND entra_object_id = $3)
           OR ($2::uuid IS NULL AND $3::uuid IS NULL AND $4::text IS NOT NULL
               AND user_id IS NULL AND lower(email) = lower($4)) )
      LIMIT 1`,
    [meetingId, preparado!.userId, preparado!.entraObjectId, preparado!.email],
  );
  if (rows[0]) return { id: rows[0].id, criado: false };

  const id = await inserirMeetingParticipant(client, meetingId, preparado!, actor, titulo);
  return { id, criado: true };
}

/**
 * Remove um participante DA REUNIÃO — fonte única, idêntica à da aba
 * Participantes (`removeParticipant`): DELETE em `meeting_participants` +
 * calendário desatualizado + auditoria. Por causa do `ON DELETE CASCADE` da 020,
 * apagar o participante elimina TODOS os vínculos dele com pautas desta reunião.
 * Devolve o `rowCount` para o chamador decidir o 404.
 */
export async function excluirMeetingParticipant(
  client: PoolClient,
  meetingId: string,
  participantId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<number> {
  await recusarRemocaoDeResponsavel(client, meetingId, participantId);

  const { rows: removidos, rowCount } = await client.query<{
    user_id: string | null;
    entra_tenant_id: string | null;
    entra_object_id: string | null;
    email: string | null;
  }>(
    `DELETE FROM meeting_participants WHERE id = $1 AND meeting_id = $2
     RETURNING user_id, entra_tenant_id, entra_object_id, email`,
    [participantId, meetingId],
  );
  if ((rowCount ?? 0) > 0) {
    // EXCEÇÃO (031): a inclusão automática não traz a pessoa de volta a ESTA
    // reunião. Grupos (órgão/tema) não são tocados; próximas reuniões seguem.
    const r = removidos[0];
    const criada =
      r !== undefined &&
      (await registrarExclusao(
        client,
        meetingId,
        await identidadeDe(
          client,
          { userId: r.user_id, entraObjectId: r.entra_object_id, email: r.email },
          r.entra_tenant_id ?? actor.entraTenantId,
        ),
        actor.userId,
      ));
    if (criada) {
      await recordAuditIn(client, {
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "Exceção registrada: não incluir automaticamente nesta reunião",
        entityType: "meeting_participant",
        entityId: participantId,
        entityLabel: titulo,
        status: "success",
      });
    }
    // A lista de convidados mudou: o evento no calendário deixa de refletir a
    // reunião. MESMO comportamento da aba Participantes.
    await marcarComoDesatualizada(client, meetingId);
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      // Distinto de "Participante removido do tema": aqui a pessoa DEIXA a reunião.
      action: "Participante removido da reunião",
      entityType: "meeting_participant",
      entityId: participantId,
      entityLabel: titulo,
      status: "success",
    });
  }
  return rowCount ?? 0;
}

/**
 * Cria o vínculo pauta↔participante. PK composta => idempotente. Devolve `true`
 * quando um vínculo NOVO foi criado (para o chamador distinguir do repetido).
 */
export async function vincularParticipanteNaPauta(
  client: PoolClient,
  agendaItemId: string,
  meetingParticipantId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO meeting_agenda_item_participants (meeting_agenda_item_id, meeting_participant_id)
          VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [agendaItemId, meetingParticipantId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * SNAPSHOT dos participantes do tema da Biblioteca para a pauta da reunião.
 *
 * Para cada `agenda_topic_participant`: find-or-create o `meeting_participant`
 * (adicionando à reunião se preciso) e cria o vínculo. Depois disso a pauta é
 * independente do tema. Roda dentro da transação do chamador.
 */
export async function snapshotTopicParticipantsIntoItem(
  client: PoolClient,
  meetingId: string,
  agendaItemId: string,
  agendaTopicId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<void> {
  const { rows } = await client.query<{
    user_id: string | null;
    display_name: string | null;
    email: string | null;
    entra_object_id: string | null;
  }>(
    `SELECT user_id, display_name, email, entra_object_id
       FROM agenda_topic_participants WHERE agenda_topic_id = $1`,
    [agendaTopicId],
  );

  let incluidos = 0;
  for (const p of rows) {
    // Removida explicitamente desta reunião (031): o padrão do tema não a traz de volta.
    const identidade = await identidadeDe(
      client,
      { userId: p.user_id, entraObjectId: p.entra_object_id, email: p.email },
      actor.entraTenantId,
    );
    if (await estaExcluidaDaReuniao(client, meetingId, identidade)) continue;

    const input: ParticipantInput = {
      userId: p.user_id ?? undefined,
      entraObjectId: p.entra_object_id ?? undefined,
      displayName: p.display_name ?? undefined,
      email: p.email ?? undefined,
    };
    const { id, criado } = await findOrCreateMeetingParticipant(client, meetingId, input, actor, titulo);
    await vincularParticipanteNaPauta(client, agendaItemId, id);
    if (criado) incluidos += 1;
  }
  if (incluidos > 0) {
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: `Participantes padrão do tema incluídos na reunião (${incluidos})`,
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: titulo,
      status: "success",
    });
  }
}

/** Pessoa de um grupo de participação do órgão (diretório OU externo do PGCP). */
export interface MembroDeGrupo {
  entraObjectId: string | null;
  nome: string;
  email: string | null;
  externo: boolean;
}

/**
 * Inclui UMA pessoa do grupo numa reunião, pelo caminho comum (find-or-create +
 * calendário desatualizado + trilha). Respeita a exceção da reunião e nunca
 * duplica (identidade ou mesmo e-mail já convidado por outra origem).
 */
export async function incluirMembroDoGrupo(
  client: PoolClient,
  meetingId: string,
  m: MembroDeGrupo,
  actor: MeetingActor,
  titulo: string,
): Promise<"incluida" | "excluida" | "ja_participa"> {
  const identidade = await identidadeDe(client, { entraObjectId: m.entraObjectId, email: m.email }, actor.entraTenantId);
  if (await estaExcluidaDaReuniao(client, meetingId, identidade)) return "excluida";

  // Mesmo endereço já convidado (por outra origem): não duplica o convite.
  if (m.email) {
    const { rows } = await client.query(
      "SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND lower(email) = lower($2) LIMIT 1",
      [meetingId, m.email],
    );
    if (rows.length > 0) return "ja_participa";
  }

  const input: ParticipantInput = m.externo
    ? { displayName: m.nome, email: m.email ?? undefined, participantType: "external" }
    : { entraObjectId: m.entraObjectId!, displayName: m.nome, email: m.email ?? undefined };
  const { criado } = await findOrCreateMeetingParticipant(client, meetingId, input, actor, titulo);
  return criado ? "incluida" : "ja_participa";
}

/**
 * GRUPO DO ÓRGÃO COLEGIADO: quem pertence ao grupo (`participant_governance_bodies`)
 * entra na reunião NOVA do órgão. Roda na transação de criação, depois dos
 * participantes manuais — o convite (Outlook/Teams) sai depois, uma vez, já com
 * todos. (Entrar no grupo depois inclui a pessoa nas reuniões ABERTAS já
 * existentes do órgão — `participants/groups.ts`.)
 *
 *   pessoa Microsoft  identidade (tenant, oid) do grupo, do tenant de quem cria
 *   externo do PGCP   convidado por nome + e-mail, sem identidade Microsoft
 *
 * Deduplica por identidade E por e-mail (nunca dois convites para o mesmo
 * endereço) e respeita a exceção da reunião. Devolve quantos entraram.
 */
export async function incluirGrupoDoOrgao(
  client: PoolClient,
  meetingId: string,
  governanceBodyId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<number> {
  const { rows: membros } = await client.query<{
    entra_object_id: string | null;
    nome: string;
    email: string | null;
    externo: boolean;
  }>(
    `SELECT dp.entra_object_id, dp.display_name AS nome, dp.email, false AS externo
       FROM participant_governance_bodies g
       JOIN directory_people dp ON dp.id = g.directory_person_id
      WHERE g.governance_body_id = $1 AND dp.entra_tenant_id = $2
     UNION ALL
     SELECT NULL, ep.full_name, ep.email, true
       FROM participant_governance_bodies g
       JOIN external_participants ep ON ep.id = g.external_participant_id
      WHERE g.governance_body_id = $1
      ORDER BY nome`,
    [governanceBodyId, actor.entraTenantId],
  );

  let incluidos = 0;
  for (const m of membros) {
    const r = await incluirMembroDoGrupo(
      client,
      meetingId,
      { entraObjectId: m.entra_object_id, nome: m.nome, email: m.email, externo: m.externo },
      actor,
      titulo,
    );
    if (r === "incluida") incluidos += 1;
  }

  if (incluidos > 0) {
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: `Participantes do grupo do órgão incluídos automaticamente (${incluidos})`,
      entityType: "meeting",
      entityId: meetingId,
      entityLabel: titulo,
      status: "success",
    });
  }
  return incluidos;
}

// -----------------------------------------------------------------------------
// INVARIANTE: responsável de pauta que é PESSOA participa da reunião E da pauta
// -----------------------------------------------------------------------------

/**
 * Papel de quem o PGCP acrescenta à reunião por conta própria.
 *
 * É o MESMO rótulo que a tela já usava ao incluir alguém à mão — nenhum papel
 * novo foi criado para este caminho, senão a lista passaria a ter duas classes
 * de convidado que ninguém pediu.
 */
export const PAPEL_PADRAO_DO_PARTICIPANTE = "Convidado";

/** O que `meeting_agenda_items` guarda sobre quem responde pela pauta. */
export interface ResponsavelDePauta {
  responsibleLabel?: string | null;
  responsibleEntraObjectId?: string | null;
}

/**
 * Converte o responsável da pauta no participante que ele deve ser — ou `null`
 * quando não há pessoa a convidar.
 *
 * PESSOA IDENTIFICÁVEL é quem tem `oid` do Entra. `responsible_label` sozinho
 * ("Todos", "Comitê de Auditoria", uma área, um texto livre) NÃO vira
 * participante: não existe caixa para convidar, e casar o texto com o diretório
 * por semelhança uniria homônimos e inventaria presença de quem ninguém
 * escolheu. O rótulo acompanha a identidade porque é o que a tela exibe sem
 * consultar o Graph — e o CHECK da migration 003 já o exige ao lado do `oid`.
 *
 * Função PURA: a regra de quem entra fica separada do INSERT que a executa.
 */
export function participanteDoResponsavel(
  responsavel: ResponsavelDePauta,
): ParticipantInput | null {
  const entraObjectId = responsavel.responsibleEntraObjectId?.trim();
  const displayName = responsavel.responsibleLabel?.trim();
  if (!entraObjectId || !displayName) return null;

  return {
    entraObjectId,
    displayName,
    roleInMeeting: PAPEL_PADRAO_DO_PARTICIPANTE,
    /*
     * Presença NÃO é confirmada aqui. Quem monta a pauta decide quem responde
     * por ela; dizer que a pessoa confirmou seria afirmar um fato dela que
     * ninguém verificou.
     */
    isConfirmed: false,
  };
}

/**
 * Garante a invariável para UMA pauta: responsável pessoa está em
 * `meeting_participants` e em `meeting_agenda_item_participants`.
 *
 * Idempotente — `findOrCreateMeetingParticipant` deduplica por identificador
 * estável (`user_id` / `entra_object_id`), nunca por nome. Quem já é
 * participante permanece como está: papel, presença e e-mail que a Assessoria
 * tiver ajustado não são sobrescritos.
 *
 * Roda na transação de quem chama, que também é responsável por serializar o
 * find-or-create com `SELECT ... FROM meetings WHERE id = $1 FOR UPDATE`.
 *
 * A PK composta torna o vínculo idempotente. Assim criação, importação e troca
 * de responsável podem repetir a garantia sem duplicar uma seleção existente.
 */
export async function garantirResponsavelComoParticipante(
  client: PoolClient,
  meetingId: string,
  agendaItemId: string,
  responsavel: ResponsavelDePauta,
  actor: MeetingActor,
  titulo: string,
): Promise<{ id: string; criado: boolean } | null> {
  const input = participanteDoResponsavel(responsavel);
  if (!input) return null;
  const participante = await findOrCreateMeetingParticipant(
    client,
    meetingId,
    input,
    actor,
    titulo,
  );
  await vincularParticipanteNaPauta(client, agendaItemId, participante.id);
  return participante;
}

/**
 * Recusa tirar da reunião quem ainda responde por alguma pauta dela.
 *
 * A barreira é AQUI e não na tela: desabilitar o botão é cortesia, e qualquer
 * DELETE direto na API passaria por cima dela deixando a reunião com uma pauta
 * cujo responsável não está presente — exatamente o estado que a regra proíbe.
 *
 * Fica dentro de `excluirMeetingParticipant` porque essa é a única remoção do
 * sistema: vale para a aba Participantes e para o desvínculo pela pauta, e
 * qualquer caminho futuro herda a checagem sem precisar lembrar dela.
 *
 * O casamento é por IDENTIDADE (par tenant+oid), nunca por nome: só pessoa
 * identificável entra pela regra, então só ela pode ser retida por ela.
 */
/**
 * Remove a pessoa de UM tema — só o vínculo (regra vigente desde a revisão de
 * 025, substitui a Opção A da 020). A pessoa continua em `meeting_participants`
 * e nos demais temas; o convite do calendário não muda. Sair da reunião
 * inteira é `excluirMeetingParticipant` (aba Participantes).
 *
 * O responsável PESSOA continua obrigatoriamente participante do próprio tema:
 * desvinculá-lo exige trocar o responsável antes.
 *
 * `meeting_id` + item no WHERE: id de outra reunião/tema não remove nada.
 * Devolve o `rowCount` para o chamador decidir o 404.
 */
export async function desvincularParticipanteDoTema(
  client: PoolClient,
  meetingId: string,
  agendaItemId: string,
  participantId: string,
  actor: MeetingActor,
  titulo: string,
): Promise<number> {
  const { rows: responsavel } = await client.query(
    `SELECT 1
       FROM meeting_agenda_items ai
       JOIN meeting_participants mp
         ON mp.meeting_id = ai.meeting_id
        AND mp.entra_object_id = ai.responsible_entra_object_id
        AND mp.entra_tenant_id = ai.responsible_entra_tenant_id
      WHERE ai.id = $1 AND ai.meeting_id = $2 AND mp.id = $3`,
    [agendaItemId, meetingId, participantId],
  );
  if (responsavel.length > 0) {
    throw new HttpError(409, "Esta pessoa é a responsável por este tema. Troque o responsável antes de removê-la do tema.");
  }

  const { rowCount } = await client.query(
    `DELETE FROM meeting_agenda_item_participants aip
      USING meeting_agenda_items ai
      WHERE aip.meeting_agenda_item_id = $1
        AND aip.meeting_participant_id = $2
        AND ai.id = aip.meeting_agenda_item_id
        AND ai.meeting_id = $3`,
    [agendaItemId, participantId, meetingId],
  );
  if ((rowCount ?? 0) > 0) {
    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "Participante removido do tema",
      entityType: "meeting_agenda_item",
      entityId: agendaItemId,
      entityLabel: titulo,
      status: "success",
    });
  }
  return rowCount ?? 0;
}

async function recusarRemocaoDeResponsavel(
  client: PoolClient,
  meetingId: string,
  participantId: string,
): Promise<void> {
  const { rows } = await client.query<{ title: string }>(
    `SELECT ai.title
       FROM meeting_participants mp
       JOIN meeting_agenda_items ai
         ON ai.meeting_id = mp.meeting_id
        AND ai.responsible_entra_object_id = mp.entra_object_id
        AND ai.responsible_entra_tenant_id = mp.entra_tenant_id
      WHERE mp.id = $1
        AND mp.meeting_id = $2
        AND mp.entra_object_id IS NOT NULL
      ORDER BY ai.position
      LIMIT 1`,
    [participantId, meetingId],
  );

  if (rows.length > 0) {
    throw new HttpError(
      409,
      `Esta pessoa é responsável pela pauta "${rows[0]!.title}". Troque o responsável ou remova a pauta antes de tirá-la da reunião.`,
    );
  }
}
