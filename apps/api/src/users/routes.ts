import { Router, type Request, type Response } from "express";
import { requirePgcpAdmin } from "../authz/app-roles.js";
import { listPgcpUsers } from "./service.js";

export const usersRouter = Router();

/**
 * Usuarios do PGCP — quem foi provisionado no sistema.
 *
 * Dominio DISTINTO do diretorio corporativo:
 *
 *   /directory/users  -> Microsoft Graph, pessoas da organizacao
 *   /users            -> PostgreSQL, pessoas com registro no PGCP
 *
 * Confundir os dois foi justamente o defeito da tela antiga, que exibia uma
 * lista local editavel como se fosse o diretorio.
 *
 * SOMENTE LEITURA nesta etapa. Nao existem POST, PATCH nem DELETE: alterar
 * usuario exige autorizacao funcional, e o modelo ainda nao tem papel algum.
 * Esconder um botao no frontend nao seria controle de acesso.
 *
 * A entrada de novos usuarios continua sendo o JIT do login: atribuicao no
 * Entra -> primeiro acesso -> linha em `users`.
 */
/*
 * ADMINISTRACAO de usuarios do PGCP — quem tem conta, quem esta ativo.
 *
 * NAO confundir com `GET /directory/users`, que busca no Microsoft Graph e
 * alimenta os seletores de organizador, participante e responsavel. Aquele
 * continua aberto a usuario ativo; se subisse de nivel, ninguem conseguiria
 * cadastrar reuniao.
 */
usersRouter.get("/", requirePgcpAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ users: await listPgcpUsers() });
  } catch (error) {
    console.error("[users] erro ao listar:", error);
    res.status(500).json({ error: "Erro interno ao listar os usuários." });
  }
});
