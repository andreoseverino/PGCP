# Segurança e readiness de produção — PGCP

**Fonte principal de verdade** sobre segurança, hardening e prontidão de produção do PGCP.
Escrito para que um agente técnico novo entenda todo o contexto **lendo apenas o repositório** —
sem depender de links externos, artifacts ou conversas anteriores.

Documentos relacionados (todos no repositório):
- [`docs/go-live.md`](go-live.md) — checklist operacional de go-live (13 passos), fonte para o dia da liberação.
- [`docs/producao-hardening.md`](producao-hardening.md) — detalhe técnico de configuração de produção (CSP, headers, proxy/WAF, Log Analytics).
- [`infra/postgres/README.md`](../infra/postgres/README.md) — procedimento de provisionamento dos papéis do PostgreSQL.
- [`docs/integracoes.md`](integracoes.md) — integrações, variáveis de ambiente e permissões do Microsoft Graph.

> **Convenção deste documento:** cada afirmação de estado usa
> **✅ validado (local)** = comprovado neste repositório/ambiente de desenvolvimento;
> **⚠️ pendente externo** = depende do tenant corporativo / borda de produção;
> **corrigido / mitigado / externo** = estado de um achado.
> Nenhum valor de segredo aparece aqui.

---

## 0. Estado atual de readiness

```text
Auditoria de código              ✅ concluída
Hardening PostgreSQL             ✅ concluído
Hardening de produção no código  ✅ concluído
npm audit                        ⚠️ 3 (2 moderadas, 1 alta) em dependências transitivas já presentes antes do S3: qs (via express), browserslist e baseline-browser-mapping (via vite/build). Correção (`npm audit fix`) pendente de rodada própria
Build / typecheck / testes       ✅ verdes (API 323 + web 178)
Pré-go-live local                ✅ concluído
Mail.Send Delegated / OBO        ✅ validado no tenant real (envio e recebimento)
Validação de pautas — pós-envio  ⚠️ revalidar após a correção do 202 (ver §9)
Teams Chat — código/testes        ✅ implementado e validado localmente
Teams Chat — permissões Entra    ✅ Chat.Create + ChatMessage.Send Delegated concedidas
Teams Chat — entrega real        ✅ mensagem manual e Chamar validados no tenant real
Pré-go-live corporativo          ⚠️ pendente (ver docs/go-live.md)
```

