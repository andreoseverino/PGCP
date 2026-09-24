import { getInitials } from "./user";
import type { ActionItem } from "../types";

/**
 * Contrato do FUP e tradução para o modelo das telas.
 *
 * Só transformação, sem rede — as chamadas ficam em `action-items.ts`.
 *
 * O ponto central: **atraso não é dado persistido**. O banco guarda `dueDate`
 * (data civil) e devolve `daysLate` calculado contra o `current_date` DELE. O
 * navegador não recalcula: senão cada máquina, com seu relógio e seu fuso,
 * daria uma resposta diferente para a mesma ação.
 */

export type ApiActionItemStatus = "open" | "completed" | "cancelled";

export interface ApiActionItemAssignee {
  userId: string | null;
  userName: string | null;
  name: string | null;
  entraTenantId: string | null;
  entraObjectId: string | null;
}

export interface ApiActionItemOrigin {
  meetingId: string | null;
  meetingTitle: string | null;
  agendaItemId: string | null;
  agendaItemTitle: string | null;
  governanceBody: { id: string; name: string } | null;
  label: string | null;
}

export interface ApiActionItem {
  id: string;
  title: string;
  description: string | null;
  /** VP responsável pelo tema perante a governança. Texto livre. */
  vpResponsavel: string | null;
  assignee: ApiActionItemAssignee;
  origin: ApiActionItemOrigin;
  /** `YYYY-MM-DD`. Data civil: sem horário, sem fuso. */
  dueDate: string | null;
  status: ApiActionItemStatus;
  completedAt: string | null;
  /** DERIVADO pelo servidor. Negativo = ainda no prazo. */
  daysLate: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionItemPayload {
  title?: string;
  description?: string | null;
  vpResponsavel?: string | null;
  dueDate?: string | null;
  assignedUserId?: string | null;
  /** `oid` do Graph. O tenant é acrescentado pelo servidor. */
  assigneeEntraObjectId?: string | null;
  assigneeName?: string | null;
  originMeetingId?: string | null;
  originAgendaItemId?: string | null;
  governanceBodyId?: string | null;
  originLabel?: string | null;
  status?: ApiActionItemStatus;
}

/**
 * Texto que descreve a origem, para exibir.
 *
 * Montado a partir dos vínculos REAIS. O modelo antigo guardava uma string
 * concatenada e depois filtrava a aba FUP da reunião procurando o título dentro
 * dela — o que casava reuniões homônimas e quebrava ao renomear.
 */
export function describeOrigin(origin: ApiActionItemOrigin): string {
  if (origin.agendaItemTitle && origin.meetingTitle) {
    return `${origin.agendaItemTitle} (Reunião: ${origin.meetingTitle})`;
  }
  if (origin.meetingTitle) return `Reunião: ${origin.meetingTitle}`;
  if (origin.governanceBody) return origin.governanceBody.name;
  return origin.label ?? "";
}

/**
 * FUP da API no modelo que as telas consomem.
 *
 * `status` da UI mistura situação e prazo: `Overdue` e `Due Today` são
 * DERIVADOS de `daysLate`, e só `Completed` é situação de verdade. A tradução
 * acontece aqui para nenhuma tela precisar refazê-la.
 */
export function actionItemFromApi(api: ApiActionItem): ActionItem {
  const nome = api.assignee.name ?? api.assignee.userName ?? "";
  const atraso = api.daysLate ?? 0;

  return {
    id: api.id,
    title: api.title,
    origin: describeOrigin(api.origin),
    daysLate: atraso,
    assignedUser: {
      name: nome,
      initials: getInitials(nome),
      entraObjectId: api.assignee.entraObjectId ?? undefined
    },
    status: api.status === "completed" ? "Completed" : atraso > 0 ? "Overdue" : "Due Today",
    // Campos que a UI ainda não exibe, mas que o banco guarda e a tela precisa
    // para editar sem perder informação.
    actionItemId: api.id,
    dueDate: api.dueDate ?? undefined,
    apiStatus: api.status,
    originMeetingId: api.origin.meetingId ?? undefined,
    originAgendaItemId: api.origin.agendaItemId ?? undefined,
    // "Comentários" da tela: reaproveita `description`, campo que já existia
    // no banco e não tinha consumidor nenhum na UI.
    description: api.description ?? undefined,
    vpResponsavel: api.vpResponsavel ?? undefined,
    createdAt: api.createdAt
  };
}

/**
 * Grupos de "Minhas Pendências".
 *
 * DERIVADOS, sempre. Nada disso é gravado: `days_late` vem calculado pelo
 * servidor contra a data DELE (`current_date - due_date`), e a única data
 * persistida é `due_date`. Guardar "vencido" criaria um fato que envelhece
 * sozinho à meia-noite.
 */
export type PendenciaBucket = "overdue" | "dueSoon" | "open";

/** Janela de "vence em breve", em dias. */
export const PENDENCIA_DIAS_PROXIMOS = 3;

export function classificarPendencia(item: ActionItem): PendenciaBucket {
  // Sem prazo não há vencimento: fica entre as demais pendentes, nunca como
  // "vence hoje" — `daysLate` chega 0 quando o servidor mandou nulo.
  if (!item.dueDate) return "open";
  if (item.daysLate > 0) return "overdue";
  if (item.daysLate >= -PENDENCIA_DIAS_PROXIMOS) return "dueSoon";
  return "open";
}

/**
 * Ordem de quem cobra: o que já venceu primeiro, e dentro disso o prazo mais
 * próximo. Sem prazo vai para o fim — não é urgência, é ausência de data.
 */
export function ordenarPendencias(itens: ActionItem[]): ActionItem[] {
  const peso: Record<PendenciaBucket, number> = { overdue: 0, dueSoon: 1, open: 2 };

  return [...itens].sort((a, b) => {
    const grupo = peso[classificarPendencia(a)] - peso[classificarPendencia(b)];
    if (grupo !== 0) return grupo;

    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;

    return a.title.localeCompare(b.title);
  });
}

export interface FupFormInput {
  title: string;
  description?: string;
  /** VP responsável pelo tema perante a governança. Texto livre. */
  vpResponsavel?: string;
  /** Data civil. Quando o formulário só coleta dias, use `daysLateToDueDate`. */
  dueDate?: string;
  /** "Em andamento" (open) ou "Concluído" (completed). Ausente = nasce aberto. */
  status?: "open" | "completed";
  assigneeName: string;
  assigneeEntraObjectId?: string;
  originMeetingId?: string;
  originAgendaItemId?: string;
  governanceBodyId?: string;
  originLabel?: string;
}

const opcional = (v: string | undefined | null) => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * Monta o corpo do POST.
 *
 * O que NÃO entra: `assigneeEntraTenantId` (o tenant é do servidor),
 * `daysLate` (derivado), `initials`, `avatarUrl` e `isCurrentUser` (derivados
 * ou mock), `id` e `createdAt` (o banco gera).
 */
export function buildActionItemPayload(input: FupFormInput): ActionItemPayload {
  return {
    title: input.title.trim(),
    description: opcional(input.description) ?? null,
    vpResponsavel: opcional(input.vpResponsavel) ?? null,
    dueDate: opcional(input.dueDate) ?? null,
    assigneeName: input.assigneeName.trim(),
    assigneeEntraObjectId: opcional(input.assigneeEntraObjectId) ?? null,
    originMeetingId: opcional(input.originMeetingId) ?? null,
    // Pauta sem reunião não é origem válida — a API recusa, e com razão.
    originAgendaItemId: input.originMeetingId ? (opcional(input.originAgendaItemId) ?? null) : null,
    governanceBodyId: opcional(input.governanceBodyId) ?? null,
    originLabel: opcional(input.originLabel) ?? null,
    status: input.status
  };
}

export function describeActionItemError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;

  if (status === 0) {
    return pt
      ? "Não foi possível falar com o servidor. Verifique se a API está no ar."
      : "Could not reach the server.";
  }
  if (status === 400 || status === 404 || status === 409) {
    return mensagem ?? (pt ? "Dados inválidos." : "Invalid data.");
  }
  if (status === 401) return pt ? "Sua sessão expirou. Entre novamente." : "Your session expired.";
  if (status === 403) return pt ? "Sua conta não tem acesso a este recurso." : "No access.";

  return pt
    ? "Não foi possível concluir a operação. Tente novamente."
    : "The operation could not be completed. Please try again.";
}
