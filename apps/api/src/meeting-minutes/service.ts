import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";

/**
 * Ata da reuniao — documento FORMAL.
 *
 * NAO e o rascunho de anotacoes: `meeting_notes` tem tabela e ciclo proprios e
 * nada e copiado de la para ca. Anotar durante a reuniao e lavrar a Ata sao
 * atos diferentes, e transformar um no outro automaticamente daria a um texto
 * de trabalho a forca de um documento de governanca.
 *
 * CONTEUDO E TEXTO PURO. A tela edita em <textarea> e exporta como text/plain.
 *
 * NENHUM CONTEUDO E GERADO AQUI. O servidor guarda o que a pessoa escreveu.
 * Deliberacao, decisao, votacao, responsavel e prazo entram por quem participou
 * da sessao — nao ha sintese automatica, nem modelo externo, nem template com
 * texto de exemplo.
 *
 * CONCORRENCIA: a Ata e unica por reuniao e pode ser editada por mais de uma
 * pessoa. Cada gravacao informa a revisao que o navegador editou, e o servidor
 * so aceita se ela ainda for a vigente.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Teto do documento. Generoso para uma ata longa, finito contra abuso. */
export const MINUTES_MAX_LENGTH = 500_000;

/**
 * Estados com caminho honesto NESTA onda.
 *
 * `approved` continua no CHECK do banco para a assinatura futura, mas nenhuma
 * operacao daqui o produz: ate hoje ele so era alcancado por duas assinaturas
 * ficticias embutidas na tela. `closed` nunca foi escrito por ninguem.
 */
export type MinutesStatus = "draft" | "under_review";

export function assertValidId(id: string, campo = "Identificador"): string {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, `${campo} inválido.`);
  return id.toLowerCase();
}

export interface MeetingMinutes {
  meetingId: string;
  /** Texto puro. Nunca HTML. */
  content: string;
  /** `0` significa que a reuniao ainda nao tem Ata. */
  revision: number;
  status: string;
  updatedByUserId: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  secretariatClearedAt: string | null;
  secretariatClearedByUserId: string | null;
  secretariatClearedByName: string | null;
  secretariatClearedRevision: number | null;
  /**
   * Derivado, nao armazenado: a revisao ATUAL esta saneada.
   *
   * Fica falso assim que alguem edita depois do visto, porque o que a
   * Secretaria conferiu foi um texto especifico, nao o documento em abstrato.
   */
  clearedForCurrentRevision: boolean;
}

/** Reuniao sem Ata, devolvida sem criar linha alguma. */
function vazio(meetingId: string): MeetingMinutes {
  return {
    meetingId,
    content: "",
    revision: 0,
    status: "draft",
    updatedByUserId: null,
    updatedByName: null,
    updatedAt: null,
    secretariatClearedAt: null,
    secretariatClearedByUserId: null,
    secretariatClearedByName: null,
    secretariatClearedRevision: null,
    clearedForCurrentRevision: false,
  };
}

type Executor = Pick<PoolClient, "query">;

interface MinutesRow {
  content: string;
  revision: number;
  status: string;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  updated_at: Date;
  secretariat_cleared_at: Date | null;
  secretariat_cleared_by_user_id: string | null;
  secretariat_cleared_by_name: string | null;
  secretariat_cleared_revision: number | null;
}

const SELECT_MINUTES = `
  SELECT m.content, m.revision, m.status, m.updated_by_user_id,
         u.name AS updated_by_name, m.updated_at,
         m.secretariat_cleared_at, m.secretariat_cleared_by_user_id,
         s.name AS secretariat_cleared_by_name, m.secretariat_cleared_revision
    FROM meeting_minutes m
    LEFT JOIN users u ON u.id = m.updated_by_user_id
    LEFT JOIN users s ON s.id = m.secretariat_cleared_by_user_id
   WHERE m.meeting_id = $1`;

