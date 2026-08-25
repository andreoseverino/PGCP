import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Correlation id disponivel para logs e para o handler de erro. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Id de correlacao da requisicao. Sempre presente apos `requestId`. */
      id?: string;
    }
  }
}

/**
 * Aceita apenas um id enviado pelo cliente que seja curto e de caracteres
 * seguros — senao ele iria para o log e para o cabecalho sem sanitizacao, e um
 * valor forjado poderia injetar conteudo no coletor de logs.
 */
const ID_PERMITIDO = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Correlation / request id.
 *
 * Reaproveita `X-Request-Id` vindo do proxy quando valido (o proxy costuma
 * gera-lo na borda), senao cria um UUID. Devolve no cabecalho da resposta para
 * o cliente e os demais componentes casarem a mesma requisicao. Montado cedo,
 * antes das rotas, para todo log ja ter o id.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const recebido = req.headers["x-request-id"];
  const id = typeof recebido === "string" && ID_PERMITIDO.test(recebido) ? recebido : randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
