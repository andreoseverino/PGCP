/**
 * Regras PURAS de Participantes (sem rede), separadas de
 * `external-participants.ts` para serem testáveis em Node.
 */

export interface ExternalParticipant {
  id: string;
  origin: "pgcp";
  fullName: string;
  email: string;
  phone: string;
  /** Classificação (027): só sugestão, nunca autorização ou inclusão automática. */
  governanceBodies: Array<{ id: string; name: string }>;
  topics: Array<{ id: string; title: string }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cadastro da pessoa externa (Pessoas externas). Órgãos/temas NÃO vão aqui:
 * a API mantém os grupos da pessoa intactos quando eles não são informados.
 */
export interface ExternalParticipantPayload {
  fullName: string;
  email: string;
  phone: string;
}

/** Validação local espelhando a API (a autoridade continua sendo o servidor). */
export function validateExternalParticipant(p: ExternalParticipantPayload, language: "en" | "pt"): string | null {
  const pt = language === "pt";
  if (p.fullName.trim().length < 2) return pt ? "Informe o nome completo." : "Enter the full name.";
  if (!/^[^\s@,;]+@[^\s@,;]+\.[a-zA-Z]{2,}$/.test(p.email.trim())) {
    return pt ? "Informe um e-mail válido." : "Enter a valid e-mail.";
  }
  const tel = p.phone.trim();
  if (!/^[0-9+() -]{6,30}$/.test(tel) || (tel.match(/\d/g) ?? []).length < 8) {
    return pt
      ? "Telefone: dígitos, espaços e + ( ) -, com ao menos 8 dígitos."
      : "Phone: digits, spaces and + ( ) -, at least 8 digits.";
  }
  return null;
}

/**
 * Pessoa do Microsoft Entra ID com classificação no PGCP (`/directory-people`).
 * A identidade é do Entra; aqui só o vínculo para sugestão. Não é usuário.
 */
export interface DirectoryPerson {
  id: string;
  origin: "entra";
  entraObjectId: string;
  displayName: string;
  email: string | null;
  governanceBodies: Array<{ id: string; name: string }>;
  topics: Array<{ id: string; title: string }>;
  createdAt: string;
  updatedAt: string;
}
