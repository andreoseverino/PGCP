/**
 * Resolucao do usuario do PGCP a partir da identidade Microsoft.
 *
 * REGRA CENTRAL: a chave externa e o par (entra_tenant_id, entra_object_id).
 * Nunca e-mail, UPN, preferred_username, name ou sub — todos sao atributos
 * mutaveis, e `sub` ainda e pairwise (muda entre aplicacoes).
 *
 * `users.id` continua sendo a identidade INTERNA: e ela que aparece em todas as
 * FKs do sistema. A identidade Microsoft nunca vaza para as demais tabelas.
 */

import pool from "../database.js";

export interface PgcpUser {
  id: string;
  name: string;
  email: string;
  upn: string | null;
  jobTitle: string | null;
  userType: "internal" | "external";
  isActive: boolean;
}

/** Desfecho da resolucao. Distingue "nao cadastrado" de "desativado". */
export type UserResolution =
  | { status: "ok"; user: PgcpUser }
  | { status: "not_provisioned" }
  | { status: "inactive"; user: PgcpUser };

interface UserRow {
  id: string;
  name: string;
  email: string;
  upn: string | null;
  job_title: string | null;
  user_type: "internal" | "external";
  is_active: boolean;
}

const toUser = (row: UserRow): PgcpUser => ({
  id: row.id,
  name: row.name,
  email: row.email,
  upn: row.upn,
  jobTitle: row.job_title,
  userType: row.user_type,
  isActive: row.is_active,
});

const SELECT_COLUMNS = "id, name, email, upn, job_title, user_type, is_active";

/**
 * Busca EXCLUSIVAMENTE pelo par (tenant, object id).
 *
 * A consulta nao menciona e-mail de proposito: casar por e-mail permitiria que
 * uma conta reciclada no diretorio assumisse o historico de outra pessoa.
 */
export async function findUserByEntraIdentity(
  entraTenantId: string,
  entraObjectId: string,
): Promise<UserResolution> {
  const { rows } = await pool.query<UserRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM users
      WHERE entra_tenant_id = $1
        AND entra_object_id = $2`,
    [entraTenantId, entraObjectId],
  );

  const row = rows[0];
  if (!row) return { status: "not_provisioned" };

  const user = toUser(row);
  return user.isActive ? { status: "ok", user } : { status: "inactive", user };
}

/**
 * Usuario do PGCP para listagem administrativa.
 *
 * NAO inclui `entra_tenant_id` nem `entra_object_id`: a identidade Microsoft
 * serve para autenticar, nao para exibir. A tela nao precisa dela.
 */
export interface PgcpUserListItem extends PgcpUser {
  /** Ultima sincronizacao com o diretorio. `null` enquanto o Graph nao alimenta. */
  syncedAt: string | null;
}

interface UserListRow extends UserRow {
  synced_at: Date | null;
}

/**
 * Usuarios do PGCP — quem foi efetivamente provisionado.
 *
 * NAO e o diretorio corporativo: aqui so aparece quem ja entrou no sistema.
 * O diretorio inteiro vive no Microsoft Graph e e consultado sob demanda.
 *
 * Somente leitura. Ordena por ativos primeiro, depois nome.
 */
export async function listPgcpUsers(): Promise<PgcpUserListItem[]> {
  const { rows } = await pool.query<UserListRow>(
    `SELECT ${SELECT_COLUMNS}, synced_at
       FROM users
      ORDER BY is_active DESC, name ASC`,
  );

  return rows.map((row) => ({
    ...toUser(row),
    syncedAt: row.synced_at ? row.synced_at.toISOString() : null,
  }));
}

// -----------------------------------------------------------------------------
// Provisionamento JIT
// -----------------------------------------------------------------------------

/** Formato minimo de endereco. Nao valida existencia — so descarta lixo. */
const PARECE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type EmailSource = "claim_email" | "preferred_username";

export interface ResolvedEmail {
  email: string;
  /** De onde veio. Registrado na auditoria; o VALOR nunca e logado. */
  source: EmailSource;
}

/**
 * Determina o e-mail a gravar.
 *
 * `users.email` e NOT NULL, mas o claim `email` e OPCIONAL no Entra: so aparece
 * se configurado como optional claim na API registration. O fallback para
 * `preferred_username` exige formato de endereco — sem isso o provisionamento
 * FALHA. Inventar "@company.internal" foi o padrao mockado que removemos.
 *
 * `null` significa: nao ha endereco utilizavel, recuse o acesso.
 */
export function resolveEmail(
  emailClaim: string | null,
  preferredUsername: string | null,
): ResolvedEmail | null {
  if (emailClaim && PARECE_EMAIL.test(emailClaim)) {
    return { email: emailClaim, source: "claim_email" };
  }
  if (preferredUsername && PARECE_EMAIL.test(preferredUsername)) {
    return { email: preferredUsername, source: "preferred_username" };
  }
  return null;
}

export interface ProvisionInput {
  entraTenantId: string;
  entraObjectId: string;
  name: string;
  email: string;
  upn: string | null;
}

export interface ProvisionResult {
  user: PgcpUser;
  /** `false` quando a linha ja existia — inclusive numa corrida perdida. */
  created: boolean;
}

/**
 * Cria o usuario na primeira entrada, de forma IDEMPOTENTE.
 *
 * A unicidade de (entra_tenant_id, entra_object_id) e um indice PARCIAL, entao
 * o `ON CONFLICT` precisa repetir o predicado para o Postgres escolher o indice.
 *
 * `DO NOTHING` — e nao `DO UPDATE` — porque JIT e provisionamento INICIAL, nao
 * sincronizacao: um login nao pode sobrescrever nome ou e-mail ja gravados.
 * Como `DO NOTHING` nao devolve linha em caso de conflito, relemos em seguida:
 * e assim que duas requisicoes simultaneas convergem para o MESMO users.id.
 *
 * `job_title` e `synced_at` ficam nulos: nada veio do diretorio. Preenche-los
 * com o token fingiria uma sincronizacao que nao aconteceu (Etapa 3).
 *
 * Nenhum privilegio e concedido: o modelo nao tem papel funcional global, entao
 * o usuario nasce apenas existindo. Quando houver RBAC, revisar aqui.
 */
export async function provisionUser(input: ProvisionInput): Promise<ProvisionResult> {
  const { rows: inserted } = await pool.query<UserRow>(
    `INSERT INTO users (name, email, upn, user_type, is_active, entra_tenant_id, entra_object_id)
          VALUES ($1, $2, $3, 'internal', true, $4, $5)
     ON CONFLICT (entra_tenant_id, entra_object_id)
             WHERE entra_object_id IS NOT NULL AND entra_tenant_id IS NOT NULL
        DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
    [input.name, input.email, input.upn, input.entraTenantId, input.entraObjectId],
  );

  const row = inserted[0];
  if (row) return { user: toUser(row), created: true };

  // Conflito: a linha ja existia, ou outra requisicao venceu a corrida.
  const existente = await findUserByEntraIdentity(input.entraTenantId, input.entraObjectId);
  if (existente.status === "not_provisioned") {
    // Nao deveria acontecer: o conflito prova que a linha existe.
    throw new Error("Conflito de provisionamento sem linha correspondente.");
  }

  return { user: existente.user, created: false };
}
