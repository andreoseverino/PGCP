import type { ActionItem, GovernanceBody, Meeting } from "../types";
import type { AnnualAgendaSummary } from "./annual-agendas";
import { classificarPendencia } from "./action-item-adapters";
import { pipelineStage } from "./pipeline";

/**
 * RESUMO OPERACIONAL da Visão Geral — regras puras, sem React.
 *
 * Cada número sai de um eixo que já existe no banco; nada de percentual ou
 * comparação temporal sem cálculo real. Contexto de órgão: "" = Todos.
 *
 *   Órgãos colegiados        órgãos ATIVOS (ou o órgão do contexto)
 *   Pendências de aprovação  Agenda Anual em `pending_approval`
 *                            + pautas de reunião enviadas à validação (`sent`)
 *   FUP vencidos             FUP aberto com prazo vencido (daysLate do servidor)
 *   Reuniões da semana       data entre hoje e hoje+6 (7 dias), ainda não realizada
 *   Atas pendentes           reunião realizada cuja Ata não está aprovada/encerrada
 *   Ações pendentes          todo FUP aberto (inclui os vencidos)
 */

/** `YYYY-MM-DD` + n dias, em aritmética de calendário (sem fuso). */
export function somarDias(ymd: string, dias: number): string {
  const [a, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/**
 * Hoje até hoje+6, inclusive (próximos 7 dias), e ainda exigindo atenção:
 * agendada, em preparação ou em andamento. Realizada/encerrada (Done,
 * Approved, Closed — a etapa "Realizada" do Pipeline) não conta. O modelo não
 * tem status de cancelamento.
 */
export function reuniaoNaSemana(
  meeting: Pick<Meeting, "date" | "status" | "agendaItemsCount" | "agendaValidation">,
  hoje: string
): boolean {
  if (pipelineStage(meeting) === "done") return false;
  return meeting.date >= hoje && meeting.date < somarDias(hoje, 7);
}

/** Realizada (mesma regra do Pipeline) e Ata não aprovada/encerrada — inclusive não iniciada. */
export function ataPendente(
  meeting: Pick<Meeting, "status" | "agendaItemsCount" | "agendaValidation" | "minutesStatus">
): boolean {
  if (pipelineStage(meeting) !== "done") return false;
  return meeting.minutesStatus !== "approved" && meeting.minutesStatus !== "closed";
}

/** FUP ainda aberto. `apiStatus` é a situação persistida; cancelado não conta. */
export function acaoAberta(item: Pick<ActionItem, "apiStatus" | "status">): boolean {
  if (item.apiStatus) return item.apiStatus === "open";
  return item.status !== "Completed";
}

/** Aberto e com prazo vencido (`daysLate` calculado pelo servidor contra `due_date`). */
export function fupVencido(item: ActionItem): boolean {
  return acaoAberta(item) && classificarPendencia(item) === "overdue";
}

/**
 * Órgão de um FUP: o da reunião de origem (`originMeetingId`). FUP sem reunião
 * de origem não tem órgão — com um órgão no contexto, não entra na conta
 * (o texto livre de `origin` não é vínculo).
 */
function fupDoOrgao(item: ActionItem, orgao: string, orgaoDaReuniao: Map<string, string | undefined>): boolean {
  if (!orgao) return true;
  return Boolean(item.originMeetingId) && orgaoDaReuniao.get(item.originMeetingId!) === orgao;
}

export interface ResumoOperacional {
  orgaos: number;
  aprovacoes: number;
  aprovacoesAgendaAnual: number;
  aprovacoesPautas: number;
  fupVencidos: number;
  reunioesSemana: number;
  atasPendentes: number;
  acoesPendentes: number;
}

export function calcularResumoOperacional(dados: {
  orgaoContexto: string;
  hoje: string;
  governanceBodies: readonly GovernanceBody[];
  meetings: readonly Meeting[];
  actionItems: readonly ActionItem[];
  /** `null` = Agenda Anual não carregada (a contagem de aprovações sai sem ela). */
  annualAgendas: readonly AnnualAgendaSummary[] | null;
}): ResumoOperacional {
  const { orgaoContexto: orgao, hoje } = dados;
  const doOrgao = <T,>(id: string | undefined, item: T) => (!orgao || id === orgao ? [item] : []);

  const reunioes = dados.meetings.flatMap((m) => doOrgao(m.governanceBodyId, m));
  const orgaoDaReuniao = new Map(dados.meetings.map((m) => [m.id, m.governanceBodyId]));
  const acoes = dados.actionItems.filter((i) => acaoAberta(i) && fupDoOrgao(i, orgao, orgaoDaReuniao));

  const aprovacoesAgendaAnual = (dados.annualAgendas ?? []).filter(
    (a) => a.status === "pending_approval" && (!orgao || a.governanceBody.id === orgao)
  ).length;
  const aprovacoesPautas = reunioes.filter((m) => m.agendaValidation?.status === "sent").length;

  return {
    orgaos: orgao
      ? dados.governanceBodies.filter((b) => b.id === orgao).length
      : dados.governanceBodies.filter((b) => b.isActive).length,
    aprovacoes: aprovacoesAgendaAnual + aprovacoesPautas,
    aprovacoesAgendaAnual,
    aprovacoesPautas,
    fupVencidos: acoes.filter(fupVencido).length,
    reunioesSemana: reunioes.filter((m) => reuniaoNaSemana(m, hoje)).length,
    atasPendentes: reunioes.filter(ataPendente).length,
    acoesPendentes: acoes.length
  };
}
