import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import {
  createGovernanceBody,
  findGovernanceBody,
  listGovernanceBodies,
  parseInput,
  updateGovernanceBody,
} from "./service.js";

export const governanceBodiesRouter = Router();

/**
 * Orgaos de governanca.
 *
 * AUTENTICADO desde a 4.12b. O modulo ficou anonimo enquanto o frontend ainda
 * nao adquiria token, e isso permitia que qualquer um com acesso de rede a API
 * criasse, renomeasse e desativasse orgao — alem de tornar impossivel dizer
 * QUEM fez, que e o motivo de a trilha nunca ter existido aqui.
 *
 * Autorizacao em camadas, a mesma de /meetings, /directory e /users:
 *
 *   1. Entra "Atribuicao necessaria = Sim" -> quem obtem token
 *   2. requireEntraAuth                    -> token valido para esta API
 *   3. requireActivePgcpUser               -> existe em `users` e esta ativo
 *
 * `requireActivePgcpUser` ja encadeia `requireEntraAuth`; declarar os dois
 * duplicaria a validacao do token.
 *
 * PENDENCIA EXPLICITA — AUTENTICACAO NAO E AUTORIZACAO. Qualquer usuario ativo
 * do PGCP pode hoje criar, renomear, ativar e desativar orgao de governanca.
 * Nao existe no modelo distincao de "pode administrar orgaos": `users` nao tem
 * coluna de papel, e `job_title` e rotulo de exibicao. Antes de producao, essas
 * mutacoes precisam de autorizacao funcional (RBAC). O filtro entra aqui.
 */
governanceBodiesRouter.use(requireActivePgcpUser);

/**
 * Ator da trilha. `requireActivePgcpUser` garante que existe; a checagem cobre
 * o caso impossivel sem mentir sobre quem agiu.
 *
 * `entraTenantId` vem do token ja validado — e o mesmo usado para gravar a
 * identidade Microsoft do Presidente da Mesa, nunca aceito do corpo.
 */
function exigirAtor(req: Request): { id: string; name: string; entraTenantId: string } {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) throw new HttpError(500, "Erro interno ao resolver a identidade.");
  return { id: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

/** Express 5 tipa req.params como string | string[]; o generico fixa como string. */
type IdParam = { id: string };

/**
 * Traduz a excecao em resposta HTTP.
 *
 * HttpError carrega mensagem escrita para o usuario. Qualquer outra coisa e
 * erro inesperado: loga completo no servidor e devolve texto generico, sem
 * stack nem detalhe do PostgreSQL.
 */
function sendError(res: Response, error: unknown, context: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error(`[governance-bodies] ${context}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

governanceBodiesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listGovernanceBodies());
  } catch (error) {
    sendError(res, error, "listar");
  }
});

governanceBodiesRouter.get<IdParam>("/:id", async (req, res) => {
  try {
    res.json(await findGovernanceBody(req.params.id));
  } catch (error) {
    sendError(res, error, "consultar");
  }
});

/*
 * CADASTRO FUNCIONAL. Criar, renomear e desativar orgao e trabalho da Assessoria
 * — e tambem da administracao tecnica, que continua podendo faze-lo.
 *
 * Um orgao desativado some dos filtros e do cadastro de reuniao: efeito amplo
 * demais para ficar com qualquer usuario ativo.
 *
 * A LEITURA (acima) continua aberta: o modal de nova reuniao precisa da lista.
 */
governanceBodiesRouter.post("/", requireAssessoriaOuAdmin, async (req: Request, res: Response) => {
  try {
    const created = await createGovernanceBody(parseInput(req.body), exigirAtor(req));
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error, "criar");
  }
});

/**
 * Atualiza nome e/ou estado. Enviar `isActive` desativa ou reativa o órgão.
 *
 * Não existe DELETE: órgãos são preservados para não quebrar o histórico de
 * reuniões, pautas e ações já vinculadas.
 */
governanceBodiesRouter.put<IdParam>("/:id", requireAssessoriaOuAdmin, async (req, res) => {
  try {
    res.json(await updateGovernanceBody(req.params.id, parseInput(req.body), exigirAtor(req)));
  } catch (error) {
    sendError(res, error, "atualizar");
  }
});

/** JSON malformado vira 400, nao 500. */
export function jsonErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "JSON inválido no corpo da requisição." });
    return;
  }
  next(error);
}
