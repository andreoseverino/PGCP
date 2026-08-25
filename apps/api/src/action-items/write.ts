import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { podeVisualizarReuniao } from "../meetings/visibility.js";
import { recordAuditIn } from "../audit/service.js";
import type { MeetingActor } from "../meetings/create.js";
import {
  ACTION_ITEM_STATUSES,
  assertValidId,
  findActionItemAposEscrita,
  type ActionItem,
  type ActionItemStatus,
} from "./service.js";

/**
 * Escrita de FUP.
 *
 * `daysLate` NAO existe aqui. O prazo e `due_date`, uma data civil; atraso e
 * derivado na leitura, contra `current_date`. Gravar o atraso congelaria um
 * numero que muda todo dia.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const texto = (valor: unknown, campo: string, max: number): string | undefined => {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== "string") throw new HttpError(400, `O campo '${campo}' deve ser um texto.`);
  const limpo = valor.trim();
  if (limpo.length === 0) return undefined;
  if (limpo.length > max) throw new HttpError(400, `O campo '${campo}' excede ${max} caracteres.`);
  return limpo;
};

const uuidOpcional = (valor: unknown, campo: string): string | undefined => {
  const t = texto(valor, campo, 36);
  return t === undefined ? undefined : assertValidId(t, `O campo '${campo}'`);
};

/**
 * Data civil `YYYY-MM-DD`.
 *
 * A ida e volta pelo ISO rejeita 2026-02-30: o formato bate, mas a data nao
 * existe, e `Date.parse` transborda em silencio para 2 de marco.
 */
function dataCivil(valor: unknown, campo: string): string | undefined {
  const t = texto(valor, campo, 10);
  if (t === undefined) return undefined;
  if (!DATE_PATTERN.test(t)) throw new HttpError(400, `'${campo}' deve estar no formato YYYY-MM-DD.`);

  const data = new Date(`${t}T00:00:00Z`);
  // Mes 13 produz Invalid Date, e `toISOString()` sobre ele LANCA RangeError —
  // que viraria 500. A checagem vem antes da ida e volta.
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== t) {
    throw new HttpError(400, `'${campo}' não é uma data válida.`);
  }
  return t;
}

export interface ActionItemInput {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  assignedUserId?: string | null;
  assigneeEntraObjectId?: string | null;
  assigneeName?: string | null;
  originMeetingId?: string | null;
  originAgendaItemId?: string | null;
  governanceBodyId?: string | null;
  originLabel?: string | null;
  status?: ActionItemStatus;
}

const PERMITIDOS = new Set([
  "title", "description", "dueDate", "assignedUserId", "assigneeEntraObjectId",
  "assigneeName", "originMeetingId", "originAgendaItemId", "governanceBodyId",
  "originLabel", "status",
]);

/**
 * Le o corpo. Allowlist fechada: campo desconhecido e RECUSADO.
 *
 * FORA por decisao: `id`, `createdAt`, `completedAt` (efeito de concluir),
 * `daysLate` (derivado) e `assigneeEntraTenantId` (o tenant vem do token).
 */
