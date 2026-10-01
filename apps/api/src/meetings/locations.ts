/**
 * Catalogo de LOCAIS FISICOS de reuniao presencial.
 *
 * Sem tabela de proposito (ver migration 025): sao duas sedes conhecidas, e os
 * enderecos oficiais ainda nao existem no repositorio. O que o produto conhece
 * — o NOME da sede — vive aqui; o ENDERECO vem exclusivamente da configuracao
 * do ambiente, e enquanto ninguem o cadastrar ele simplesmente nao aparece.
 * Nenhum endereco e inventado ou presumido neste arquivo.
 *
 * Configuracao (opcional), uma variavel com JSON por chave de local:
 *
 *   MEETING_LOCATIONS_ADDRESSES='{"sede-matriz":{"address":"...","complement":"...","city":"...","state":"SP"}}'
 *
 * JSON invalido ou campo com tipo errado e ignorado com aviso no log — um erro
 * de configuracao nao pode derrubar a criacao de reunioes, so deixa o local sem
 * endereco (o nome continua indo para o convite).
 *
 * Sede nova = uma linha em `LOCAIS` (e, se houver, o endereco na configuracao).
 * A chave persistida em `meetings.physical_location_key` e validada por esta
 * lista na aplicacao, sem CHECK no banco, para nao exigir migration.
 */

export interface LocalFisico {
  /** Chave estavel persistida na reuniao. Nunca muda depois de usada. */
  id: string;
  name: string;
  address: string | null;
  complement: string | null;
  city: string | null;
  /** UF. */
  state: string | null;
}

const LOCAIS: ReadonlyArray<Pick<LocalFisico, "id" | "name">> = [
  { id: "sede-matriz", name: "Sede Matriz" },
  { id: "sede-leopoldo", name: "Sede Leopoldo" },
];

type EnderecoConfigurado = Partial<Pick<LocalFisico, "address" | "complement" | "city" | "state">>;

/** Texto curto e sem controle; qualquer outra coisa vira `null`. */
function textoDeConfiguracao(valor: unknown, max: number): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  // eslint-disable-next-line no-control-regex
  if (limpo.length === 0 || limpo.length > max || /[\u0000-\u001F\u007F]/.test(limpo)) return null;
  return limpo;
}

/**
 * Le os enderecos da configuracao. Exportada com o texto como parametro para o
 * teste nao depender de `process.env`.
 */
export function lerEnderecosConfigurados(bruto: string | undefined): Map<string, EnderecoConfigurado> {
  const enderecos = new Map<string, EnderecoConfigurado>();
  if (!bruto?.trim()) return enderecos;

  let dados: unknown;
  try {
    dados = JSON.parse(bruto);
  } catch {
    console.warn("[locations] MEETING_LOCATIONS_ADDRESSES nao e JSON valido; enderecos ignorados.");
    return enderecos;
  }
  if (typeof dados !== "object" || dados === null || Array.isArray(dados)) {
    console.warn("[locations] MEETING_LOCATIONS_ADDRESSES deve ser um objeto por chave de local.");
    return enderecos;
  }

  for (const [chave, valor] of Object.entries(dados as Record<string, unknown>)) {
    if (!LOCAIS.some((local) => local.id === chave)) continue;
    if (typeof valor !== "object" || valor === null) continue;
    const v = valor as Record<string, unknown>;
    enderecos.set(chave, {
      address: textoDeConfiguracao(v.address, 300),
      complement: textoDeConfiguracao(v.complement, 200),
      city: textoDeConfiguracao(v.city, 120),
      state: textoDeConfiguracao(v.state, 40),
    });
  }
  return enderecos;
}

export function listarLocaisFisicos(
  configuracao: string | undefined = process.env.MEETING_LOCATIONS_ADDRESSES,
): LocalFisico[] {
  const enderecos = lerEnderecosConfigurados(configuracao);
  return LOCAIS.map((local) => {
    const endereco = enderecos.get(local.id) ?? {};
    return {
      ...local,
      address: endereco.address ?? null,
      complement: endereco.complement ?? null,
      city: endereco.city ?? null,
      state: endereco.state ?? null,
    };
  });
}

export function encontrarLocalFisico(
  chave: string | null | undefined,
  configuracao?: string,
): LocalFisico | null {
  if (!chave) return null;
  return listarLocaisFisicos(configuracao).find((local) => local.id === chave) ?? null;
}

export function localFisicoExiste(chave: string): boolean {
  return LOCAIS.some((local) => local.id === chave);
}

/**
 * Uma linha legivel para convite e PDF: nome e, se configurado, endereco.
 * Nunca completa com dado que nao existe.
 */
export function descreverLocalFisico(local: LocalFisico): string {
  const cidadeUf = [local.city, local.state].filter(Boolean).join("/");
  const partes = [local.address, local.complement, cidadeUf].filter(
    (parte): parte is string => Boolean(parte),
  );
  return partes.length > 0 ? `${local.name} — ${partes.join(", ")}` : local.name;
}
