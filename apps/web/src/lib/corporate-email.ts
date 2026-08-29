/**
 * Endereço utilizável de uma pessoa do diretório.
 *
 * `mail` válido tem prioridade. Um UPN válido é o fallback legítimo quando
 * `mail` está ausente ou inválido. Nunca deriva endereço do nome.
 */
export function enderecoDoDiretorio(pessoa: {
  mail?: string | null;
  userPrincipalName?: string | null;
}): string | undefined {
  const mail = pessoa.mail?.trim();
  if (mail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return mail;

  const upn = pessoa.userPrincipalName?.trim();
  return upn && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(upn) ? upn : undefined;
}
