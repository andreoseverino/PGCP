import type { Meeting } from "../types";
import { ataPendente } from "./dashboard-kpis";

/**
 * Pendências da reunião no Pipeline — regras puras (sem React), afirmáveis em teste.
 *
 * Só alerta o que os dados do servidor permitem determinar:
 *   convite falhou     calendarSyncStatus = failed
 *   convite a atualizar calendarSyncStatus = stale
 *   tema sem duração   agendaItemsWithoutDuration > 0
 *   ata pendente       realizada e Ata não aprovada/encerrada (mesma regra do Painel)
 */

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
