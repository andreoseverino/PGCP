import type { NextFunction, Request, Response } from "express";
import { logSecurityEvent, safeRoute } from "./security-log.js";

/**
 * Rate limiting por PRINCIPAL AUTENTICADO — camada de aplicacao.
 *
 * Proposito deliberadamente estreito: proteger RECURSOS COMPARTILHADOS que o
 * proxy nao sabe proteger porque nao conhece a identidade. O caso central e o
 * Microsoft Graph — a cota de throttling e do TENANT, entao um unico usuario
 * batendo em `/directory/users` degrada o serdico para todos. Limitar por `oid`
 * exige conhecer o principal, o que so acontece DENTRO da aplicacao.
 *
 * O QUE NAO FICA AQUI: limite volumetrico por IP, burst e protecao contra abuso
 * automatizado anonimo. Isso e da borda (reverse proxy / API Gateway / WAF),
 * que ve o IP e roda antes da aplicacao. Nao duplicamos isso no processo.
 *
 * ESTADO EM MEMORIA, POR PROCESSO. Simples e sem dependencia nova. Limitacao
 * conhecida: com varias instancias, o limite vale por instancia — por isso o
 * teto volumetrico AUTORITATIVO e o da borda; este e defesa por instancia,
 * focada na cota do Graph. Um store compartilhado (Redis) so se justifica se o
 * limite por principal precisar ser global entre instancias.
 *
 * Chave = `oid` do principal. Este middleware roda SEMPRE depois da
 * autenticacao; sem principal (nao deveria ocorrer nessas rotas) cai para o IP.
 */

export interface RateLimitOptions {
  /** Tamanho da janela, em milissegundos. */
  windowMs: number;
  /** Maximo de requisicoes permitidas na janela, por principal. */
  max: number;
  /** Rotulo para log e diagnostico (ex.: "directory-search"). */
  name: string;
  /** Injetavel para teste. Padrao `Date.now`. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Acima disto, faz uma limpeza dos buckets expirados para nao crescer sem fim. */
const LIMPAR_ACIMA_DE = 10_000;

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, name } = options;
  const agora = options.now ?? Date.now;
  const store = new Map<string, Bucket>();

  function purgar(t: number): void {
    for (const [chave, bucket] of store) {
      if (t >= bucket.resetAt) store.delete(chave);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const chave = req.principal?.entraObjectId ?? req.ip ?? "desconhecido";
    const t = agora();

    if (store.size > LIMPAR_ACIMA_DE) purgar(t);

    let bucket = store.get(chave);
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + windowMs };
      store.set(chave, bucket);
    }

    bucket.count += 1;

    const restante = Math.max(0, max - bucket.count);
    const resetSegundos = Math.max(0, Math.ceil((bucket.resetAt - t) / 1000));

    // Cabecalhos do draft IETF de RateLimit. Informam o cliente sem vazar dado.
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(restante));
    res.setHeader("RateLimit-Reset", String(resetSegundos));

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(resetSegundos));
      logSecurityEvent({
        type: "rate_limit",
        message: `Limite de requisicoes atingido em ${name}.`,
        requestId: req.id,
        principalOid: req.principal?.entraObjectId ?? null,
        route: safeRoute(req.method, req.originalUrl),
        status: 429,
        code: "rate_limited",
        detail: { limiter: name, limit: max, windowMs },
      });
      res.status(429).json({
        error: "Muitas requisições em pouco tempo. Aguarde alguns instantes e tente novamente.",
        code: "rate_limited",
      });
      return;
    }

    next();
  };
}
