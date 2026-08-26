# scripts

Scripts utilitários de desenvolvimento e diagnóstico.

| Script | Comando | O que faz |
|---|---|---|
| [entra-preflight.mjs](entra-preflight.mjs) | `npm run entra:check` | Pré-voo dos **dois** App Registrations do Entra, sem exigir login: confere a coerência entre `apps/api/.env` e `apps/web/.env`, alcança o tenant e interroga o endpoint de autorização para detectar client id inexistente, redirect URI não registrada e scope não exposto |

O pré-voo **não** imprime segredo nem token — client ids e tenant aparecem
mascarados. Ele também **não** prova que o login funciona: isso exige uma pessoa
concluindo o popup da Microsoft (credencial + MFA) no navegador.

Os comandos do dia a dia (build, lint, testes, banco) estão nos scripts do
`package.json` da raiz.
