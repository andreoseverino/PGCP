# Runbook de go-live — PGCP

Checklist operacional dos **itens externos ainda pendentes** para liberar o PGCP
em produção, em **ordem de execução**. Autossuficiente: não depende de link
externo. Contexto completo de segurança em [`docs/security.md`](security.md).

Estado inicial de todos os passos: **⚠️ pendente externo** (dependem do tenant
Entra, do Exchange, da borda de rede, do cofre e do Log Analytics). O código já
foi validado localmente e **não** é alterado por esta checklist.

**Responsáveis:** `Aplicação` · `Cloud/Infra` · `Entra/Identidade` · `Exchange`.

**Regra de liberação:** o go-live só é declarado fechado quando os 13 passos
estiverem concluídos, com evidência guardada.

---

## Fase 1 — Preparação (provisionar antes de subir)

### 1. Secrets no cofre + rotação do client secret
- **Responsável:** Entra/Identidade + Cloud/Infra
- **Configurar:** emitir um **novo** `ENTRA_API_CLIENT_SECRET` no App Registration
  da API e guardar no cofre (Key Vault). Mover `DB_PASSWORD`,
  `DB_MIGRATION_PASSWORD` e `DB_BOOTSTRAP_PASSWORD` para o cofre. Remover
  `VITE_ALLOW_MOCK_LOGIN` do ambiente de produção. Garantir que nenhum `.env`
  real entre em imagem/artefato.
- **Como testar:** a aplicação sobe lendo os segredos do cofre (não de arquivo);
  **revogar** o secret antigo de desenvolvimento e confirmar que nada quebra;
  escanear a imagem por `.env`.
- **Resultado esperado:** app inicia com segredos do cofre; secret de dev antigo
  revogado e inutilizável; nenhum `.env` na imagem.
- **Evidência:** id/versão do novo secret no cofre (sem o valor); registro da
  revogação do antigo; resultado do scan de imagem limpo.
- **Status:** ⚠️ pendente externo.

### 2. PostgreSQL de produção com papéis e TLS
- **Responsável:** Cloud/Infra
- **Configurar:** instância gerenciada; rodar
  [`infra/postgres/provision-roles.sql`](../infra/postgres/provision-roles.sql)
  (cluster limpo) ou
  [`infra/postgres/harden-existing-cluster.sql`](../infra/postgres/harden-existing-cluster.sql)
  (existente), com senhas do cofre: `pcgp_bootstrap` (DBA), `pcgp_admin`
  (migrations), `pcgp_app` (runtime). `DB_SSL=true` + `sslmode=verify-full`. Rede
  do banco restrita à aplicação. Aplicar migrations como `pcgp_admin`
  (`npm run db:migrate`).
- **Como testar:** consultar atributos dos 4 papéis; `has_table_privilege('pcgp_app','audit_logs',…)`;
  confirmar app conectando como `pcgp_app` e migrations como `pcgp_admin`.
- **Resultado esperado:** `pcgp_app` = `NOSUPERUSER`/`NOBYPASSRLS`, dono de nada;
  `audit_logs` só INSERT/SELECT (UPDATE/DELETE/TRUNCATE negados); `pcgp_initdb`
  `NOLOGIN`; TLS obrigatório.
- **Evidência:** saída das queries de papéis e de `audit_logs`; log da migration
  “aplicadas como pcgp_admin”.
- **Status:** ⚠️ pendente externo. *(Arquitetura validada localmente — ver
  [`infra/postgres/README.md`](../infra/postgres/README.md) e `docs/security.md` §3/§4.)*

### 3. Exchange Online RBAC — Resource Scope
- **Responsável:** Exchange
- **Configurar:** atribuir `Application Calendars.ReadWrite` ao service principal
  do PGCP via **Exchange Online RBAC for Applications**, com **Resource Scope**
  limitando as mailboxes autorizadas. **Não** conceder `Calendars.ReadWrite`
  (Application) tenant-wide no Entra.
- **Como testar:** sincronizar reunião cujo organizador está **dentro** do escopo;
  repetir com mailbox **fora** do escopo.
- **Resultado esperado:** dentro do escopo → evento criado; fora do escopo →
  `ErrorAccessDenied` (o escopo está de fato limitando).
- **Evidência:** saída do `New-ManagementRoleAssignment`; log de um sync ok e de
  um `ErrorAccessDenied`.
- **Status:** ⚠️ pendente externo. *(Ver [`docs/runbook-exchange-calendar.md`](runbook-exchange-calendar.md).)*

