import type { Meeting } from "../types";

/**
 * Andamento da reunião.
 *
 * A etapa é SEMPRE derivada de sinais reais — nunca armazenada. Isso separa
 * duas coisas que antes se misturavam:
 *
 *   Meeting.status  = situação formal (Scheduled -> In Progress -> Done)
 *   Etapa           = onde o processo está, calculada aqui
 *
 * Antes existiam três mapas duplicados de string->índice, e etapas de tela
 * ("Agenda", "Finalizing", "Minutes") eram gravadas como status.
 */

export type MeetingStage =
  | "preparation"
  | "validation"
  | "in_meeting"
  | "recording"
  | "minutes"
  | "finished";

/**
 * `validation` é uma etapa VISUAL derivada do eixo de validação das pautas
 * (`agendaValidation.status`) — NÃO um `meetings.status` novo. Fica entre
 * Preparação e Em Reunião, dentro da fase pré-reunião.
 */
export const MEETING_STAGES: MeetingStage[] = [
  "preparation",
  "validation",
  "in_meeting",
  "recording",
  "minutes",
  "finished"
];

/*
 * ESTADO DE EXECUÇÃO DA PAUTA: só `meeting_agenda_items.execution_status`.
 *
 * Até a 4.12 estas funções caíam para `cielo_meeting_topics_done_{id}` e
 * `cielo_meeting_topic_states_{id}` quando a pauta não trazia estado próprio —
 * fallback para a massa de demonstração, que deixou de existir quando as
 * reuniões passaram a vir todas do PostgreSQL. As chaves, os helpers de leitura
 * e os geradores de chave saíram junto: eram uma segunda verdade sobre um dado
 * que o banco já responde.
 */

/** IDs de pauta concluídos, conforme o estado persistido. */
export function readDoneTopicIdsFor(meeting: Meeting): string[] {
  return (meeting.agenda ?? [])
    .filter((item) => item.executionStatus === "completed")
    .map((item) => item.id);
}

/** Mesma regra para as adiadas. */
export function readPostponedTopicIdsFor(meeting: Meeting): string[] {
  return (meeting.agenda ?? [])
    .filter((item) => item.executionStatus === "postponed")
    .map((item) => item.id);
}

export interface AgendaProgress {
  /** Pautas efetivamente tratadas. */
  done: number;
  /** Pautas retiradas do fluxo desta reunião sem terem sido tratadas. */
  postponed: number;
  /** Pautas que ainda serão tratadas nesta reunião. */
  remaining: number;
  /** Total de pautas cadastradas. */
  total: number;
  /**
   * Percentual de conclusão, ou `null` quando não há métrica.
   * Ver `getAgendaProgress` para o que compõe o denominador.
   */
  percentage: number | null;
  /**
   * Não há mais pauta a tratar: toda a agenda terminou como Concluída ou
   * Postergada. Falso para reunião sem pauta cadastrada.
   */
  agendaClosed: boolean;
}

/**
 * Progresso da agenda, com conclusão e adiamento como desfechos DISTINTOS.
 *
 * Concluída  = pauta efetivamente tratada nesta reunião.
 * Postergada = pauta retirada do fluxo desta reunião sem ter sido tratada.
 *
 * Postergada nunca entra em `done`. A precedência é a mesma de
 * `getTopicStatus`: se um ID aparecer nas duas listas, vale concluída.
 *
 * DENOMINADOR: o percentual mede conclusão sobre as pautas que PERMANECERAM no
 * fluxo (`total - postponed`), não sobre o total cadastrado. Sem isso, adiar
 * uma pauta tornaria 100% inatingível e o número diria que a reunião ficou
 * incompleta quando na verdade nada restou a tratar. As adiadas seguem
 * visíveis em `postponed` — some do percentual, não do relatório.
 *
 * Devolvemos `percentage: null` — em vez de inventar um número — quando não há
 * pauta cadastrada ou quando nenhuma permaneceu no fluxo (todas adiadas).
 */
export function getAgendaProgress(
  meeting: Meeting,
  doneTopicIds: string[],
  postponedTopicIds: string[] = []
): AgendaProgress {
  const agenda = meeting.agenda || [];
  const total = agenda.length;
  if (total === 0) {
    return { done: 0, postponed: 0, remaining: 0, total: 0, percentage: null, agendaClosed: false };
  }

  const done = agenda.filter((item) => doneTopicIds.includes(item.id)).length;
  const postponed = agenda.filter(
    (item) => !doneTopicIds.includes(item.id) && postponedTopicIds.includes(item.id)
  ).length;
  const remaining = total - done - postponed;

  const tratadas = total - postponed;
  const percentage = tratadas > 0 ? Math.round((done / tratadas) * 100) : null;

  return { done, postponed, remaining, total, percentage, agendaClosed: remaining === 0 };
}

/**
 * Etapa atual do processo.
 *
 * `minutesApproved` vem do ciclo próprio da Ata e é usado apenas para LEITURA:
 * o status da reunião nunca é alterado pela Ata.
 */
export function getMeetingStage(
  meeting: Meeting,
  progress: AgendaProgress,
  minutesApproved: boolean
): MeetingStage {
  if (meeting.status === "Done" || meeting.status === "Closed") {
    return minutesApproved ? "finished" : "minutes";
  }

  if (meeting.status === "In Progress") {
    // Avança para Registro quando não resta pauta a tratar. Adiar é um desfecho
    // válido: a pauta sai do fluxo desta reunião. Antes a condição era
    // `done === total`, e uma única pauta adiada travava a reunião para sempre,
    // porque ela entrava no total e nunca no concluído.
    return progress.agendaClosed ? "recording" : "in_meeting";
  }

  // FASE PRÉ-REUNIÃO (Scheduled, Draft, Needs Approval e o legado Approved).
  //
  // A etapa ativa aqui reflete o eixo de VALIDAÇÃO DAS PAUTAS — derivado de
  // `agendaValidation.status`, nunca um status de reunião novo:
  //
  //   enviada / aprovada  -> etapa "validation" (aprovada = último marco antes
  //                          de a reunião começar; o fluxo avança para "Em
  //                          Reunião" quando o status vira In Progress, acima)
  //   ainda não enviada   -> etapa "preparation"
  const validacao = meeting.agendaValidation?.status;
  if (validacao === "sent" || validacao === "approved") return "validation";
  return "preparation";
}

export const stageIndex = (stage: MeetingStage) => MEETING_STAGES.indexOf(stage);

/**
 * Modo da aba Pautas — derivado SÓ de `meetings.status`, sem status novo.
 *
 *   planejamento  antes da reunião: montar/editar/ordenar a agenda, Biblioteca
 *   execução      `In Progress`: conduzir ao vivo (iniciar/aprovar/adiar/cron.)
 *   resultado     `Done`/`Closed`: leitura do desfecho
 *
 * É de APRESENTAÇÃO, não de autorização: o backend segue exigindo
 * `PGCP.Assessoria` em toda mutação. Esconder um controle é cortesia de UX.
 */
export type PautasMode = "planning" | "execution" | "result";

export function getPautasMode(meeting: Meeting): PautasMode {
  if (meeting.status === "In Progress") return "execution";
  if (meeting.status === "Done" || meeting.status === "Closed") return "result";
  return "planning";
}
