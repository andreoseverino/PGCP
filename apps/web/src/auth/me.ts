/**
 * `GET /me` — identidade do usuário autenticado, conforme a API validou.
 *
 * Nesta etapa a resposta traz SOMENTE claims do token. O vínculo com a tabela
 * `users` (UUID interno do PGCP) entra na Etapa 2.3, e é por isso que
 * `pgcpUserResolved` existe: torna a ausência explícita em vez de ambígua.
 */

import { ApiError, apiRequest } from "../lib/api";

export interface MeResponse {
  /**
   * `users.id` — identidade INTERNA do PGCP. É este o identificador da sessão:
   * é ele que aparece nas FKs do sistema. A identidade Microsoft serve para
   * autenticar, não para referenciar.
   */
  id: string;
  name: string;
  email: string;
  upn: string | null;
  jobTitle: string | null;
  userType: "internal" | "external";
  isActive: boolean;
  /** `tid` — tenant Microsoft. Rastreabilidade, não referência. */
  entraTenantId: string;
  /** `oid` — junto com o tenant, a chave que resolveu este usuário. */
  entraObjectId: string;
  /**
   * App Roles do PGCP atribuídos a esta pessoa, vindos do token.
   *
   * Servem para a tela decidir o que mostrar. **Não são controle de acesso**:
   * o servidor revalida em cada rota protegida, e esconder um botão é cortesia
   * com quem não pode — nunca a barreira.
   *
   * Vazio é o caso comum e legítimo: quem não agenda continua entrando, vendo
   * o próprio calendário e participando das reuniões.
   */
  appRoles: string[];
}

/** Perfil funcional da Assessoria. Espelha o App Role do backend. */
export const PGCP_ASSESSORIA = "PGCP.Assessoria";

/** Administração técnica da plataforma. Espelha o App Role do backend. */
export const PGCP_ADMIN = "PGCP.Admin";

/**
 * Opera a governança: cria, agenda, administra e conduz reuniões, e mantém os
 * cadastros funcionais.
 *
 * Substituiu `podeAgendar` na 5.4l. Cortesia com quem não pode, nunca controle
 * de acesso: o servidor revalida cada rota.
 */
export function podeAssessorar(me: { appRoles?: string[] } | null | undefined): boolean {
  return me?.appRoles?.includes(PGCP_ASSESSORIA) === true;
}

/**
 * Administra a plataforma? Usuários, órgãos, integrações, auditoria.
 *
 * INDEPENDENTE de `podeAssessorar`: nenhuma das duas consulta a outra. Quem tem
 * só esta administra tecnicamente e não conduz reunião; quem tem só a outra
 * conduz e não administra. As duas juntas vêm do token, não de hierarquia.
 *
 * ÚNICA sobreposição, deliberada: os cadastros funcionais (órgãos, tipos e
 * naturezas de pauta), que Assessoria e Admin mantêm igualmente.
 *
 * As roles chegam de `GET /me` — o navegador NÃO decodifica token.
 */
export function podeAdministrar(me: { appRoles?: string[] } | null | undefined): boolean {
  return me?.appRoles?.includes(PGCP_ADMIN) === true;
}

export function fetchMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>("/me", { auth: true });
}

/**
 * Traduz a falha de `/me` para texto humano.
 *
 * Cada status significa uma coisa distinta e a pessoa precisa saber o que
 * fazer: 401 é credencial, 403 é autorização, 503 é instalação.
 */
export function describeMeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Não foi possível confirmar sua identidade. Tente novamente.";
  }

  switch (error.status) {
    case 401:
      return "Sua credencial não foi aceita ou expirou. Entre novamente.";
    case 403:
      /*
       * `user_inactive` NÃO é problema de credencial: o Entra autenticou, e
       * desativar a conta foi decisão explícita do PGCP. Confundir os dois
       * mandaria a pessoa tentar login de novo, sem efeito.
       */
      if (error.code === "user_inactive") {
        return "Sua conta está desativada no PGCP. Procure a Secretaria de Governança.";
      }
      // `azp` de outro cliente ou `scp` sem access_as_user.
      return "Sua conta autenticou, mas este aplicativo não está autorizado a acessar a API do PGCP. Procure a Secretaria de Governança.";
    case 422:
      // Autenticado e autorizado no Entra, porém sem e-mail utilizável no token.
      return "Sua conta foi autenticada, mas o token não traz um endereço de e-mail utilizável. Procure a Secretaria de Governança.";
    case 503:
      return "A autenticação corporativa não está configurada nesta instalação do PGCP.";
    case 0:
      return "Não foi possível conectar à API do PGCP.";
    default:
      return error.message;
  }
}
