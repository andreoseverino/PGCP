import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { GraphError } from "../graph/client.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { ownCalendarRateLimit } from "../security/limiters.js";
import { listMyCalendar, parseMyCalendarQuery } from "./my-calendar.js";

export const calendarRouter = Router();

/**
 * Meu Calendário.
 *
 * SOMENTE LEITURA e SOMENTE do próprio usuário. Não existe rota para ler a
 * agenda de outra pessoa: `/me/calendarView` resolve pelo token delegado, e o
 * PGCP nunca escolhe de quem é a agenda que está sendo lida.
 *
 * ABERTO A QUALQUER USUÁRIO ATIVO — de propósito. Ver a própria agenda não é
 * privilégio de assessoria; `PGCP.Assessoria` controla quem AGENDA, não quem
 * consulta o que já tem.
 *
 * Nada aqui é persistido: a agenda pessoal é visualização sob demanda.
 */
calendarRouter.get("/me", requireActivePgcpUser, ownCalendarRateLimit, async (req: Request, res: Response) => {
  const token = req.entraAccessToken;
  if (!token) {
    // `requireActivePgcpUser` garante; a checagem existe para falhar alto caso
    // a cadeia de middleware mude.
    res.status(500).json({ error: "Erro interno ao resolver a credencial da sessão." });
    return;
  }

  try {
    res.json(await listMyCalendar(token, parseMyCalendarQuery(req.query as Record<string, unknown>)));
  } catch (error) {
    if (error instanceof GraphError) {
      res.status(error.status ?? 502).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("[calendar] consultar agenda própria:", error);
    res.status(502).json({ error: "Não foi possível consultar o calendário." });
  }
});
