import {
  buildCreatePayload,
  type CreateMeetingPayload,
  type CreateOrganizerPayload
} from "./meeting-adapters";
import type { Participant } from "../types";

/**
 * Agendamento pelo CALENDÁRIO — o cadastro inicial, deliberadamente simples.
 *
 * Só o essencial para reservar a agenda e enviar o convite: título, data,
 * horários, órgão, modalidade, local (presencial), organizador e participantes.
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
  title: string;
  /** Data local, YYYY-MM-DD. */
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  governanceBodyId: string;
  modality: Modality;
  /** Chave do catálogo. Só no presencial. */
  physicalLocationKey: string;
  organizer?: CreateOrganizerPayload;
  participants: Array<
    Pick<Participant, "name" | "role" | "confirmed" | "entraObjectId"> & { email?: string }
  >;
}

/**
 * Primeiro problema do formulário, ou `null`. A API revalida tudo; isto só
 * evita uma ida ao servidor para o que já se sabe errado.
 */
export function validateNewMeeting(form: NewMeetingForm, language: "en" | "pt"): string | null {
  const pt = language === "pt";
  if (!form.title.trim()) return pt ? "Informe o título da reunião." : "Enter the meeting title.";
  if (!form.date) return pt ? "Informe a data." : "Enter the date.";
  if (!form.startTime || !form.endTime) {
    return pt ? "Informe os horários de início e término." : "Enter the start and end times.";
  }
  if (form.endTime <= form.startTime) {
    return pt
      ? "O horário de término deve ser depois do horário de início."
      : "The end time must be after the start time.";
  }
  if (!form.governanceBodyId) return pt ? "Selecione o órgão de governança." : "Select the governance body.";
  if (form.modality === "in_person" && !form.physicalLocationKey) {
    return pt ? "Selecione o local físico da reunião presencial." : "Select the physical location.";
  }
  return null;
}

/**
 * Corpo do `POST /meetings`. NUNCA leva pautas/temas (`agendaItems: []`), e só
 * leva local físico no presencial — a API recusaria local em reunião online.
 */
export function buildNewMeetingPayload(form: NewMeetingForm): CreateMeetingPayload {
  const payload = buildCreatePayload({
    governanceBodyId: form.governanceBodyId,
    organizer: form.organizer,
    title: form.title,
    date: form.date,
    startTime: form.startTime,
    endTime: form.endTime,
    timezone: form.timezone,
    participants: form.participants,
    agendaItems: []
  });

  return {
    ...payload,
    modality: form.modality,
    ...(form.modality === "in_person" ? { physicalLocationKey: form.physicalLocationKey } : {})
  };
}
