/**
 * COMITÊ (substitui a recorrência do tema, 040): além do órgão "dono" do
 * tema/reunião, outros órgãos por onde o tema também deve passar.
 *
 *   todos         marca o tema em TODAS as reuniões já agendadas (não
 *                 canceladas) daquele órgão, nesta chamada — não é um
 *                 vínculo vivo: reunião criada depois não recebe o tema.
 *   especificas   só nas reuniões escolhidas (já agendadas) daquele órgão.
 */
export type ModoComite = "todos" | "especificas";

export interface ComiteVinculo {
  governanceBodyId: string;
  modo: ModoComite;
  /** Obrigatório (não vazio) quando `modo === "especificas"`. */
  meetingIds?: string[];
}