function montar(meetingId: string, row: MinutesRow): MeetingMinutes {
  return {
    meetingId,
    content: row.content,
    revision: row.revision,
    status: row.status,
    updatedByUserId: row.updated_by_user_id,
    updatedByName: row.updated_by_name,
    updatedAt: row.updated_at.toISOString(),
    secretariatClearedAt: row.secretariat_cleared_at?.toISOString() ?? null,
    secretariatClearedByUserId: row.secretariat_cleared_by_user_id,
    secretariatClearedByName: row.secretariat_cleared_by_name,
    secretariatClearedRevision: row.secretariat_cleared_revision,
    clearedForCurrentRevision: row.secretariat_cleared_revision === row.revision,
  };
}

async function lerAta(executor: Executor, meetingId: string): Promise<MeetingMinutes> {
  const { rows } = await executor.query<MinutesRow>(SELECT_MINUTES, [meetingId]);
  const row = rows[0];
  return row ? montar(meetingId, row) : vazio(meetingId);
}

async function exigirReuniao(executor: Executor, meetingId: string): Promise<string> {
  const { rows } = await executor.query<{ title: string }>(
    "SELECT title FROM meetings WHERE id = $1",
    [meetingId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "Reunião não encontrada.");
  return row.title;
}

/**
 * Le a Ata.
 *
 * Reuniao sem Ata devolve o vazio com `revision: 0`. NAO cria linha: um GET nao
 * deve escrever, e abrir a aba sem digitar nada nao pode deixar rastro.
 */
export async function findMeetingMinutes(meetingId: string): Promise<MeetingMinutes> {
  assertValidId(meetingId, "Identificador da reunião");
  await exigirReuniao(pool, meetingId);
  return lerAta(pool, meetingId);
}

/** Conflito de revisao, com o estado atual para o cliente decidir o que fazer. */
export class MinutesConflictError extends HttpError {
  constructor(readonly atual: MeetingMinutes, mensagem = "A Ata foi alterada em outra sessão.") {
    super(409, mensagem);
    this.name = "MinutesConflictError";
  }
}

function parseExpectedRevision(valor: unknown): number {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0) {
    throw new HttpError(400, "O campo 'expectedRevision' deve ser um inteiro maior ou igual a zero.");
  }
  return valor;
}

function exigirObjeto(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  return body as Record<string, unknown>;
}

