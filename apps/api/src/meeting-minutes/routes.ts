import type { Request, Response } from "express";
import { HttpError } from "../http-error.js";
import {
  MinutesConflictError,
  clearMinutesBySecretariat,
  findMeetingMinutes,
  parseClearInput,
  parseSaveInput,
  saveMeetingMinutes,
} from "./service.js";

/**
 * Ata da reuniao.
 *
 * Handlers, nao um sub-router: `router.use("/:id/minutes", ...)` NAO casa no
 * Express 5, que trocou o path-to-regexp e deixou de aceitar parametro seguido
 * de segmento literal em `use()`. As rotas irmas sao declaradas direto no
 * roteador de reunioes, e estas seguem o mesmo caminho.
 *
 * O `meetingId` vem SEMPRE da rota, nunca do corpo.
 *
 * TRILHA FORMAL SO NO SANEAMENTO. Salvar rascunho nao gera entrada em
 * `audit_logs` — quem gravou por ultimo e quando fica em `updated_by_user_id`,
 * `updated_at` e `revision`, que e o dado util. O saneamento pela Secretaria e
 * outro caso: e ato de governanca, e a trilha e escrita na mesma transacao.
 *
 * O CONTEUDO DA ATA NUNCA ENTRA EM `audit_logs`.
 *
 * SEM ENDPOINT DE ASSINATURA. Nao existe assinatura real nesta onda, e uma rota
 * que devolvesse sucesso sem assinar nada seria pior do que a ausencia dela.
 */

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof MinutesConflictError) {
    // 409 com o estado atual: o cliente precisa dele para oferecer recarregar
    // sem descartar o que a pessoa digitou.
    res.status(409).json({ error: error.message, code: "minutes_conflict", current: error.atual });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[meeting-minutes] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

/** Reuniao sem Ata devolve vazio com revision 0, sem criar linha. */
export const getMinutesHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await findMeetingMinutes(req.params.id as string));
  } catch (error) {
    sendError(res, error, "consultar");
  }
};

/**
 * PUT porque o recurso e "a Ata desta reuniao": uma so, sempre substituida por
 * inteiro. POST + PATCH separados sugeririam varias atas e edicao parcial.
 */
export const putMinutesHandler = async (req: Request, res: Response): Promise<void> => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const input = parseSaveInput(req.body);
    res.json(await saveMeetingMinutes(req.params.id as string, input, usuario.id));
  } catch (error) {
    sendError(res, error, "gravar");
  }
};

/**
 * POST porque saneamento e um ATO, nao um campo.
 *
 * O ator sai do token, a data sai do banco e o status decorre da regra. O corpo
 * carrega no maximo `expectedRevision`.
 */
export const clearMinutesHandler = async (req: Request, res: Response): Promise<void> => {
  const usuario = req.pgcpUser;
  if (!usuario) {
    res.status(500).json({ error: "Erro interno ao resolver a identidade." });
    return;
  }

  try {
    const input = parseClearInput(req.body);
    res.json(
      await clearMinutesBySecretariat(req.params.id as string, input, {
        id: usuario.id,
        name: usuario.name,
      }),
    );
  } catch (error) {
    sendError(res, error, "sanear");
  }
};
