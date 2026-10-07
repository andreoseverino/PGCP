/**
 * LOCAL FISICO de reuniao presencial — a COPIA CONGELADA guardada na reuniao.
 *
 * Desde a migration 038 os locais sao cadastrados na Administracao
 * (`meeting_locations`, modulo `meeting-locations/`). A reuniao guarda a
 * referencia (`physical_location_id`) e uma copia do nome e do endereco DO
 * MOMENTO da escolha (`physical_location_snapshot`). Convite (Graph), versoes,
 * PDF e exportacao leem a copia: editar o cadastro depois nao muda nenhuma
 * reuniao ja agendada — so uma nova escolha do local muda.
 *
 * O catalogo fixo da 025 ("sede-matriz", "sede-leopoldo") e a variavel
 * `MEETING_LOCATIONS_ADDRESSES` deixaram de ser usados; as duas sedes viraram
 * locais INATIVOS no cadastro (endereco a completar). Nenhum endereco e
 * inventado: campo ausente simplesmente nao aparece.
 */

export interface LocalFisico {
  /** Id do cadastro (`meeting_locations.id`). */
  id: string;
  name: string;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  /** UF. */
  state: string | null;
  /** CEP so com digitos. */
  postalCode: string | null;
}

const CAMPOS_TEXTO = ["street", "number", "complement", "neighborhood", "city", "state", "postalCode"] as const;

function textoOuNull(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim().length > 0 ? valor.trim() : null;
}

/**
 * Le a copia gravada na reuniao. Defensiva: o jsonb pode vir de versoes
 * anteriores do formato (o backfill da 038 so tem `id` e `name`).
 */
export function lerLocalDaReuniao(bruto: unknown): LocalFisico | null {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;
  const d = bruto as Record<string, unknown>;
  const id = textoOuNull(d.id);
  const name = textoOuNull(d.name);
  if (!id || !name) return null;
  const local: LocalFisico = {
    id,
    name,
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: null,
    state: null,
    postalCode: null,
  };
  for (const campo of CAMPOS_TEXTO) local[campo] = textoOuNull(d[campo]);
  return local;
}

/** "01310100" -> "01310-100". Outro formato volta como veio. */
export function formatarCep(cep: string | null): string | null {
  if (!cep) return null;
  return /^\d{8}$/.test(cep) ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
}

/** "Av. Paulista, 1000" — logradouro e numero. */
export function logradouroComNumero(local: Pick<LocalFisico, "street" | "number">): string | null {
  if (!local.street) return null;
  return local.number ? `${local.street}, ${local.number}` : local.street;
}

/**
 * Endereco em uma linha, so com o que existe:
 * "Av. Paulista, 1000, 10º andar — Bela Vista, São Paulo/SP, CEP 01310-100".
 */
export function enderecoDoLocal(local: LocalFisico): string | null {
  const rua = [logradouroComNumero(local), local.complement].filter(Boolean).join(", ");
  const cidadeUf = [local.city, local.state].filter(Boolean).join("/");
  const cep = formatarCep(local.postalCode);
  const resto = [local.neighborhood, cidadeUf, cep ? `CEP ${cep}` : null].filter(Boolean).join(", ");
  const partes = [rua, resto].filter((p) => p.length > 0);
  return partes.length > 0 ? partes.join(" — ") : null;
}

/**
 * Uma linha legivel para convite, versao e PDF: nome e, se houver, endereco.
 * Nunca completa com dado que nao existe.
 */
export function descreverLocalFisico(local: LocalFisico): string {
  const endereco = enderecoDoLocal(local);
  return endereco ? `${local.name} — ${endereco}` : local.name;
}