export function parseActionItemInput(body: unknown, parcial = false): ActionItemInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;

  // Os dois casos abaixo vêm ANTES da allowlist: ambos seriam recusados por ela
  // de qualquer forma, mas com uma mensagem genérica. Dizer POR QUE o campo não
  // existe evita que alguém conclua que o nome está errado e insista.
  if (dados.assigneeEntraTenantId !== undefined) {
    throw new HttpError(400, "'assigneeEntraTenantId' não é aceito: o tenant vem da autenticação.");
  }
  if (dados.daysLate !== undefined) {
    throw new HttpError(400, "'daysLate' não é persistido: o atraso é derivado de 'dueDate'.");
  }

  for (const chave of Object.keys(dados)) {
    if (!PERMITIDOS.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser definido por este endpoint.`);
    }
  }

  const saida: ActionItemInput = {};

  if ("title" in dados || !parcial) {
    const t = texto(dados.title, "title", 300);
    if (!t) throw new HttpError(400, "O campo 'title' é obrigatório.");
    saida.title = t;
  }

  if ("description" in dados) saida.description = texto(dados.description, "description", 5000) ?? null;
  if ("dueDate" in dados) saida.dueDate = dataCivil(dados.dueDate, "dueDate") ?? null;
  if ("assigneeName" in dados) saida.assigneeName = texto(dados.assigneeName, "assigneeName", 200) ?? null;
  if ("originLabel" in dados) saida.originLabel = texto(dados.originLabel, "originLabel", 300) ?? null;

  for (const chave of [
    "assignedUserId", "assigneeEntraObjectId",
    "originMeetingId", "originAgendaItemId", "governanceBodyId",
  ] as const) {
    if (!(chave in dados)) continue;
    saida[chave] = dados[chave] === null ? null : (uuidOpcional(dados[chave], chave) ?? null);
  }

  if ("status" in dados) {
    if (!(ACTION_ITEM_STATUSES as readonly string[]).includes(dados.status as string)) {
      throw new HttpError(400, `'status' aceita apenas: ${ACTION_ITEM_STATUSES.join(", ")}.`);
    }
    saida.status = dados.status as ActionItemStatus;
  }

  // Identidade Microsoft sem nome obrigaria consultar o Graph so para exibir
  // quem responde — e a lista pararia de funcionar com o Graph fora do ar.
  if (saida.assigneeEntraObjectId && !saida.assigneeName) {
    throw new HttpError(400, "Informe 'assigneeName' junto de 'assigneeEntraObjectId'.");
  }

  if (parcial && Object.keys(saida).length === 0) {
    throw new HttpError(400, "Nenhum campo alterável foi informado.");
  }

  return saida;
}

async function emTransacao<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Liga o responsavel a `users` quando a pessoa JA existe — nunca provisiona.
 * Busca exclusiva por (tenant validado, oid).
 */
async function resolverResponsavel(
  client: PoolClient,
  input: ActionItemInput,
  tenantId: string,
): Promise<{ userId: string | null; entraObjectId: string | null }> {
  const entraObjectId = input.assigneeEntraObjectId ?? null;

  if (input.assignedUserId) {
    const { rows } = await client.query("SELECT id FROM users WHERE id = $1", [input.assignedUserId]);
    if (rows.length === 0) {
      throw new HttpError(400, "O responsável informa um usuário do PGCP que não existe.");
    }
    return { userId: input.assignedUserId, entraObjectId };
  }

  if (!entraObjectId) return { userId: null, entraObjectId: null };

  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE entra_tenant_id = $1 AND entra_object_id = $2",
    [tenantId, entraObjectId],
  );
  return { userId: rows[0]?.id ?? null, entraObjectId };
}

/**
 * Confere que a origem e coerente.
 *
 * LACUNA CONHECIDA no schema: `origin_meeting_id` e `origin_agenda_item_id` sao
 * duas FKs INDEPENDENTES, entao o banco aceitaria uma pauta da reuniao B
 * declarada como originada na reuniao A. Ate existir a FK composta, esta
 * checagem e a unica barreira — e por isso ela roda dentro da transacao, com o
 * item travado.
 */
async function validarOrigem(client: PoolClient, input: ActionItemInput): Promise<void> {
  if (input.originMeetingId) {
    const { rows } = await client.query("SELECT id FROM meetings WHERE id = $1", [input.originMeetingId]);
    if (rows.length === 0) throw new HttpError(404, "Reunião de origem não encontrada.");
  }

  if (input.originAgendaItemId) {
    const { rows } = await client.query<{ meeting_id: string }>(
      "SELECT meeting_id FROM meeting_agenda_items WHERE id = $1 FOR SHARE",
      [input.originAgendaItemId],
    );
    if (rows.length === 0) throw new HttpError(404, "Pauta de origem não encontrada.");

    if (!input.originMeetingId) {
      throw new HttpError(400, "Informe 'originMeetingId' junto de 'originAgendaItemId'.");
    }
    if (rows[0]!.meeting_id !== input.originMeetingId) {
      throw new HttpError(400, "A pauta de origem não pertence à reunião informada.");
    }
  }

  if (input.governanceBodyId) {
    const { rows } = await client.query("SELECT id FROM governance_bodies WHERE id = $1", [
      input.governanceBodyId,
    ]);
    if (rows.length === 0) throw new HttpError(404, "Órgão de governança não encontrado.");
  }
}

export async function createActionItem(
  input: ActionItemInput,
  actor: MeetingActor,
): Promise<ActionItem> {
  const id = await emTransacao(async (client) => {
    await validarOrigem(client, input);
    const { userId, entraObjectId } = await resolverResponsavel(client, input, actor.entraTenantId);

    // O CHECK do banco cobre isso, mas conferir aqui devolve 400 explicativo em
    // vez de uma violacao crua traduzida em 500.
    if (!userId && !entraObjectId) {
      throw new HttpError(400, "Informe o responsável: 'assignedUserId' ou 'assigneeEntraObjectId'.");
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO action_items
              (title, description, assigned_user_id, assignee_name,
               assignee_entra_tenant_id, assignee_entra_object_id,
               origin_meeting_id, origin_agenda_item_id, governance_body_id,
               origin_label, due_date, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')
         RETURNING id`,
      [
        input.title,
        input.description ?? null,
        userId,
        input.assigneeName ?? null,
        entraObjectId ? actor.entraTenantId : null,
        entraObjectId,
        input.originMeetingId ?? null,
        input.originAgendaItemId ?? null,
        input.governanceBodyId ?? null,
        input.originLabel ?? null,
        input.dueDate ?? null,
      ],
    );

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: "FUP criado",
      entityType: "action_item",
      entityId: rows[0]!.id,
      entityLabel: input.title ?? null,
      status: "success",
    });

    return rows[0]!.id;
  });

  // Quem acabou de criar recebe o que criou: a autorizacao ja aconteceu na rota.
  return findActionItemAposEscrita(id);
}

