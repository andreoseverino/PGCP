import { Router, type Request, type Response } from "express";
import {
  DIRECTORY_SEARCH_LIMIT,
  GraphError,
  SEARCH_TERM_MAX,
  SEARCH_TERM_MIN,
  getGraphConfig,
  missingGraphConfig,
  searchDirectoryUsers,
  validateSearchTerm,
} from "../graph/client.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { directorySearchRateLimit } from "../security/limiters.js";

export const directoryRouter = Router();

/**
 * Diretorio corporativo — leitura sob demanda no Microsoft Graph.
 *
 * O Graph e a FONTE do diretorio; o PostgreSQL guarda apenas quem tem relacao
 * real com o PGCP. Esta rota nao cria, nao atualiza e nao reconcilia nada:
 * e estritamente somente leitura.
 *
 * Nomeada por capacidade (`/directory`) e nao por fornecedor (`/graph`): se a
 * fonte do diretorio mudar um dia, o contrato do cliente sobrevive.
 */

const MENSAGENS_INVALIDAS: Record<string, string> = {
  too_short: `Informe ao menos ${SEARCH_TERM_MIN} caracteres para buscar.`,
  too_long: `O termo de busca deve ter no máximo ${SEARCH_TERM_MAX} caracteres.`,
  invalid_characters: "O termo de busca contém caracteres não permitidos.",
};

/**
 * GET /directory/users?q=termo
 *
 * Exige usuario do PGCP autenticado e ativo. Nao ha papel administrativo no
 * modelo, entao qualquer usuario ativo pode consultar — quem controla o acesso
 * a aplicacao e o Entra, via "Atribuicao necessaria = Sim".
 *
 * Contra enumeracao do diretorio: termo obrigatorio, minimo de caracteres,
 * teto de resultados e paginacao limitada. Nao existe consulta que devolva o
 * diretorio inteiro.
 */
directoryRouter.get("/users", requireActivePgcpUser, directorySearchRateLimit, async (req: Request, res: Response) => {
  const validacao = validateSearchTerm(req.query.q);

  if (!validacao.ok) {
    res.status(400).json({
      error: MENSAGENS_INVALIDAS[validacao.reason] ?? "Termo de busca inválido.",
      code: validacao.reason,
    });
    return;
  }

  const config = getGraphConfig();
  if (!config) {
    // Nomes de variaveis apenas; nenhum valor.
    console.warn("[directory] Graph não configurado:", missingGraphConfig().join(", "));
    res.status(503).json({
      error: "A integração com o Microsoft Graph não está configurada nesta instalação.",
      code: "graph_not_configured",
    });
    return;
  }

  try {
    const { users, truncated } = await searchDirectoryUsers(config, validacao.term);

    // O termo e o resultado NAO vao para log: sao dado pessoal.
    res.json({
      users,
      count: users.length,
      limit: DIRECTORY_SEARCH_LIMIT,
      /** Havia mais resultados do que o teto permite trazer. Refine a busca. */
      truncated,
    });
  } catch (error) {
    if (error instanceof GraphError) {
      // 429 vira 503 com Retry-After: para o cliente, o serviço está
      // temporariamente indisponível — o detalhe é de quem chama o Graph.
      const status = error.status === 429 ? 503 : (error.status ?? 502);
      if (error.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }

    console.error("[directory] falha inesperada na busca:", error);
    res.status(500).json({ error: "Erro interno ao consultar o diretório." });
  }
});
