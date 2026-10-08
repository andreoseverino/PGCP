import { apiRequest, apiRequestBlob } from "./api";
import { consultaDaExportacaoDoTema, type FormatoDoArquivo, type ReuniaoDoTema } from "./topic-meetings-rules";

/**
 * REUNIÕES DE UM TEMA DA BIBLIOTECA — cliente de `/agenda-topics/:id/meetings`
 * (modal aberto pelo selo "N reuniões" do card do tema).
 *
 * O servidor decide o que existe (todas as reuniões em que o tema está na
 * pauta, passadas, futuras e canceladas) e o que sai no arquivo exportado.
 * Rótulos, busca, recorte e seleção: `topic-meetings-rules.ts`.
 */

export * from "./topic-meetings-rules";

export async function listarReunioesDoTema(topicId: string, signal?: AbortSignal): Promise<ReuniaoDoTema[]> {
  const { meetings } = await apiRequest<{ meetings: ReuniaoDoTema[] }>(`/agenda-topics/${topicId}/meetings`, {
    auth: true,
    signal
  });
  return meetings;
}

export async function exportarReunioesDoTema(topicId: string, formato: FormatoDoArquivo, meetingIds?: string[]): Promise<void> {
  const { blob, filename } = await apiRequestBlob(
    `/agenda-topics/${topicId}/meetings/export?${consultaDaExportacaoDoTema(formato, meetingIds)}`,
    { auth: true }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename ?? `reunioes-do-tema.${formato}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