### 4. Entra ID / App Registrations / App Roles / MSAL
- **Responsável:** Entra/Identidade
- **Configurar:** API (confidential) com `requestedAccessTokenVersion=2`, scope
  `access_as_user`, App Roles `PGCP.Assessoria` e `PGCP.Admin`, permissões
  `User.Read.All` (App) + `Calendars.Read` (Delegated) com **consentimento de
  admin**. SPA (public) com redirect de produção `…/auth/redirect.html`,
  pré-autorizado na API. Enterprise App com **Atribuição necessária = Sim** e
  usuários/grupos atribuídos aos App Roles. Preencher `VITE_ENTRA_*` de produção.
- **Como testar:** conferir manifests e o consentimento de admin (login real fica
  no passo 9).
- **Resultado esperado:** só quem tem atribuição obtém token; App Roles chegam no
  claim `roles`; mock login desligado (Entra configurado).
- **Evidência:** prints dos manifests (aud v2, roles, scope), do consentimento de
  admin e da atribuição no Enterprise App.
- **Status:** ⚠️ pendente externo. *(Ver [`docs/runbook-entra-app-registration.md`](runbook-entra-app-registration.md).)*

---

## Fase 2 — Borda (rede e proxy antes da verificação)

### 5. HTTPS / HSTS / WAF / rate limit por IP
- **Responsável:** Cloud/Infra
- **Configurar:** TLS no proxy; redirect HTTP→HTTPS; HSTS (`max-age` longo +
  `includeSubDomains`); WAF (OWASP CRS); rate limit por IP + burst; bloquear
  `TRACE`/`CONNECT`; timeout e limite de body; gerar `X-Request-Id` na borda e
  propagar `X-Forwarded-For`.
- **Como testar:** `curl -I http://…`; header HSTS no HTTPS; `curl -X TRACE`;
  teste de carga por IP; regras do WAF ativas.
- **Resultado esperado:** HTTP → 308 para HTTPS; HSTS presente; `TRACE` → 405;
  excesso por IP → 429; WAF ativo.
- **Evidência:** saídas dos `curl`; regra do WAF; configuração de rate limit.
- **Status:** ⚠️ pendente externo.

### 6. CSP validada com MSAL
- **Responsável:** Cloud/Infra + Aplicação
- **Configurar:** CSP como **header** no host do frontend (string completa em
  [`docs/producao-hardening.md`](producao-hardening.md)): `connect-src` e
  `frame-src` com `login.microsoftonline.com` e a URL da API; **Graph não** entra
  no `connect-src`; `frame-ancestors 'none'` no `index.html`. **Crítico:**
  `auth/redirect.html` **sem** `X-Frame-Options: DENY` / `frame-ancestors 'none'`
  (senão quebra o `acquireTokenSilent`).
- **Como testar:** login por popup **e** renovação silenciosa (iframe)
  funcionando; console do navegador sem violação de CSP.
- **Resultado esperado:** MSAL popup + silent OK; zero violação de CSP;
  clickjacking bloqueado no app principal.
- **Evidência:** header CSP servido; print do console limpo; confirmação do login
  silencioso.
- **Status:** ⚠️ pendente externo.

### 7. API não exposta diretamente
- **Responsável:** Cloud/Infra
- **Configurar:** API só alcançável **via proxy**; porta da API não publicada
  (firewall/NSG/rede privada); bind em interface interna. PostgreSQL igualmente
  fora da internet.
- **Como testar:** tentar acessar o IP:porta da API **diretamente** de fora da
  borda; acessar pelo domínio do proxy.
- **Resultado esperado:** acesso direto recusado/timeout; só o proxy alcança.
- **Evidência:** teste de conexão externa negado; regra de firewall/NSG.
- **Status:** ⚠️ pendente externo.

### 8. Log Analytics
- **Responsável:** Cloud/Infra
- **Configurar:** coletar as linhas `kind:"security"` do stdout da API e exportar
  a trilha `audit_logs`. Criar alertas: pico de 401/403 por principal/IP,
  `rate_limit` recorrente, `unexpected_error`, `missing_app_role` repetido.
- **Como testar:** gerar 401, 403, 429 e um ato administrativo; conferir a chegada
  no workspace.
- **Resultado esperado:** eventos `kind:security` (401/403/429) e entradas de
  `audit_logs` visíveis — sem token/segredo.
- **Evidência:** consulta do workspace mostrando os quatro tipos; regras de alerta.
- **Status:** ⚠️ pendente externo.

---

## Fase 3 — Verificação funcional (ambiente de pé)

### 9. Login real via MSAL / Entra ID
- **Responsável:** Aplicação + Entra/Identidade
- **Configurar:** fases 1–2 concluídas; executar o primeiro login real de produção.
- **Como testar:** logar pelo PGCP Web em produção; conferir `GET /me` e o
  provisionamento JIT em `users`.