const COLUNA_DE: Record<string, string> = {
  title: "title",
  description: "description",
  dueDate: "due_date",
  originMeetingId: "origin_meeting_id",
  originAgendaItemId: "origin_agenda_item_id",
  governanceBodyId: "governance_body_id",
  originLabel: "origin_label",
};

/** Rotulo factual da trilha, conforme o que a mutacao realmente fez. */
function acaoDaTrilha(input: ActionItemInput): string {
  if (input.status === "completed") return "FUP concluído";
  if (input.status === "open") return "FUP reaberto";
  if (input.status === "cancelled") return "FUP cancelado";
  return "FUP atualizado";
}

/**
 * Quem pode ALTERAR um FUP.
 *
 * Ler e escrever sao permissoes diferentes, e o produto ja separava as duas em
 * reunioes: qualquer usuario ativo consulta, so a Assessoria altera. O FUP
 * segue o mesmo desenho, com a excecao obvia de quem responde por ele:
 *
 *   responsavel       conclui, reabre e ajusta a propria obrigacao
 *   PGCP.Assessoria   gerencia FUP como ja gerencia a reuniao de origem
 *   demais            leem, quando visivel, e nao escrevem
 *
 * `PGCP.Assessoria` entra porque o FUP nasce na reuniao e e mantido por quem
 * conduz a reuniao. `PGCP.Admin` NAO entra: administrar a plataforma nao e
 * gerenciar a obrigacao de outra pessoa.
 *
 * O responsavel e reconhecido por IDENTIDADE: `assigned_user_id` ou o par
 * (tenant, oid) do token. Nome e e-mail iguais nao dao acesso a nada.
 */
export interface PermissoesDeFup {
  /** O ator tem a App Role `PGCP.Assessoria`? Resolvido na rota, do token. */
  isAssessoria: boolean;
  /** Identidade Microsoft do ator, quando o token a traz. */
  entraObjectId: string | null;
}

