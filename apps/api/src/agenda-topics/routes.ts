import { Router, type Request, type Response } from "express";
import { HttpError } from "../http-error.js";
import { requireActivePgcpUser } from "../users/middleware.js";
import { requireAssessoriaOuAdmin } from "../authz/app-roles.js";
import {
  AGENDA_TOPICS_LIMIT_DEFAULT,
  AGENDA_TOPICS_LIMIT_MAX,
  assertValidId,
  createTaxonomyItem,
  deleteTaxonomyItem,
  findAgendaTopic,
  listAgendaTopics,
  listTaxonomy,
  parseTaxonomyName,
  renameTaxonomyItem,
  setTaxonomyActive,
  type ListTopicsFilters,
  type TaxonomyKind,
} from "./service.js";
import {
  addTopicParticipant,
  createAgendaTopic,
  deleteAgendaTopic,
  parseAgendaTopicInput,
  parseTopicParticipant,
  removeTopicParticipant,
  updateAgendaTopic,
} from "./write.js";

export const agendaTopicsRouter = Router();

/**
 * Biblioteca de pautas — `agenda_topics`.
 *
 * Pauta REUTILIZAVEL, sem contexto de reuniao. Postergar cria aqui uma copia
 * automatica, mas essa operacao vive em /meetings: ela mexe nas duas pontas e
 * precisa ser uma transacao so.
 *
 * Autorizacao: o padrao existente (requireEntraAuth -> requireActivePgcpUser).
 * Nenhum RBAC novo.
 */

