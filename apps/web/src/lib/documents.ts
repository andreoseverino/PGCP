import { apiRequest } from "./api";
import { downloadMeetingMinutesPdf } from "./meeting-minutes";
import { downloadAnnualAgendaDocument } from "./annual-agendas";
import { consultaDosFiltros, type DocumentoDoPgcp, type FiltrosDaTela } from "./documents-rules";

export * from "./documents-rules";

/** Lista (paginada) a biblioteca central. A API valida e autoriza; aqui só monta a consulta. */
export async function listDocuments(
  filtros: FiltrosDaTela,
  pagina: { limit: number; offset: number },
  signal?: AbortSignal
): Promise<{ documents: DocumentoDoPgcp[]; total: number }> {
  return apiRequest<{ documents: DocumentoDoPgcp[]; total: number }>(`/documents?${consultaDosFiltros(filtros, pagina)}`, {
    auth: true,
    signal
  });
}

/**
 * Baixa pela ROTA DE ORIGEM do documento (Ata da reunião / versão vigente da
 * Agenda Anual), com a autorização dela. Nenhum caminho de arquivo trafega.
 */
export function downloadDocument(d: Pick<DocumentoDoPgcp, "type" | "meeting" | "annualAgenda">) {
  if (d.type === "ata" && d.meeting) return downloadMeetingMinutesPdf(d.meeting.id);
  if (d.type === "agenda_anual" && d.annualAgenda) return downloadAnnualAgendaDocument(d.annualAgenda.id);
  throw new Error("Documento sem origem conhecida.");
}
