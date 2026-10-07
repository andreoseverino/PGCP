import type { Pool, PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import type { LocalFisico } from "../meetings/locations.js";

/**
 * LOCAIS de reuniao presencial (migration 038) — cadastro da Administracao.
 *
 * Endereco simples, digitado: sem geocodificacao, sem consulta externa de CEP,
 * sem tabela de pais/estado/cidade, sem reserva de sala ou capacidade.
 *
 * SEM EXCLUSAO: o runtime nao tem DELETE na tabela. Inativar tira o local da
 * escolha de reunioes NOVAS; reunioes que ja o usam guardam a propria copia
 * (`meetings.physical_location_snapshot`) e nao mudam.
 *
 * Autorizacao (no router): `PGCP.Assessoria` OU `PGCP.Admin`, a mesma dos
 * outros cadastros funcionais. A lista de locais ATIVOS para o agendamento sai
 * por `GET /meetings/locations` (usuario ativo).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As 27 UFs. Lista fixa de siglas (nao e cadastro de estados). */
export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export interface MeetingLocation {
  id: string;
  name: string;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
  isActive: boolean;
  /** Reunioes que referenciam o local (so informativo; nada e apagado). */
  meetingsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingLocationInput {
  name: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string | null;
  city: string;
  state: string;
  postalCode: string;
  notes: string | null;
}

export interface Ator {
  userId: string;
  name: string;
}

type Db = Pick<Pool, "connect" | "query">;

// ---------------------------------------------------------------------------
// Validacao
// ---------------------------------------------------------------------------

const CAMPOS = [
  "name", "street", "number", "complement", "neighborhood", "city", "state", "postalCode", "notes",
] as const;

// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u001F\u007F]/;

function texto(
  dados: Record<string, unknown>,
  campo: string,
  rotulo: string,
  { min, max, obrigatorio }: { min: number; max: number; obrigatorio: boolean },
): string | null {
  const valor = dados[campo];
  if (valor === undefined || valor === null || (typeof valor === "string" && valor.trim() === "")) {
    if (obrigatorio) throw new HttpError(400, `Informe ${rotulo}.`);
    return null;
  }
  if (typeof valor !== "string") throw new HttpError(400, `Campo '${campo}' inválido.`);
  const limpo = valor.trim().replace(/[ \t]+/g, " ");
  if (campo !== "notes" && CONTROLE.test(limpo)) throw new HttpError(400, `Campo '${campo}' inválido.`);
  // Observacao aceita quebra de linha; nenhum outro controle.
  if (campo === "notes" && /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/.test(limpo)) {
    throw new HttpError(400, "Observação inválida.");
  }
  if (limpo.length < min || limpo.length > max) {
    throw new HttpError(400, `${rotulo[0]!.toUpperCase()}${rotulo.slice(1)} deve ter entre ${min} e ${max} caracteres.`);
  }
  return limpo;
}

/** CEP: "01310-100" ou "01310100" -> "01310100". */
export function parseCep(valor: unknown): string {
  if (typeof valor !== "string" || valor.trim() === "") throw new HttpError(400, "Informe o CEP.");
  const cep = valor.trim();
  if (!/^\d{5}-?\d{3}$/.test(cep)) throw new HttpError(400, "CEP inválido: use 8 dígitos (ex.: 01310-100).");
  return cep.replace("-", "");
}

export function parseUf(valor: unknown): string {
  if (typeof valor !== "string" || valor.trim() === "") throw new HttpError(400, "Informe o estado (UF).");
  const uf = valor.trim().toUpperCase();
  if (!(UFS as readonly string[]).includes(uf)) throw new HttpError(400, "Estado inválido: use a sigla da UF (ex.: SP).");
  return uf;
}

/** Corpo de criar/editar. Allowlist fechada: status, autoria e id nunca vem do corpo. */
export function parseMeetingLocationInput(body: unknown): MeetingLocationInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;
  for (const chave of Object.keys(dados)) {
    if (!(CAMPOS as readonly string[]).includes(chave)) {
      throw new HttpError(400, `O campo '${chave}' não pode ser informado para local.`);
    }
  }
  return {
    name: texto(dados, "name", "o nome do local", { min: 2, max: 120, obrigatorio: true })!,
    street: texto(dados, "street", "o logradouro", { min: 2, max: 200, obrigatorio: true })!,
    number: texto(dados, "number", "o número", { min: 1, max: 20, obrigatorio: true })!,
    complement: texto(dados, "complement", "o complemento", { min: 1, max: 120, obrigatorio: false }),
    neighborhood: texto(dados, "neighborhood", "o bairro", { min: 1, max: 120, obrigatorio: false }),
    city: texto(dados, "city", "a cidade", { min: 2, max: 120, obrigatorio: true })!,
    state: parseUf(dados.state),
    postalCode: parseCep(dados.postalCode),
    notes: texto(dados, "notes", "a observação", { min: 1, max: 500, obrigatorio: false }),
  };
}

/** Corpo de ativar/inativar: `{ isActive: boolean }` e nada mais. */
export function parseStatusInput(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "O corpo da requisição deve ser um objeto.");
  }
  const dados = body as Record<string, unknown>;
  const extras = Object.keys(dados).filter((k) => k !== "isActive");
  if (extras.length > 0) throw new HttpError(400, `O campo '${extras[0]}' não pode ser informado.`);
  if (typeof dados.isActive !== "boolean") throw new HttpError(400, "Informe 'isActive' (true ou false).");
  return dados.isActive;
}

