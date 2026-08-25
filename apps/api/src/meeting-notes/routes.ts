import type { Request, Response } from "express";
import { HttpError } from "../http-error.js";
import {
  NotesConflictError,
  findMeetingNotes,
  parseSaveInput,
  saveMeetingNotes,
} from "./service.js";

/**
 * Anotacoes da reuniao.
 *
 * Handlers, nao um sub-router: `router.use("/:id/notes", ...)` NAO casa no
 * Express 5, que trocou o path-to-regexp e deixou de aceitar parametro seguido
 * de segmento literal em `use()`. As rotas irmas (`/:id/agenda-items/...`) sao
 * declaradas direto no roteador de reunioes, e estas seguem o mesmo caminho.
 *
 * O `meetingId` vem SEMPRE da rota, nunca do corpo.
 *
 * SEM AUDITORIA POR GRAVACAO. As anotacoes salvam por autosave: uma entrada em
 * `audit_logs` a cada debounce encheria a trilha de dezenas de registros por
 * reuniao e afogaria as acoes de governanca que ela existe para guardar —
 * agendar, postergar, concluir. Quem gravou por ultimo e quando fica em
 * `meeting_notes.updated_by_user_id` e `updated_at`, que e o dado util e nao
 * duplica o conteudo em lugar nenhum.
 *
 * O conteudo das anotacoes NUNCA entra em `audit_logs`.
 */

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof NotesConflictError) {
    // 409 com o estado atual: o cliente precisa dele para oferecer recarregar
    // sem descartar o que a pessoa digitou.
    res.status(409).json({ error: error.message, code: "notes_conflict", current: error.atual });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[meeting-notes] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

/** Reuniao sem documento devolve vazio com revision 0, sem criar linha. */
export const getNotesHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await findMeetingNotes(req.params.id as string));
  } catch (error) {
    sendError(res, error, "consultar");
  }
};

/**
 * PUT porque o recurso e "o documento de anotacoes desta reuniao": um so, sempre
 * substituido por inteiro. POST + PATCH separados sugeririam varios documentos e
 * edicao parcial, que nao e o caso.
 */
export const putNotesHandler = async (req: Request, res: Response): Promise<void> => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const input = parseSaveInput(req.body);
    res.json(await saveMeetingNotes(req.params.id as string, input, usuario.id));
  } catch (error) {
    sendError(res, error, "gravar");
  }
};
