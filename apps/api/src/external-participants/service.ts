import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { findDirectoryUsersByEmail, getGraphConfig } from "../graph/client.js";
import {
  exigirExistencia,
  gravarClassificacoes,
  lerClassificacoes,
  parseClassificacoes,
  type Classificacoes,
  type VinculosLidos,
} from "../participants/classifications.js";

/**
 * PARTICIPANTES EXTERNOS — cadastro local de quem participa de reunioes sem
 * existir no Entra ID (migration 026).
 *
 * NAO SAO USUARIOS: nada aqui cria linha em `users`, concede App Role, gera
 * login ou identidade Microsoft. Autenticacao continua exclusivamente Entra.
 *
 * Este modulo trata SOMENTE registros locais: nenhuma rota daqui lista, busca
 * ou edita pessoas do Entra. O diretorio e consultado apenas por INTEGRIDADE
 * (o e-mail cadastrado nao pode ser corporativo) — nunca devolvido. A busca
 * combinada Entra + PGCP e da tela de selecao de participantes de reuniao.
 *
 * Autorizacao: cadastro funcional — `PGCP.Assessoria` OU `PGCP.Admin`, o mesmo
 * de orgaos, tipos e naturezas (aplicado no router). Leitura tambem restrita:
 * a lista carrega e-mail e telefone de terceiros.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExternalParticipant {
  id: string;
  /** Procedencia fixa. Pessoas do Entra nunca aparecem neste contrato. */
  origin: "pgcp";
  fullName: string;
  email: string;
  /** Opcional desde a 038. */
  phone: string | null;
  /** Empresa/organizacao (opcional, 038). */
  company: string | null;
  /** Classificacao (027): orgaos colegiados e temas da Biblioteca. So sugestao. */
  governanceBodies: VinculosLidos["governanceBodies"];
  topics: VinculosLidos["topics"];
  createdAt: string;
  updatedAt: string;
}

export interface ExternalParticipantInput {
  fullName: string;
  email: string;
  phone: string | null;
  company: string | null;
  /**
   * Órgãos/temas (027; substitui o `governanceBodyId` único da 026). `null` =
   * não informados: a gravação NÃO mexe nos vínculos (os grupos de participação
   * são mantidos na própria tela de grupos).
   */
  classificacoes: Classificacoes | null;
}

// ---------------------------------------------------------------------------
// Validacao
// ---------------------------------------------------------------------------

const CAMPOS = ["fullName", "email", "phone", "company", "governanceBodyIds", "topicIds"] as const;

/**
 * Endereco pragmatico (mesmo criterio do aprovador de pautas): forma de
 * endereco, um destinatario so, sem caractere de controle ou separador.
 */
export function parseEmail(valor: unknown): string {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new HttpError(400, "Informe o e-mail do participante.");
  }
  const email = valor.trim();
  if (email.length > 254) throw new HttpError(400, "O e-mail informado é longo demais.");
  // eslint-disable-next-line no-control-regex
  if (/[,;\s<>"()[\]\\\u0000-\u001F\u007F]/.test(email)) {
    throw new HttpError(400, "Informe um único endereço de e-mail, sem espaços ou separadores.");
  }
  if (!/^[^@]+@[^@]+\.[a-zA-Z]{2,}$/.test(email) || /\.\.|^\.|@\.|\.$/.test(email)) {
    throw new HttpError(400, "O e-mail informado não é válido.");
  }
  return email;
}

/**
 * Telefone como TEXTO: digitos, `+`, `(`, `)`, `-` e espacos. Sem regra
 * internacional rigida; exige ao menos 8 digitos (numero com DDD cabe folgado)
 * e preserva DDI/DDD como digitados, so normalizando espacos repetidos.
 *
 * OPCIONAL desde a 038: ausente, `null` ou vazio = sem telefone (`null`).
 * Informado, continua validado.
 */
export function parsePhone(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") {
    throw new HttpError(400, "Telefone inválido.");
  }
  if (valor.trim().length === 0) return null;
  const telefone = valor.trim().replace(/\s+/g, " ");
  if (!/^[0-9+() -]{6,30}$/.test(telefone)) {
    throw new HttpError(400, "Telefone aceita apenas dígitos, espaços e os caracteres + ( ) -, com até 30 caracteres.");
  }
  if ((telefone.match(/\d/g) ?? []).length < 8) {
    throw new HttpError(400, "Telefone deve ter ao menos 8 dígitos.");
  }
  return telefone;
}

