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
npm audit                        ✅ 0 vulnerabilidades
Build / typecheck / testes       ✅ verdes (107 testes)
Pré-go-live local                ✅ concluído
Validação de pautas por e-mail   ⚠️ Mail.Send Delegated não concedida; envio nunca validado
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

### Ciclo de vida da reunião — três eixos independentes

Criar reunião **não envia nada à Microsoft**. O convite é um ato próprio,
liberado só depois que as pautas voltam aprovadas:

```
Preparação → validação das pautas (PDF por e-mail) → aprovação → convite Outlook/Teams
```

| Etapa | Onde vive o estado | Quem pode |
| --- | --- | --- |
| Preparação | `meetings.agenda_validation_status = 'draft'` | `PGCP.Assessoria` |
| Enviar pautas para validação | `… = 'sent'` + `agenda_validation_sent_to` | `PGCP.Assessoria` |
| Marcar pautas como aprovadas | `… = 'approved'` + `agenda_approved_by_user_id` | `PGCP.Assessoria` |
| Enviar convite Outlook/Teams | `meeting_calendar_integrations.sync_status` | `PGCP.Assessoria` |

**Três eixos que não se confundem** e por isso não compartilham coluna:

- `meetings.status` — ciclo da **reunião** (`scheduled`, `in_progress`, `done`);
- `meetings.agenda_validation_status` — ciclo da **pauta**;
- `meeting_calendar_integrations.sync_status` — estado do **convite**, com
  `provider_event_id` como prova de que o evento existe.

Aprovar a pauta **não** altera `meetings.status`. "Convite enviado" não ganhou
coluna própria: já é `sync_status = 'synced'`, e uma segunda fonte poderia
discordar dela.

**A barreira do convite está no backend.** `POST /meetings/:id/calendar-sync`
confere `agenda_validation_status` **antes de qualquer chamada ao Graph** e
responde **409** `agenda_not_approved` quando a pauta não está aprovada.
Desabilitar o botão na tela é cortesia — convidar é irreversível para terceiros.

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
| Enviar pautas para validação | **Delegated (OBO)** | `Mail.Send` | `POST /me/sendMail` | App Registration da API (Entra) — ⚠️ **ainda não concedida** |
| SPA (navegador) | — | **nenhuma** | — | zero permissão de Graph |

Pontos-chave:
- **O SPA não deve carregar permissão de Graph** — todo Graph nasce na API. O
  navegador só obtém token para a **API do PGCP**.
- Calendário **app-only** (não OBO) para reunião/Teams: sincronizar não pode
  depender da sessão do organizador estar aberta.
- **Exchange RBAC com Resource Scope** limita **quais mailboxes** a aplicação
  alcança. **Não** conceder `Calendars.ReadWrite` (Application) **tenant-wide no
  Entra** — passaria por cima do escopo do Exchange.
- Teams-messages: **adiado**, sem permissão concedida — nada a reduzir.

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

#### ⚠️ Pendência de ambiente corporativo — não tratar como pronto

| Item | Estado |
| --- | --- |
| Permissão `Mail.Send` (Delegated) no App Registration da API | ⚠️ **não concedida** |
| Consentimento do administrador do tenant | ⚠️ **pendente** |
| Envio real de e-mail | ⚠️ **nunca executado / não validado** |

Enquanto os três itens acima não forem concluídos e verificados no tenant real,
**este fluxo não deve ser considerado pronto para produção.**

Comportamento hoje, sem a permissão: a troca OBO falha com `AADSTS65001`, a API
traduz para `consent_required` (403) com mensagem acionável, e — o que importa
para integridade — **a validação NÃO é marcada como enviada**. O envio acontece
antes de qualquer escrita no banco; se o Graph falha, o estado permanece
inalterado e resta apenas a entrada de auditoria da tentativa, com
`status: "failure"`.

### Como validar (⚠️ pendente externo)
- `POST /integrations/graph/test` (Admin) → `connected`;
- busca real em `GET /directory/users`;
- agendar reunião → **evento no Outlook** do organizador + reunião **Teams** com
  `joinUrl`;
- `GET /calendar/me` retorna agenda;
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
npm audit                        ✅ 0 vulnerabilidades
Build / typecheck / testes       ✅ verdes
Pré-go-live local                ✅ concluído
Validação de pautas por e-mail   ⚠️ Mail.Send Delegated não concedida
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
