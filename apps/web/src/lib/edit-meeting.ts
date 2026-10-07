import type { Meeting } from "../types";
import { localToInstant, participantsPayload } from "./meeting-adapters";
import type { UpdateMeetingPayload } from "./meetings";
import { descricaoComoHtml, sanitizarHtml } from "./rich-text";
import type { SessionType } from "./meeting-title";

/**
 * EDIÇÃO DA REUNIÃO — regra única usada pelo Pipeline e pelo Calendário.
 *
 * O PATCH leva SÓ o que mudou. Abrir e salvar sem alterar nada não chama a
 * API: nenhuma auditoria, nenhuma versão nova (034) e nenhum convite
 * marcado para reenvio (o servidor desatualiza o evento por CAMPO enviado).
 */

export interface FormDeEdicao {
  /** "" = reunião antiga sem tipo: título livre. */
  sessionType: SessionType | "";
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  governanceBodyId: string;
  recurrence: string;
  modality: "online" | "in_person";
  physicalLocationId: string;
  /**
   * Participantes no formulário. `participantId` = já gravado na reunião.
   * `null` = a reunião veio sem a lista (resumo): o modal não mexe nela.
   */
  participants: ParticipanteDaEdicao[] | null;
}

export interface ParticipanteDaEdicao {
  participantId?: string;
  /** Acrescentado do grupo do novo órgão (só UX). */
  doOrgao?: boolean;
  name: string;
  role: string;
  confirmed: boolean;
  entraObjectId?: string;
  email?: string;
}

export function formularioDaReuniao(m: Meeting): FormDeEdicao {
  return {
    sessionType: m.sessionType ?? "",
    title: m.title || "",
    description: m.description || "",
    date: m.date || "",
    startTime: m.startTime || "",
    endTime: m.endTime || "",
    governanceBodyId: m.governanceBodyId || "",
    recurrence: m.recurrence || "Single",
    modality: m.modality ?? "online",
    physicalLocationId: m.physicalLocation?.id ?? "",
    participants: m.participants
      ? m.participants.map((p) => ({
          participantId: p.participantId,
          name: p.name,
          role: p.role,
          confirmed: p.confirmed,
          entraObjectId: p.entraObjectId,
          email: p.email
        }))
      : null
  };
}

/** A lista mudou? Compara quem continua (por id) e se há gente nova. */
export function participantesMudaram(base: ParticipanteDaEdicao[] | null, atual: ParticipanteDaEdicao[] | null): boolean {
  if (!base || !atual) return false;
  if (atual.some((p) => !p.participantId)) return true;
  const antes = base.map((p) => p.participantId).filter(Boolean).sort();
  const depois = atual.map((p) => p.participantId).filter(Boolean).sort();
  return antes.length !== depois.length || antes.some((id, i) => id !== depois[i]);
}

const htmlNormalizado = (valor: string | null | undefined) => sanitizarHtml(descricaoComoHtml(valor ?? ""));

export function montarPatchDaEdicao(original: Meeting, f: FormDeEdicao): UpdateMeetingPayload {
  const base = formularioDaReuniao(original);
  const fuso = original.timeZone;
  const patch: UpdateMeetingPayload = {};

  // Com tipo, o servidor monta o título; sem tipo (legado), título livre.
  if (f.sessionType) {
    if (f.sessionType !== base.sessionType) patch.sessionType = f.sessionType;
  } else if (f.title.trim() !== base.title.trim()) {
    patch.title = f.title.trim();
  }

  const inicio = localToInstant(f.date, f.startTime, fuso);
  const fim = localToInstant(f.date, f.endTime, fuso);
  if (inicio !== localToInstant(base.date, base.startTime, fuso)) patch.startAt = inicio;
  if (fim !== localToInstant(base.date, base.endTime, fuso)) patch.endAt = fim;

  if (htmlNormalizado(f.description) !== htmlNormalizado(base.description)) {
    patch.description = htmlNormalizado(f.description) || null;
  }
  if (f.recurrence !== base.recurrence) patch.recurrence = f.recurrence;
  if (f.governanceBodyId && f.governanceBodyId !== base.governanceBodyId) patch.governanceBodyId = f.governanceBodyId;
  // Modalidade/local: vão juntos (o servidor confere a coerência do par).
  if (f.modality !== base.modality || f.physicalLocationId !== base.physicalLocationId) {
    patch.modality = f.modality;
    patch.physicalLocationId = f.modality === "in_person" ? f.physicalLocationId || null : null;
  }
  // Participantes: lista COMPLETA só quando mudou (o servidor aplica a diferença).
  if (f.participants && participantesMudaram(base.participants, f.participants)) {
    patch.participants = f.participants.map((p) =>
      p.participantId ? { id: p.participantId } : participantsPayload([p])[0]!
    );
  }
  return patch;
}
