import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";

/**
 * Camada formal de aprovacao da Ata — modelo de dominio, provider-agnostic.
 *
 * SEM ROTAS HTTP. Nenhuma operacao daqui esta exposta, e a ausencia e
 * deliberada: preparar e cancelar um processo formal de assinatura sao atos de
 * governanca, e o sistema hoje so sabe se o chamador esta AUTENTICADO, nao se
 * esta AUTORIZADO a homologar documento. Abrir a operacao antes da autorizacao
 * seria transformar "tem conta" em "pode homologar". Quando existir esse
 * controle, as rotas entram sem tocar neste arquivo.
 *
 * SEM ASSINATURA. Nao existe funcao que marque signatario como assinado: hoje
 * nao ha evidencia externa alguma para sustentar essa afirmacao, e aceitar a
 * confirmacao do navegador seria a assinatura falsa que a 4.10 removeu.
 * `completed` e `approved` so poderao ser produzidos por uma integracao real,
 * na mesma transacao.
 *
 * SEM DOCUSIGN. `provider` e `provider_reference` existem vazios; nenhum
 * vocabulario, formato ou estado de fornecedor aparece no dominio.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Estados de dominio do processo. Nao sao os do fornecedor. */
export type SignatureProcessStatus =
  | "prepared"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

/** Estados em que o processo prende a revisao. */
export const ACTIVE_PROCESS_STATUSES: SignatureProcessStatus[] = ["prepared", "in_progress"];

export type SignerStatus = "pending" | "signed" | "declined";

export interface SignerInput {
  /** `users.id` de quem tem conta no PGCP. */
  userId?: string | null;
  /** `entra_object_id` (oid). O tenant NUNCA vem do navegador. */
  entraObjectId?: string | null;
  displayName: string;
  email?: string | null;
  roleLabel?: string | null;
  signingOrder?: number;
  required?: boolean;
}

export interface Signer {
  id: string;
  userId: string | null;
  entraObjectId: string | null;
  displayName: string;
  email: string | null;
  roleLabel: string | null;
  signingOrder: number;
  required: boolean;
  status: SignerStatus;
  signedAt: string | null;
  providerReference: string | null;
}

export interface SignatureProcess {
  id: string;
  meetingMinuteId: string;
  /** Revisao EXATA coberta por este processo. */
  minuteRevision: number;
  status: SignatureProcessStatus;
  provider: string | null;
  providerReference: string | null;
  /** SHA-256 do conteudo enviado. O snapshot integral nao trafega por padrao. */
  contentHash: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  signers: Signer[];
}

function assertValidId(id: string, campo: string): string {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, `${campo} inválido.`);
  return id.toLowerCase();
}

/**
 * Impressao digital do que foi enviado para assinatura.
 *
 * SHA-256 sobre o UTF-8 do texto, em hexadecimal minusculo. Calculado na
 * aplicacao porque o banco nao tem pgcrypto e porque a evidencia precisa ser a
 * mesma coisa que um cliente de fornecedor calcularia sobre o mesmo documento.
 */
