import pool from "../database.js";
import { HttpError } from "../http-error.js";

/**
 * Anotacoes da reuniao — documento operacional de trabalho.
 *
 * NAO e a Ata: `meeting_minutes` tem ciclo formal proprio e nao e tocada aqui.
 * Nada e copiado automaticamente de um para o outro.
 *
 * CONCORRENCIA: o documento e unico por reuniao e editado por autosave, entao
 * duas abas abertas na mesma reuniao sao o caso normal, nao a excecao. Cada
 * gravacao informa a revisao que o navegador editou; o servidor so aceita se
 * ela ainda for a vigente. Sem isso, a ultima aba a salvar apagaria em silencio
 * o que a outra escreveu.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Teto do documento. Generoso para uma reuniao longa, finito contra abuso. */
export const NOTES_MAX_LENGTH = 500_000;

export function assertValidId(id: string, campo = "Identificador"): string {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, `${campo} inválido.`);
  return id.toLowerCase();
}

export interface MeetingNotes {
  meetingId: string;
  contentHtml: string;
  /**
   * Revisao vigente. `0` significa que a reuniao ainda nao tem documento — e e
   * essa a revisao que o cliente informa para cria-lo.
   */
  revision: number;
  updatedByUserId: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

/** Documento inexistente, devolvido sem criar linha alguma. */
function vazio(meetingId: string): MeetingNotes {
  return {
    meetingId,
    contentHtml: "",
    revision: 0,
    updatedByUserId: null,
    updatedByName: null,
    updatedAt: null,
  };
}

async function exigirReuniao(meetingId: string): Promise<void> {
  const { rows } = await pool.query("SELECT id FROM meetings WHERE id = $1", [meetingId]);
  if (rows.length === 0) throw new HttpError(404, "Reunião não encontrada.");
}

/**
 * Le as anotacoes.
 *
 * Reuniao sem documento devolve o vazio com `revision: 0`. NAO cria linha: um
 * GET nao deve escrever, e abrir a aba sem digitar nada nao pode deixar rastro
 * no banco.
 */
export async function findMeetingNotes(meetingId: string): Promise<MeetingNotes> {
  assertValidId(meetingId, "Identificador da reunião");
  await exigirReuniao(meetingId);

  const { rows } = await pool.query<{
    content_html: string;
    revision: number;
    updated_by_user_id: string | null;
    updated_by_name: string | null;
    updated_at: Date;
  }>(
    `SELECT n.content_html, n.revision, n.updated_by_user_id,
            u.name AS updated_by_name, n.updated_at
       FROM meeting_notes n
       LEFT JOIN users u ON u.id = n.updated_by_user_id
      WHERE n.meeting_id = $1`,
    [meetingId],
  );

  const row = rows[0];
  if (!row) return vazio(meetingId);

  return {
    meetingId,
    contentHtml: row.content_html,
    revision: row.revision,
    updatedByUserId: row.updated_by_user_id,
    updatedByName: row.updated_by_name,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface SaveNotesInput {
  contentHtml: string;
  /** Revisao que o navegador tinha ao editar. `0` para criar o documento. */
  expectedRevision: number;
}

/**
 * Le o corpo do PUT. Allowlist fechada.
 *
 * FORA por decisao: `meetingId` (vem da rota), `updatedByUserId` (vem do
 * token), `revision` (quem incrementa e o servidor) e qualquer campo da Ata.
 */
export function parseSaveInput(body: unknown): SaveNotesInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;

  const permitidos = new Set(["contentHtml", "expectedRevision"]);
  for (const chave of Object.keys(dados)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser definido por este endpoint.`);
    }
  }

  if (typeof dados.contentHtml !== "string") {
    throw new HttpError(400, "O campo 'contentHtml' é obrigatório e deve ser um texto.");
  }
  if (dados.contentHtml.length > NOTES_MAX_LENGTH) {
    throw new HttpError(400, `As anotações excedem ${NOTES_MAX_LENGTH} caracteres.`);
  }

  const revisao = dados.expectedRevision;
  if (typeof revisao !== "number" || !Number.isInteger(revisao) || revisao < 0) {
    throw new HttpError(400, "O campo 'expectedRevision' deve ser um inteiro maior ou igual a zero.");
  }

  // Conteudo vazio e legitimo: a usuaria pode apagar tudo. Nao ha DELETE — o
  // documento existe enquanto a reuniao existir.
  return { contentHtml: dados.contentHtml, expectedRevision: revisao };
}

/** Conflito de revisao, com o estado atual para o cliente decidir o que fazer. */
export class NotesConflictError extends HttpError {
  constructor(readonly atual: MeetingNotes) {
    super(409, "As anotações foram alteradas em outra sessão.");
    this.name = "NotesConflictError";
  }
}

/**
 * Grava as anotacoes.
 *
 * `expectedRevision = 0` cria; qualquer outro valor atualiza somente se a
 * revisao no banco ainda for aquela. O UPDATE traz a condicao no WHERE, entao a
 * verificacao e a escrita sao o MESMO comando — ler antes e gravar depois
 * deixaria uma janela entre as duas em que a outra aba grava.
 */
export async function saveMeetingNotes(
  meetingId: string,
  input: SaveNotesInput,
  actorUserId: string,
): Promise<MeetingNotes> {
  assertValidId(meetingId, "Identificador da reunião");
  await exigirReuniao(meetingId);

  if (input.expectedRevision === 0) {
    /*
     * ON CONFLICT DO NOTHING em vez de "consultar e decidir": duas abas podem
     * tentar criar o documento ao mesmo tempo, e o UNIQUE resolve sem janela.
     * Zero linhas afetadas significa que alguem criou primeiro — conflito.
     */
    const { rows } = await pool.query<{ revision: number }>(
      `INSERT INTO meeting_notes (meeting_id, content_html, revision, updated_by_user_id)
            VALUES ($1, $2, 1, $3)
       ON CONFLICT (meeting_id) DO NOTHING
         RETURNING revision`,
      [meetingId, input.contentHtml, actorUserId],
    );

    if (rows.length === 0) {
      throw new NotesConflictError(await findMeetingNotes(meetingId));
    }
    return findMeetingNotes(meetingId);
  }

  const { rowCount } = await pool.query(
    `UPDATE meeting_notes
        SET content_html = $2,
            revision = revision + 1,
            updated_by_user_id = $3
      WHERE meeting_id = $1 AND revision = $4`,
    [meetingId, input.contentHtml, actorUserId, input.expectedRevision],
  );

  if (rowCount === 0) {
    // Ou a revisao avancou, ou o documento nem existe. As duas coisas dizem ao
    // cliente a mesma coisa: recarregue antes de gravar.
    throw new NotesConflictError(await findMeetingNotes(meetingId));
  }

  return findMeetingNotes(meetingId);
}