**Leitura:** o código está pronto do ponto de vista das validações realizadas
localmente. O **go-live final NÃO deve ser declarado concluído** até os itens
externos (tenant Entra, Exchange RBAC, `Mail.Send` Delegated, borda de rede,
cofre, Log Analytics) serem validados no ambiente corporativo real — ver
[§16](#16-estado-atual-e-o-que-falta) e [`docs/go-live.md`](go-live.md).

---

## 1. Auditoria de segurança realizada

### Escopo auditado
Frontend (`apps/web`) e backend (`apps/api`); APIs e contratos; autenticação
Microsoft Entra ID / MSAL; autorização, RBAC e App Roles; sessões, cookies,
tokens e JWT; classes OWASP e OWASP API Security (CSRF, XSS, SSRF, SQL Injection,
command injection, IDOR/Broken Access Control, mass assignment, escalada de
privilégio horizontal/vertical); validação e sanitização de entrada;
upload/download; exposição de informação sensível; secrets/`.env`/connection
strings; CORS e headers HTTP; rate limiting; dependências / supply chain;
PostgreSQL, migrations, papéis e permissões; Microsoft Graph / Teams / Outlook;
logs e auditoria; tratamento de erros; Docker/infra; endpoints administrativos;
operações que alteram/excluem/acessam dados sensíveis; bypass de regra de
negócio; concorrência e idempotência.

### Resultado por classe

| Classe | Resultado |
| --- | --- |
| SQL Injection | ✅ Nenhuma. Todo SQL é parametrizado; construtores dinâmicos usam helper `bind()` com placeholders; valores de enum validados por allowlist. |
| XSS | ⚠️→corrigido. Um vetor de XSS armazenado via `meetingLink` (ver §2). Sem `dangerouslySetInnerHTML`; React escapa texto por padrão. |
| SSRF | ✅ Nenhuma. Rede só alcança hosts fixos (`login.microsoftonline.com`, `graph.microsoft.com`); sem URL controlada pelo usuário em fetch. |
| Command injection | ✅ Nenhuma. Sem `child_process`/`exec`. |
| CSRF | ✅ N/A relevante. API é bearer-token stateless (sem cookie de sessão), então não há CSRF clássico. |
| IDOR / Broken Access Control | ✅ Controle presente (cláusulas de visibilidade + 404/403); ⚠️ teste ponta a ponta com contas reais é pré-go-live. |
| Mass assignment | ✅ Allowlists fechadas em todos os `parse*`; campos definidos pelo servidor (`tenant`, `created_by`, `id`, etc.) recusados do corpo. |
| Autenticação (Entra) | ✅ Validação completa de token — ver §7. |
| Autorização / RBAC / App Roles | ✅ Revalidada no servidor em cada rota — ver §7/§8. |
| CORS | ✅ Allowlist explícita, nunca `*` — ver §10. |
| Sessões / tokens | ✅ Stateless bearer; token só no `sessionStorage` do MSAL; nunca em URL/log — ver §12. |
| Secrets | ✅ Nenhum hardcoded; `.env*` fora do Git — ver §13. |
| Dependências / supply chain | ⚠️→corrigido. Ver §2. `npm audit` = 0. |
| Logs e auditoria | ✅ `audit_logs` (governança) + log estruturado de segurança — ver §12. |
| Banco | ✅→hardened. Ver §3/§4. |
| Infraestrutura | Parcial no repo (Docker), resto externo — ver §14. |

### Principais achados originais e estado final

| # | Achado | Severidade | Estado final |
| --- | --- | --- | --- |
| A | Usuário de banco `pcgp_app` operando como **SUPERUSER** (append-only de `audit_logs` só por convenção) | Alto | **Corrigido/validado** (§3, §4) |
| B | **Vazamento de stack trace** e caminho de disco em erros não tratados | Médio | **Corrigido** (§2) |
| C | **XSS armazenado via `meetingLink`** (`javascript:`/`data:` como `href`) | Médio | **Corrigido** (§2) |
| D | **Dependências vulneráveis** (postcss, nanoid high; body-parser; protobufjs) | Médio | **Corrigido** (§2) |
| E | **Ausência de rate limiting** | Baixo | **Corrigido (app) + externo (borda)** (§6) |
| F | **Headers / configuração de produção** (sem fail-fast, sem headers, `X-Powered-By`) | Baixo/Info | **Corrigido** (§2, §5, §11) |

Nenhum achado bloqueante permanece no código. Riscos residuais são de
configuração externa (§16, `docs/go-live.md`).

---

## 2. Correções de segurança implementadas

| Correção | Arquivo(s) |
| --- | --- |
| Handler de erro final genérico (sem stack no cliente) + 404 JSON | `apps/api/src/server.ts` |
| `X-Powered-By` removido | `apps/api/src/server.ts` (`app.disable("x-powered-by")`) |
| Headers básicos da API (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`) | `apps/api/src/server.ts` |
| Validação `http`/`https` do `meetingLink` (recusa `javascript:`/`data:`) — backend | `apps/api/src/meetings/create.ts` (`urlHttpOpcional`, usado em create e update) |
| Defesa adicional no frontend (só renderiza link se esquema seguro) | `apps/web/src/lib/safe-url.ts` + `apps/web/src/components/MeetingDetailView.tsx` |
| Remoção de dependências vulneráveis não usadas (`express`, `@google/genai` no web) + `npm audit fix` | `apps/web/package.json`, `package-lock.json` |
| Testes negativos de segurança | `apps/api/src/meetings/create.test.ts` (meetingLink perigoso, mass assignment) |
| Restauração de sessão preserva `appRoles` (perda de papel após remount/reload) — ver §7 | `apps/web/src/auth/session.ts`, `apps/web/src/App.tsx`, `apps/web/src/auth/session.test.ts` (commit `3a6f76d`) |

Validação: ✅ `npm audit` = **0 vulnerabilidades**; typecheck/build verdes; erro
não tratado passou a devolver JSON genérico sem stack (verificado ao vivo com
`/meetings/%`).

---

## 3. Hardening PostgreSQL — arquitetura de papéis

Fecha o **Achado A**. Procedimento completo e SQL em
[`infra/postgres/README.md`](../infra/postgres/README.md),
[`infra/postgres/provision-roles.sql`](../infra/postgres/provision-roles.sql),
[`infra/postgres/harden-existing-cluster.sql`](../infra/postgres/harden-existing-cluster.sql) e a
migration [`apps/api/migrations/015_runtime_least_privilege.sql`](../apps/api/migrations/015_runtime_least_privilege.sql).

```text
Runtime API    → pcgp_app        (menor privilégio, sem nada administrativo)
Migrations     → pcgp_admin      (dono dos objetos, sem SUPERUSER)
DBA/breakglass → pcgp_bootstrap  (SUPERUSER, uso excepcional, credencial no cofre)
Initdb legado  → pcgp_initdb     (SUPERUSER imutável, NOLOGIN, sem senha, sem uso)
```

### `pcgp_initdb`
- Superusuário de **bootstrap original do `initdb`** (OID 10).
- Permanece `SUPERUSER` por **limitação do PostgreSQL**: o bootstrap superuser
  não pode ter o atributo `SUPERUSER` removido nem ser derrubado
  (`ERROR: The bootstrap superuser must have the SUPERUSER attribute`). Por isso
  foi **renomeado** (era `pcgp_app`) e neutralizado.
- **`NOLOGIN`** e **senha removida** (`PASSWORD NULL`) → não é credencial utilizável.
- **Não participa do runtime.**
- **Não é proprietário de nenhum objeto da aplicação PGCP** (0 tabelas, 0 funções,
  0 bancos da aplicação). É dono apenas de objetos internos do próprio PostgreSQL
  ligados ao bootstrap — o que não afeta a aplicação.

### `pcgp_bootstrap`
- Superusuário de **DBA / break-glass**.
- **Não utilizado pela aplicação nem pelas migrations.**
- Credencial deve ficar **no cofre**; uso **excepcional** (administração de cluster).
- Em ambientes **novos** (via `docker-compose`), é o único superusuário com login;
  `pcgp_initdb` nem existe.

### `pcgp_admin`
- **Migrations / administração controlada.** Dono do banco e de todos os objetos
  (por isso pode conceder privilégios de objeto).
- `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`.
- Usado por `npm run db:migrate` (o runner `apps/api/src/migrate.ts` tem pool
  próprio com `DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD`).

### `pcgp_app`
- **Runtime da API** (`DB_USER`/`DB_PASSWORD`).
- Menor privilégio: `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`,
  `NOBYPASSRLS`.
- **Sem ownership** de qualquer objeto (não pode `ALTER`/`DROP`/`TRUNCATE` nem
  desabilitar gatilho).
- Só o **DML** necessário nas tabelas do domínio; **sem** acesso a
  `schema_migrations`.

### Por que a posse é de `pcgp_admin`, não de `pcgp_app`
O **dono** de uma tabela pode `TRUNCATE`, `DROP`, `ALTER` e desabilitar gatilho
independentemente de `REVOKE`. Enquanto `pcgp_app` fosse dono de `audit_logs`,
nenhum `REVOKE` protegeria a trilha. Por isso toda a posse migrou para
`pcgp_admin`, e o runtime recebe apenas grants de DML.

---

## 4. `audit_logs` append-only — protegido por privilégio real

`audit_logs` deixou de ser append-only "por convenção" e passou a ser imposto
por privilégio do PostgreSQL. Para **`pcgp_app`** (runtime):

```text
SELECT   = permitido
INSERT   = permitido
UPDATE   = negado
DELETE   = negado
TRUNCATE = negado
DROP     = negado (não é owner da tabela)
```

Concedido pela migration `015_runtime_least_privilege.sql`; a posse da tabela é
de `pcgp_admin`.

### Evidência (✅ validado no cluster local)
`SELECT has_table_privilege('pcgp_app','audit_logs', …)`:
```text
INSERT   = true
UPDATE   = false
DELETE   = false
TRUNCATE = false
SELECT   = true
```
Prova funcional conectado como `pcgp_app` (transação revertida, sem alterar dado real):
```text
UPDATE audit_logs …    → ERROR: permission denied for table audit_logs
DELETE FROM audit_logs → ERROR: permission denied for table audit_logs
TRUNCATE audit_logs    → ERROR: permission denied for table audit_logs
DROP TABLE audit_logs  → ERROR: must be owner of table audit_logs
CREATE DATABASE …      → ERROR: permission denied to create database
CREATE ROLE …          → ERROR: permission denied to create role
CREATE TABLE public.…  → ERROR: permission denied for schema public
INSERT INTO audit_logs → INSERT 0 1   (append-only permite INSERT)
```
Validado no cluster real (dado preservado: `users`, `governance_bodies`,
`meetings`, `audit_logs`, `schema_migrations` intactos) e num cluster limpo
efêmero provisionado do zero pelo init do Docker.

---

## 5. Hardening de produção — `production-guard` (fail-fast)

`apps/api/src/config/production-guard.ts`, chamado em `server.ts` **antes** do
`app.listen`. Só age quando `NODE_ENV=production`; em desenvolvimento é no-op.

Aborta a inicialização (a API **não sobe**) se houver, entre outros:
- **Entra não configurado** (`ENTRA_TENANT_ID` / `ENTRA_API_CLIENT_ID` / `ENTRA_SPA_CLIENT_ID` ausente);
- **`CORS_ORIGIN=*`**;
- **localhost / 127.0.0.1** no `CORS_ORIGIN`;
- **`http://`** em origem de produção (sem TLS);
- **`DB_SSL != true`**;
- `CORS_ORIGIN` ausente (cairia no default de desenvolvimento).

Frontend: `apps/web/src/main.tsx` tem fail-fast próprio — um bundle
`import.meta.env.PROD` que ainda permitisse **mock login** (Entra não configurado
no build) **não renderiza**, mostra erro e aborta. O mock login já se desliga
sozinho quando o Entra está configurado (`isMockLoginAllowed()` exige Entra
ausente).

### Cinco cenários validados (✅ local)
| Cenário | Resultado |
| --- | --- |
| `NODE_ENV=production` + só `DB_SSL=false` | **aborta** (só acusa DB_SSL) |
| `NODE_ENV=production` + só CORS localhost | **aborta** (só acusa localhost) |
| `NODE_ENV=production` + só CORS `http://` | **aborta** (só acusa http) |
| `NODE_ENV=production` + `DB_SSL=true` + CORS `https://` válido | **sobe normalmente** |
| `NODE_ENV=development` + `DB_SSL=false` + localhost | **permitido** (dev) |

Cobertura: `apps/api/src/config/production-guard.test.ts`.

---

## 6. Rate limiting

### Na aplicação — por principal autenticado (`oid`)
`apps/api/src/security/rate-limit.ts` + `apps/api/src/security/limiters.ts`.
Chave = `oid` do principal → **isolamento por usuário**.

| Rota | Limite | Por quê |
| --- | --- | --- |
| `GET /directory/users` | **40 / 10 s** | Busca no **Microsoft Graph** — cota de throttling é do **tenant**; um usuário não pode degradar o Graph para todos. Typeahead com debounce; 40/10 s dá folga e corta enumeração roteirizada. |
| `GET /calendar/me` | **30 / 10 s** | Agenda própria via Graph (OBO); cobre recargas sem martelar o Graph. |
| `POST /meetings/:id/agenda-items/:agendaItemId/teams-message` e `…/teams-call` | **10 / 60 s** compartilhado | Cada uso faz até duas chamadas Graph por participante (chat 1:1 + mensagem); limita abuso e protege a cota do tenant. |
| `POST /integrations/:id/test` | **10 / 60 s** | Admin; dispara probe de rede (banco, OIDC, Graph, DocuSign) — evita virar scanner contra hosts externos. |

Ao estourar: **HTTP 429** `{code:"rate_limited"}` + `Retry-After` + cabeçalhos
`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` (draft IETF).
Registra evento de segurança `rate_limit`.

**Limitação (documentada):** estado **em memória, por instância**. Com múltiplas
instâncias, o teto por principal vale por instância; o limite volumétrico
autoritativo é o da borda. A interface do middleware isola isso — se um dia for
preciso limite por principal **global** entre instâncias, trocar por **Redis** ou
mecanismo equivalente.

Cobertura: `apps/api/src/security/rate-limit.test.ts` (chamada normal, estouro
429, `Retry-After`, `RateLimit-*`, isolamento por usuário, recuperação após a
janela). ✅ validado.

### Na borda (⚠️ externo)
WAF / reverse proxy / API Gateway cuida do volumétrico que a aplicação não deve
duplicar: **por IP**, **burst**, **volumetria**, **DDoS**, **automação abusiva**.
Ver §14 e `docs/producao-hardening.md`.

---

## 7. Entra ID / autenticação

Validação do access token em `apps/api/src/entra/verify.ts` (via `jose`):

- **assinatura** (chaves do **JWKS** remoto por tenant), **RS256**;
- **issuer** (`https://login.microsoftonline.com/{tid}/v2.0`);
- **audience** (`aud` = client id da API — reconferido após o `jose`);
- **`tid`** (tenant);
- **`oid`** (identidade estável; rejeita token sem `oid`);
- **`azp`** (só o SPA do PGCP pode obter token para a API);
- **`scp`** (contém `access_as_user`);
- **`exp`** / **`nbf`** (com `clockTolerance` de 60 s).

Regras de autorização:
- **autorização é feita no servidor** — cada rota protegida revalida;
- o **frontend só controla UX** (esconder botão é cortesia, não barreira);
- **App Roles vêm do claim `roles`** do token assinado;
- **papel nunca é derivado de e-mail, nome, `jobTitle` ou grupo consultado à
  parte** — o token já diz, assinado.

Identidade = par (`tid`, `oid`). Nunca e-mail/UPN/`sub` (mutáveis / pairwise).

Rejeição comprovada (✅ local): token forjado (assinatura inválida), `Bearer`
malformado e ausência de credencial → **401** com mensagem genérica
(`invalid_token`), sem oráculo. Validação de `aud`/`tid`/`exp` contra token
**real** é ⚠️ pré-go-live (precisa do tenant).

### Restauração de sessão no frontend — App Roles preservadas (correção, commit `3a6f76d`)

**Sintoma:** após alguns minutos de inatividade (aba descartada/congelada pelo
navegador) ou reload da SPA, o usuário seguia **autenticado**, mas a interface
passava a tratá-lo como **sem papel** — funcionalidades condicionadas a App Role
sumiam; logout+login restaurava.

**Causa raiz:** o login gravava `name`, `role` **e `appRoles`** no `sessionStorage`,
mas `readSessionUser()` restaurava **só `name`/`role`**, descartando `appRoles`.
No remount, `isAuthenticated` voltava `true` (de `sessionStorage`) enquanto
`currentUser.appRoles` vinha vazio → `podeAssessorar`/`podeAdministrar` = `false`.

**Correção:** `apps/web/src/auth/session.ts` (`parseSessionUser`, pura) passa a
restaurar `appRoles` (sanitizando: só array de strings); `App.tsx` delega a ela.

**Não era expiração de token / MSAL / Graph.** `acquireTokenSilent` e a
restauração da conta ativa (`initializeMsal` → `setActiveAccount`) funcionavam; a
renovação do token **nunca** tocava `appRoles`; não há handler de `401` que zere
papéis; o frontend **não** decodifica token — as roles vêm de `GET /me` (servidor).
Era exclusivamente a **desserialização da sessão no navegador**.

**`appRoles` no frontend = UX, não autorização.** O backend continua a autoridade:
cada rota revalida a App Role e responde **403** sem o papel (§8). Restaurar as
roles no cliente **não** escala privilégio — token/`azp`/`scp`/`roles` são
reconferidos no servidor, e usuário sem papel continua recebendo 403.

**Testes:** `apps/web/src/auth/session.test.ts` (7 casos — papéis preservados no
remount, sem escalonamento, formato inválido ignorado, sessão corrompida →
padrão); suíte web incorporada ao monorepo (`npm test`).

**Pendência:** QA autenticado real dos cenários de inatividade/remount/renovação
com o tenant Entra continua ⚠️ **pré-go-live** — não validado aqui.

---

## 8. Perfis / RBAC

Middlewares em `apps/api/src/authz/app-roles.ts`.

| Perfil | App Role | Pode |
| --- | --- | --- |
| Usuário comum | *(nenhum)* | Ler conteúdo corporativo, ver a própria agenda, cuidar dos próprios FUPs. |
| Assessoria | `PGCP.Assessoria` | Operar reuniões (criar, agendar, editar, conduzir) e manter cadastros funcionais. |
| Admin | `PGCP.Admin` | Administrar a plataforma: usuários, órgãos, integrações, auditoria, taxonomias. |

`PGCP.Assessoria` e `PGCP.Admin` são **independentes** (sem hierarquia implícita);
quem precisa das duas recebe as duas atribuições no Entra. Exceção deliberada:
cadastros funcionais (órgãos, tipos, naturezas) aceitam `PGCP.Assessoria` **OU**
`PGCP.Admin`.

### Ciclo de vida da reunião — eixos independentes (revisado na migration 025)

**Mudança de regra de produto (025).** Até a 024 o convite só saía depois das
pautas aprovadas (409 `agenda_not_approved`). O fluxo principal foi
reestruturado para **reservar a agenda de executivos cedo**:

```
Calendário ──► Nova reunião ──► convite Outlook/Teams ──► Pipeline (preparação)
Agenda Anual ─► associa as MESMAS reuniões do órgão/ano ─► Pauta → Tema ─► compilado ─► aprovação (versão imutável)
Pipeline: Pautas → Temas → validação das pautas → aprovação → INICIAR a reunião
```

O gate do convite foi **retirado deliberadamente** de `POST /:id/calendar-sync`;
o de **início** da reunião foi mantido (pautas aprovadas + convite enviado,
`exigirProntaParaIniciar`). O que continua barrando o convite: App Role
`PGCP.Assessoria`, organizador com identidade Microsoft, participantes com
endereço (422 nominal) e a idempotência (`transactionId` fixo + PATCH no
`provider_event_id` — no máximo um evento por reunião, inclusive nas reuniões
reservadas pela Agenda Anual e depois editadas pelo Pipeline).

| Etapa | Onde vive o estado | Quem pode |
| --- | --- | --- |
| Agendar (Calendário) / reservar (Agenda Anual — rota mantida, sem UI desde a 028) | `meetings` (+ `origin`) e `annual_agenda_items.meeting_id` | `PGCP.Assessoria` |
| Enviar convite Outlook/Teams | `meeting_calendar_integrations.sync_status` | `PGCP.Assessoria` |
| Preparação (pautas e temas) | `meeting_agendas` / `meeting_agenda_items` | `PGCP.Assessoria` |
| Enviar pautas para validação | `meetings.agenda_validation_status = 'sent'` | `PGCP.Assessoria` |
| Marcar pautas como aprovadas | `… = 'approved'` + `agenda_approved_by_user_id` | `PGCP.Assessoria` |
| Aprovação da Agenda Anual | `annual_agendas.status` + `annual_agenda_versions` (snapshot imutável) | `PGCP.Assessoria` |
| Associar reunião / editar pauta-tema pela Agenda Anual | `meetings.annual_agenda_id`; `meeting_agendas`/`meeting_agenda_items` | `PGCP.Assessoria`; só com a agenda em `draft` (servidor) |

**Três eixos que não se confundem** e por isso não compartilham coluna:

- `meetings.status` — ciclo da **reunião** (`scheduled`, `in_progress`, `done`);
- `meetings.agenda_validation_status` — ciclo da **pauta**;
- `meeting_calendar_integrations.sync_status` — estado do **convite**, com
  `provider_event_id` como prova de que o evento existe.

Aprovar a pauta **não** altera `meetings.status`. "Convite enviado" não ganhou
coluna própria: já é `sync_status = 'synced'`, e uma segunda fonte poderia
discordar dela.

**A barreira que resta no convite é o papel.** Com o gate de aprovação retirado,
`requirePgcpAssessoria` em `calendar-sync` e em `annual-agendas/:id/reserve` é o
que impede usuário comum de criar eventos na agenda de terceiros (testado em
`authz/route-guards.test.ts`). Esconder botão continua sendo cortesia.

**IDOR em pautas/temas.** Toda operação de pauta (`/meetings/:id/agendas/:agendaId`)
e de tema filtra por `meeting_id`; vincular tema a pauta confere a pauta **na
mesma reunião** (404 caso contrário) e o banco reforça com **FK composta**
`(meeting_agenda_id, meeting_id)` — um tema não consegue apontar para pauta de
outra reunião nem por chamada direta. Itens de Agenda Anual são sempre
consultados com `annual_agenda_id` no `WHERE`.

**Agenda Anual (028).** Rotas de conteúdo `/annual-agendas/:id/meetings/:meetingId/...`
conferem que a reunião pertence à agenda (IDOR → 404) e que a agenda está em
`draft` (409 enviada/aprovada) antes de delegar às funções de `/meetings`.
Payloads fechados (mass assignment recusado): criar tema (`POST .../temas`)
aceita o cadastro do tema **ou** só `agendaTopicId` + duração/pauta (o servidor
resolve o tema-mestre — o cliente não forja título, ficha nem origem); editar
aceita os campos do cadastro, nunca os operacionais (`executionStatus` etc.). Associar
exige mesmo órgão e mesmo ano no fuso da reunião e recusa reunião de outra
agenda — validado na aplicação e por trigger no banco. A versão aprovada é
imutável por privilégio (sem `DELETE`/`UPDATE` de conteúdo para `pcgp_app`) e
por trigger. Associar não chama o Graph; o envio para aprovação reusa
`Mail.Send` (nenhuma permissão nova).

**Participantes externos (026).** `/external-participants` tem
`requireAssessoriaOuAdmin` **no router** (mesma política dos cadastros
funcionais; nenhuma App Role nova) — inclusive a leitura, porque a lista expõe
e-mail e telefone de terceiros. Allowlist fechada (`fullName`, `email`, `phone`,
`governanceBodyId`); identidade Entra, `userId`, origem e id são recusados. E-mail
único case-insensitive (índice), telefone por allowlist de caracteres, nome
2–200, órgão conferido no banco. Antes de gravar: recusa e-mail já usado por
participante PGCP, por conta em `users` (e-mail/UPN) e — uma chamada Graph
**só na gravação**, `User.Read.All` já concedida — por pessoa do diretório.
**Fail closed:** se o Graph não puder verificar, o cadastro é recusado (503,
mensagem simples, sem detalhe do Graph) e nada é gravado. A consulta é só de
integridade — o resultado nunca é devolvido; a API administrativa lista apenas
registros locais. A busca combinada Entra + PGCP existe só nos seletores de
participantes de reunião (`/directory/users` já existente + lista local).
Participante externo **não** cria linha em `users`, não recebe App Role e não
autentica. Trilha: "Participante criado/atualizado/removido", com nome e id —
sem e-mail nem telefone.

**Classificação de pessoas e contexto global (027).** `/directory-people` tem
`requireAssessoriaOuAdmin` no router (mesma política de Participantes). Vincular
pessoa do Entra aceita só o `oid`: a existência é confirmada no Graph
(`GET /users/{oid}`, `User.Read.All` já concedida; **fail closed** — sem
verificação, 503) e nome/e-mail vêm do Graph, o tenant do token. Leitura,
alteração e remoção filtram por tenant (IDOR). Nada cria `users`,
`external_participants` ou App Role. Órgãos/temas inexistentes → 404; vínculos
duplicados barrados por índice único. Auditoria consolidada por ato ("Vínculos
de pessoa do diretório atualizados/removidos"), sem e-mail. O **Órgão colegiado
do cabeçalho é filtro de navegação no navegador** — não é enviado à API e não
concede acesso; o backend/App Roles seguem como autoridade.

**Grupos de participação e exceção por reunião (031).** `/participation-groups`
tem `requireAssessoriaOuAdmin` no router. Adicionar ao grupo do órgão aceita só
`entraObjectId` **ou** `externalParticipantId` (corpo fechado; nome, e-mail,
tenant e órgão nunca vêm do cliente); pessoa do Entra é confirmada no Graph
(**fail closed**, 503); externo precisa existir (404). Remover filtra por órgão
**e** tenant (IDOR → 404). Participantes padrão do tema seguem nas rotas e
regras de `/agenda-topics`. A inclusão automática roda **só no servidor** (criação
da reunião; entrada no grupo, nas reuniões abertas do órgão, travadas na mesma
transação; tema da Biblioteca adicionado) e respeita
`meeting_participant_exclusions`. "+ Novo tema" da Agenda cria o tema-mestre
pela mesma função da Biblioteca (corpo fechado do contrato "novo"; tipo/natureza
inexistentes → 404). **Pertencer a um grupo não é autorização**:
não cria `users`, não dá App Role, não dá acesso ao PGCP. Trilha: entrada/saída
do grupo (órgão + nome), inclusão automática consolidada por ato (contagem),
exceção criada/removida — sem e-mail.

**Agenda Anual → Pipeline.** Mutação em `/meetings/:id/...` de reunião cuja
Agenda Anual não está aprovada → 409 ("em preparação na Agenda Anual"), por
uma guarda única montada antes das rotas do router; leitura e
`calendar-sync` seguem. A listagem expõe `releasedToPipeline` decidido no
servidor. A Agenda gerencia participantes da reunião pelas próprias rotas
(`PGCP.Assessoria`, agenda em `draft`, pertença conferida, mesmas regras de
deduplicação/exceção da aba Participantes).

**Documentos (S3, migration 033).**

- Leitura: `GET /documents`, `GET /documents/tree` e
  `GET /documents/:id/download` exigem usuário PGCP ativo e aplicam a cláusula
  de leitura de reunião (`clausulaDeReuniaoVisivel`). Query fechada e validada
  (UUIDs, enums, datas, ano/mês, limites; curingas do LIKE escapados).
  Documento inexistente ou fora da visibilidade → 404, sem revelar qual.
- Download: a API autoriza pelo contexto, lê o objeto e devolve os bytes com
  `Content-Disposition: attachment` (nome saneado + `filename*` UTF-8),
  `Cache-Control: private, no-store` e `X-Content-Type-Options: nosniff`.
  **Sem URL pré-assinada, sem URL permanente, chave do objeto nunca sai.**
  Ata e Agenda Anual seguem pelas rotas de origem.
- Upload: só `POST /meetings/:id/documents`, com `PGCP.Assessoria` e a guarda
  de liberação do Pipeline (reunião de Agenda não aprovada → 409). Corpo
  `application/octet-stream` (outro tipo → 415), limite central
  `DOCUMENT_MAX_SIZE_BYTES` (padrão 20 MB, teto 100 MB; excedeu → 413). Nome e
  descrição em cabeçalho URL-encoded; só `agendaItemId` é aceito na query.
- Validação no servidor: allowlist (PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX) com
  **MIME decidido pelo servidor** e assinatura do conteúdo (`%PDF-`, ZIP, OLE);
  denylist de extensões perigosas também nas extensões internas (dupla
  extensão: `relatorio.exe.pdf`), sem macro (`pptm/docm/xlsm`), sem
  HTML/SVG/JS/CSV; arquivo vazio recusado; nome reduzido ao basename (sem
  path traversal), sem caracteres de controle, sem arquivo oculto, ≤ 255.
- Tema precisa ser **desta** reunião (checagem na aplicação + FK composta).
- Ordem: valida → grava no S3 (SSE `AES256`, ou `aws:kms` com
  `PGCP_DOCUMENTS_KMS_KEY_ID`; sem ACL) → INSERT + auditoria na mesma
  transação. Falha no banco após o upload remove o objeto (compensação, sem
  órfão). Falha do S3 não grava metadado.
- Auditoria: "Documento adicionado à reunião" / "… ao tema da reunião", sem
  chave, URL ou conteúdo.
- Sem S3 configurado o sistema funciona; só as operações de arquivo respondem
  503. Em produção, `production-guard` exige `PGCP_DOCUMENTS_BUCKET` e
  `AWS_REGION`. Credenciais só pela cadeia padrão do SDK (IAM role) — nenhuma
  credencial no código ou no `.env.example`.

**Mass assignment.** `origin`, `annualAgendaId`, `status` da Agenda Anual,
`meeting_id` do item e tenant não são aceitos do corpo (allowlists fechadas,
testadas). Local físico só por chave do catálogo — texto livre é recusado.

A **aprovação acontece fora do sistema**: o aprovador responde por e-mail e
alguém da Secretaria registra o fato no PGCP. Não há leitura automática de
resposta, link de aprovação nem portal externo — afirmar aprovação sem evidência
seria o mesmo erro da assinatura fictícia removida na 4.10.

### Testes que dependem do ambiente real (⚠️ pendente externo)
- usuário comum tentando ação de Assessoria → **403** (`missing_app_role`);
- usuário comum tentando ação Admin → **403**;
- Assessoria tentando ação Admin → **403**;
- chamadas **diretas à API** ignorando restrição que só existe na UI;
- **troca de IDs** / IDOR: reunião/FUP/ata/pauta de outro usuário → **404**
  (invisível) ou **403** (existe, não é seu) — nunca **200**.

Esses testes ponta a ponta exigem **contas/tokens corporativos reais** e
continuam como item de pré-go-live (ver `docs/go-live.md`, passos 10–11). Os
controles de código já foram auditados e estão presentes.

---

## 9. Microsoft Graph

Modelo de **menor privilégio** — detalhe em [`docs/integracoes.md`](integracoes.md)
e `apps/api/src/graph/client.ts`.

| Capacidade PGCP | Tipo | Permissão | Endpoint | Onde é concedida |
| --- | --- | --- | --- | --- |
| Diretório (busca de pessoas) | Application | `User.Read.All` | `GET /users?$search` | App Registration da API (Entra) |
| Meu calendário | Delegated (OBO) | `Calendars.Read` | `GET /me/calendarView` | App Registration da API (Entra) |
| Sincronizar reunião / Teams / Outlook | Application | `Calendars.ReadWrite` | `POST/PATCH /users/{id}/events` (com `isOnlineMeeting`) | **Exchange Online RBAC for Applications** (Resource Scope de mailbox) |
| Enviar pautas para validação | **Delegated (OBO)** | `Mail.Send` | `POST /me/sendMail` | App Registration da API (Entra) — ✅ **concedida e validada** |
| Enviar Agenda Anual para aprovação (PDF) | **Delegated (OBO)** | `Mail.Send` (a MESMA) | `POST /me/sendMail` | Reusa `mail/send.ts`; nenhuma permissão nova. ⚠️ envio real deste fluxo ainda não exercitado no tenant |
| Mensagem individual ou chamada por pauta | **Delegated (OBO)** | `Chat.Create` + `ChatMessage.Send` | `POST /chats` + `POST /chats/{id}/messages` | App Registration da API (Entra) — ✅ **concedidas e validadas no tenant real** |
| SPA (navegador) | — | **nenhuma** | — | zero permissão de Graph |

Pontos-chave:
- **O SPA não deve carregar permissão de Graph** — todo Graph nasce na API. O
  navegador só obtém token para a **API do PGCP**.
- Calendário **app-only** (não OBO) para reunião/Teams: sincronizar não pode
  depender da sessão do organizador estar aberta.
- **Exchange RBAC com Resource Scope** limita **quais mailboxes** a aplicação
  alcança. **Não** conceder `Calendars.ReadWrite` (Application) **tenant-wide no
  Entra** — passaria por cima do escopo do Exchange.
- Teams-messages usa exclusivamente as permissões **delegadas** já concedidas;
  não existe fallback app-only, bot ou conta técnica.

### `Mail.Send` — Delegated com OBO, nunca Application

Estratégia **definida e implementada** para o e-mail de validação de pautas:

```
usuário autenticado → PGCP API → OBO → Microsoft Graph → POST /me/sendMail
```

| Decisão | Estado |
| --- | --- |
| `Mail.Send` **Delegated** | estratégia definida para este fluxo |
| `Mail.Send` **Application** | **NÃO é utilizado** — nem agora, nem como alternativa |
| Caixa remetente | a do **usuário autenticado**, resolvida pelo token |
| Aquisição do token | **On-Behalf-Of** na API (`apps/api/src/mail/send.ts`) |
| Mailbox técnica / remetente institucional | **não** usado neste fluxo |

**Por que Delegated e não Application.** `Mail.Send` Application permite enviar
como **qualquer caixa do tenant**, a menos que restringida por uma *Application
Access Policy* do Exchange. É o mesmo padrão que este projeto já recusou para
`Calendars.ReadWrite` (ver ponto acima). Delegated envia como a **própria
pessoa**, só enquanto ela tem sessão, e não alcança caixa alheia — não há
privilégio novo a conter.

Além disso o e-mail é um pedido pessoal da Secretaria ao aprovador: sair da caixa
de quem pediu é o comportamento correto, e o aprovador responde para a pessoa
certa. `MAIL_SENDER_ADDRESS` **não participa** deste fluxo.

`/me/sendMail` não aceita identificador de caixa na chamada — não há parâmetro
por onde o PGCP enviar como outra pessoa, nem por engano nem por manipulação.

**O corpo é enviado como `contentType: "text"`**, nunca HTML: o texto vem de um
modelo editável pela administração somado a dados da reunião, e HTML
transformaria qualquer título em superfície de injeção no cliente do
destinatário. O anexo é um **PDF** gerado no servidor.

#### Estado da validação no tenant real

Primeiro teste corporativo em **26/08/2026**.

**✅ Validado no tenant real:**

| Item | Evidência |
| --- | --- |
| Permissão `Mail.Send` (Delegated) concedida | consentimento do administrador aplicado |
| Fluxo OBO com usuário corporativo real | troca de token concluída; sem `AADSTS65001` |
| `POST /me/sendMail` | Graph respondeu **202 Accepted** |
| Envio pela caixa do **usuário autenticado** | mensagem saiu da caixa de quem clicou |
| Recebimento real com o **PDF anexado** | destinatário recebeu e abriu o anexo |

Isso encerra a dúvida sobre a estratégia: **`Mail.Send` Delegated + OBO funciona
no tenant**, e a versão Application segue sem necessidade.

**⚠️ Ainda a revalidar — o mesmo teste expôs um defeito, já corrigido:**

| Item | Estado |
| --- | --- |
| Persistência de `agenda_validation_status = 'sent'` após envio real | ⚠️ **não confirmada** |
| Entrada de auditoria de **sucesso** | ⚠️ **não confirmada** |
| Retorno de sucesso na interface | ⚠️ **não confirmado** |

**O que aconteceu.** `/me/sendMail` responde `202 Accepted` com corpo **vazio**.
O cliente do Graph tratava apenas `204` como "sem corpo" e chamava
`response.json()` no resto, então o `202` virava
`SyntaxError: Unexpected end of JSON input` **depois** de a Microsoft já ter
aceitado a mensagem. O e-mail chegou; a tela mostrou *"Erro interno ao processar
a solicitação"*; o `UPDATE` para `sent` nunca executou; a trilha registrou
**falha**. A pessoa reenviou e o aprovador recebeu **dois e-mails**.

As duas entradas `failure` em `audit_logs` são **evidência legítima do
incidente** e não devem ser removidas nem editadas — `audit_logs` é append-only.

Corrigido em `apps/api/src/graph/client.ts` (lê o corpo como texto e só faz parse
se houver conteúdo), com teste de regressão em `graph/client.test.ts`. A cadeia
pós-envio foi exercitada contra o banco (`draft → sent → approved`,
`meetings.status` inalterado, aprovação idempotente, trilha com dois sucessos),
mas **com o envio simulado** — falta repetir com envio real.

**Enquanto os três itens de revalidação não forem confirmados no tenant, este
fluxo não deve ser considerado pronto para produção.**

Comportamento quando o Graph falha de verdade: a API traduz para erro acionável
e — o que importa para integridade — **a validação NÃO é marcada como enviada**.
O envio acontece antes de qualquer escrita no banco. Se a falha ocorrer **depois**
de o Graph aceitar, a API devolve mensagem explícita dizendo que o e-mail **foi
enviado** e que não se deve reenviar, e registra o descompasso na trilha.

### Mensagens do Teams — Delegated com OBO, nunca Application

Fluxo implementado em `apps/api/src/teams/messages.ts`:

```
usuário autenticado → SPA (token da API) → API PGCP → OBO
→ Microsoft Graph → chat 1:1 → participante da pauta
```

| Estado | Evidência |
| --- | --- |
| **IMPLEMENTADO NO CÓDIGO** | endpoints de mensagem manual e chamada automática protegidos por `PGCP.Assessoria`; destinatários consultados em `meeting_agenda_item_participants`; identidade por `entra_tenant_id + entra_object_id`; `POST /chats` one-on-one e `POST /chats/{id}/messages`; resultado individual e sucesso parcial; rate limit compartilhado por `oid` |
| **VALIDADO POR TESTE AUTOMATIZADO** | payload Graph, OBO com `.default` e verificação dos scopes concedidos; Chamar com cronograma/link oficiais; um/vários destinatários; sucesso parcial; pauta vazia; link ausente; timezone; IDOR; RBAC; 401/403/429; identidade ausente; limites de mensagem; auditoria distinta e sem conteúdo |
| **CONFIGURADO NO ENTRA** | `Chat.Create` — Delegated — concedida; `ChatMessage.Send` — Delegated — concedida |
| **VALIDADO MANUALMENTE NO TENANT CORPORATIVO** | troca OBO com `.default` e scopes exigidos aceita; mensagem manual e Chamar entregues pelo usuário autenticado; hyperlink clicável e apresentação HTML do Chamar confirmados visualmente |

O navegador continua pedindo somente `access_as_user` para a API PGCP. A API
valida `aud` como o client id da própria API, conserva a assertion somente na
requisição e pede ao Entra um token Graph delegado com
`https://graph.microsoft.com/.default`. Antes de usar o token, a API exige que
o resultado validado pelo MSAL contenha `Chat.Create` e `ChatMessage.Send`.
Nenhum access token ou refresh token é persistido, devolvido ao frontend ou
escrito em log.

Os destinatários não vêm do corpo: a API valida o par reunião/pauta e consulta a
relação persistida da pauta. Participante sem o par Microsoft inequívoco falha
individualmente; não há busca aproximada por nome ou e-mail. Cada destinatário
gera auditoria de sucesso/falha com ator, pauta e nome exibido, mas nunca com o
texto da mensagem. Em `teams-call`, a própria API acrescenta o título da reunião,
o título e o horário persistido da pauta, a duração e o link de acesso real
(`calendar.joinUrl`, com `meetingLink` válido como fallback legado); nenhum desses
campos vem do navegador.

### Validação no ambiente corporativo

Realizado nesta entrega: convite Outlook recebido pelo participante; mensagem
manual e Chamar entregues no Teams; hyperlink e apresentação HTML do Chamar
confirmados visualmente.

Checklist geral do ambiente, com itens independentes desta entrega:
- `POST /integrations/graph/test` (Admin) → `connected`;
- busca real em `GET /directory/users`;
- agendar reunião → **evento no Outlook** do organizador + reunião **Teams** com
  `joinUrl`;
- `GET /calendar/me` retorna agenda;
- enviar mensagem na aba Anotações e confirmar, em contas distintas, remetente
  igual ao usuário autenticado, recebimento individual e resultado parcial;
- mailbox **dentro** do Resource Scope → sucesso;
- mailbox **fora** do escopo → `ErrorAccessDenied`.

---

## 10. CORS

`apps/api/src/server.ts`. Estado final:
- **allowlist explícita** por `CORS_ORIGIN`, **nunca `*`**;
- reflete a origem só se estiver na lista; adiciona **`Vary: Origin`**;
- métodos exatos (`GET, POST, PATCH, PUT, DELETE, OPTIONS`); headers exatos
  (`Authorization, Content-Type`);
- **sem `Access-Control-Allow-Credentials`** — a API é **bearer token**, não usa
  cookie; habilitar credentials ampliaria superfície sem necessidade;
- preflight `OPTIONS` → 204;
- em produção o `production-guard` recusa `localhost`, `http://` e `*` no
  `CORS_ORIGIN` (**HTTPS obrigatório**).

✅ validado ao vivo: origem permitida recebe `Access-Control-Allow-Origin`; origem
fora da lista não recebe.

---

## 11. Headers / CSP

### API (implementado)
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `X-Powered-By` removido — em toda resposta.

### Frontend / borda (⚠️ configurar no host estático / reverse proxy)
O frontend é um bundle estático; CSP, HSTS e `Permissions-Policy` pertencem ao
host que o serve. **CSP não foi embutida como `<meta>`** de propósito — uma CSP
incorreta quebra o fluxo MSAL e o login real não é validável em desenvolvimento.
String recomendada completa em [`docs/producao-hardening.md`](producao-hardening.md); em resumo:
- `connect-src 'self' https://SUA-API https://login.microsoftonline.com` — **Graph
  NÃO** entra (o navegador não chama o Graph);
- `frame-src 'self' https://login.microsoftonline.com`;
- `frame-ancestors 'none'` no `index.html` (anti-clickjacking);
- `Strict-Transport-Security` (HSTS) só com HTTPS garantido;
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`.

**Observação crítica (fluxo silencioso do MSAL):** `acquireTokenSilent` usa um
**iframe oculto** que carrega `login.microsoftonline.com` e depois a página
**same-origin** `auth/redirect.html`. Portanto **`auth/redirect.html` NÃO pode
receber `X-Frame-Options: DENY` nem `frame-ancestors 'none'`** — isso quebra o
iframe (mesmo same-origin) e o SSO silencioso. Para `redirect.html` use no máximo
`frame-ancestors 'self'` e **não** envie `X-Frame-Options`.

**CSP deve ser validada com login real e `acquireTokenSilent`** antes do go-live
(passo 6 de `docs/go-live.md`).

---

## 12. Logs e observabilidade

### Correlation id
`apps/api/src/security/request-id.ts` — cada requisição tem **`X-Request-Id`**:
- **reaproveita** o id do proxy quando válido (`^[A-Za-z0-9._-]{1,128}$`);
- **gera UUID** quando ausente;
- devolvido no cabeçalho da resposta e presente em todo log.

### Log estruturado de segurança
`apps/api/src/security/security-log.ts` — uma linha JSON por evento
(`kind:"security"`), em stdout, **sem token / secret / cookie / connection
string** (os campos são fechados de propósito). Cada evento tem `requestId`,
`principalOid`, `route` (sem querystring), `status`, `code`.

Eventos cobertos:

| Evento | Origem |
| --- | --- |
| 401 / credencial ausente / token inválido | `entra/middleware.ts` (`unauthorized`, `invalid_token`) |
| 403 / App Role ausente | `authz/app-roles.ts` (`missing_app_role`, `forbidden`) |
| 429 (rate limit) | `security/rate-limit.ts` (`rate_limit`) |
| teste de integração | `integrations/routes.ts` (`integration_test`) |
| erro de Graph | `graph/client.ts` (log da API, sem token) |
| erro inesperado | handler final em `server.ts` (`unexpected_error`, com `requestId`) |
| login bem-sucedido | `audit_logs` (trilha de governança, em `/me`) |
| alterações administrativas | `audit_logs` (cada operação de domínio, na transação do ato) |

Tipos definidos no `SecurityEventType`: `auth_success`, `auth_failure`,
`invalid_token`, `missing_app_role`, `unauthorized`, `forbidden`, `rate_limit`,
`admin_change`, `integration_test`, `graph_error`, `unexpected_error`.

✅ validado ao vivo: um 401 emitiu
`{"kind":"security","type":"unauthorized","requestId":"…","route":"GET /directory/users","status":401,"code":"missing_token"}`
— com `requestId`, `route` **sem querystring** (protege o termo de busca) e **sem token**.

### Log Analytics em produção (⚠️ externo)
Dois caminhos, sem código novo obrigatório:
1. o coletor do host lê **stdout** (as linhas `kind:"security"` já saem prontas);
2. ou exportador OpenTelemetry / Application Insights na API (slot
   `APPLICATIONINSIGHTS_CONNECTION_STRING` já previsto no catálogo).
   **Nunca** enviar token, secret, cookie ou connection string.
Alertas sugeridos: pico de 401/403 por `principalOid`/IP; `rate_limit` recorrente;
`unexpected_error`; `missing_app_role` repetido.

---

## 13. Secrets

- **`.env*` ignorados no Git** (`.gitignore`: `.env*`, exceto `.env.example`) — o
  `.env` real nunca é versionado.
- **Nenhum secret hardcoded** em código, docs, scripts, `docker-compose` ou
  `.env.example` — verificado; só há `config.clientSecret` (leitura de config).
- Frontend: variáveis `VITE_*` são **públicas por natureza** (tenant/client ids);
  **nenhum** secret com prefixo `VITE_`.

### Ações antes do go-live (⚠️ externo)
- **produção deve usar cofre** (Key Vault) — segredos nunca em arquivo;
- **`ENTRA_API_CLIENT_SECRET` deve ser rotacionado** antes do go-live (o valor de
  desenvolvimento existiu em arquivo local durante o projeto);
- **credenciais PostgreSQL distintas** por papel (`pcgp_app`, `pcgp_admin`,
  `pcgp_bootstrap`), próprias de produção, no cofre;
- garantir que **nenhum `.env` real** chegue a imagem de contêiner / artefato.

> **Nunca** colocar o valor de um secret nesta documentação nem em qualquer
> arquivo versionado.

---

## 14. Reverse proxy / WAF (arquitetura esperada, independente de fornecedor)

A tecnologia de hospedagem não está fixada — recomendação por **controle**, não
por produto. Detalhe e comandos de teste em
[`docs/producao-hardening.md`](producao-hardening.md).

| Controle | Onde |
| --- | --- |
| HTTPS obrigatório | proxy/host |
| redirect HTTP → HTTPS | proxy/host |
| HSTS (`max-age` longo, `includeSubDomains`) | proxy/host |
| WAF (OWASP CRS) | WAF |
| rate limit por IP + burst | proxy/WAF |
| limite de body | proxy (a API já impõe limite JSON) |
| timeout de requisição | proxy |
| bloquear `TRACE` / `CONNECT` | proxy |
| headers de segurança do frontend + CSP (§11) | host estático/proxy |
| correlation id (`X-Request-Id` gerado na borda, propagado) | proxy |
| **API não exposta diretamente à internet** | rede/firewall |
| `trust proxy` (quando o nº de hops do proxy for conhecido) | aplicação — hoje **não** setado, decisão consciente; o rate limit por principal não depende de IP |

---

## 15. Checklist de go-live

A checklist operacional completa (13 passos, com responsável / o que configurar /
como testar / resultado esperado / evidência / status) está **integralmente no
repositório** em **[`docs/go-live.md`](go-live.md)** — é a fonte para o dia da
liberação. Não depende de nenhum link externo.

Resumo das fases:
- **Fase 1 — Preparação:** (1) secrets no cofre + rotação do client secret;
  (2) PostgreSQL de produção com papéis e TLS; (3) Exchange RBAC / Resource Scope;
  (4) Entra ID / App Registrations / App Roles / MSAL.
- **Fase 2 — Borda:** (5) HTTPS/HSTS/WAF/rate limit por IP; (6) CSP validada com
  MSAL; (7) API não exposta diretamente; (8) Log Analytics.
- **Fase 3 — Verificação funcional:** (9) login real Entra/MSAL; (10) perfis
  Usuário/Assessoria/Admin; (11) testes reais de RBAC e IDOR; (12) Graph / Outlook
  / Teams / calendário.

---

## 16. Estado atual e o que falta

Repetido no topo (§0) por conveniência:

```text
Auditoria de código              ✅ concluída
Hardening PostgreSQL             ✅ concluído
Hardening de produção no código  ✅ concluído
npm audit                        ⚠️ 3 (2 moderadas, 1 alta) em dependências transitivas já presentes antes do S3: qs (via express), browserslist e baseline-browser-mapping (via vite/build). Correção (`npm audit fix`) pendente de rodada própria
Build / typecheck / testes       ✅ verdes
Pré-go-live local                ✅ concluído
Mail.Send Delegated / OBO        ✅ validado no tenant real
Validação de pautas — pós-envio  ⚠️ revalidar após a correção do 202
Teams Chat — código/testes        ✅ implementado e validado localmente
Teams Chat — permissões Entra    ✅ Chat.Create + ChatMessage.Send Delegated concedidas
Teams Chat — entrega real        ✅ mensagem manual e Chamar validados no tenant real
Pré-go-live corporativo          ⚠️ pendente
```

**O código está pronto** do ponto de vista das validações realizadas. O
**go-live final não deve ser declarado concluído** enquanto os itens externos de
`docs/go-live.md` (login MSAL real, os três perfis com escalada negada, IDOR
retornando 404/403, Exchange RBAC limitando mailbox, borda HTTPS/HSTS/WAF/rate
limit, rotação do secret no cofre, Log Analytics) não forem validados no ambiente
corporativo real.

---

## Contexto para agentes futuros

> **Leia antes de mexer em qualquer coisa de segurança.** As decisões abaixo
> foram investigadas e validadas. Não as desfaça sem evidência.

- **Não reabrir o hardening do PostgreSQL** sem evidência concreta de regressão.
  A topologia de 4 papéis (§3) e o append-only de `audit_logs` (§4) foram
  validados no cluster real e num cluster limpo. `pcgp_initdb` continuar
  `SUPERUSER` é **limitação do PostgreSQL**, não um esquecimento — ele é
  `NOLOGIN` e sem senha.
- **Não remover os guards de produção** (`production-guard.ts` no backend, o
  fail-fast de mock login em `main.tsx`). Eles existem para a API **não subir**
  insegura.
- **Não relaxar o RBAC para resolver problema de UX.** Esconder/mostrar botão é
  UX; a barreira é a revalidação no servidor. Se a UI precisa de algo, ajuste a
  UI — não a autorização.
- **Não transformar autorização de frontend em fonte de verdade.** O `appRoles`
  que o frontend recebe é para decidir o que **mostrar**; toda rota revalida.
- **Não ampliar permissões do Microsoft Graph** sem necessidade comprovada, e
  **nunca** conceder `Calendars.ReadWrite` (Application) tenant-wide no Entra
  (§9) — a autorização de calendário é do **Exchange RBAC** com Resource Scope.
  O SPA continua com **zero** permissão de Graph.
- **Não colocar secrets no repositório** (§13). Produção usa cofre; `.env*` são
  ignorados; nenhum valor de secret em código, doc ou teste.
- **Não declarar go-live concluído** enquanto a checklist externa
  (`docs/go-live.md`) estiver pendente.
- **Validar toda mudança futura contra os controles existentes**: rodar
  `npm test`, `npm run lint:api`/`lint:web`, `npm run build`, `npm audit`; e, se
  a mudança tocar auth/rota/entrada, conferir os testes negativos
  (`create.test.ts`, `rate-limit.test.ts`, `production-guard.test.ts`) e o log de
  segurança.

---

## Como validar a documentação e o código (comandos)

```bash
npm run lint:api               # typecheck backend (tsc --noEmit)
npm run lint:web               # typecheck frontend (tsc --noEmit)
npm run test --workspace @pgcp/api   # testes de segurança (node --test)
npm run build                  # build web + api
npm audit                      # deve reportar 0 vulnerabilidades
```
Evidência de banco (como `pcgp_bootstrap`, uso de DBA):
```sql
SELECT rolname, rolsuper, rolcanlogin, rolbypassrls
  FROM pg_roles WHERE rolname LIKE 'pcgp_%';
SELECT has_table_privilege('pcgp_app','audit_logs','INSERT');   -- true
SELECT has_table_privilege('pcgp_app','audit_logs','UPDATE');   -- false
SELECT has_table_privilege('pcgp_app','audit_logs','DELETE');   -- false
SELECT has_table_privilege('pcgp_app','audit_logs','TRUNCATE'); -- false
```