/** Empresa (opcional): texto de uma linha, ate 200 caracteres; vazio = `null`. */
export function parseCompany(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") throw new HttpError(400, "Empresa inválida.");
  const empresa = valor.trim().replace(/\s+/g, " ");
  if (empresa.length === 0) return null;
  if (empresa.length > 200) throw new HttpError(400, "A empresa deve ter até 200 caracteres.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(empresa)) throw new HttpError(400, "Empresa inválida.");
  return empresa;
}

/** Corpo de criar/editar. Allowlist fechada; identidade e origem nunca vem do cliente. */
export function parseExternalParticipantInput(body: unknown): ExternalParticipantInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;
  for (const chave of Object.keys(dados)) {
    if (!(CAMPOS as readonly string[]).includes(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser informado para participante externo.`);
    }
  }

  if (typeof dados.fullName !== "string" || dados.fullName.trim().length === 0) {
    throw new HttpError(400, "Informe o nome completo do participante.");
  }
  const fullName = dados.fullName.trim().replace(/\s+/g, " ");
  if (fullName.length < 2 || fullName.length > 200) {
    throw new HttpError(400, "O nome deve ter entre 2 e 200 caracteres.");
  }

  return {
    fullName,
    email: parseEmail(dados.email),
    phone: parsePhone(dados.phone),
    company: parseCompany(dados.company),
    classificacoes:
      dados.governanceBodyIds === undefined && dados.topicIds === undefined ? null : parseClassificacoes(dados),
  };
}

// ---------------------------------------------------------------------------
// Duplicidade com identidades conhecidas
// ---------------------------------------------------------------------------

/**
 * Resultado da checagem no diretorio Microsoft — INTEGRIDADE, nao busca.
 *   clear        nao ha ninguem com o e-mail no diretorio: pode cadastrar
 *   found        ha — a pessoa e corporativa e e escolhida pelo diretorio
 *   unavailable  nao foi possivel verificar (Graph ausente/fora do ar)
 *
 * FAIL CLOSED: `unavailable` RECUSA o cadastro. Participante externo so existe
 * se ficar comprovado que a pessoa nao pertence ao tenant.
 */
export type DirectoryCheck = "clear" | "found" | "unavailable";
export type DirectoryChecker = (email: string) => Promise<DirectoryCheck>;

export const verificarNoDiretorio: DirectoryChecker = async (email) => {
  const config = getGraphConfig();
  if (!config) return "unavailable";
  try {
    return (await findDirectoryUsersByEmail(config, email)).length > 0 ? "found" : "clear";
  } catch {
    // Detalhe do Graph (resposta, tenant, token) nunca sai daqui.
    return "unavailable";
  }
};

export const MSG_EMAIL_CORPORATIVO =
  "Este e-mail já pertence ao diretório corporativo. Essa pessoa pode ser selecionada diretamente nas reuniões.";
export const MSG_VALIDACAO_INDISPONIVEL =
  "Não foi possível validar se este e-mail já pertence ao diretório corporativo. Tente novamente em alguns minutos.";

/** Decisao sobre o resultado do diretorio. Pura, para ser testada. */
export function exigirForaDoDiretorio(check: DirectoryCheck): void {
  if (check === "found") throw new HttpError(409, MSG_EMAIL_CORPORATIVO);
  if (check === "unavailable") throw new HttpError(503, MSG_VALIDACAO_INDISPONIVEL);
}

async function exigirSemDuplicidade(
  client: PoolClient,
  input: ExternalParticipantInput,
  checker: DirectoryChecker,
  ignorarId: string | null,
): Promise<void> {
  const { rows: locais } = await client.query(
    "SELECT 1 FROM external_participants WHERE lower(email) = lower($1) AND ($2::uuid IS NULL OR id <> $2)",
    [input.email, ignorarId],
  );
  if (locais.length > 0) {
    throw new HttpError(409, "Já existe participante do PGCP com este e-mail.");
  }

  // Pessoa que ja entrou no PGCP (identidade Entra conhecida localmente).
  const { rows: usuarios } = await client.query(
    "SELECT 1 FROM users WHERE lower(email) = lower($1) OR lower(upn) = lower($1) LIMIT 1",
    [input.email],
  );
  if (usuarios.length > 0) throw new HttpError(409, MSG_EMAIL_CORPORATIVO);

  // Antes de qualquer INSERT/UPDATE: falha aqui nao grava nada.
  exigirForaDoDiretorio(await checker(input.email));
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  company: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `
  SELECT ep.id, ep.full_name, ep.email, ep.phone, ep.company,
         ep.created_at, ep.updated_at
    FROM external_participants ep
`;

function toParticipant(row: Row, vinculos: VinculosLidos | undefined): ExternalParticipant {
  return {
    id: row.id,
    origin: "pgcp",
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    governanceBodies: vinculos?.governanceBodies ?? [],
    topics: vinculos?.topics ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listExternalParticipants(query?: string): Promise<ExternalParticipant[]> {
  const termo = typeof query === "string" ? query.trim().slice(0, 100) : "";
  const { rows } = termo
    ? await pool.query<Row>(
        `${SELECT} WHERE ep.full_name ILIKE $1 OR ep.email ILIKE $1 OR ep.company ILIKE $1 ORDER BY ep.full_name, ep.id LIMIT 500`,
        // Curingas do usuario sao escapados: a busca e por substring literal.
        [`%${termo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
      )
    : await pool.query<Row>(`${SELECT} ORDER BY ep.full_name, ep.id LIMIT 500`);
  const vinculos = await lerClassificacoes(pool, "external", rows.map((r) => r.id));
  return rows.map((r) => toParticipant(r, vinculos.get(r.id)));
}

async function findById(client: Pick<PoolClient, "query">, id: string): Promise<ExternalParticipant> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE ep.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Participante não encontrado.");
  const vinculos = await lerClassificacoes(client, "external", [id]);
  return toParticipant(rows[0], vinculos.get(id));
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

export interface Ator {
  userId: string;
  name: string;
}

export interface ResultadoGravacao {
  participant: ExternalParticipant;
}

function assertId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Identificador do participante inválido.");
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
    const code = (error as { code?: string } | null)?.code;
    // Corrida entre duas gravacoes do mesmo e-mail: o indice unico decide.
    if (code === "23505") throw new HttpError(409, "Já existe participante do PGCP com este e-mail.");
    if (code === "23503") throw new HttpError(404, "Órgão colegiado ou tema não encontrado.");
    throw error;
  } finally {
    client.release();
  }
}


export async function createExternalParticipant(
  input: ExternalParticipantInput,
  ator: Ator,
  checker: DirectoryChecker = verificarNoDiretorio,
): Promise<ResultadoGravacao> {
  return emTransacao(async (client) => {
    if (input.classificacoes) await exigirExistencia(client, input.classificacoes);
    await exigirSemDuplicidade(client, input, checker, null);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_participants (full_name, email, phone, company, created_by_user_id)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.fullName, input.email, input.phone, input.company, ator.userId],
    );
    // `governance_body_id` (026) depreciada: orgaos vivem em participant_governance_bodies.
    if (input.classificacoes) {
      await gravarClassificacoes(client, { tipo: "external", id: rows[0]!.id }, input.classificacoes);
    }

    // Trilha sem e-mail/telefone: nome e id bastam para auditar o ato.
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Participante criado",
      entityType: "external_participant",
      entityId: rows[0]!.id,
      entityLabel: input.fullName,
      status: "success",
    });

    return { participant: await findById(client, rows[0]!.id) };
  });
}

