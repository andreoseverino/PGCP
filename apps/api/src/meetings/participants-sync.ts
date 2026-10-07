import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";
import {
  parseParticipantInput,
  prepararParticipantes,
  type MeetingActor,
  type ParticipantInput,
  type ParticipanteResolvido,
} from "./create.js";
import { excluirMeetingParticipant, inserirMeetingParticipant } from "./agenda-item-participants.js";

/**
 * PARTICIPANTES DA REUNIÃO como LISTA COMPLETA — usada pela edição da reunião
 * (`PATCH /meetings/:id` com `participants`).
 *
 * Não é uma segunda implementação: a inclusão e a remoção são as MESMAS peças
 * da aba Participantes do Pipeline (`inserirMeetingParticipant`,
 * `excluirMeetingParticipant`, `prepararParticipantes`, `exigirQueNaoParticipa`)
 * — mesma validação, mesma resolução de identidade, mesma proteção do
 * responsável por tema, mesmas exceções de inclusão automática (031), mesma
 * auditoria. A diferença é só o envelope: tudo roda dentro da transação da
 * edição, que gera UMA versão e UMA sincronização do convite.
 */

/** Máximo de participantes por reunião no corpo (mesmo limite da criação). */
export const MAX_PARTICIPANTES_NA_EDICAO = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lista desejada:
 *   `manter` — ids de `meeting_participants` que continuam (pessoa já na reunião);
 *   `novos`  — pessoas a incluir, validadas como na criação/inclusão avulsa.
 * Quem está na reunião e não aparece em `manter` sai.
 */
export interface ListaDeParticipantes {
  manter: string[];
  novos: ParticipantInput[];
}

/**
 * Lê `participants` do corpo. Item com `id` = participante existente (só o id
 * é aceito, nada mais muda nele). Item sem `id` = pessoa nova, com as regras
 * de `parseParticipantInput` (tenant nunca vem do corpo).
 */
export function parseListaDeParticipantes(bruto: unknown): ListaDeParticipantes {
  if (!Array.isArray(bruto)) throw new HttpError(400, "O campo 'participants' deve ser uma lista.");
  if (bruto.length > MAX_PARTICIPANTES_NA_EDICAO) {
    throw new HttpError(400, `O campo 'participants' aceita no máximo ${MAX_PARTICIPANTES_NA_EDICAO} itens.`);
  }
  const manter: string[] = [];
  const novos: ParticipantInput[] = [];
  bruto.forEach((item, i) => {
    const onde = `participants[${i}]`;
    if (typeof item === "object" && item !== null && !Array.isArray(item) && "id" in item) {
      const chaves = Object.keys(item);
      if (chaves.length !== 1) {
        throw new HttpError(400, `${onde}: participante existente é informado só pelo 'id'.`);
      }
      const id = (item as { id: unknown }).id;
      if (typeof id !== "string" || !UUID.test(id)) throw new HttpError(400, `${onde}.id deve ser um UUID.`);
      const normalizado = id.toLowerCase();
      if (manter.includes(normalizado)) throw new HttpError(400, `${onde}: participante repetido na lista.`);
      manter.push(normalizado);
      return;
    }
    novos.push(parseParticipantInput(item, onde));
  });
  return { manter, novos };
}

/**
 * A pessoa já está na reunião? Mesmo critério do índice de convidados (001):
 * `user_id`, `entra_object_id` ou, para quem não tem identidade (externo do
 * PGCP), o e-mail. Usada pela inclusão avulsa (Pipeline) e pela edição.
 */
export async function exigirQueNaoParticipa(
  client: PoolClient,
  meetingId: string,
  p: Pick<ParticipanteResolvido, "userId" | "entraObjectId" | "email">,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM meeting_participants
      WHERE meeting_id = $1
        AND ( ($2::uuid IS NOT NULL AND user_id = $2)
           OR ($3::uuid IS NOT NULL AND entra_object_id = $3)
           OR ($2::uuid IS NULL AND $3::uuid IS NULL AND $4::text IS NOT NULL
               AND user_id IS NULL AND entra_object_id IS NULL AND lower(email) = lower($4)) )
      LIMIT 1`,
    [meetingId, p.userId, p.entraObjectId, p.email],
  );
  if (rows.length > 0) throw new HttpError(409, "Esta pessoa já é participante da reunião.");
}

/**
 * Aplica a lista desejada. Remove primeiro (libera quem foi trocado), depois
 * inclui. Qualquer recusa (responsável por tema, duplicidade, id de outra
 * reunião) lança e a transação de quem chamou desfaz TUDO — inclusive a edição
 * dos outros campos. Devolve se algo mudou.
 */
export async function aplicarListaDeParticipantes(
  client: PoolClient,
  meetingId: string,
  lista: ListaDeParticipantes,
  actor: MeetingActor,
  titulo: string,
): Promise<boolean> {
  const { rows: atuais } = await client.query<{ id: string }>(
    "SELECT id FROM meeting_participants WHERE meeting_id = $1",
    [meetingId],
  );
  const idsAtuais = new Set(atuais.map((r) => r.id));

  // Id que não é desta reunião: 404 sem dizer se existe em outra (IDOR).
  for (const id of lista.manter) {
    if (!idsAtuais.has(id)) throw new HttpError(404, "Participante não encontrado nesta reunião.");
  }

  let mudou = false;
  const manter = new Set(lista.manter);
  for (const id of idsAtuais) {
    if (manter.has(id)) continue;
    await excluirMeetingParticipant(client, meetingId, id, actor, titulo);
    mudou = true;
  }

  if (lista.novos.length > 0) {
    // Valida o lote inteiro antes de gravar (usuários existentes, duplicados no lote).
    const preparados = await prepararParticipantes(client, lista.novos, actor.entraTenantId);
    for (const p of preparados) {
      await exigirQueNaoParticipa(client, meetingId, p);
      await inserirMeetingParticipant(client, meetingId, p, actor, titulo);
      mudou = true;
    }
  }
  return mudou;
}
