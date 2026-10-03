import { HttpError } from "../http-error.js";

/**
 * TÍTULO PADRONIZADO da reunião (030) — sempre montado pelo servidor:
 *
 *   09:00 | Cielo | Reunião Extraordinária do Comitê de Riscos (PRESENCIAL)
 *
 * Hora de início no fuso da reunião, empresa, tipo, órgão (com "do"/"da") e
 * formato. Puro: a mesma regra roda na criação, na reserva da Agenda Anual e
 * em toda edição pelo Pipeline. A prévia da tela (`web/src/lib/meeting-title.ts`)
 * espelha esta função; os testes dos dois lados usam os mesmos exemplos.
 */

export const TIPOS_DE_SESSAO = ["ordinary", "extraordinary"] as const;
export type TipoDeSessao = (typeof TIPOS_DE_SESSAO)[number];

export const EMPRESA_DO_TITULO = "Cielo";

const ROTULO_DO_TIPO: Record<TipoDeSessao, string> = {
  ordinary: "Ordinária",
  extraordinary: "Extraordinária",
};

export function parseTipoDeSessao(valor: unknown, campo = "sessionType"): TipoDeSessao {
  if (typeof valor !== "string" || !(TIPOS_DE_SESSAO as readonly string[]).includes(valor)) {
    throw new HttpError(400, `O campo '${campo}' deve ser 'ordinary' (Ordinária) ou 'extraordinary' (Extraordinária).`);
  }
  return valor as TipoDeSessao;
}

/**
 * "do" ou "da" pelo primeiro substantivo do nome do órgão: Diretoria,
 * Assembleia, Comissão, Câmara... -> "da"; Comitê, Conselho... -> "do".
 */
export function preposicaoDoOrgao(nome: string): "do" | "da" {
  const primeira = nome.trim().split(/\s+/)[0]?.toLocaleLowerCase("pt-BR") ?? "";
  return /(a|ão|ade|ção|são)$/.test(primeira) ? "da" : "do";
}

/** HH:mm no fuso da reunião. */
export function horaLocal(iso: string, fuso: string): string {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hora = partes.find((p) => p.type === "hour")?.value ?? "00";
  const minuto = partes.find((p) => p.type === "minute")?.value ?? "00";
  return `${hora === "24" ? "00" : hora}:${minuto}`;
}

export function montarTituloDaReuniao(dados: {
  startAt: string;
  timezone: string;
  orgao: string;
  tipo: TipoDeSessao;
  modalidade: "online" | "in_person";
}): string {
  const orgao = dados.orgao.trim();
  const formato = dados.modalidade === "in_person" ? "PRESENCIAL" : "VIDEOCONFERÊNCIA";
  return `${horaLocal(dados.startAt, dados.timezone)} | ${EMPRESA_DO_TITULO} | Reunião ${ROTULO_DO_TIPO[dados.tipo]} ${preposicaoDoOrgao(orgao)} ${orgao} (${formato})`;
}