export async function updateExternalParticipant(
  id: string,
  input: ExternalParticipantInput,
  ator: Ator,
  checker: DirectoryChecker = verificarNoDiretorio,
): Promise<ResultadoGravacao> {
  assertId(id);
  return emTransacao(async (client) => {
    const { rows: atual } = await client.query<{ email: string }>(
      "SELECT email FROM external_participants WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!atual[0]) throw new HttpError(404, "Participante não encontrado.");
    if (input.classificacoes) await exigirExistencia(client, input.classificacoes);

    // So revalida (inclusive no diretorio) quando o e-mail muda.
    if (atual[0].email.toLowerCase() !== input.email.toLowerCase()) {
      await exigirSemDuplicidade(client, input, checker, id);
    }

    await client.query(
      `UPDATE external_participants
          SET full_name = $2, email = $3, phone = $4, company = $5, updated_by_user_id = $6
        WHERE id = $1`,
      [id, input.fullName, input.email, input.phone, input.company, ator.userId],
    );
    // Remover vinculo nunca apaga a pessoa; a trilha abaixo consolida o ato.
    if (input.classificacoes) await gravarClassificacoes(client, { tipo: "external", id }, input.classificacoes);

    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Participante atualizado",
      entityType: "external_participant",
      entityId: id,
      entityLabel: input.fullName,
      status: "success",
    });

    return { participant: await findById(client, id) };
  });
}

/**
 * Remove o CADASTRO. Reunioes que ja convidaram a pessoa mantem o snapshot em
 * `meeting_participants` (nome/e-mail daquela sessao) — nada e apagado nelas.
 */
export async function deleteExternalParticipant(id: string, ator: Ator): Promise<void> {
  assertId(id);
  await emTransacao(async (client) => {
    // Preside a Mesa de algum órgão (035, FK RESTRICT)? Recusa com motivo legível.
    const { rows: mesas } = await client.query<{ name: string }>(
      "SELECT name FROM governance_bodies WHERE chair_external_participant_id = $1 ORDER BY name LIMIT 3",
      [id],
    );
    if (mesas.length > 0) {
      throw new HttpError(
        409,
        `Esta pessoa é Presidente da Mesa de: ${mesas.map((m) => m.name).join(", ")}. Troque o presidente do órgão antes de remover o cadastro.`,
      );
    }
    const { rows } = await client.query<{ full_name: string }>(
      "DELETE FROM external_participants WHERE id = $1 RETURNING full_name",
      [id],
    );
    if (!rows[0]) throw new HttpError(404, "Participante não encontrado.");
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Participante removido",
      entityType: "external_participant",
      entityId: id,
      entityLabel: rows[0].full_name,
      status: "success",
    });
  });
}
