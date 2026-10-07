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

/** Um campo que mudou em relação à versão anterior, pronto para exibir. */
export interface DiferencaDaVersao {
  /** Agrupador para a tela ("Data e horário", "Tema: Orçamento 2027", ...). */
  grupo: string;
  campo: string;
  antes: string | null;
  depois: string | null;
}

export interface MudancasDaVersao {
  version: number;
  previousVersion: number | null;
  changeSummary: string;
  changes: DiferencaDaVersao[];
}

/** O que mudou NESTA versão em relação à anterior, campo a campo. */
export async function getMeetingVersionChanges(
  meetingId: string,
  versionId: string,
  signal?: AbortSignal
): Promise<MudancasDaVersao> {
  return apiRequest<MudancasDaVersao>(
    `/meetings/${encodeURIComponent(meetingId)}/versions/${encodeURIComponent(versionId)}/changes`,
    { auth: true, signal }
  );
}
