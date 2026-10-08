import { HttpError } from "../http-error.js";

/**
 * COMITÊ (substitui a recorrência do tema, 040): além do órgão "dono" do
 * tema/reunião, o usuário escolhe outros órgãos de governança por onde o
 * tema também deve passar.
 *
 *   todos         marca o tema em TODAS as reuniões já agendadas (não
 *                 canceladas) daquele órgão, nesta chamada — não é um vínculo
 *                 vivo: reunião criada depois não recebe o tema automaticamente.
 *   especificas   só nas reuniões informadas, confirmadas como daquele órgão.
 *
 * Puro tipo/parse; quem efetivamente cria as pautas é `vincularTemaAComites`
 * (`meetings/committee-fanout.ts`), que depende de `addAgendaItem` — fora
 * daqui para não criar um ciclo de módulos com `meetings/update.ts`.
 */
export interface ComiteVinculoInput {
  governanceBodyId: string;
  modo: "todos" | "especificas";
  /** Obrigatório (não vazio) quando `modo === "especificas"`. */
  meetingIds?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || !UUID_RE.test(valor)) {
    throw new HttpError(400, `'${campo}' deve ser um identificador válido.`);
  }
  return valor;
}

export function parseComitesInput(valor: unknown): ComiteVinculoInput[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor)) throw new HttpError(400, "'comites' deve ser uma lista.");
  if (valor.length > 20) throw new HttpError(400, "'comites' aceita no máximo 20 itens.");

  return valor.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new HttpError(400, `comites[${i}] deve ser um objeto.`);
    }
    const dados = item as Record<string, unknown>;
    const governanceBodyId = uuid(dados.governanceBodyId, `comites[${i}].governanceBodyId`);

    if (dados.modo !== "todos" && dados.modo !== "especificas") {
      throw new HttpError(400, `comites[${i}].modo deve ser 'todos' ou 'especificas'.`);
    }

    if (dados.modo === "especificas") {
      if (!Array.isArray(dados.meetingIds) || dados.meetingIds.length === 0) {
        throw new HttpError(
          400,
          `comites[${i}].meetingIds é obrigatório e não pode ser vazio quando modo = 'especificas'.`,
        );
      }
      const meetingIds = dados.meetingIds.map((m, j) => uuid(m, `comites[${i}].meetingIds[${j}]`));
      return { governanceBodyId, modo: "especificas" as const, meetingIds };
    }

    return { governanceBodyId, modo: "todos" as const };
  });
}