- **Resultado esperado:** popup conclui; `/me` → 200 com identidade + `appRoles`;
  linha criada em `users`.
- **Evidência:** HAR/print de `/me` 200; linha em `users`; entrada `audit_logs`
  “Autenticação corporativa”.
- **Status:** ⚠️ pendente externo.

### 10. Perfis Usuário / Assessoria / Admin
- **Responsável:** Aplicação
- **Configurar:** três contas de teste: sem papel, `PGCP.Assessoria`, `PGCP.Admin`.
- **Como testar:** cada perfil vê só o que deve: comum sem Administração/Auditoria;
  Assessoria agenda; Admin abre Auditoria e Integrações.
- **Resultado esperado:** UI condiz com o papel — e nada além.
- **Evidência:** prints das três sessões; tabela perfil × acesso.
- **Status:** ⚠️ pendente externo.

### 11. RBAC e IDOR reais (chamada direta à API)
- **Responsável:** Aplicação
- **Configurar:** obter os tokens dos três perfis (DevTools) para chamar a API
  ignorando a UI.
- **Como testar:** **RBAC** — comum em `POST /meetings`; Assessoria em
  `GET /audit-logs`. **IDOR** — com token do usuário A, trocar o `:id` para
  reunião/FUP/ata/pauta do usuário B em `GET`/`PATCH`. Repetir `/directory/users`
  além do limite.
- **Resultado esperado:** escalada → `403 missing_app_role`; recurso de outro →
  `404` (invisível) ou `403` (não é seu) — **nunca 200**; excesso por principal →
  `429`.
- **Evidência:** coleção de requests (curl/Postman) com os status; captura do 429.
- **Status:** ⚠️ pendente externo. *(Controles de código já auditados —
  `docs/security.md` §8.)*

### 12. Graph / Outlook / Teams / calendário
- **Responsável:** Aplicação + Exchange
- **Configurar:** fases 1, 3 e 4 concluídas; usar **Configurações → Integrações**
  como ferramenta de validação.
- **Como testar:** `POST /integrations/graph/test` (Admin); `GET /directory/users`
  com busca real; agendar reunião → evento no Outlook do organizador + reunião
  Teams; `GET /calendar/me`.
- **Resultado esperado:** Graph `connected`; diretório busca pessoas; evento
  criado com `joinUrl` do Teams; agenda própria retornada.
- **Evidência:** status do painel de integrações; print do evento no Outlook +
  `joinUrl`; resposta de `/calendar/me`.
- **Status:** ⚠️ pendente externo.

---

## Ordem sugerida

Fase 1 (provisionar) → Fase 2 (borda) → Fase 3 (verificar com o ambiente de pé).
O go-live só fecha com os 13 passos concluídos e evidência guardada.

---

### 13. `Mail.Send` (Delegated) — validação de pautas

- **O que fazer:** conceder a permissão **`Mail.Send` do tipo Delegated** no App
  Registration da **PGCP API** e dar o consentimento do administrador.
  **Não** conceder a versão `Application` — ela enviaria como qualquer caixa do
  tenant, o mesmo padrão já recusado para `Calendars.ReadWrite`.
- **Como validar:** em uma reunião preparada, usar **Enviar pautas para
  validação**, informar um endereço de teste e confirmar que o e-mail chega com
  o **PDF anexado** e que o remetente é a **caixa de quem está na sessão**.
- **Resultado esperado:** e-mail entregue; a reunião passa a `sent`; a trilha
  registra **sucesso**; a interface confirma o envio.
- **Se falhar com `consent_required`:** a permissão não foi concedida — a
  validação **não** é marcada como enviada, e nada precisa ser desfeito.
- **Status:** 🟡 **parcialmente validado (26/08/2026).**

  ✅ Concessão, OBO com usuário real, `202 Accepted` do Graph, envio pela caixa
  do usuário e recebimento com PDF anexado — **todos confirmados**.

  ⚠️ **Falta revalidar** — no mesmo teste, o `202` com corpo vazio quebrava o
  cliente do Graph, então o estado não chegou a ser gravado. Corrigido; repetir
  o passo e confirmar os três pontos:

  - [ ] a reunião fica em `agenda_validation_status = 'sent'`
  - [ ] `audit_logs` registra **"Pautas enviadas para validação"** com sucesso
  - [ ] a interface mostra confirmação, e não erro

  Detalhe do incidente e da correção em [`security.md`](security.md) §9. As duas
  entradas `failure` já gravadas são evidência do incidente e **permanecem**.
