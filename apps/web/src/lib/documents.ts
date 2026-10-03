import { apiRequest, apiRequestBlob } from "./api";
import { downloadMeetingMinutesPdf } from "./meeting-minutes";
import { downloadAnnualAgendaDocument } from "./annual-agendas";
import {
  consultaDosFiltros,
  idDoAnexo,
  type ArvoreDeDocumentos,
  type DocumentoDoPgcp,
  type FiltrosDaTela
} from "./documents-rules";

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

/** Documentos de UMA reunião (anexos gerais, dos temas e a Ata), para a aba do Pipeline. */
export async function listMeetingDocuments(meetingId: string, signal?: AbortSignal): Promise<DocumentoDoPgcp[]> {
  const p = new URLSearchParams({ meetingId, sort: "antigos", limit: "200" });
  const r = await apiRequest<{ documents: DocumentoDoPgcp[]; total: number }>(`/documents?${p}`, { auth: true, signal });
  return r.documents;
}

/** Pastas visuais (Órgão → Ano → Agenda Anual | Mês → Reunião), montadas dos metadados. */
export async function getDocumentsTree(governanceBodyId: string, signal?: AbortSignal): Promise<ArvoreDeDocumentos> {
  const q = governanceBodyId ? `?${new URLSearchParams({ governanceBodyId })}` : "";
  return apiRequest<ArvoreDeDocumentos>(`/documents/tree${q}`, { auth: true, signal });
}

/**
 * Baixa pela API, que autoriza pelo contexto a cada pedido: anexo via
 * `/documents/:id/download` (a API lê do armazenamento; nenhuma URL do S3 nem
 * chave de objeto chega ao navegador); Ata e Agenda Anual pela rota de origem.
 */
export function downloadDocument(d: Pick<DocumentoDoPgcp, "id" | "type" | "meeting" | "annualAgenda">) {
  const anexo = idDoAnexo(d);
  if (anexo) return apiRequestBlob(`/documents/${encodeURIComponent(anexo)}/download`, { auth: true });
  if (d.type === "ata" && d.meeting) return downloadMeetingMinutesPdf(d.meeting.id);
  if (d.type === "agenda_anual" && d.annualAgenda) return downloadAnnualAgendaDocument(d.annualAgenda.id);
  throw new Error("Documento sem origem conhecida.");
}

/** Salva o blob baixado com o nome que a API informou (ou o da lista). */
export function salvarArquivo(blob: Blob, nome: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/**
 * Envia um anexo à reunião (ou ao tema DESTA reunião). Corpo = bytes do arquivo
 * (`application/octet-stream`); nome e descrição em cabeçalho, URL-encoded. O
 * servidor valida tipo, conteúdo, tamanho e o contexto, e grava no armazenamento.
 */
export async function uploadMeetingDocument(
  meetingId: string,
  arquivo: File,
  contexto: { agendaItemId?: string | null; descricao?: string },
  signal?: AbortSignal
): Promise<{ id: string; documentId: string; name: string; sizeBytes: number }> {
  const q = contexto.agendaItemId ? `?${new URLSearchParams({ agendaItemId: contexto.agendaItemId })}` : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Document-Filename": encodeURIComponent(arquivo.name)
  };
  const descricao = contexto.descricao?.trim();
  if (descricao) headers["X-Document-Description"] = encodeURIComponent(descricao);
  const r = await apiRequest<{ document: { id: string; documentId: string; name: string; sizeBytes: number } }>(
    `/meetings/${encodeURIComponent(meetingId)}/documents${q}`,
    { auth: true, method: "POST", headers, body: arquivo, signal }
  );
  return r.document;
}