function exigirAllowlist(dados: Record<string, unknown>, permitidos: Set<string>): void {
  for (const chave of Object.keys(dados)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser definido por este endpoint.`);
    }
  }
}

export interface SaveMinutesInput {
  content: string;
  /** Revisao que o navegador tinha ao editar. `0` para criar a Ata. */
  expectedRevision: number;
}

/**
 * Le o corpo do PUT. Allowlist fechada.
 *
 * FORA por decisao: `meetingId` (vem da rota), `updatedByUserId` (vem do token),
 * `revision` (quem incrementa e o servidor), `status` (muda por regra, nao por
 * escolha do cliente), todo o bloco `secretariat*` (tem operacao propria) e
 * `signatures` (nao existe assinatura real para guardar).
 */
export function parseSaveInput(body: unknown): SaveMinutesInput {
  const dados = exigirObjeto(body);
  exigirAllowlist(dados, new Set(["content", "expectedRevision"]));

  if (typeof dados.content !== "string") {
    throw new HttpError(400, "O campo 'content' é obrigatório e deve ser um texto.");
  }
  if (dados.content.length > MINUTES_MAX_LENGTH) {
    throw new HttpError(400, `A Ata excede ${MINUTES_MAX_LENGTH} caracteres.`);
  }

  // Conteudo vazio e legitimo: a pessoa pode apagar tudo e recomecar. Nao ha
  // DELETE — a Ata existe enquanto a reuniao existir.
  return { content: dados.content, expectedRevision: parseExpectedRevision(dados.expectedRevision) };
}

export interface ClearInput {
  expectedRevision: number;
}

/** Corpo do saneamento. So a revisao conferida — ator, data e status sao do servidor. */
export function parseClearInput(body: unknown): ClearInput {
  const dados = exigirObjeto(body);
  exigirAllowlist(dados, new Set(["expectedRevision"]));
  return { expectedRevision: parseExpectedRevision(dados.expectedRevision) };
}

async function emTransacao<T>(trabalho: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await trabalho(client);
    await client.query("COMMIT");
    return resultado;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Sinaliza conflito de dentro da transacao.
 *
 * O estado atual so e lido DEPOIS do ROLLBACK, ja fora dela: ler antes
 * devolveria a visao da propria transacao abortada, e o cliente precisa do que
 * esta valendo de verdade para oferecer "recarregar".
 */
class ConflitoDetectado extends Error {
  constructor(readonly mensagem: string) {
    super(mensagem);
  }
}

/**
 * Grava a Ata.
 *
 * `expectedRevision = 0` cria; qualquer outro valor atualiza somente se a
 * revisao no banco ainda for aquela.
 *
 * SEM AUTOSAVE, por decisao de produto: a Ata e escrita em bloco e revisada,
 * nao digitada ao vivo como as anotacoes. Um PUT por tecla num documento formal
 * so produziria dezenas de revisoes intermediarias sem significado.
 *
 * REGRA DO SANEAMENTO: alterar o conteudo depois do visto devolve o status para
 * `draft`. O que a Secretaria conferiu foi um texto especifico; se ele muda, o
 * visto nao acompanha. `secretariat_cleared_*` NAO e apagado — continua
 * registrando qual revisao foi conferida e por quem.
 *
 * Gravar o MESMO texto nao e alteracao: nao avanca a revisao nem derruba o
 * visto. Salvar duas vezes sem editar nada nao pode invalidar o saneamento.
 */
export async function saveMeetingMinutes(
  meetingId: string,
  input: SaveMinutesInput,
  actorUserId: string,
): Promise<MeetingMinutes> {
  assertValidId(meetingId, "Identificador da reunião");

  try {
    return await emTransacao(async (client) => {
      await exigirReuniao(client, meetingId);

      /*
       * FOR UPDATE trava a linha ate o COMMIT. A verificacao de revisao e a
       * escrita ficam no mesmo bloco atomico: sem o lock, duas gravacoes
       * poderiam ler a mesma revisao e a segunda apagaria a primeira em
       * silencio. O `AND revision = $` no UPDATE permanece como segunda barreira.
       */
      const { rows } = await client.query<{ revision: number; content: string; status: string }>(
        "SELECT revision, content, status FROM meeting_minutes WHERE meeting_id = $1 FOR UPDATE",
        [meetingId],
      );
      const atual = rows[0];

      if (!atual) {
        if (input.expectedRevision !== 0) {
          throw new ConflitoDetectado("A Ata desta reunião ainda não existe.");
        }
        /*
         * ON CONFLICT DO NOTHING em vez de "consultar e decidir": o SELECT
         * anterior nao trava uma linha que nao existe, entao duas sessoes podem
         * chegar aqui juntas. O UNIQUE resolve sem janela; zero linhas
         * afetadas significa que alguem criou primeiro.
         */
        const criada = await client.query(
          `INSERT INTO meeting_minutes (meeting_id, content, status, revision, updated_by_user_id)
                VALUES ($1, $2, 'draft', 1, $3)
           ON CONFLICT (meeting_id) DO NOTHING`,
          [meetingId, input.content, actorUserId],
        );
        if (criada.rowCount === 0) {
          throw new ConflitoDetectado("A Ata desta reunião já foi criada em outra sessão.");
        }
        return lerAta(client, meetingId);
      }

      if (atual.revision !== input.expectedRevision) {
        throw new ConflitoDetectado("A Ata foi alterada em outra sessão.");
      }

      if (atual.content === input.content) {
        // Nada mudou: nao avanca revisao, nao derruba o visto, nao toca
        // updated_at. Um "salvar" sem edicao nao e um evento.
        return lerAta(client, meetingId);
      }

      /*
       * CONGELAMENTO. Revisao enviada para assinatura nao muda por baixo do
       * processo: cancelar o processo e o caminho, e depois disso a edicao gera
       * nova revisao, novo saneamento e novo processo. O banco repete a barreira
       * em gatilho — aqui a mensagem, la a garantia.
       */
      const { rows: emAssinatura } = await client.query<{ id: string }>(
        `SELECT p.id
           FROM meeting_minute_signature_processes p
           JOIN meeting_minutes m ON m.id = p.meeting_minute_id
          WHERE m.meeting_id = $1
            AND p.status IN ('prepared', 'in_progress')`,
        [meetingId],
      );
      if (emAssinatura.length > 0) {
        throw new HttpError(
          409,
          "A revisão atual da Ata está em processo de assinatura e não pode ser alterada. Cancele o processo antes de editar.",
        );
      }

      await client.query(
        `UPDATE meeting_minutes
            SET content = $2,
                revision = revision + 1,
                updated_by_user_id = $3,
                status = CASE WHEN status = 'under_review' THEN 'draft' ELSE status END
          WHERE meeting_id = $1 AND revision = $4`,
        [meetingId, input.content, actorUserId, input.expectedRevision],
      );

      return lerAta(client, meetingId);
    });
  } catch (error) {
    if (error instanceof ConflitoDetectado) {
      throw new MinutesConflictError(await findMeetingMinutes(meetingId), error.mensagem);
    }
    throw error;
  }
}

/**
 * Saneamento pela Secretaria — "Camada 1" da governanca da Ata.
 *
 * Operacao de dominio, nao um PATCH de campo: quem sanciona, quando e QUAL
 * revisao foi conferida sao decisao do servidor. O cliente informa apenas a
 * revisao que tinha em tela, para nao dar visto em texto que ja mudou.
 *
 * NAO e assinatura. Nao aprova a Ata, nao produz `approved` e nao substitui a
 * etapa formal que ainda nao existe.
 */
export async function clearMinutesBySecretariat(
  meetingId: string,
  input: ClearInput,
  actor: { id: string; name: string },
): Promise<MeetingMinutes> {
  assertValidId(meetingId, "Identificador da reunião");

  try {
    return await emTransacao(async (client) => {
      const meetingTitle = await exigirReuniao(client, meetingId);

      const { rows } = await client.query<{ revision: number; status: string }>(
        "SELECT revision, status FROM meeting_minutes WHERE meeting_id = $1 FOR UPDATE",
        [meetingId],
      );
      const atual = rows[0];

      if (!atual) {
        throw new HttpError(404, "A Ata desta reunião ainda não existe.");
      }
      if (atual.revision !== input.expectedRevision) {
        throw new ConflitoDetectado("A Ata foi alterada em outra sessão.");
      }
      if (atual.status !== "draft" && atual.status !== "under_review") {
        // Defesa para os estados que esta onda nao produz: uma Ata assinada no
        // futuro nao volta para a mesa da Secretaria por este caminho.
        throw new HttpError(409, `Ata com status '${atual.status}' não pode ser saneada.`);
      }

      await client.query(
        `UPDATE meeting_minutes
            SET status = 'under_review',
                secretariat_cleared_at = now(),
                secretariat_cleared_by_user_id = $2,
                secretariat_cleared_revision = revision
          WHERE meeting_id = $1 AND revision = $3`,
        [meetingId, actor.id, input.expectedRevision],
      );

      /*
       * Evento formal de governanca — este merece trilha, diferente do salvar
       * rascunho. `recordAuditIn` participa da MESMA transacao: ou o visto e o
       * registro existem juntos, ou nenhum dos dois.
       *
       * O rotulo carrega o titulo da reuniao e a revisao conferida. O CONTEUDO
       * DA ATA NUNCA ENTRA AQUI.
       */
      await recordAuditIn(client, {
        actorUserId: actor.id,
        actorName: actor.name,
        action: "Ata saneada pela Secretaria",
        entityType: "meeting_minutes",
        entityId: meetingId,
        entityLabel: `${meetingTitle} (revisão ${atual.revision})`,
        status: "success",
      });

      return lerAta(client, meetingId);
    });
  } catch (error) {
    if (error instanceof ConflitoDetectado) {
      throw new MinutesConflictError(await findMeetingMinutes(meetingId), error.mensagem);
    }
    throw error;
  }
}
