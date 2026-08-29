import type { StandaloneAgenda } from "../types";

/**
 * Contrato da Biblioteca de pautas e a tradução para o view model das telas.
 *
 * Só transformação: nenhuma chamada de rede. As chamadas ficam em
 * `agenda-topics.ts`. A separação torna a conversão verificável sem subir
 * servidor — e `api.ts` lê `import.meta.env`, que só existe sob o Vite.
 *
 * Identidade é sempre o UUID do PostgreSQL. Título nunca identifica pauta —
 * duas pautas homônimas são duas pautas.
 */

// -----------------------------------------------------------------------------
// Contrato
// -----------------------------------------------------------------------------

export interface NamedRef {
  id: string;
  name: string;
}

export interface TopicResponsible {
  label: string;
  entraTenantId: string | null;
  entraObjectId: string | null;
}

/** De onde a cópia automática veio. `null` em pauta criada manualmente. */
export interface TopicSource {
  meetingId: string;
  agendaItemId: string;
}

export interface TopicParticipant {
  id: string;
  userId: string | null;
  userName: string | null;
  displayName: string | null;
  email: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
}

/** Reunião em que a pauta está vinculada. Vem da FK, nunca do título. */
export interface LinkedMeeting {
  meetingId: string;
  agendaItemId: string;
  title: string;
  startAt: string;
  executionStatus: string;
}

