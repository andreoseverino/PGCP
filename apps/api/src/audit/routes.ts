import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requirePgcpAdmin } from "../authz/app-roles.js";
import { listAuditLogs, parseAuditFilters } from "./read.js";

/**
 * Trilha corporativa — SOMENTE LEITURA.
 *
 * A trilha e escrita pelas proprias operacoes de dominio, dentro da transacao
 * do ato. Nao ha POST, PATCH nem DELETE aqui, e nao devera haver: `audit_logs`
 * e append-only, e uma rota que editasse ou limpasse registro destruiria
 * exatamente aquilo que a tabela existe para provar.
 *
 * AUTORIZACAO: `PGCP.Admin`, e so ela. Ler o historico completo da governanca —
 * quem fez o que, em qual reuniao, com sucesso ou falha — e administracao da
 * plataforma. `PGCP.Assessoria` opera reunioes e NAO abre esta porta; ter
 * conta ativa tampouco.
 */
export const auditLogsRouter = Router();

auditLogsRouter.get("/", requirePgcpAdmin, async (req: Request, res: Response) => {
  try {
    /*
     * O parser da allowlist e do proprio servico: `limit`, `cursor`,
     * `actorUserId`, `entityType`, `entityId`, `dateFrom` e `dateTo`. Parametro
     * fora da lista vira 400 em vez de ser ignorado em silencio.
     *
     * Nao ha filtro por `status` nem por `action`: o servico nao os suporta, e
     * inventa-los aqui exigiria SQL proprio — o oposto de reutilizar a leitura
     * que ja existe e ja foi testada.
     */
    const filtros = parseAuditFilters(req.query as Record<string, unknown>);
    const pagina = await listAuditLogs(filtros);

    /*
     * `nextCursor` codifica (occurred_at, id) — o mesmo par da ordenacao.
     * OFFSET repetiria registros: a trilha recebe escrita o tempo todo, e uma
     * linha nova entre duas requisicoes empurraria a pagina seguinte.
     */
    res.json({
      items: pagina.entries,
      nextCursor: pagina.nextCursor,
      limit: filtros.limit,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("[audit-logs] erro ao listar:", error);
    res.status(500).json({ error: "Erro interno ao consultar a trilha de auditoria." });
  }
});