export async function updateActionItem(
  id: string,
  input: ActionItemInput,
  actor: MeetingActor,
  permissoes: PermissoesDeFup,
): Promise<ActionItem> {
  assertValidId(id);

  await emTransacao(async (client) => {
    const atual = await client.query<{
      title: string;
      assigned_user_id: string | null;
      assignee_entra_tenant_id: string | null;
      assignee_entra_object_id: string | null;
      origin_meeting_id: string | null;
    }>(
      `SELECT title, assigned_user_id, assignee_entra_tenant_id, assignee_entra_object_id,
              origin_meeting_id
         FROM action_items WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (atual.rows.length === 0) throw new HttpError(404, "Ação de acompanhamento não encontrada.");

    const linha = atual.rows[0]!;
    const souResponsavel =
      linha.assigned_user_id === actor.userId ||
      (permissoes.entraObjectId !== null &&
        linha.assignee_entra_object_id === permissoes.entraObjectId &&
        linha.assignee_entra_tenant_id === actor.entraTenantId);

    if (!souResponsavel && !permissoes.isAssessoria) {
      /*
       * 404 para quem nem podia VER: confirmar a existencia diria a um
       * estranho que aquele UUID e um FUP real. Quem pode ver recebe 403, que
       * e a resposta honesta — o recurso existe e a acao e que nao e sua.
       */
      const visivel =
        linha.origin_meeting_id !== null &&
        (await podeVisualizarReuniao(linha.origin_meeting_id, {
          userId: actor.userId,
          entraTenantId: actor.entraTenantId,
          entraObjectId: permissoes.entraObjectId,
        }));

      if (!visivel) throw new HttpError(404, "Ação de acompanhamento não encontrada.");

      throw new HttpError(
        403,
        "Este FUP é de outra pessoa. Apenas o responsável ou a Assessoria pode alterá-lo.",
      );
    }

    await validarOrigem(client, input);

    const atribuicoes: string[] = [];
    const valores: unknown[] = [id];
    const bind = (coluna: string, valor: unknown) => {
      valores.push(valor);
      atribuicoes.push(`${coluna} = $${valores.length}`);
    };

    for (const [chave, coluna] of Object.entries(COLUNA_DE)) {
      const valor = (input as unknown as Record<string, unknown>)[chave];
      if (valor !== undefined) bind(coluna, valor);
    }

    // Responsavel muda em bloco: nome e identidade andam juntos, senao sobra um
    // `oid` apontando para alguem cujo nome exibido ja e outro.
    if (
      input.assignedUserId !== undefined ||
      input.assigneeEntraObjectId !== undefined ||
      input.assigneeName !== undefined
    ) {
      const { userId, entraObjectId } = await resolverResponsavel(client, input, actor.entraTenantId);
      if (!userId && !entraObjectId) {
        throw new HttpError(400, "Um FUP não pode ficar sem responsável.");
      }
      bind("assigned_user_id", userId);
      bind("assignee_name", input.assigneeName ?? null);
      bind("assignee_entra_object_id", entraObjectId);
      bind("assignee_entra_tenant_id", entraObjectId ? actor.entraTenantId : null);
    }

    if (input.status !== undefined) {
      bind("status", input.status);
      // `completed_at` e EFEITO de concluir, nunca campo do cliente. Reabrir
      // limpa: manter a data faria a acao parecer concluída e aberta ao mesmo
      // tempo.
      bind("completed_at", input.status === "completed" ? new Date() : null);
    }

    if (atribuicoes.length > 0) {
      await client.query(
        `UPDATE action_items SET ${atribuicoes.join(", ")} WHERE id = $1`,
        valores,
      );
    }

    await recordAuditIn(client, {
      actorUserId: actor.userId,
      actorName: actor.name,
      action: acaoDaTrilha(input),
      entityType: "action_item",
      entityId: id,
      entityLabel: input.title ?? atual.rows[0]!.title,
      status: "success",
    });
  });

  return findActionItemAposEscrita(id);
}
