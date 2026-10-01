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
  governanceBody: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalParticipantPayload {
  fullName: string;
  email: string;
  phone: string;
  governanceBodyId: string | null;
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
