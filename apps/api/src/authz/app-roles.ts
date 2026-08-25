import type { NextFunction, Request, Response } from "express";
import { logSecurityEvent, safeRoute } from "../security/security-log.js";
import { requireActivePgcpUser } from "../users/middleware.js";

/**
 * Autorizacao funcional por App Role do PGCP API.
 *
 * DUAS roles, e so:
 *
 *   PGCP.Assessoria  opera reunioes e mantem os cadastros funcionais
 *   PGCP.Admin       administra tecnicamente a plataforma
 *
 * Sem role nenhuma, a pessoa continua entrando: le o conteudo corporativo e
 * cuida dos proprios FUPs.
 *
 * Historico: ate a 5.4l existiu `Meeting.Scheduler`, substituida por
 * `PGCP.Assessoria` e removida.
 *
 * O papel chega no claim `roles` do token DELEGADO, assinado pelo Entra. Quem
 * atribui e o Enterprise Application — diretamente a uma pessoa ou, no caso
 * real, a um GRUPO corporativo (o time de assessoria). O codigo nunca precisa
 * saber que grupo e esse.
 *
 * DELIBERADAMENTE FORA:
 *   - nome ou GUID de grupo no codigo — mudar o grupo viraria deploy;
 *   - `jobTitle` — rotulo de exibicao, nao perfil funcional;
 *   - e-mail ou nome — atributo, nunca autorizacao;
 *   - consulta de pertencimento a grupo no Graph — o token ja diz, assinado, e
 *     uma segunda fonte poderia discordar dele.
 *
 * NAO e RBAC completo. E o minimo para separar "quem pode agendar" de "quem
 * usa o sistema", que era a lacuna real.
 */

/**
 * Cadastrar e gerenciar reunioes.
 *
 * O valor precisa coincidir com o `value` do App Role no manifesto do App
 * Registration da API.
 */
/**
 * Perfil FUNCIONAL da Assessoria.
 *
 * Cria, agenda, administra e conduz reunioes; mantem os cadastros funcionais
 * (orgaos de governanca, tipos e naturezas de pauta). E o papel de quem opera a
 * governanca no dia a dia.
 *
 * NAO da administracao tecnica: usuarios do PGCP, integracoes, auditoria e
 * configuracoes continuam exclusivos de `PGCP.Admin`.
 */
export const PGCP_ASSESSORIA = "PGCP.Assessoria";

/**
 * Administrar a PLATAFORMA — nao reunioes.
 *
 * Usuarios do PGCP, orgaos de governanca, integracoes, auditoria e taxonomias
 * administrativas. Quem opera reunioes nao precisa disto, e quem administra a
 * plataforma nao ganha, por isso, o direito de conduzir uma sessao.
 *
 * INDEPENDENTE de `PGCP.Assessoria`, nos DOIS sentidos:
 *
 *   PGCP.Admin       NAO implica PGCP.Assessoria
 *   PGCP.Assessoria  NAO implica PGCP.Admin
 *
 * Nao existe hierarquia no codigo. Quem precisa das duas capacidades recebe as
 * DUAS atribuicoes no Entra, e o token chega com as duas no claim `roles` —
 * que e a unica fonte de verdade. Nada disso e persistido em `users`.
 *
 * A EXCECAO deliberada sao os CADASTROS FUNCIONAIS (orgaos, tipos, naturezas),
 * onde vale `PGCP.Assessoria OU PGCP.Admin`. E um OR local, declarado num lugar
 * so — nao uma hierarquia que valha para o resto do sistema.
 */
export const PGCP_ADMIN = "PGCP.Admin";

/** O principal ja validado tem o papel? */
export function hasAppRole(req: Request, role: string): boolean {
  return req.principal?.appRoles.includes(role) === true;
}

/**
 * Exige autenticacao, usuario ativo no PGCP E o papel informado.
 *
 * Encadeia `requireActivePgcpUser` para nao duplicar a validacao do token nem a
 * resolucao do usuario. A ordem importa: 401 para quem nao provou quem e, 403
 * para quem provou mas nao pode.
 *
 * O BACKEND E A AUTORIDADE. Esconder o botao na tela e cortesia com quem nao
 * pode agendar; nao e controle de acesso.
 */
export function requireAppRole(role: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireActivePgcpUser(req, res, () => {
      if (!hasAppRole(req, role)) {
        logSecurityEvent({
          type: "missing_app_role",
          message: "Acesso negado por falta de App Role.",
          requestId: req.id,
          principalOid: req.principal?.entraObjectId ?? null,
          route: safeRoute(req.method, req.originalUrl),
          status: 403,
          code: "missing_app_role",
          detail: { requiredRole: role },
        });
        res.status(403).json({
          error:
            "Sua conta não tem a função necessária para esta operação. " +
            "Fale com a Secretaria de Governança para solicitar acesso.",
          code: "missing_app_role",
          requiredRole: role,
        });
        return;
      }
      next();
    });
  };
}

/**
 * Exige QUALQUER uma das roles informadas.
 *
 * Existe para os cadastros funcionais, onde Assessoria e Admin sao igualmente
 * legitimas. Centralizado de proposito: repetir `hasAppRole(a) || hasAppRole(b)`
 * dentro de cinco handlers espalharia a regra e faria a sexta rota nascer
 * diferente das outras.
 */
export function requireAnyAppRole(roles: readonly string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireActivePgcpUser(req, res, () => {
      if (!roles.some((role) => hasAppRole(req, role))) {
        logSecurityEvent({
          type: "missing_app_role",
          message: "Acesso negado por falta de App Role.",
          requestId: req.id,
          principalOid: req.principal?.entraObjectId ?? null,
          route: safeRoute(req.method, req.originalUrl),
          status: 403,
          code: "missing_app_role",
          detail: { requiredRoles: roles.join(",") },
        });
        res.status(403).json({
          error:
            "Sua conta não tem a função necessária para esta operação. " +
            "Fale com a Secretaria de Governança para solicitar acesso.",
          code: "missing_app_role",
          requiredRoles: [...roles],
        });
        return;
      }
      next();
    });
  };
}

/** Operar reunioes e conduzir a governanca. */
export const requirePgcpAssessoria = requireAppRole(PGCP_ASSESSORIA);

/**
 * Atalho do papel administrativo.
 *
 * Mesmo mecanismo generico: 401 para quem nao provou quem e, 403 para quem
 * provou e nao pode. Nenhuma checagem cruzada com a outra role.
 */
export const requirePgcpAdmin = requireAppRole(PGCP_ADMIN);

/**
 * CADASTROS FUNCIONAIS — orgaos de governanca, tipos e naturezas de pauta.
 *
 * Assessoria mantem esses cadastros porque eles sao o vocabulario do trabalho
 * dela; Admin tambem os mantem porque continuam sendo cadastro da plataforma.
 * Fora daqui, uma role nao substitui a outra.
 */
export const requireAssessoriaOuAdmin = requireAnyAppRole([PGCP_ASSESSORIA, PGCP_ADMIN]);
