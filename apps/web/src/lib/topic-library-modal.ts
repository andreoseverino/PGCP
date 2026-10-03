/**
 * Estado do modal de cadastro da Biblioteca de Temas — lógica pura.
 *
 *   fechado   nenhum formulário na tela
 *   novo      "Novo tema"
 *   editar    "Editar tema" de UM tema (identificado pelo `id`)
 *
 * O formulário só existe enquanto o modal está aberto: fechar (Cancelar, X,
 * fundo) ou salvar volta para `fechado` e descarta o que não foi salvo.
 */
import type { ConfirmacaoRemocao } from "./participant-removal";

export type EstadoModalTema =
  | { modo: "fechado" }
  | { modo: "novo" }
  | { modo: "editar"; id: string };

export const MODAL_FECHADO: EstadoModalTema = { modo: "fechado" };

export function abrirNovoTema(): EstadoModalTema {
  return { modo: "novo" };
}

/** Sem `id` não há o que editar: o modal permanece fechado. */
export function abrirEdicaoTema(id: string | null | undefined): EstadoModalTema {
  return id ? { modo: "editar", id } : MODAL_FECHADO;
}

export function modalAberto(estado: EstadoModalTema): boolean {
  return estado.modo !== "fechado";
}

export function idEmEdicao(estado: EstadoModalTema): string | null {
  return estado.modo === "editar" ? estado.id : null;
}

export function tituloDoModalTema(estado: EstadoModalTema, language: "en" | "pt"): string {
  if (estado.modo === "editar") return language === "en" ? "Edit topic" : "Editar tema";
  return language === "en" ? "New topic" : "Novo tema";
}

/**
 * Confirmação de "Excluir tema" da Biblioteca. Só prepara o texto: a regra
 * (tema vinculado a reunião não pode ser excluído) continua no backend, que
 * responde 409 com a mensagem exibida no toast.
 */
export function confirmacaoExclusaoTema(titulo: string, language: "en" | "pt"): ConfirmacaoRemocao {
  if (language === "en") {
    return {
      titulo: "Delete topic from the Library?",
      paragrafos: [
        `The topic "${titulo}" will be removed from the Topic library.`,
        "This action cannot be undone. Do you want to continue?"
      ],
      temas: [],
      acao: "Delete topic"
    };
  }
  return {
    titulo: "Excluir tema da Biblioteca?",
    paragrafos: [
      `O tema “${titulo}” será removido da Biblioteca de Temas.`,
      "Esta ação não poderá ser desfeita. Deseja continuar?"
    ],
    temas: [],
    acao: "Excluir tema"
  };
}