export function assertLocationId(id: unknown): string {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new HttpError(400, "Identificador do local inválido.");
  return id.toLowerCase();
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  notes: string | null;
  is_active: boolean;
  meetings_count: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `
  SELECT l.id, l.name, l.street, l.number, l.complement, l.neighborhood, l.city, l.state,
         l.postal_code, l.notes, l.is_active, l.created_at, l.updated_at,
         (SELECT count(*) FROM meetings m WHERE m.physical_location_id = l.id) AS meetings_count
    FROM meeting_locations l
`;

function toLocation(r: Row): MeetingLocation {
  return {
    id: r.id,
    name: r.name,
    street: r.street,
    number: r.number,
    complement: r.complement,
    neighborhood: r.neighborhood,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
    notes: r.notes,
    isActive: r.is_active,
    meetingsCount: Number(r.meetings_count),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Lista da Administracao: ativos e inativos. */
export async function listMeetingLocations(db: Pick<Pool, "query"> = pool): Promise<MeetingLocation[]> {
  const { rows } = await db.query<Row>(`${SELECT} ORDER BY l.is_active DESC, lower(l.name), l.id LIMIT 1000`);
  return rows.map(toLocation);
}

/** Copia que a reuniao guarda (sem observacao interna nem status). */
export function copiaDoLocal(r: Pick<Row, "id" | "name" | "street" | "number" | "complement" | "neighborhood" | "city" | "state" | "postal_code">): LocalFisico {
  return {
    id: r.id,
    name: r.name,
    street: r.street,
    number: r.number,
    complement: r.complement,
    neighborhood: r.neighborhood,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
  };
}

/**
 * Locais ATIVOS para o agendamento (`GET /meetings/locations`). So o necessario
 * para escolher: nome e endereco; sem observacao, autoria ou contagens.
 */
export async function listActiveMeetingLocations(db: Pick<Pool, "query"> = pool): Promise<LocalFisico[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, name, street, number, complement, neighborhood, city, state, postal_code
       FROM meeting_locations WHERE is_active ORDER BY lower(name), id`,
  );
  return rows.map(copiaDoLocal);
}

/**
 * Valida a ESCOLHA de local para uma reuniao e devolve a copia a gravar.
 *
 * Local novo precisa existir e estar ATIVO. Manter o local que a reuniao ja
 * tem (mesmo inativado depois) nao passa por aqui: quem chama preserva a copia
 * antiga, sem reler o cadastro — e isso que mantem o endereco historico.
 */
export async function resolverLocalParaReuniao(
  executor: Pick<PoolClient, "query">,
  idBruto: unknown,
): Promise<LocalFisico> {
  const id = assertLocationId(idBruto);
  const { rows } = await executor.query<Row>(
    `SELECT id, name, street, number, complement, neighborhood, city, state, postal_code, is_active
       FROM meeting_locations WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, "Local não encontrado.");
  if (!r.is_active) throw new HttpError(400, "Este local está inativo e não pode ser escolhido para reuniões.");
  return copiaDoLocal(r);
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

async function emTransacao<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = (await db.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const e = error as { code?: string; constraint?: string } | null;
    if (e?.code === "23505") throw new HttpError(409, "Já existe local com este nome.");
    if (e?.code === "23514" && e.constraint === "meeting_locations_active_address_check") {
      throw new HttpError(409, "Complete o endereço do local antes de ativá-lo.");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function buscar(client: Pick<PoolClient, "query">, id: string): Promise<MeetingLocation> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE l.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Local não encontrado.");
  return toLocation(rows[0]);
}

export async function createMeetingLocation(
  input: MeetingLocationInput,
  ator: Ator,
  db: Db = pool,
): Promise<MeetingLocation> {
  return emTransacao(db, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO meeting_locations
              (name, street, number, complement, neighborhood, city, state, postal_code, notes, is_active, created_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
         RETURNING id`,
      [input.name, input.street, input.number, input.complement, input.neighborhood, input.city,
        input.state, input.postalCode, input.notes, ator.userId],
    );
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Local criado",
      entityType: "meeting_location",
      entityId: rows[0]!.id,
      entityLabel: input.name,
      status: "success",
    });
    return buscar(client, rows[0]!.id);
  });
}

/**
 * Edita o CADASTRO. Reunioes ja agendadas nao mudam (copia congelada); so as
 * proximas escolhas deste local levam o endereco novo.
 */
export async function updateMeetingLocation(
  idBruto: string,
  input: MeetingLocationInput,
  ator: Ator,
  db: Db = pool,
): Promise<MeetingLocation> {
  const id = assertLocationId(idBruto);
  return emTransacao(db, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE meeting_locations
          SET name = $2, street = $3, number = $4, complement = $5, neighborhood = $6,
              city = $7, state = $8, postal_code = $9, notes = $10, updated_by_user_id = $11
        WHERE id = $1`,
      [id, input.name, input.street, input.number, input.complement, input.neighborhood,
        input.city, input.state, input.postalCode, input.notes, ator.userId],
    );
    if (!rowCount) throw new HttpError(404, "Local não encontrado.");
    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Local atualizado",
      entityType: "meeting_location",
      entityId: id,
      entityLabel: input.name,
      status: "success",
    });
    return buscar(client, id);
  });
}

/** Ativa/inativa. Nunca apaga: reunioes que usam o local continuam legiveis. */
export async function setMeetingLocationActive(
  idBruto: string,
  ativo: boolean,
  ator: Ator,
  db: Db = pool,
): Promise<MeetingLocation> {
  const id = assertLocationId(idBruto);
  return emTransacao(db, async (client) => {
    const { rows } = await client.query<{ name: string; is_active: boolean }>(
      "SELECT name, is_active FROM meeting_locations WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!rows[0]) throw new HttpError(404, "Local não encontrado.");
    if (rows[0].is_active !== ativo) {
      await client.query(
        "UPDATE meeting_locations SET is_active = $2, updated_by_user_id = $3 WHERE id = $1",
        [id, ativo, ator.userId],
      );
      await recordAuditIn(client, {
        actorUserId: ator.userId,
        actorName: ator.name,
        action: ativo ? "Local reativado" : "Local inativado",
        entityType: "meeting_location",
        entityId: id,
        entityLabel: rows[0].name,
        status: "success",
      });
    }
    return buscar(client, id);
  });
}