function sendError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[agenda-topics] ${contexto}:`, error);
  res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

function atorDa(req: Request) {
  const usuario = req.pgcpUser;
  const principal = req.principal;
  if (!usuario || !principal) return null;
  return { userId: usuario.id, name: usuario.name, entraTenantId: principal.entraTenantId };
}

function mutacao(contexto: string, executar: (req: Request, ator: NonNullable<ReturnType<typeof atorDa>>) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response): Promise<void> => {
    const ator = atorDa(req);
    if (!ator) {
      res.status(500).json({ error: "Erro interno ao resolver a identidade." });
      return;
    }
    try {
      const resultado = await executar(req, ator);
      if (status === 204) res.status(204).end();
      else res.status(status).json(resultado);
    } catch (error) {
      sendError(res, error, contexto);
    }
  };
}

function parseFilters(query: Record<string, unknown>): ListTopicsFilters {
  const filtros: ListTopicsFilters = { limit: AGENDA_TOPICS_LIMIT_DEFAULT };

  const booleano = (valor: unknown, campo: string): boolean | undefined => {
    if (valor === undefined) return undefined;
    if (valor === "true") return true;
    if (valor === "false") return false;
    throw new HttpError(400, `O parâmetro '${campo}' aceita apenas 'true' ou 'false'.`);
  };

  filtros.automatic = booleano(query.automatic, "automatic");
  filtros.generatesActionItem = booleano(query.generatesActionItem, "generatesActionItem");

  for (const campo of ["typeId", "natureId"] as const) {
    const valor = query[campo];
    if (valor === undefined) continue;
    if (typeof valor !== "string") throw new HttpError(400, `'${campo}' deve ser informado uma vez.`);
    filtros[campo] = assertValidId(valor, `O parâmetro '${campo}'`);
  }

  if (query.limit !== undefined) {
    const valor = Number(query.limit);
    if (!Number.isInteger(valor) || valor < 1 || valor > AGENDA_TOPICS_LIMIT_MAX) {
      throw new HttpError(400, `'limit' deve ser um inteiro entre 1 e ${AGENDA_TOPICS_LIMIT_MAX}.`);
    }
    filtros.limit = valor;
  }

  return filtros;
}

// --------------------------------------------------------------- cadastros
//
// Declarados ANTES de /:id — Express casa na ordem, e "types" seria capturado
// como identificador de pauta.

const CADASTROS: Record<string, TaxonomyKind> = { types: "types", natures: "natures" };

function kindDa(req: Request): TaxonomyKind {
  const kind = CADASTROS[req.params.kind as string];
  if (!kind) throw new HttpError(404, "Cadastro não encontrado.");
  return kind;
}

agendaTopicsRouter.get("/taxonomy/:kind", requireActivePgcpUser, async (req, res) => {
  try {
    res.json({ items: await listTaxonomy(kindDa(req)) });
  } catch (error) {
    sendError(res, error, "listar cadastro");
  }
});

/*
 * CADASTROS FUNCIONAIS: tipo e natureza de pauta definem o vocabulario que toda
 * pauta passa a usar. Sao mantidos pela Assessoria — e tambem pela
 * administracao tecnica.
 *
 * A LEITURA acima continua aberta — o cadastro de pauta livre precisa da lista
 * para montar o formulario, e restringi-la quebraria o fluxo normal.
 */
agendaTopicsRouter.post(
  "/taxonomy/:kind",
  requireAssessoriaOuAdmin,
  mutacao("criar cadastro", (req) => createTaxonomyItem(kindDa(req), parseTaxonomyName(req.body)), 201),
);

agendaTopicsRouter.patch(
  "/taxonomy/:kind/:id",
  requireAssessoriaOuAdmin,
  mutacao("atualizar cadastro", (req) => {
    const kind = kindDa(req);
    const id = req.params.id as string;
    const corpo = (req.body ?? {}) as Record<string, unknown>;

    // Renomear e ativar/desativar sao coisas diferentes; aceitar as duas no
    // mesmo corpo esconderia qual delas o cliente quis.
    if ("isActive" in corpo) {
      if (typeof corpo.isActive !== "boolean") {
        throw new HttpError(400, "'isActive' deve ser booleano.");
      }
      return setTaxonomyActive(kind, id, corpo.isActive);
    }
    return renameTaxonomyItem(kind, id, parseTaxonomyName(corpo));
  }),
);

/** Exclusao fisica so quando ninguem referencia; em uso -> 409 e desative. */
agendaTopicsRouter.delete(
  "/taxonomy/:kind/:id",
  requireAssessoriaOuAdmin,
  mutacao("excluir cadastro", async (req) => {
    await deleteTaxonomyItem(kindDa(req), req.params.id as string);
  }, 204),
);

// ---------------------------------------------------------------- pautas

agendaTopicsRouter.get("/", requireActivePgcpUser, async (req: Request, res: Response) => {
  try {
    const filtros = parseFilters(req.query as Record<string, unknown>);
    const topics = await listAgendaTopics(filtros);
    res.json({ topics, count: topics.length, limit: filtros.limit });
  } catch (error) {
    sendError(res, error, "listar");
  }
});

agendaTopicsRouter.post(
  "/",
  requireActivePgcpUser,
  mutacao("criar", (req, ator) => createAgendaTopic(parseAgendaTopicInput(req.body), ator), 201),
);

agendaTopicsRouter.get("/:id", requireActivePgcpUser, async (req, res) => {
  try {
    res.json(await findAgendaTopic(req.params.id as string));
  } catch (error) {
    sendError(res, error, "consultar");
  }
});

agendaTopicsRouter.patch(
  "/:id",
  requireActivePgcpUser,
  mutacao("atualizar", (req, ator) =>
    updateAgendaTopic(req.params.id as string, parseAgendaTopicInput(req.body, true), ator),
  ),
);

/**
 * Exclusao recusada com 409 quando ha reuniao vinculada: a FK e SET NULL e
 * apagaria em silencio a procedencia de itens de reuniao ja realizados.
 * A copia automatica sai pelo Retomar, nao por aqui.
 */
agendaTopicsRouter.delete(
  "/:id",
  requireActivePgcpUser,
  mutacao("excluir", async (req, ator) => {
    await deleteAgendaTopic(req.params.id as string, ator);
  }, 204),
);

agendaTopicsRouter.post(
  "/:id/participants",
  requireActivePgcpUser,
  mutacao("adicionar participante", (req, ator) =>
    addTopicParticipant(req.params.id as string, parseTopicParticipant(req.body), ator),
  ),
);

agendaTopicsRouter.delete(
  "/:id/participants/:participantId",
  requireActivePgcpUser,
  mutacao("remover participante", (req, ator) =>
    removeTopicParticipant(req.params.id as string, req.params.participantId as string, ator),
  ),
);
