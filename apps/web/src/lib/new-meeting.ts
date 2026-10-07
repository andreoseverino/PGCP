import {
  buildCreatePayload,
  type CreateMeetingPayload,
  type CreateOrganizerPayload
} from "./meeting-adapters";
import type { Participant } from "../types";
import type { SessionType } from "./meeting-title";
import { ehHorarioValido } from "./time-options";
import { sanitizarHtml, textoDaDescricao } from "./rich-text";

/**
 * Agendamento pelo CALENDÁRIO — o cadastro inicial, deliberadamente simples.
 *
 * Só o essencial para reservar a agenda e enviar o convite: data, horários,
 * órgão, formato (Presencial/Videoconferência), local (presencial), tipo
 * (Ordinária/Extraordinária), organizador e participantes. O TÍTULO não é
 * digitado: o servidor monta o padrão a partir desses campos (030).
 * Pautas, temas, documentos, decisões, ações e ata NÃO entram aqui: são
 * preparação, e acontecem depois, pelo Pipeline.
 *
 * Puro (sem React, sem rede) para as regras serem afirmáveis em teste.
 */

export type Modality = "online" | "in_person";

/** Texto do aviso de modalidade — exibido no formulário e no resumo. */
export const MODALITY_DISCLAIMER = {
  pt: "Todas as reuniões geram convite de calendário e link do Microsoft Teams. Em reuniões presenciais, o Teams será disponibilizado como contingência e o local físico selecionado será informado no convite.",
  en: "Every meeting generates a calendar invitation and a Microsoft Teams link. For in-person meetings, Teams is provided as a fallback and the selected physical location is included in the invitation."
} as const;

export interface NewMeetingForm {
  /** Ordinária/Extraordinária. "" = ainda não escolhido. */
  sessionType: SessionType | "";
  /** Data local, YYYY-MM-DD. */
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  governanceBodyId: string;
  modality: Modality;
  /** Id do local cadastrado (Administração → Locais). Só no presencial. */
  physicalLocationId: string;
  organizer?: CreateOrganizerPayload;
  /**
   * Descrição (HTML da lista fechada do editor). Vai ao convite do Outlook.
   * O servidor saneia de novo; vazio = sem descrição.
   */
  description?: string;
  participants: Array<
    Pick<Participant, "name" | "role" | "confirmed" | "entraObjectId"> & { email?: string; doOrgao?: boolean }
  >;
  /**
   * A lista já partiu do grupo do órgão (carregado na tela) e foi ajustada pela
   * usuária: o servidor não recoloca ninguém. Falso = servidor inclui o grupo.
   */
  participantsIncludeGroup?: boolean;
}

/**
 * Primeiro problema do formulário, ou `null`. A API revalida tudo; isto só
 * evita uma ida ao servidor para o que já se sabe errado.
 */
export function validateNewMeeting(form: NewMeetingForm, language: "en" | "pt"): string | null {
  const pt = language === "pt";
  if (!form.sessionType) return pt ? "Selecione o tipo: Ordinária ou Extraordinária." : "Select the type: Ordinary or Extraordinary.";
  if (!form.date) return pt ? "Informe a data." : "Enter the date.";
  if (!form.startTime || !form.endTime) {
    return pt ? "Informe os horários de início e término." : "Enter the start and end times.";
  }
  if (!ehHorarioValido(form.startTime) || !ehHorarioValido(form.endTime)) {
    return pt ? "Use horários em intervalos de 5 minutos (HH:mm)." : "Use times in 5-minute steps (HH:mm).";
  }
  if (form.endTime <= form.startTime) {
    return pt
      ? "O horário de término deve ser depois do horário de início."
      : "The end time must be after the start time.";
  }
  if (!form.governanceBodyId) return pt ? "Selecione o órgão de governança." : "Select the governance body.";
  if (form.modality === "in_person" && !form.physicalLocationId) {
    return pt ? "Selecione o local físico da reunião presencial." : "Select the physical location.";
  }
  return null;
}

/**
 * Corpo do `POST /meetings`. NUNCA leva pautas/temas (`agendaItems: []`), e só
 * leva local físico no presencial — a API recusaria local em reunião online.
 */
export function buildNewMeetingPayload(form: NewMeetingForm): CreateMeetingPayload {
  // Sem título no corpo: com `sessionType`, a API monta o padrão e recusaria um título.
  const { title: _semTitulo, ...payload } = buildCreatePayload({
    governanceBodyId: form.governanceBodyId,
    organizer: form.organizer,
    title: "",
    date: form.date,
    startTime: form.startTime,
    endTime: form.endTime,
    timezone: form.timezone,
    participants: form.participants,
    agendaItems: []
  });

  const descricao = form.description ? sanitizarHtml(form.description) : "";
  return {
    ...payload,
    ...(textoDaDescricao(descricao) ? { description: descricao } : {}),
    sessionType: form.sessionType || undefined,
    modality: form.modality,
    ...(form.modality === "in_person" ? { physicalLocationId: form.physicalLocationId } : {}),
    ...(form.participantsIncludeGroup ? { participantsIncludeGroup: true } : {})
  };
}
