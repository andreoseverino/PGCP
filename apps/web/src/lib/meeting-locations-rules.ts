/**
 * Regras PURAS de Locais (sem rede), separadas de `meeting-locations.ts` para
 * serem testáveis em Node. A autoridade continua sendo o servidor.
 */

import type { PhysicalLocation } from "../types";

/** Local como a Administração vê (cadastro completo, com status). */
export interface MeetingLocation extends PhysicalLocation {
  notes: string | null;
  isActive: boolean;
  /** Reuniões que usam o local (só informativo). */
  meetingsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingLocationPayload {
  name: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  notes: string;
}

export const LOCAL_VAZIO: MeetingLocationPayload = {
  name: "",
  street: "",
  number: "",
  complement: "",
  neighborhood: "",
  city: "",
  state: "",
  postalCode: "",
  notes: ""
};

/** As 27 UFs (lista fixa de siglas; não é cadastro de estados). */
export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"
] as const;

export function formatarCep(cep: string | null | undefined): string {
  if (!cep) return "";
  const d = cep.replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

/** "Av. Paulista, 1000, 10º andar" — linha da rua. */
export function linhaDaRua(l: Pick<PhysicalLocation, "street" | "number" | "complement">): string {
  const rua = l.street ? (l.number ? `${l.street}, ${l.number}` : l.street) : "";
  return [rua, l.complement].filter(Boolean).join(", ");
}

/** "São Paulo/SP". */
export function cidadeUf(l: Pick<PhysicalLocation, "city" | "state">): string {
  return [l.city, l.state].filter(Boolean).join("/");
}

/** Endereço completo em uma linha; só o que existe. */
export function enderecoCompleto(l: PhysicalLocation): string {
  const cep = formatarCep(l.postalCode);
  const resto = [l.neighborhood, cidadeUf(l), cep ? `CEP ${cep}` : ""].filter(Boolean).join(", ");
  return [linhaDaRua(l), resto].filter(Boolean).join(" — ");
}

/** Rótulo do local: nome e, se houver, endereço (mesma forma do convite). */
export function locationLabel(l: PhysicalLocation): string {
  const endereco = enderecoCompleto(l);
  return endereco ? `${l.name} — ${endereco}` : l.name;
}

/**
 * Texto da opção no seletor: nome + rua/número + cidade/UF, o bastante para
 * distinguir locais de nome parecido.
 */
export function rotuloDaOpcao(l: PhysicalLocation): string {
  const rua = l.street ? (l.number ? `${l.street}, ${l.number}` : l.street) : "";
  const detalhe = [rua, cidadeUf(l)].filter(Boolean).join(" · ");
  return detalhe ? `${l.name} — ${detalhe}` : l.name;
}

/**
 * Opções do seletor: só ATIVOS; o local atual da reunião (copiado na escolha)
 * entra marcado quando não está mais entre os ativos — inativado ou editado —
 * para a edição não trocar o local sem querer.
 */
export function opcoesDeLocal(
  ativos: PhysicalLocation[],
  atual: PhysicalLocation | null | undefined
): Array<{ local: PhysicalLocation; atual: boolean }> {
  const lista = ativos.map((local) => ({ local, atual: false }));
  if (atual && !ativos.some((a) => a.id === atual.id)) lista.unshift({ local: atual, atual: true });
  return lista;
}

export function paraPayload(l: MeetingLocation): MeetingLocationPayload {
  return {
    name: l.name,
    street: l.street ?? "",
    number: l.number ?? "",
    complement: l.complement ?? "",
    neighborhood: l.neighborhood ?? "",
    city: l.city ?? "",
    state: l.state ?? "",
    postalCode: formatarCep(l.postalCode),
    notes: l.notes ?? ""
  };
}

/** Validação local espelhando a API (sem consulta externa de CEP). */
export function validateMeetingLocation(p: MeetingLocationPayload, language: "en" | "pt"): string | null {
  const pt = language === "pt";
  if (p.name.trim().length < 2) return pt ? "Informe o nome do local." : "Enter the location name.";
  if (p.street.trim().length < 2) return pt ? "Informe o logradouro." : "Enter the street.";
  if (!p.number.trim()) return pt ? "Informe o número." : "Enter the number.";
  if (p.city.trim().length < 2) return pt ? "Informe a cidade." : "Enter the city.";
  if (!(UFS as readonly string[]).includes(p.state.trim().toUpperCase())) {
    return pt ? "Selecione o estado (UF)." : "Select the state.";
  }
  if (!/^\d{5}-?\d{3}$/.test(p.postalCode.trim())) {
    return pt ? "CEP inválido: use 8 dígitos (ex.: 01310-100)." : "Invalid postal code: 8 digits (e.g. 01310-100).";
  }
  return null;
}
