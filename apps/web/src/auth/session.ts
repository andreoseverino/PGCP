import type { SessionUser } from "../types";

/**
 * Desserializa o usuário da sessão gravado em `sessionStorage` por `startSession`.
 *
 * POR QUE ISTO EXISTE (correção de regressão de autorização): a versão anterior
 * lia só `name` e `role` e **descartava `appRoles`**, embora `startSession` os
 * tivesse gravado. Num remount da SPA — reload, ou aba descartada pelo navegador
 * após inatividade — `isAuthenticated` voltava `true` (de `sessionStorage`) mas
 * `currentUser.appRoles` vinha vazio: o usuário aparecia autenticado e SEM
 * papéis (Assessoria/Admin sumiam), e só logout+login restaurava.
 *
 * Restaurar `appRoles` aqui NÃO é controle de acesso — o backend revalida cada
 * rota (403 sem o papel). É a mesma cortesia de UI já concedida no login,
 * apenas sobrevivendo ao remount. A sessão é `sessionStorage` (escopo da aba):
 * fechar a aba encerra; não persiste em `localStorage`.
 *
 * Função PURA (sem `sessionStorage`) para ser testável sem navegador. Devolve
 * `null` quando não há sessão gravada ou o conteúdo está corrompido; o chamador
 * aplica o usuário padrão.
 */
export function parseSessionUser(saved: string | null): SessionUser | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as Partial<SessionUser>;
    if (typeof parsed?.name !== "string" || parsed.name.length === 0) return null;
    if (typeof parsed?.role !== "string" || parsed.role.length === 0) return null;

    // Só array de strings vira `appRoles`; qualquer outro formato é ignorado.
    const appRoles = Array.isArray(parsed.appRoles)
      ? parsed.appRoles.filter((r): r is string => typeof r === "string")
      : undefined;

    return { name: parsed.name, role: parsed.role, ...(appRoles ? { appRoles } : {}) };
  } catch {
    return null;
  }
}
