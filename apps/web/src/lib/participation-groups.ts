import { apiRequest } from "./api";
import type { ParticipanteSelecionado } from "./participant-search";
import { corpoDoMembroDoOrgao, type GrupoDeOrgao, type MembroDoGrupo } from "./participation-groups-rules";

export * from "./participation-groups-rules";

/**
 * GRUPOS DE PARTICIPAÇÃO (Administração → Participantes).
 *
 *   Grupo do Órgão colegiado  `/participation-groups/governance-bodies` —
 *                             entra automaticamente nas reuniões NOVAS do órgão
 *   Participantes padrão      os participantes do tema da Biblioteca
 *   do Tema                   (`/agenda-topics/:id/participants`) — entram
 *                             quando o tema é adicionado a uma reunião
 *
 * Remover alguém de UMA reunião não muda o grupo. Grupo não dá acesso ao PGCP.
 */

interface ApiMembro {
  id: string;
  origin: "entra" | "external";
  displayName: string;
  email: string | null;
}

const doApi = (m: ApiMembro): MembroDoGrupo => ({
  id: m.id,
  nome: m.displayName,
  email: m.email,
  origem: m.origin === "entra" ? "cielo" : "externo"
});

const json = (method: string, body?: unknown) => ({
  auth: true,
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
});

export async function listGovernanceBodyGroups(signal?: AbortSignal): Promise<GrupoDeOrgao[]> {
  const { groups } = await apiRequest<{ groups: GrupoDeOrgao[] }>("/participation-groups/governance-bodies", { auth: true, signal });
  return groups;
}

export async function listGovernanceBodyGroupMembers(id: string, signal?: AbortSignal): Promise<MembroDoGrupo[]> {
  const { members } = await apiRequest<{ members: ApiMembro[] }>(`/participation-groups/governance-bodies/${id}/members`, { auth: true, signal });
  return members.map(doApi);
}

/** Só a pessoa escolhida: o servidor confirma no diretório / no cadastro e resolve nome e e-mail. */
/**
 * Entrar no grupo também inclui a pessoa nas reuniões ABERTAS já existentes do
 * órgão (exceto onde foi removida antes). Devolve os membros e essas contagens.
 */
export async function addGovernanceBodyGroupMember(
  id: string,
  sel: ParticipanteSelecionado
): Promise<{ membros: MembroDoGrupo[]; reunioesAtualizadas: number; reunioesComExcecao: number }> {
  const r = await apiRequest<{ members: ApiMembro[]; meetingsUpdated: number; meetingsSkippedByException: number }>(
    `/participation-groups/governance-bodies/${id}/members`,
    json("POST", corpoDoMembroDoOrgao(sel))
  );
  return {
    membros: r.members.map(doApi),
    reunioesAtualizadas: r.meetingsUpdated ?? 0,
    reunioesComExcecao: r.meetingsSkippedByException ?? 0
  };
}

export async function removeGovernanceBodyGroupMember(id: string, membroId: string): Promise<MembroDoGrupo[]> {
  const { members } = await apiRequest<{ members: ApiMembro[] }>(
    `/participation-groups/governance-bodies/${id}/members/${membroId}`,
    json("DELETE")
  );
  return members.map(doApi);
}

export function describeGroupError(error: unknown, language: "en" | "pt"): string {
  const pt = language === "pt";
  const status = (error as { status?: number } | null)?.status;
  const mensagem = (error as { message?: string } | null)?.message;
  if (status === 403) return pt ? "Sua conta não pode gerenciar grupos de participação." : "Your account cannot manage participation groups.";
  if (status && ((status >= 400 && status < 500) || status === 503) && mensagem) return mensagem;
  if (status === 0) return pt ? "Sem conexão com o servidor." : "No connection to the server.";
  return pt ? "Não foi possível concluir a operação." : "The operation could not be completed.";
}
