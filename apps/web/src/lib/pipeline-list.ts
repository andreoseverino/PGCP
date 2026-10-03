import type { Meeting } from "../types";
import { ataPendente } from "./dashboard-kpis";

/**
 * Lista operacional do Pipeline — regras puras (sem React), afirmáveis em teste.
 *
 * Só alerta o que os dados do servidor permitem determinar:
 *   convite falhou     calendarSyncStatus = failed
 *   convite a atualizar calendarSyncStatus = stale
 *   tema sem duração   agendaItemsWithoutDuration > 0
 *   ata pendente       realizada e Ata não aprovada/encerrada (mesma regra do Painel)
 */

export type ModoDoPipeline = "list" | "board";

export const CHAVE_DO_MODO = "pgcp_pipeline_modo";

type Armazenamento = Pick<Storage, "getItem" | "setItem">;

function armazenamentoPadrao(): Armazenamento | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Última escolha do usuário; sem escolha (ou storage indisponível) = Lista. */
export function modoInicialDoPipeline(armazenamento: Armazenamento | null = armazenamentoPadrao()): ModoDoPipeline {
  try {
    return armazenamento?.getItem(CHAVE_DO_MODO) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

export function lembrarModoDoPipeline(modo: ModoDoPipeline, armazenamento: Armazenamento | null = armazenamentoPadrao()): void {
  try {
    armazenamento?.setItem(CHAVE_DO_MODO, modo);
  } catch {
    // Storage bloqueado: a escolha vale só nesta sessão.
  }
}

export type TipoDePendencia = "convite_falhou" | "convite_desatualizado" | "tema_sem_duracao" | "ata_pendente";

export interface Pendencia {
  tipo: TipoDePendencia;
  texto: string;
  grave: boolean;
}

type ReuniaoDaLista = Pick<
  Meeting,
  "status" | "agendaItemsCount" | "agendaValidation" | "minutesStatus" | "calendarSyncStatus" | "agendaItemsWithoutDuration"
>;

export function pendenciasDaReuniao(m: ReuniaoDaLista, language: "en" | "pt" = "pt"): Pendencia[] {
  const pt = language === "pt";
  const lista: Pendencia[] = [];
  if (m.calendarSyncStatus === "failed") {
    lista.push({ tipo: "convite_falhou", texto: pt ? "Convite falhou" : "Invite failed", grave: true });
  } else if (m.calendarSyncStatus === "stale") {
    lista.push({ tipo: "convite_desatualizado", texto: pt ? "Convite a atualizar" : "Invite outdated", grave: false });
  }
  const semDuracao = m.agendaItemsWithoutDuration ?? 0;
  if (semDuracao > 0) {
    lista.push({
      tipo: "tema_sem_duracao",
      texto: pt
        ? `${semDuracao} ${semDuracao === 1 ? "tema sem duração" : "temas sem duração"}`
        : `${semDuracao} topic(s) without duration`,
      grave: false,
    });
  }
  if (ataPendente(m)) lista.push({ tipo: "ata_pendente", texto: pt ? "Ata pendente" : "Minutes pending", grave: false });
  return lista;
}

export interface FiltrosDaLista {
  /** "AAAA-MM-DD" inclusivo; vazio = sem limite. */
  de: string;
  ate: string;
  comPendencias: boolean;
  conviteComFalha: boolean;
}

export const FILTROS_DA_LISTA_VAZIOS: FiltrosDaLista = { de: "", ate: "", comPendencias: false, conviteComFalha: false };

export function aplicarFiltrosDaLista<T extends ReuniaoDaLista & Pick<Meeting, "date">>(reunioes: readonly T[], f: FiltrosDaLista): T[] {
  return reunioes.filter((m) => {
    if (f.de && m.date < f.de) return false;
    if (f.ate && m.date > f.ate) return false;
    if (f.conviteComFalha && m.calendarSyncStatus !== "failed") return false;
    if (f.comPendencias && pendenciasDaReuniao(m).length === 0) return false;
    return true;
  });
}