export interface ApiAgendaTopic {
  id: string;
  title: string;
  description: string | null;
  estimatedDurationMinutes: number | null;
  generatesActionItem: boolean;
  responsible: TopicResponsible | null;
  type: NamedRef | null;
  nature: NamedRef | null;
  governanceBody: NamedRef | null;
  ownerUserId: string | null;
  /** PADRÃO de tema circular. Copiado para a pauta ao vincular a uma reunião. */
  isCircularTheme: boolean;
  source: TopicSource | null;
  isAutomaticCopy: boolean;
  linkedMeetingsCount: number;
  participantsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgendaTopicDetail extends ApiAgendaTopic {
  participants: TopicParticipant[];
  linkedMeetings: LinkedMeeting[];
}

export interface TaxonomyItem {
  id: string;
  name: string;
  isActive: boolean;
  /** Quantas pautas referenciam. Governa o que pode ser excluído. */
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export type TaxonomyKind = "types" | "natures";

// -----------------------------------------------------------------------------
// Payloads
// -----------------------------------------------------------------------------

export interface TopicParticipantPayload {
  userId?: string;
  /** `oid` do Graph. O tenant é acrescentado pelo servidor, nunca pelo browser. */
  entraObjectId?: string;
  displayName?: string;
  email?: string;
}

export interface AgendaTopicPayload {
  title?: string;
  description?: string | null;
  estimatedDurationMinutes?: number | null;
  generatesActionItem?: boolean;
  responsibleLabel?: string | null;
  responsibleEntraObjectId?: string | null;
  /** IDENTIDADE do tipo, não o rótulo. */
  agendaTopicTypeId?: string | null;
  agendaTopicNatureId?: string | null;
  governanceBodyId?: string | null;
  /** PADRÃO de tema circular do tema mestre. Booleano estrito no servidor. */
  isCircularTheme?: boolean;
  participants?: TopicParticipantPayload[];
}

/** Hidrata o formulário de edição a partir do detalhe canônico da API. */
export function topicParticipantsToPayload(
  participants: readonly TopicParticipant[],
): TopicParticipantPayload[] {
  return participants.map((participant) => ({
    ...(participant.userId ? { userId: participant.userId } : {}),
    ...(participant.entraObjectId ? { entraObjectId: participant.entraObjectId } : {}),
    ...(participant.displayName ?? participant.userName
      ? { displayName: participant.displayName ?? participant.userName ?? undefined }
      : {}),
    ...(participant.email ? { email: participant.email } : {}),
  }));
}

/**
 * Reflexo imediato da invariante na Biblioteca. A API repete a garantia dentro
 * da transação; aqui apenas evitamos que o formulário mostre um estado que o
 * backend nunca aceitaria persistir.
 */
export function ensureResponsibleTopicParticipant(
  participants: readonly TopicParticipantPayload[],
  responsibleLabel: string | null | undefined,
  responsibleEntraObjectId: string | null | undefined,
): TopicParticipantPayload[] {
  const displayName = responsibleLabel?.trim();
  const entraObjectId = responsibleEntraObjectId?.trim();
  if (!displayName || !entraObjectId) return [...participants];

  const normalized = entraObjectId.toLowerCase();
  if (participants.some((participant) => participant.entraObjectId?.toLowerCase() === normalized)) {
    return [...participants];
  }
  return [...participants, { entraObjectId, displayName }];
}

export function isResponsibleTopicParticipant(
  participant: TopicParticipantPayload,
  responsibleEntraObjectId: string | null | undefined,
): boolean {
  const participantOid = participant.entraObjectId?.trim().toLowerCase();
  const responsibleOid = responsibleEntraObjectId?.trim().toLowerCase();
  return Boolean(participantOid && responsibleOid && participantOid === responsibleOid);
}

// -----------------------------------------------------------------------------
// Adaptação para o view model das telas
// -----------------------------------------------------------------------------

const doisDigitos = (n: number) => String(n).padStart(2, "0");

/** Minutos inteiros -> "HH:mm", formato canônico de `agenda-time.ts`. */
const minutosParaDuracao = (minutos: number | null): string =>
  minutos === null || !Number.isFinite(minutos)
    ? ""
    : `${doisDigitos(Math.floor(minutos / 60))}:${doisDigitos(minutos % 60)}`;

/**
 * Pauta da API no formato que a Biblioteca consome.
 *
 * `StandaloneAgenda` sobrevive como view model para não exigir reescrita das
 * telas, mas TODOS os dados vêm da API. Campos que o modelo antigo tinha e o
 * banco não guarda simplesmente não aparecem:
 *
 *   `category`   — a auditoria provou que não tinha consumidor;
 *   `meetingId`  — vínculo é `meeting_agenda_items.agenda_topic_id`, e vem em
 *                  `linkedMeetingsCount` / `linkedMeetings`;
 *   `authorId`   — id de um mock de diretório que não existe mais.
 */
export function agendaTopicToStandalone(t: ApiAgendaTopic): StandaloneAgenda {
  return {
    id: t.id,
    title: t.title,
    duration: minutosParaDuracao(t.estimatedDurationMinutes),
    author: t.responsible?.label ?? "",
    authorEntraObjectId: t.responsible?.entraObjectId ?? undefined,
    description: t.description ?? "",
    createdAt: new Date(t.createdAt).toLocaleDateString("pt-BR"),
    isFUP: t.generatesActionItem,
    pautaTypeId: t.type?.id,
    pautaType: t.type?.name,
    pautaNatureId: t.nature?.id,
    pautaNature: t.nature?.name,
    isCircularTheme: t.isCircularTheme,
    linkedMeetingsCount: t.linkedMeetingsCount,
    participantsCount: t.participantsCount,
    /*
     * Procedência é EXIBIÇÃO. O frontend não gera, não decide e não a usa para
     * localizar cópia — quem remove a cópia certa é o PostgreSQL, pela chave
     * estrutural, dentro de `POST .../resume`.
     */
    sourceMeetingId: t.source?.meetingId,
    sourceAgendaItemId: t.source?.agendaItemId,
    isAutomaticCopy: t.isAutomaticCopy
  };
}

/** O que o formulário da Biblioteca coleta. */
export interface BibliotecaFormInput {
  title: string;
  description?: string;
  durationMinutes?: number | null;
  responsibleLabel?: string;
  responsibleEntraObjectId?: string;
  /** IDENTIDADE do cadastro, não o rótulo. */
  typeId?: string;
  natureId?: string;
  generatesActionItem?: boolean;
  /** PADRÃO de tema circular. Default Não no formulário. */
  isCircularTheme?: boolean;
  participants?: TopicParticipantPayload[];
}

/** Monta o corpo do POST/PATCH a partir do formulário. */
export function buildTopicPayload(input: BibliotecaFormInput): AgendaTopicPayload {
  const label = input.responsibleLabel?.trim() || undefined;

  return {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    estimatedDurationMinutes: input.durationMinutes ?? null,
    generatesActionItem: input.generatesActionItem ?? false,
    responsibleLabel: label ?? null,
    // Identidade só acompanha rótulo — a API recusa o contrário, e com razão:
    // a tela precisaria do Graph só para escrever quem responde.
    responsibleEntraObjectId: label ? (input.responsibleEntraObjectId ?? null) : null,
    agendaTopicTypeId: input.typeId ?? null,
    agendaTopicNatureId: input.natureId ?? null,
    // Só emite quando o formulário informou o campo. Um PATCH parcial que não o
    // traz (ex.: alternar FUP) NÃO deve zerar um "Sim" já gravado.
    ...(input.isCircularTheme !== undefined ? { isCircularTheme: input.isCircularTheme } : {}),
    ...(input.participants ? { participants: input.participants } : {})
  };
}

/** Mensagem para a usuária, a partir do status HTTP. */
export function describeTopicError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;

  if (status === 0) {
    return pt
      ? "Não foi possível falar com o servidor. Verifique se a API está no ar."
      : "Could not reach the server. Check whether the API is running.";
  }
  // 400, 404 e 409 já vêm com texto do servidor, que sabe qual campo ou qual
  // vínculo impediu a operação.
  if (status === 400 || status === 404 || status === 409) {
    return mensagem ?? (pt ? "Dados inválidos." : "Invalid data.");
  }
  if (status === 401) return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired.";
  if (status === 403) return pt ? "Sua conta não tem acesso a este recurso." : "No access.";

  return pt
    ? "Não foi possível concluir a operação. Tente novamente."
    : "The operation could not be completed. Please try again.";
}
