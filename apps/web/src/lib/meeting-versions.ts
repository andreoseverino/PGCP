import { apiRequest, apiRequestBlob } from "./api";

/**
 * VERSÕES DA REUNIÃO (034) — "fotografias" auditáveis gravadas pelo servidor a
 * cada alteração relevante. Somente leitura aqui: quem cria versão é o
 * servidor, dentro da transação da alteração.
 */

export interface VersaoDaReuniao {
  id: string;
  number: number;
  changeSummary: string;
  createdAt: string;
  createdBy: { id: string; name: string };
}

export async function listMeetingVersions(meetingId: string, signal?: AbortSignal): Promise<VersaoDaReuniao[]> {
  const { versions } = await apiRequest<{ versions: VersaoDaReuniao[] }>(
    `/meetings/${encodeURIComponent(meetingId)}/versions`,
    { auth: true, signal }
  );
  return versions;
}

export const downloadMeetingVersionPdf = (meetingId: string, versionId: string) =>
  apiRequestBlob(`/meetings/${encodeURIComponent(meetingId)}/versions/${encodeURIComponent(versionId)}/pdf`, { auth: true });
