import { enderecoDoDiretorio } from "./corporate-email";
import type { DirectoryUser } from "./directory";
import type { ExternalParticipant } from "./external-participants-rules";
import type { CreateParticipantPayload } from "./meeting-adapters";

/**
 * SELEÇÃO DE PARTICIPANTES DE REUNIÃO — busca combinada, lógica pura.
 *
 *   Microsoft Entra ID   pessoas do diretório corporativo (/directory/users),
 *                        consultadas só a partir de `ENTRA_MIN_QUERY` letras
 *   PGCP / Externo       participantes externos cadastrados na Administração,
 *                        filtrados localmente, já na primeira letra
 *
 * Só esta tela junta as duas origens. Administração → Participantes lida
 * apenas com os externos do PGCP.
 */

/** Mínimo de letras para consultar o Entra — o mesmo de `/directory/users`. */
export const ENTRA_MIN_QUERY = 3;

export type ParticipanteSelecionado =
  | { origem: "entra"; user: DirectoryUser }
  | { origem: "pgcp"; participante: ExternalParticipant };

export interface ResultadoCombinado {
  entra: DirectoryUser[];
  pgcp: ExternalParticipant[];
}

export function deveBuscarNoEntra(termo: string): boolean {
  return termo.trim().length >= ENTRA_MIN_QUERY;
}

/** Externos do PGCP por nome ou e-mail, sem diferenciar maiúsculas. Termo vazio: nada. */
export function filtrarLocais(locais: readonly ExternalParticipant[], termo: string): ExternalParticipant[] {
  const t = termo.trim().toLowerCase();
  if (!t) return [];
  return locais.filter((p) => p.fullName.toLowerCase().includes(t) || p.email.toLowerCase().includes(t));
}

/**
 * Junta e separa por origem. Defesa contra duplicidade: um externo cujo e-mail
 * também aparece no Entra é omitido — a identidade corporativa prevalece (o
 * cadastro já é barrado na origem). Quem já foi escolhido não é oferecido.
 */
export function combinarResultados(
  entra: readonly DirectoryUser[],
  locais: readonly ExternalParticipant[],
  termo: string,
  jaEscolhidos: { entraIds?: readonly string[]; emails?: readonly string[] } = {}
): ResultadoCombinado {
  const ids = new Set((jaEscolhidos.entraIds ?? []).map((x) => x.toLowerCase()));
  const emails = new Set((jaEscolhidos.emails ?? []).filter(Boolean).map((x) => x.toLowerCase()));

  const doEntra = entra.filter((u) => {
    const email = enderecoDoDiretorio(u)?.toLowerCase();
    return !ids.has(u.id.toLowerCase()) && !(email && emails.has(email));
  });
  const emailsEntra = new Set(
    entra.map((u) => enderecoDoDiretorio(u)?.toLowerCase()).filter((x): x is string => Boolean(x))
  );
  const doPgcp = filtrarLocais(locais, termo).filter((p) => {
    const email = p.email.toLowerCase();
    return !emailsEntra.has(email) && !emails.has(email);
  });

  return { entra: doEntra, pgcp: doPgcp };
}

/** Nome exibido da pessoa escolhida. */
export function nomeDoSelecionado(s: ParticipanteSelecionado): string {
  return s.origem === "entra" ? s.user.displayName ?? enderecoDoDiretorio(s.user) ?? "" : s.participante.fullName;
}

/**
 * Corpo de participante para a API da reunião.
 *   Entra  → identidade Microsoft (`entraObjectId`), fluxo corporativo atual
 *   PGCP   → só nome + e-mail, `external`: nenhuma identidade Microsoft
 *            inventada, nenhum usuário, nenhuma App Role
 */
export function selecionadoParaPayload(s: ParticipanteSelecionado): CreateParticipantPayload {
  if (s.origem === "entra") {
    return {
      entraObjectId: s.user.id,
      displayName: nomeDoSelecionado(s),
      email: enderecoDoDiretorio(s.user),
      isConfirmed: false
    };
  }
  return {
    displayName: s.participante.fullName,
    email: s.participante.email,
    participantType: "external",
    isConfirmed: false
  };
}

/** Item da lista de convidados dos formulários (Nova reunião, reserva anual). */
export function selecionadoComoConvidado(s: ParticipanteSelecionado, role: string) {
  return s.origem === "entra"
    ? { name: nomeDoSelecionado(s), role, confirmed: false, entraObjectId: s.user.id, email: enderecoDoDiretorio(s.user) }
    : { name: s.participante.fullName, role, confirmed: false, entraObjectId: undefined, email: s.participante.email };
}