export function hashMinutesContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface ProcessRow {
  id: string;
  meeting_minute_id: string;
  minute_revision: number;
  status: SignatureProcessStatus;
  provider: string | null;
  provider_reference: string | null;
  content_hash: string;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

interface SignerRow {
  id: string;
  signature_process_id: string;
  user_id: string | null;
  entra_object_id: string | null;
  display_name: string;
  email: string | null;
  role_label: string | null;
  signing_order: number;
  required: boolean;
  status: SignerStatus;
  signed_at: Date | null;
  provider_reference: string | null;
}

type Executor = Pick<PoolClient, "query">;

/*
 * `entra_tenant_id` fica FORA do SELECT de proposito: e a identidade do tenant
 * da propria autenticacao e nao tem por que voltar para a tela. O `oid` basta
 * para a UI casar uma pessoa do diretorio.
 */
const SELECT_SIGNERS = `
  SELECT id, signature_process_id, user_id, entra_object_id, display_name, email,
         role_label, signing_order, required, status, signed_at, provider_reference
    FROM meeting_minute_signers
   WHERE signature_process_id = ANY($1::uuid[])
   ORDER BY signing_order, display_name`;

const SELECT_PROCESSES = `
  SELECT id, meeting_minute_id, minute_revision, status, provider, provider_reference,
         content_hash, created_by_user_id, created_at, updated_at, completed_at, cancelled_at
    FROM meeting_minute_signature_processes
   WHERE meeting_minute_id = $1
   ORDER BY created_at DESC`;

function montarSigner(row: SignerRow): Signer {
  return {
    id: row.id,
    userId: row.user_id,
    entraObjectId: row.entra_object_id,
    displayName: row.display_name,
    email: row.email,
    roleLabel: row.role_label,
    signingOrder: row.signing_order,
    required: row.required,
    status: row.status,
    signedAt: row.signed_at?.toISOString() ?? null,
    providerReference: row.provider_reference,
  };
}

function montarProcesso(row: ProcessRow, signers: Signer[]): SignatureProcess {
  return {
    id: row.id,
    meetingMinuteId: row.meeting_minute_id,
    minuteRevision: row.minute_revision,
    status: row.status,
    provider: row.provider,
    providerReference: row.provider_reference,
    contentHash: row.content_hash,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    signers,
  };
}

/** Processos de uma Ata, do mais recente ao mais antigo. */
export async function listSignatureProcesses(
  meetingMinuteId: string,
  executor: Executor = pool,
): Promise<SignatureProcess[]> {
  assertValidId(meetingMinuteId, "Identificador da Ata");

  const { rows } = await executor.query<ProcessRow>(SELECT_PROCESSES, [meetingMinuteId]);
  if (rows.length === 0) return [];

  const { rows: signers } = await executor.query<SignerRow>(SELECT_SIGNERS, [rows.map((r) => r.id)]);

  return rows.map((row) =>
    montarProcesso(
      row,
      signers.filter((s) => s.signature_process_id === row.id).map(montarSigner),
    ),
  );
}

/** Processo que hoje prende a revisao, se houver. */
export async function findActiveProcess(
  meetingMinuteId: string,
  executor: Executor = pool,
): Promise<SignatureProcess | null> {
  const processos = await listSignatureProcesses(meetingMinuteId, executor);
  return processos.find((p) => ACTIVE_PROCESS_STATUSES.includes(p.status)) ?? null;
}

/**
 * O conteudo enviado, na integra. Separado da leitura normal porque e o
 * documento inteiro — carrega-lo em toda listagem seria desperdicio.
 */
export async function findProcessSnapshot(
  processId: string,
  executor: Executor = pool,
): Promise<{ contentSnapshot: string; contentHash: string; minuteRevision: number } | null> {
  assertValidId(processId, "Identificador do processo");

  const { rows } = await executor.query<{
    content_snapshot: string;
    content_hash: string;
    minute_revision: number;
  }>(
    `SELECT content_snapshot, content_hash, minute_revision
       FROM meeting_minute_signature_processes
      WHERE id = $1`,
    [processId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    contentSnapshot: row.content_snapshot,
    contentHash: row.content_hash,
    minuteRevision: row.minute_revision,
  };
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

function normalizarTexto(valor: unknown, campo: string, obrigatorio: boolean): string | null {
  if (valor === undefined || valor === null || valor === "") {
    if (obrigatorio) throw new HttpError(400, `O campo '${campo}' é obrigatório.`);
    return null;
  }
  if (typeof valor !== "string") throw new HttpError(400, `O campo '${campo}' deve ser um texto.`);
  const limpo = valor.trim();
  if (limpo.length === 0) {
    if (obrigatorio) throw new HttpError(400, `O campo '${campo}' é obrigatório.`);
    return null;
  }
  return limpo;
}

/**
 * Valida um signatario informado.
 *
 * Aceita as tres identidades do sistema: usuario PGCP (`userId`), pessoa do
 * Entra sem conta aqui (`entraObjectId`) e externo alcancavel por e-mail. Exige
 * ao menos uma — um nome digitado nao e signatario, porque nao ha como
 * convoca-lo nem como provar depois quem era.
 *
 * NAO aceita `entraTenantId`: o tenant sai do token validado no servidor, nunca
 * de um valor arbitrario do cliente.
 */
export function parseSignerInput(entrada: unknown): SignerInput {
  if (typeof entrada !== "object" || entrada === null || Array.isArray(entrada)) {
    throw new HttpError(400, "Cada signatário deve ser um objeto.");
  }
  const dados = entrada as Record<string, unknown>;

  const permitidos = new Set([
    "userId",
    "entraObjectId",
    "displayName",
    "email",
    "roleLabel",
    "signingOrder",
    "required",
  ]);
  for (const chave of Object.keys(dados)) {
    if (chave === "entraTenantId") {
      throw new HttpError(400, "O tenant é determinado pelo servidor e não pode ser informado.");
    }
    if (chave === "status" || chave === "signedAt" || chave === "providerReference") {
      throw new HttpError(400, `O campo '${chave}' não pode ser definido ao convocar um signatário.`);
    }
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não é aceito em um signatário.`);
    }
  }

  const userId = dados.userId == null ? null : assertValidId(String(dados.userId), "userId");
  const entraObjectId =
    dados.entraObjectId == null ? null : assertValidId(String(dados.entraObjectId), "entraObjectId");
  const displayName = normalizarTexto(dados.displayName, "displayName", true) as string;
  const email = normalizarTexto(dados.email, "email", false);
  const roleLabel = normalizarTexto(dados.roleLabel, "roleLabel", false);

  if (!userId && !entraObjectId && !email) {
    throw new HttpError(
      400,
      "Cada signatário precisa de ao menos uma identidade: usuário do PGCP, identidade do Entra ou e-mail.",
    );
  }

  let signingOrder = 1;
  if (dados.signingOrder !== undefined) {
    if (
      typeof dados.signingOrder !== "number" ||
      !Number.isInteger(dados.signingOrder) ||
      dados.signingOrder < 1
    ) {
      throw new HttpError(400, "O campo 'signingOrder' deve ser um inteiro maior ou igual a um.");
    }
    signingOrder = dados.signingOrder;
  }

  let required = true;
  if (dados.required !== undefined) {
    if (typeof dados.required !== "boolean") {
      throw new HttpError(400, "O campo 'required' deve ser booleano.");
    }
    required = dados.required;
  }

  return { userId, entraObjectId, displayName, email, roleLabel, signingOrder, required };
}

export class SignatureStateError extends HttpError {
  constructor(mensagem: string) {
    super(409, mensagem);
    this.name = "SignatureStateError";
  }
}

/**
 * Prepara o processo formal para a revisao VIGENTE da Ata.
 *
 * Pre-condicao (item 4 do desenho): a Ata precisa estar em `under_review` com
 * `secretariat_cleared_revision = revision`. Editar o conteudo depois do
 * saneamento devolve a Ata para `draft` e derruba a igualdade, entao conteudo
 * alterado nao entra em assinatura. O banco repete a checagem em gatilho — o
 * servico da a mensagem, o banco da a garantia.
 *
 * Nao decide quem assina. A lista vem explicita de quem chamou: o produto nao
 * tem hoje nenhum conceito que determine signatario obrigatorio (`role_in_meeting`
 * e texto livre e `governance_bodies` nao tem quadro de membros). Inventar essa
 * regra seria decidir governanca no lugar da empresa.
 *
 * `entra_tenant_id` de cada signatario vem do parametro `tenantId`, resolvido a
 * partir do token — nunca do corpo da requisicao.
 */
export async function prepareSignatureProcess(
  meetingMinuteId: string,
  signers: SignerInput[],
  actor: { id: string; name: string },
  tenantId: string,
): Promise<SignatureProcess> {
  assertValidId(meetingMinuteId, "Identificador da Ata");

  if (!Array.isArray(signers) || signers.length === 0) {
    throw new HttpError(400, "Informe ao menos um signatário.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: atas } = await client.query<{
      id: string;
      meeting_id: string;
      revision: number;
      status: string;
      secretariat_cleared_revision: number | null;
      content: string;
    }>(
      `SELECT id, meeting_id, revision, status, secretariat_cleared_revision, content
         FROM meeting_minutes
        WHERE id = $1
          FOR UPDATE`,
      [meetingMinuteId],
    );

    const ata = atas[0];
    if (!ata) throw new HttpError(404, "Ata não encontrada.");

    if (ata.status !== "under_review" || ata.secretariat_cleared_revision !== ata.revision) {
      throw new SignatureStateError(
        "A revisão atual da Ata não está saneada pela Secretaria e não pode entrar em assinatura.",
      );
    }

    const { rows: ativos } = await client.query<{ id: string }>(
      `SELECT id
         FROM meeting_minute_signature_processes
        WHERE meeting_minute_id = $1
          AND status IN ('prepared', 'in_progress')`,
      [meetingMinuteId],
    );
    if (ativos.length > 0) {
      throw new SignatureStateError(
        "Já existe um processo de assinatura em andamento para esta Ata. Cancele-o antes de abrir outro.",
      );
    }

    /*
     * Snapshot + hash gravados AGORA, dentro da mesma transacao que le o
     * conteudo com FOR UPDATE. Nao ha janela entre "o que foi lido" e "o que
     * ficou registrado como enviado".
     */
    const contentHash = hashMinutesContent(ata.content);

    const { rows: criados } = await client.query<{ id: string }>(
      `INSERT INTO meeting_minute_signature_processes
              (meeting_minute_id, minute_revision, status, content_snapshot, content_hash, created_by_user_id)
       VALUES ($1, $2, 'prepared', $3, $4, $5)
       RETURNING id`,
      [meetingMinuteId, ata.revision, ata.content, contentHash, actor.id],
    );
    const processId = criados[0]!.id;

    for (const bruto of signers) {
      const signer = parseSignerInput(bruto);

      if (signer.userId) {
        const { rows } = await client.query("SELECT id FROM users WHERE id = $1 AND is_active", [
          signer.userId,
        ]);
        if (rows.length === 0) {
          // Nunca criar usuario para satisfazer FK, e nunca executar JIT aqui.
          throw new HttpError(400, `Usuário ${signer.displayName} não está cadastrado e ativo no PGCP.`);
        }
      }

      await client.query(
        `INSERT INTO meeting_minute_signers
                (signature_process_id, user_id, entra_tenant_id, entra_object_id,
                 display_name, email, role_label, signing_order, required)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          processId,
          signer.userId,
          // Tenant do token. O par entra vazio junto quando nao ha oid.
          signer.entraObjectId ? tenantId : null,
          signer.entraObjectId,
          signer.displayName,
          signer.email,
          signer.roleLabel,
          signer.signingOrder,
          signer.required,
        ],
      );
    }

    /*
     * Evento formal. O rotulo carrega a revisao e a contagem de convocados —
     * NUNCA o conteudo da Ata, o snapshot, o hash ou dado de fornecedor.
     */
    await recordAuditIn(client, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Processo de assinatura da Ata preparado",
      entityType: "meeting_minute_signature_process",
      entityId: processId,
      entityLabel: `Revisão ${ata.revision} · ${signers.length} signatário(s)`,
      status: "success",
    });

    const processos = await listSignatureProcesses(meetingMinuteId, client);
    await client.query("COMMIT");

    return processos.find((p) => p.id === processId)!;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Cancela o processo ativo, liberando a Ata para nova edicao.
 *
 * Cancelar NAO reaproveita nada: o proximo processo nasce sobre uma nova
 * revisao, saneada de novo, com snapshot e hash proprios. Assinatura recolhida
 * para um texto nunca vale para outro.
 */
export async function cancelSignatureProcess(
  processId: string,
  actor: { id: string; name: string },
): Promise<SignatureProcess> {
  assertValidId(processId, "Identificador do processo");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id: string;
      meeting_minute_id: string;
      minute_revision: number;
      status: SignatureProcessStatus;
    }>(
      `SELECT id, meeting_minute_id, minute_revision, status
         FROM meeting_minute_signature_processes
        WHERE id = $1
          FOR UPDATE`,
      [processId],
    );

    const processo = rows[0];
    if (!processo) throw new HttpError(404, "Processo de assinatura não encontrado.");

    if (!ACTIVE_PROCESS_STATUSES.includes(processo.status)) {
      throw new SignatureStateError(
        `Processo com status '${processo.status}' não está em andamento e não pode ser cancelado.`,
      );
    }

    await client.query(
      `UPDATE meeting_minute_signature_processes
          SET status = 'cancelled', cancelled_at = now()
        WHERE id = $1`,
      [processId],
    );

    await recordAuditIn(client, {
      actorUserId: actor.id,
      actorName: actor.name,
      action: "Processo de assinatura da Ata cancelado",
      entityType: "meeting_minute_signature_process",
      entityId: processId,
      entityLabel: `Revisão ${processo.minute_revision}`,
      status: "success",
    });

    const processos = await listSignatureProcesses(processo.meeting_minute_id, client);
    await client.query("COMMIT");

    return processos.find((p) => p.id === processId)!;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
