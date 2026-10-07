import { apiRequestBlob } from "./api";

/**
 * EXPORTAÇÃO DO CALENDÁRIO — cliente de `GET /meetings/export`.
 *
 * O servidor decide o conteúdo (sem descrição, sem e-mail), autoriza (usuário
 * ativo, política de leitura de reunião) e monta o nome do arquivo. Aqui só se
 * escolhem formato e filtros — os MESMOS da tela: período e o órgão do
 * contexto global.
 */

import { consultaDaExportacao, type FiltrosDaExportacao } from "./calendar-export-rules";

export { consultaDaExportacao, validarExportacao, type FiltrosDaExportacao, type FormatoDeExportacao } from "./calendar-export-rules";

export async function exportarCalendario(f: FiltrosDaExportacao): Promise<void> {
  const { blob, filename } = await apiRequestBlob(`/meetings/export?${consultaDaExportacao(f)}`, { auth: true });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename ?? `calendario-pgcp.${f.formato}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
