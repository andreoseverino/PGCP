# PGCP — Handoff Corporativo

**Se você está assumindo o desenvolvimento do PGCP, comece por aqui.**

Este documento congela o estado real do sistema. Foi escrito conferindo código,
migrations, rotas, guardas, `package.json` e o schema do banco — não a
documentação anterior. Onde a documentação antiga divergia, o **código e as
migrations venceram** e a documentação foi corrigida.

> **Nenhum valor deste ambiente aparece aqui.** Sem GUIDs, e-mails, tenant,
> client ids, secrets, tokens ou links de reunião. Onde for preciso, use
> `<PLACEHOLDER>`.

---

## 1. Visão executiva

**PGCP — Plataforma Corporativa de Gestão de Pautas.**

> **A sigla oficial é `PGCP`.** Grafias `PCGP` são incorretas e foram corrigidas
> em todo o repositório. Três exceções permanecem, de propósito, porque nomeiam
> recursos que já existem e não seriam renomeados por edição de texto:
>
> | Onde | O quê | Por quê |
> |---|---|---|
> | `infra/docker-compose.yml` | projeto, container e volume `pcgp-governanca*` | renomear criaria um segundo container e um volume vazio; o banco atual ficaria órfão |
> | `.env` / `.env.example` / `apps/api/README.md` | `DB_NAME=pcgp`, `DB_USER=pcgp_app` | são o banco e a role existentes no servidor; mudar o texto quebraria a conexão sem renomear nada |
> | pasta do repositório | `PCGP - Plataforma de Governança Corporativa` | nome de diretório no disco, não referência no código |
>
> Migrar qualquer um dos três é operação de infraestrutura (recriar container,
> `ALTER DATABASE` / `ALTER ROLE`, renomear a pasta) — decisão própria, com o
> ambiente parado.

Gestão de reuniões de órgãos colegiados: da convocação à Ata, com a trilha de
quem fez o quê.

| | |
|---|---|
| **Problema** | reuniões de governança viviam em e-mail, planilha e documento solto; pauta, deliberação e follow-up não tinham lugar único, e o convite do calendário não conversava com o registro formal |
| **Quem usa** | Assessoria/Secretaria de Governança (opera), membros de colegiado (consultam e respondem por FUPs), administração da plataforma |
| **Estágio** | integrações Microsoft homologadas ponta a ponta; autorização por App Role fechada; auditoria funcional. Sem e-mail próprio, sem DocuSign, sem observabilidade |

Escopo funcional: reuniões · pautas · participantes · condução da sessão ·
**FUP** (follow-up) · Anotações · Ata · integrações Microsoft (Entra, Graph,
Outlook, Teams) · trilha de auditoria.

---

## 2. Estrutura do repositório

```text
apps/
  web/                  frontend React + TypeScript + Vite
    src/components/     telas (Dashboard, MeetingDetailView, Administration, …)
    src/lib/            clientes de API e adaptadores (um por domínio)
    src/auth/           MSAL, /me e helpers de App Role
  api/                  backend Node + Express + TypeScript
    src/<domínio>/      routes.ts + service.ts por domínio
    src/authz/          App Roles e middlewares de autorização
    src/entra/          validação do token
    src/graph/          cliente do Microsoft Graph
    migrations/         SQL versionado, 001…014
packages/contracts/     reservado; ainda sem package.json
docs/                   esta documentação
infra/                  docker-compose do PostgreSQL local
scripts/                utilitários (ex.: preflight do Entra)
```

Onde mexer:

| Preciso mudar… | Vá em |
|---|---|
| tela, formulário, gating visual | `apps/web/src/components/` |
| chamada de API no frontend | `apps/web/src/lib/<domínio>.ts` |
| regra de negócio, rota, guarda | `apps/api/src/<domínio>/` |
| estrutura do banco | `apps/api/migrations/` (**nova** migration, nunca editar aplicada) |
| autorização | `apps/api/src/authz/app-roles.ts` |
| política de visibilidade de reunião | `apps/api/src/meetings/visibility.ts` |

---

## 3. Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React 19 · TypeScript 5.8 · **Vite 6** · Tailwind 4 · MSAL Browser 5 · Tiptap 3 · lucide-react · recharts |
| Backend | Node.js · Express 5 · TypeScript 5.8 · `jose` (JWT) · `@azure/msal-node` (OBO e client credentials) |
| Banco | PostgreSQL 17, driver **`pg`** |
| Monorepo | **npm workspaces** — `@pgcp/web` e `@pgcp/api` |

> **Não há ORM, e isso é decisão.** Todo SQL é escrito à mão nos `service.ts`.
> Continua verdadeiro no código atual.

> **`apps/web` é um SPA servido pelo Vite — não é Next.js.** A confirmação está
> no próprio repositório: `apps/web/vite.config.ts`, `apps/web/index.html` como
> entrada e os scripts `vite` / `vite build` / `vite preview`. Não há
> `next.config.*`, não há `app/` nem `pages/`, e `next` não aparece em nenhum
> `package.json`. Portanto **não há SSR, rotas de servidor nem Server
> Components**: o roteamento é estado dentro do React, e o build gera estáticos.
> Em desenvolvimento, o recarregamento é o HMR do Vite.

### Execução local

```bash
npm install                # raiz; instala os dois workspaces
npm run db:up              # PostgreSQL em container (infra/docker-compose.yml)
npm run db:migrate         # aplica as migrations pendentes
npm run dev:api            # API  → http://localhost:3333
npm run dev                # Web  → http://localhost:3000
npm run lint               # tsc --noEmit nos dois workspaces
npm run build              # build dos dois
curl http://localhost:3333/health
# {"status":"ok","database":"connected"}  |  503 quando o banco está fora
```

O runner de migrations (`apps/api/src/migrate.ts`) envolve **cada arquivo em sua
própria transação** — arquivos de migration **não** podem conter `BEGIN`/`COMMIT`.

---

## 4. Arquitetura

```text
   Browser / React (SPA)
          │  token access_as_user (MSAL, PKCE)
          ▼
   PGCP API / Express            ← valida assinatura, iss, aud, exp/nbf, tid, oid, azp, scp
          │
          ├──────────────▶ PostgreSQL          fonte de verdade do PGCP
          │
          ├──────────────▶ Microsoft Entra ID  identidade e App Roles
          ├──────────────▶ Microsoft Graph     diretório (app-only) e calendário próprio (OBO)
          ├──────────────▶ Exchange Online     evento na mailbox do organizador (app-only + Resource Scope)
          └──────────────▶ Microsoft Teams     reunião online DENTRO do mesmo evento
```

Fronteiras:

- **PGCP é a fonte de verdade** da reunião corporativa. O Outlook é uma
  **projeção**; nada volta do calendário para o PGCP.
- **O navegador nunca fala com o Graph.** Só a API tem credencial de aplicação.
- **O Graph nunca é chamado dentro de uma transação do PostgreSQL.**

---

## 5. Autenticação

**Dois App Registrations**, e confundi-los é a maior fonte de erro:

| | PGCP Web | PGCP API |
|---|---|---|
| Tipo | SPA / public client | API / confidential client |
| Client secret | **não tem** | `<API-CLIENT-SECRET>`, só no servidor |
| Papel | login interativo; obtém token **para a API** | valida o token, executa o backend, fala com o Graph |

Fluxo: login MSAL → token com escopo `access_as_user` → API valida (assinatura
via JWKS, `iss`, `aud`, `exp`/`nbf`, `tid`, `oid`, `azp`, `scp`) → resolve o
usuário em `users`.

**Identidade é `tid` + `oid`** — nunca e-mail, `upn` ou `preferred_username`,
que são atributos de exibição e podem ser reciclados.

**JIT:** o primeiro acesso de uma pessoa atribuída no Entra cria a linha em
`users`. Sem e-mail utilizável, o provisionamento é **recusado** e registrado na
trilha.

No manifesto da API, `requestedAccessTokenVersion` precisa valer **2**.

Detalhes: [`runbook-entra-app-registration.md`](runbook-entra-app-registration.md).

---

## 6. Perfis (App Roles)

> ### ⚠ Os valores das App Roles mudaram junto com a sigla
>
> `PCGP.Assessoria` → **`PGCP.Assessoria`** · `PCGP.Admin` → **`PGCP.Admin`**
>
> O valor no código precisa ser **idêntico** ao declarado no App Registration.
> Enquanto o manifesto do Entra não for atualizado, o token continuará trazendo
> as grafias antigas e **ninguém terá role** — nem para operar reuniões, nem
> para administrar. Passos: atualizar o `value` das duas App Roles no manifesto
> da **PGCP API**, conferir as atribuições no Enterprise Application e **sair e
> entrar de novo** para receber um token com o claim atualizado.

Duas roles vivas, **independentes** — nenhuma implica a outra:

| Role | Nome humano | Responsabilidade |
|---|---|---|
| `PGCP.Assessoria` | Assessoria do PGCP | **funcional**: criar/editar/conduzir reuniões, participantes, pautas, Anotações, Ata, FUP de terceiros, Outlook/Teams, e os cadastros funcionais (órgãos, tipos e naturezas de pauta) |
| `PGCP.Admin` | Administrador do PGCP | **técnica**: usuários do PGCP, integrações, auditoria, configurações administrativas — e também os cadastros funcionais |

**Sem App Role** a pessoa continua entrando: lê o conteúdo corporativo e cuida
dos próprios FUPs. É esse perfil que servirá de base para uma futura
**experiência pública** — ainda **não implementada**.

Uma mesma pessoa pode ter as duas roles; recebe a soma das capacidades porque o
token traz as duas. Roles **não** são persistidas em `users`: a fonte é o claim
`roles` do token assinado.

*Histórico: até a 5.4l a role funcional chamava-se `Meeting.Scheduler`;
substituída por `PGCP.Assessoria` e descontinuada.*

---

## 7. Matriz de autorização

Conferida rota a rota no backend — não no que a tela mostra.

| Funcionalidade | Usuário padrão | PGCP.Assessoria | PGCP.Admin |
|---|---|---|---|
| Visualizar reuniões, pautas | ✅ | ✅ | ✅ |
| Criar reunião | ❌ | ✅ | ❌ |
| Editar reunião (cabeçalho, status) | ❌ | ✅ | ❌ |
| Participantes (incluir/remover) | ❌ | ✅ | ❌ |
| Pautas (incluir/editar/remover/reordenar) | ❌ | ✅ | ❌ |
| Conduzir (iniciar, concluir, postergar, retomar) | ❌ | ✅ | ❌ |
| Ler Anotações | ✅ | ✅ | ✅ |
| Escrever Anotações | ❌ | ✅ | ❌ |
| Ler Ata | ✅ | ✅ | ✅ |
| Escrever Ata / sanear pela Secretaria | ❌ | ✅ | ❌ |
| Sincronizar Outlook/Teams | ❌ | ✅ | ❌ |
| FUP próprio (concluir, reabrir) | ✅ | ✅ | ✅ |
| FUP de terceiros | ❌ | ✅ | ❌ |
| Ler órgãos de governança | ✅ | ✅ | ✅ |
| Criar/editar/desativar órgão | ❌ | ✅ | ✅ |
| Ler tipos/naturezas de pauta | ✅ | ✅ | ✅ |
| Mutar tipos/naturezas de pauta | ❌ | ✅ | ✅ |
| Diretório do Graph (pickers) | ✅ | ✅ | ✅ |
| Listar usuários do PGCP (`GET /users`, sem tela) | ❌ | ❌ | ✅ |
| Integrações (ver, status, testar) | ❌ | ❌ | ✅ |
| Auditoria | ❌ | ❌ | ✅ |
| Configurações administrativas | ❌ | ❌ | ✅ |

A **única** sobreposição entre as roles são os cadastros funcionais, via
`requireAssessoriaOuAdmin` — um OR local, declarado num lugar só, não uma
hierarquia.

---

## 8. Política de leitura

> **Reuniões corporativas são visíveis a qualquer usuário PGCP ativo.**

Decisão de produto (Política A), não lacuna. Duas razões, medidas no modelo real:

1. **Participação não é ACL.** `meeting_participants` lista quem foi
   *convidado*; boa parte dos participantes é snapshot textual, sem identidade.
   Usar a tabela como ACL negaria acesso a quem participa de verdade.
2. Quem cadastra a reunião, a Secretaria e quem prepara pauta consultam reuniões
   das quais não participam.

> **O PGCP NÃO oferece reunião restrita ou confidencial.** Não há coluna de
> classificação em nenhuma tabela e a interface não trata nada como reservado.
> Sessões reservadas, quando forem requisito, serão feature própria — com
> coluna, regra explícita e definição de quem classifica.

A política vive em `apps/api/src/meetings/visibility.ts` e é **herdada** pelo
FUP. Apertar a leitura = editar aquela função.

---

## 9. Banco de dados

17 tabelas de negócio, por domínio:

| Domínio | Tabelas | Responsabilidade |
|---|---|---|
| Identidade | `users` | quem tem conta no PGCP; identidade Microsoft (`entra_tenant_id` + `entra_object_id`) |
| Governança | `governance_bodies` | órgãos colegiados |
| Reunião | `meetings`, `meeting_participants` | o compromisso e seus convidados |
| Pauta | `agenda_topics`, `meeting_agenda_items`, `agenda_topic_types`, `agenda_topic_natures`, `agenda_topic_participants`, `meeting_agenda_item_presenters` | biblioteca de pautas, instância na reunião e taxonomias |
| Follow-up | `action_items` | FUP: obrigação com responsável e prazo |
| Documentos | `meeting_notes`, `meeting_minutes` | Anotações (rascunho vivo) e Ata (ciclo formal) |
| Assinatura | `meeting_minute_signature_processes`, `meeting_minute_signers` | processo de assinatura, provider-agnostic |
| Calendário | `meeting_calendar_integrations` | vínculo com o evento do Outlook |
| Trilha | `audit_logs` | append-only |

Detalhe coluna a coluna: [`modelo-de-dados.md`](modelo-de-dados.md).

---

## 10. Migrations

| Migration | O que introduziu | Decisão importante |
|---|---|---|
| **001** `initial_schema` | schema inicial completo | sem ORM; toda integridade no banco |
| **002** `add_entra_identity_to_users` | `entra_tenant_id` + `entra_object_id` | identidade é o par, **nunca** e-mail |
| **003** `add_directory_identity_to_meeting_entities` | identidade Entra em participantes/responsáveis | pessoa do diretório aparece na reunião **sem** ter conta no PGCP |
| **004** `agenda_topics_library` | biblioteca de pautas, tipos e naturezas relacionais | procedência estrutural da pauta postergada (par composto) |
| **005** `action_items_composite_origin` | FK composta da origem do FUP | a pauta de origem tem de pertencer à reunião de origem |
| **006** `action_items_origin_deferred_check` | CHECK deferido | proíbe pauta sem reunião |
| **007** `meeting_notes` | Anotações | documento **operacional**, distinto da Ata |
| **008** `meeting_minutes_workflow` | `revision`, saneamento pela Secretaria | concorrência otimista por revisão |
| **009** `meeting_minute_signature_processes` | processo + signatários | **provider-agnostic**: nada de DocuSign no schema |
| **010** `signature_process_immutability` | 4 funções, 5 triggers | evidência imutável, hash SHA-256 coerente, roster congelado, transições válidas |
| **011** `meeting_calendar_integrations` | vínculo com o evento | `idempotency_key` nasce com a reunião |
| **012** `meeting_created_by_and_organizer_identity` | `created_by_user_id` + `organizer_entra_*` | separa **ator** de **organizador** |
| **013** `calendar_owner_follows_organizer` | remove `owner_user_id` | organizador não precisa ter conta no PGCP |
| **014** `meeting_online_provider` | `online_meeting_provider` + trigger | toda reunião nova nasce com `teamsForBusiness`, definido pelo backend; o provider não pode ser removido nem trocado |

Nova mudança de schema = **nova migration**. Nunca editar uma já aplicada.

---

## 11. Regras de negócio — reuniões

> **Toda reunião do PGCP é, por definição, um evento do Outlook com reunião do
> Microsoft Teams.**

```text
reunião PGCP  →  1 evento no Outlook
                 └─ o MESMO evento com isOnlineMeeting = true
                    e onlineMeetingProvider = "teamsForBusiness"
                    └─ joinUrl persistido na integração
```

Não é opção do usuário: **não há checkbox**. `online_meeting_provider` é gravado
pelo servidor na criação e não vem do corpo da requisição — cliente antigo,
script ou `curl` criam reunião com Teams do mesmo jeito.

Reuniões **legadas** (anteriores à regra) ficam sem provider e são exibidas como
legadas. Não há backfill.

---

## 12. Ator, organizador e participante

Três conceitos, três colunas — nunca o mesmo:

```text
created_by_user_id     quem EXECUTOU a ação no PGCP (do token, sempre)
organizer_*            de quem é a mailbox onde o evento nasce
meeting_participants   quem foi convidado
```

A assessora cadastra (**ator**) uma reunião cujo **organizador** é o Presidente;
o evento nasce na caixa dele. O organizador **não precisa ter conta no PGCP** —
basta a identidade Microsoft (`tid` + `oid`).

---

## 13. Outlook — duas capacidades distintas

| | Calendário próprio | Calendário do organizador |
|---|---|---|
| Fluxo | **On-Behalf-Of** | **app-only** (client credentials) |
| Permissão | `Calendars.Read` **delegada** | `Application Calendars.ReadWrite` **pelo Exchange RBAC** |
| Endpoint | `GET /me/calendarView` | `POST/PATCH /users/{oid}/events` |
| Uso | calendário da Visão Geral | criar e atualizar o evento da reunião |
| Limite | a própria pessoa | **Resource Scope** define quais mailboxes podem ser **organizadoras** |

> **NÃO conceder `Calendars.ReadWrite` Application tenant-wide no App
> Registration.** Daria escrita em todas as caixas do tenant. A escrita vem do
> **Exchange Online RBAC for Applications** com Resource Scope.

O Resource Scope limita **quem organiza**, não **quem é convidado**.
Procedimento: [`runbook-exchange-calendar.md`](runbook-exchange-calendar.md).

Eventos pessoais do Outlook **não são persistidos** no PostgreSQL.

---

## 14. Sincronização com o Outlook

`meeting_calendar_integrations`:

| Coluna | Papel |
|---|---|
| `provider_event_id` | id do evento, em forma **imutável** |
| `idempotency_key` | nasce com a reunião; vira `transactionId` na criação |
| `sync_status` | `pending` · `synced` · `stale` · `failed` |
| `last_synced_at`, `last_error` | mensagem legível, **nunca** payload |
| `web_link`, `join_url` | devolvidos pelo Graph |

Estados:

| Estado | Significado |
|---|---|
| `pending` | evento ainda não provisionado |
| `synced` | PGCP e evento alinhados |
| `stale` | o evento existe e não reflete o estado atual |
| `failed` | a tentativa falhou e **ainda não existe** `provider_event_id` |

Na tela, uma distinção a mais: **`stale` sem erro** = "Atualização pendente";
**`stale` com `last_error`** = "Falha na sincronização". Os dois são `stale` no
banco — o evento existe e está desatualizado —, mas esconder a falha atrás de
"pendente" seria mentir por omissão.

### Idempotência

```text
criação      POST /users/{oid}/events   com transactionId = idempotency_key
atualização  PATCH pelo provider_event_id
sempre       Prefer: IdType="ImmutableId"
```

**Nunca** localizar evento por título, data ou participante. Timeout **não** gera
chave nova — é justamente o caso em que o evento pode ter sido criado sem a
resposta voltar.

### Quando o PGCP fala com a Microsoft

Depois do **COMMIT**, nunca dentro dele:

| Ação | Comportamento |
|---|---|
| **Criar reunião** | **nenhuma** chamada externa — a reunião nasce em preparação |
| **Enviar convite da reunião** (ato explícito) | cria o evento; exige pauta **aprovada** |
| Editar campo projetado, **depois** do convite | integração vira `stale` → uma tentativa |
| Incluir/remover participante, **depois** do convite | idem |
| Mutação interna (FUP, Ata, status, pauta) | **nenhuma** chamada externa |

> **Mudou na 5.5.** Até então, `POST /meetings` chamava `syncMeetingCalendar`
> logo após o commit: o convite chegava na caixa dos participantes antes de
> existir uma única pauta, e corrigir a pauta significava reenviar convite a
> executivos. Hoje o convite é um ato próprio — ver *Validação de pautas* abaixo.

A linha de `meeting_calendar_integrations` continua nascendo na mesma transação
da reunião, em `pending`, com a `idempotency_key` que o envio vai reusar. Antes
do primeiro envio, editar a reunião não dispara nada: `stale` só é marcado a
partir de `synced`.

**Falha da Microsoft não desfaz nada no PGCP.** O dado permanece, a integração
registra `failed`/`stale` com motivo sanitizado, e a tela oferece **Reenviar
convite da reunião** — que reusa a mesma chave e nunca cria segundo evento.

### Validação de pautas (5.5)

```
Preparação → validação das pautas (PDF por e-mail) → aprovação → convite Outlook/Teams
```

| Etapa | Estado | Rota |
|---|---|---|
| Preparação | `meetings.agenda_validation_status = 'draft'` | — |
| Enviar pautas para validação | `'sent'` + `agenda_validation_sent_to` | `POST /meetings/:id/agenda-validation` |
| Marcar pautas como aprovadas | `'approved'` + `agenda_approved_by_user_id` | `POST /meetings/:id/agenda-approval` |
| Enviar convite | `meeting_calendar_integrations.sync_status` | `POST /meetings/:id/calendar-sync` |

Todas exigem `PGCP.Assessoria`.

**Três eixos independentes, sem coluna compartilhada:** `meetings.status` é o
ciclo da **reunião**; `agenda_validation_status` é o ciclo da **pauta**;
`sync_status` é o estado do **convite**. Aprovar pauta **não** altera
`meetings.status`. "Convite enviado" não ganhou coluna — já é `synced`, com
`provider_event_id` como prova.

O envio do convite confere a aprovação **no backend**, antes de qualquer chamada
ao Graph: sem ela, **409** `agenda_not_approved`. Desabilitar o botão é cortesia.

A **aprovação acontece fora do sistema**: o aprovador responde por e-mail e a
Secretaria registra o fato. Não há leitura de resposta nem portal externo.

O e-mail leva um **PDF** gerado no servidor (`apps/api/src/agenda-pdf/`) e sai da
caixa **do próprio usuário autenticado**, via `Mail.Send` **Delegated** + OBO.
⚠️ A permissão ainda não foi concedida no tenant — ver `docs/security.md` §9.

`failed` **não** é reenviado automaticamente a cada edição; fica no botão.

---

## 15. Teams

Não existe integração paralela de `onlineMeeting`. É o **mesmo evento**:

```json
{ "isOnlineMeeting": true, "onlineMeetingProvider": "teamsForBusiness" }
```

O link de entrada vem **exclusivamente** de `onlineMeeting.joinUrl` — nunca de
`onlineMeetingUrl`, legado. **`OnlineMeetings.ReadWrite` não é usada**, porque
`/communications/onlineMeetings` criaria um recurso independente do calendário.

Toda reunião nova do PGCP nasce com `online_meeting_provider =
"teamsForBusiness"`. O provider é **definido pelo backend na criação** — não vem
do corpo da requisição, não há checkbox — e **não pode ser removido nem
trocado**: o contrato recusa `null` e qualquer outro valor, e o trigger da 014 é
a última barreira. No Microsoft Graph, o **mesmo evento do Outlook** é
provisionado como reunião do Teams.

Reuniões **legadas**, anteriores à regra, seguem sem provider — não há
backfill.

---

## 16. FUP (follow-up)

| Estado | Significado |
|---|---|
| `open` | exige ação |
| `completed` | concluído (grava `completed_at`) |
| `cancelled` | não vai acontecer; preserva o histórico |

`due_date` é a **única** data persistida. "Vencido" e "vence em N dias" são
**derivados** na leitura (`current_date - due_date`). **Não existe coluna de dias
de atraso** — persistir isso apodreceria à meia-noite.

**Minhas Pendências** (Visão Geral) lista os FUPs abertos do usuário, agrupados
em *vencidos* · *vencem em até 3 dias* · *demais*, com a lista já filtrada pelo
servidor.

Identidade do responsável: `assigned_user_id` **ou** o par
(`assignee_entra_tenant_id`, `assignee_entra_object_id`). **Nunca nome ou
e-mail** — homônimo não concede acesso.

Visibilidade: `é meu` **ou** `nasceu de reunião que posso ver`. FUP sem reunião
de origem só é visível ao responsável. A mesma regra vale na lista **e** na
consulta por UUID — invisível responde **404**, igual a inexistente.

Mutação: **responsável** ou **`PGCP.Assessoria`**.

---

## 17. Pautas

```text
agenda_topics          biblioteca — cadastro reutilizável
meeting_agenda_items   instância dentro de UMA reunião
```

`agenda_topic_types` e `agenda_topic_natures` são cadastros relacionais (não
enums), mantidos na Administração.

`execution_status`: `pending` · `presenting` · `completed` · `postponed`.
Postergar/retomar são rotas próprias, com procedência **estrutural** — o backend
localiza a cópia pelo par (reunião, item), não por título.

> **Responsável ≠ apresentador.** `responsible_label` pode ser pessoa, área,
> cargo ou coletivo ("Todos"); apresentador é outro conceito
> (`meeting_agenda_item_presenters`).

---

## 18. Anotações

`meeting_notes` — documento **operacional** da sessão, HTML produzido pelo
Tiptap, com concorrência por `revision`.

Leitura corporativa; escrita exige `PGCP.Assessoria` (sem a role, o editor abre
em modo leitura e o autosave não dispara).

> **Não existe transcrição** no PGCP, e não deve ser reintroduzida.

---

## 19. Ata

`meeting_minutes` com ciclo formal:

| Status | Significado |
|---|---|
| `draft` | em elaboração |
| `under_review` | saneada pela Secretaria (`clear-by-secretariat`) |
| `approved`, `closed` | previstos no CHECK; **nenhum fluxo atual os produz** |

Concorrência otimista por `revision`: salvar com revisão desatualizada devolve
conflito e **o texto local não é descartado**. `secretariat_cleared_revision`
registra qual revisão recebeu o visto — se o conteúdo mudar depois, a tela avisa
que o visto se refere a uma revisão anterior.

Não há aprovação automática.

---

## 20. Assinatura / DocuSign

Domínio modelado e protegido por triggers, **sem provedor integrado**:

- signatários escolhidos **explicitamente** no PGCP;
- o processo guarda `content_snapshot` + `content_hash` (SHA-256) — evidência
  imutável;
- transições de estado e roster congelados por trigger (010);
- `completed` exige que todos os signatários obrigatórios tenham assinado.

Desenho pretendido: **PGCP envia documento + signatários ao DocuSign → o DocuSign
convida → a assinatura ocorre fora do PGCP → o PGCP acompanha status e
evidência.**

> **Estado atual: DocuSign NÃO está integrado** e não há credenciais. O módulo
> de assinatura **não tem rota exposta**. Não simular assinatura.

---

## 21. E-mail

> **`Mail.Send` (Delegated) tem código pronto, mas a permissão NÃO foi concedida.**

O Outlook/Exchange já envia convite, atualização e notificação de inclusão ou
remoção de participante. E-mail próprio do PGCP duplicaria essas mensagens.

E-mail próprio só será considerado para **obrigações de governança** (cobrança de
FUP). Não existem mais mocks de envio na interface — os dois que existiam foram
removidos.

---

## 22. Auditoria

`audit_logs` é **append-only**. A trilha é escrita pelas próprias operações de
domínio, **dentro da transação do ato** — não há rota de escrita, e não deve
haver.

```text
GET /audit-logs   →  PGCP.Admin, somente leitura
paginação         →  cursor (occurred_at, id), nunca OFFSET
filtros           →  limit, cursor, actorUserId, entityType, entityId, dateFrom, dateTo
```

Parâmetro fora dessa lista responde 400. Não há filtro por `status` nem por
`action`, porque o serviço de leitura não os suporta.

> **Auditoria ≠ observabilidade.** Auditoria registra **ação de negócio** (quem
> fez o quê, em qual reunião). Observabilidade é diagnóstico técnico — outro
> assunto, ainda não implementado.

Nunca entram na trilha: conteúdo de Ata ou Anotações, token, payload do Graph,
cabeçalhos, `joinUrl`.

---

## 23. Integrações administrativas

`/integrations` é o painel de **Configurações → PGCP Conectado**, restrito a
`PGCP.Admin`. Cobre: Entra · Graph · Outlook · Teams · E-mail · PostgreSQL ·
DocuSign · Observabilidade.

Segredos **nunca** saem: variável marcada como secreta vira apenas
`configured: true/false`. Valores públicos (host, porta, ids) só são devolvidos
a quem está autenticado.

> O cliente do frontend precisa chamar essas rotas com **`auth: true`** — foi
> exatamente esse esquecimento que produziu "Credencial ausente" no painel.

---

## 24. Estado das integrações

| Integração | Estado | Evidência |
|---|---|---|
| Entra SSO | **homologado** | login real; `/me` devolve as roles do token |
| App Roles (`PGCP.Assessoria`, `PGCP.Admin`) | **homologadas** | as duas atribuídas e validadas ponta a ponta |
| Graph — diretório | **homologado** | busca app-only com `$search`, usada nos pickers |
| Outlook — calendário próprio | **homologado** | OBO, `GET /me/calendarView` na Visão Geral |
| Outlook — escrita (evento) | **homologado** | evento real criado e atualizado na mailbox de homologação |
| Exchange RBAC + Resource Scope | **homologado** | testes `InScope = True` (autorizada) e `False` (controle) |
| Microsoft Teams | **homologado** | `isOnlineMeeting` no próprio evento; `joinUrl` real; ingresso validado |
| PostgreSQL | **funcional** | migrations 001–014 aplicadas; `/health` conectado |
| Auditoria | **homologada** | `GET /audit-logs` restrito a `PGCP.Admin`, lendo a trilha real |
| `Mail.Send` **Delegated** | ✅ **concedida e validada no tenant real** | envia as pautas para validação (PDF) pela caixa do usuário, via OBO. A versão **Aplicação** não é usada |
| DocuSign | **futuro** | domínio modelado; sem credenciais e sem rota |
| Observabilidade (Azure) | **pendente** | variável no catálogo; nenhum exportador implementado |

---

## 25. Variáveis de ambiente

Somente nomes. Valores vivem em `.env`, que **não** é versionado.

### `apps/api/.env`

| Variável | Obrigatória | Secreta | Finalidade |
|---|---|---|---|
| `PORT` | não | não | porta da API (padrão 3333) |
| `CORS_ORIGIN` | sim | não | origem do SPA |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | sim | não | conexão PostgreSQL |
| `DB_PASSWORD` | sim | **sim** | senha da aplicação |
| `DB_SSL` | não | não | TLS obrigatório em ambiente gerenciado |
| `ENTRA_TENANT_ID` | sim | não | tenant aceito (`iss`, `tid`) |
| `ENTRA_API_CLIENT_ID` | sim | não | `aud` esperado no token |
| `ENTRA_SPA_CLIENT_ID` | sim | não | cliente aceito (`azp`) |
| `ENTRA_API_APP_ID_URI`, `ENTRA_API_SCOPE_NAME` | sim | não | escopo `access_as_user` |
| `ENTRA_API_CLIENT_SECRET` | para Graph | **sim** | OBO e app-only |
| `GRAPH_BASE_URL` | não | não | endpoint do Graph (default v1.0) |
| `MAIL_SENDER_ADDRESS` | não | não | reservado; **não** participa da validação de pautas, que envia pela caixa do usuário (OBO) |
| `DOCUSIGN_*` | não | parcial | reservado; integração futura |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | não | **sim** | reservado; observabilidade futura |

### `apps/web/.env`

| Variável | Finalidade |
|---|---|
| `VITE_API_URL` | endereço da PGCP API |
| `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_SPA_CLIENT_ID` | configuração do MSAL |
| `VITE_ENTRA_REDIRECT_URI` | retorno do login |
| `VITE_ENTRA_API_SCOPE` | escopo pedido à API |
| `VITE_ALLOW_MOCK_LOGIN` | login de teste — **manter desligado** fora do desenvolvimento |

---

## 26. Segurança — princípios consolidados

- **Segredos só no backend**, em variável de ambiente; nunca no repositório, no
  frontend, em log ou em resposta HTTP.
- **Token não é persistido à mão** — quem guarda é o MSAL; o PGCP não escreve
  token em `localStorage` nem o decodifica no navegador.
- **Identidade = `tid` + `oid`.** E-mail é exibição.
- **App Roles vêm do token**, não do banco.
- **O backend é a autoridade.** Esconder um controle na tela é cortesia; toda
  rota revalida.
- **`audit_logs` é append-only.**
- **Exchange Resource Scope** limita as mailboxes que o PGCP pode usar como
  organizadoras.
- **Graph app-only limitado** a `User.Read.All`; nada de calendário irrestrito no
  Entra.
- Invisível responde **404**, não "403 existe mas não é seu" — não confirma a
  existência do recurso para quem não pode vê-lo.

### Proibido em log

```text
access token · refresh token · Authorization header · secrets ·
connection string · conteúdo da Ata · conteúdo das Anotações ·
payload completo do Graph · joinUrl do Teams · corpo completo da reunião
```

---

## 27. Observabilidade

**Planejada, não implementada.** Não existe exportador, tracing nem métrica.

Direção já considerada: Azure Monitor / Application Insights / Log Analytics — a
variável está no catálogo de integrações para tornar a lacuna visível, não porque
haja código a ligar.

---

## 28. Mapa de endpoints

| Grupo | Função | Guarda principal |
|---|---|---|
| `GET /health` | saúde da API e do banco | **público** |
| `GET /me` | identidade e App Roles do token | token válido |
| `/meetings` | leitura de reuniões | usuário ativo |
| `/meetings` (mutações, notas, Ata, sync) | operar e conduzir | `PGCP.Assessoria` |
| `/action-items` | FUP — listar, consultar, criar | usuário ativo (visibilidade aplicada no SQL) |
| `PATCH /action-items/:id` | alterar FUP | responsável **ou** `PGCP.Assessoria` |
| `/agenda-topics` | biblioteca de pautas | usuário ativo |
| `/agenda-topics/taxonomy/*` (escrita) | tipos e naturezas | `PGCP.Assessoria` **ou** `PGCP.Admin` |
| `/governance-bodies` (leitura) | órgãos | usuário ativo |
| `/governance-bodies` (escrita) | criar/editar/desativar | `PGCP.Assessoria` **ou** `PGCP.Admin` |
| `/directory/users` | busca no Graph para os pickers | usuário ativo |
| `/calendar/me` | calendário próprio (OBO) | usuário ativo |
| `/users` | usuários do PGCP | `PGCP.Admin` |
| `/integrations` | painel técnico | `PGCP.Admin` |
| `/audit-logs` | trilha corporativa | `PGCP.Admin` |

---

## 29. Frontend — telas

| Tela | Conteúdo | Quem vê |
|---|---|---|
| **Visão Geral** | calendário do Outlook, próximas reuniões, **Minhas Pendências** | todos |
| **Reuniões** | lista e filtros; "Nova Reunião" só com a role | todos (ação: Assessoria) |
| **Pautas** | biblioteca de pautas livres | todos |
| **FUP** | gestão detalhada; ações conforme a regra | todos |
| **Busca Rápida** | busca sobre o que já foi carregado | todos |
| **Administração** | órgãos de governança, tipos e naturezas de pauta | Assessoria **ou** Admin |
| **Auditoria** | trilha real, paginada por cursor | `PGCP.Admin` |
| **Configurações** | PGCP Conectado (integrações) e Diretório | `PGCP.Admin` |

> **A Visão Geral é a experiência única de calendário.** Não existe — e não deve
> voltar a existir — uma segunda tela "Meu Calendário".

O gating no frontend é **cortesia**: `App.tsx` recusa renderizar áreas
administrativas, e cada rota do servidor revalida.

### `MeetingDetailView.tsx`

Arquivo **grande** (~3 mil linhas), com as abas **Visão Geral · Pautas ·
Participantes · FUP · Anotações · Ata**. Alterações aqui devem ser
**cirúrgicas**: localizar o bloco, mudar o mínimo, não reorganizar de passagem.

---

## 30. Dados de homologação

O banco local contém registros usados na homologação das integrações (reuniões
reais com evento no Outlook e reunião do Teams). **Não** os altere para fazer um
teste passar.

Regras para testes automatizados:

- **não** usar dados reais existentes;
- criar dados temporários com prefixo identificável e **removê-los ao final**;
- **nunca** assumir contagem fixa — capturar baseline quando precisar contar.

---

## 31. Testes

Não existe suíte formal nem runner configurado — o `package.json` não declara
script de teste. **Dizer o contrário seria falso.** O que existe:

- **scripts de verificação incrementais**, escritos por etapa, executados com
  `node`;
- **banco real local** quando a regra é de banco, sempre com limpeza ao final;
- **Graph falso local** (servidor HTTP em porta efêmera) para exercitar
  sincronização sem tocar mailbox real;
- **smoke tests reais** apenas controlados e explicitamente autorizados;
- `npm run lint` (`tsc --noEmit`), `npm run build` e `/health` como rede de
  segurança de cada entrega.

Os scripts declaram a natureza de cada verificação — *unidade*, *runtime* (HTTP
real) ou *fiação* (leitura do código que o Express usa) — e o que **não**
conseguem provar. Formalizar isso num runner é dívida conhecida.

---

## 32. Infraestrutura local

```text
PostgreSQL 17 em container   (infra/docker-compose.yml)
API      http://localhost:3333
Web      http://localhost:3000
```

`npm run db:up` · `db:down` · `db:logs` · `db:migrate`. A porta do banco e as
credenciais locais vêm do `.env` — não estão neste documento.

**Local ≠ corporativo.** Em ambiente corporativo: PostgreSQL gerenciado com TLS
obrigatório, secrets em cofre, redirect URI e origens reais, e as atribuições de
App Role feitas a **grupos**.

---

## 33. Checklist — ambiente corporativo

```text
Identidade
[ ] App Registration PGCP Web (SPA) + redirect URI
[ ] App Registration PGCP API + requestedAccessTokenVersion = 2
[ ] escopo access_as_user exposto e SPA autorizado
[ ] credencial da API (secret ou certificado), só no servidor

App Roles
[ ] criar PGCP.Assessoria e PGCP.Admin
[ ] atribuir a GRUPOS corporativos
[ ] conferir que nenhuma atribuição ficou como "Default Access"

Graph
[ ] Calendars.Read (delegada) + admin consent
[ ] User.Read.All (aplicação) + admin consent
[ ] confirmar que Calendars.ReadWrite Application NÃO foi concedida

Exchange
[ ] Application Calendars.ReadWrite via RBAC for Applications
[ ] Resource Scope das mailboxes organizadoras
[ ] provar InScope = True e InScope = False

Banco
[ ] PostgreSQL gerenciado, TLS obrigatório
[ ] aplicar migrations 001–014
[ ] usuário de aplicação com privilégio mínimo

Validação
[ ] login e claims de roles em /me
[ ] calendário próprio na Visão Geral
[ ] criar reunião: evento Outlook + Teams com joinUrl
[ ] auditoria acessível a PGCP.Admin

Pendente
[ ] observabilidade (Azure) — ainda não implementada
```

Runbooks: [`runbook-entra-app-registration.md`](runbook-entra-app-registration.md)
e [`runbook-exchange-calendar.md`](runbook-exchange-calendar.md).

---

## 34. Decisões que NÃO devem ser revertidas sem motivo

Cada uma custou uma etapa de análise ou um incidente:

1. **Não usar e-mail como identidade.** É `tid` + `oid`.
2. **Não criar usuário fake** nem massa de demonstração no banco.
3. **Não usar participante como ACL.** Convite ≠ autorização de consulta.
4. **Não conceder `Calendars.ReadWrite` Application tenant-wide no Entra.** A
   escrita vem do Exchange RBAC com Resource Scope.
5. **Não criar reunião Teams separada** do evento do Outlook.
6. **Não usar `Mail.Send` para duplicar** o convite que o Exchange já envia.
7. **Não persistir eventos pessoais do Outlook** no PostgreSQL.
8. **Não localizar evento por título, data ou participante** — só por
   `provider_event_id` imutável.
9. **Não chamar o Graph dentro de transação do PostgreSQL.**
10. **Não fazer rollback do dado do PGCP por falha da Microsoft.**
11. **Não reintroduzir transcrição.**
12. **Não transformar `PGCP.Admin` em role funcional de reunião** — nem o
    contrário.
13. **Não derivar atraso persistido** (FUP): `due_date` é a única data gravada.
14. **Não usar ORM.** SQL explícito, revisável.
15. **Não gerar chave de idempotência nova em retry.**
16. **Não decidir autorização por `jobTitle`, nome, e-mail ou grupo hardcoded.**
17. **Não deixar a tela afirmar o que o servidor não confirmou** — sem "convite
    enviado" otimista, sem simulação de envio.
18. **Não editar migration já aplicada.**

---

## 35. Dívidas e lacunas conhecidas

Lacunas reais — nenhuma é bug:

| Lacuna | Situação |
|---|---|
| Observabilidade (Azure) | pendente; variável existe, código não |
| `Mail.Send` (Delegated) | ✅ concedida; envio e recebimento validados. ⚠️ falta revalidar a persistência de `sent` após a correção do 202 |
| DocuSign | domínio pronto, **sem** provedor, credenciais ou rota |
| Reunião confidencial/restrita | **não existe** no modelo |
| Experiência pública | futura; hoje o usuário sem role já tem leitura corporativa |
| Cobertura de testes | runner existe (`node --test`, `npm test` na raiz, 16 testes verdes); cobre production-guard, rate limit e validação de entrada. **Sem** teste para `validateClaims` e sem testes no frontend |
| `packages/contracts` | pasta reservada: só um README, **sem `package.json`** e portanto **fora dos `workspaces`**. O contrato segue **duplicado** — a API declara os tipos por módulo e o frontend os redeclara nos adaptadores de `apps/web/src/lib/*-adapters.ts` |
| Status `approved`/`closed` da Ata | previstos no CHECK, sem fluxo que os produza |
| Ata e Anotações sem papel próprio | escrita é de `PGCP.Assessoria`; não há papel de Secretaria distinto |
| `setTaxonomyActive` | existe no cliente sem consumidor na tela |
| `removeParticipant` (cliente web) | `DELETE /meetings/:id/participants/:participantId` existe e está protegido na API, mas **a tela nunca o chama**: dá para adicionar participante a uma reunião existente e não para remover |

---

## 36. Próximos passos sugeridos

Sugestão, não compromisso — a ordem é do produto:

1. **Ajustes funcionais solicitados pelo produto** (prioridade).
2. Observabilidade técnica (Azure Monitor / Application Insights).
3. Conceder `Mail.Send` **Delegated** no Entra e validar o envio real das pautas.
4. DocuSign, quando houver credenciais.
5. Formalizar a suíte de testes num runner.
6. Confidencialidade de reunião, se virar requisito.

---

## 37. Índice de documentos

| Documento | Quando consultar |
|---|---|
| [`../README.md`](../README.md) | primeira execução local, estrutura, estado atual |
| **`HANDOFF-CORPORATIVO.md`** (este) | ao assumir o projeto — porta de entrada |
| [`integracoes.md`](integracoes.md) | arquitetura das integrações, política de autorização, estados de sincronização |
| [`runbook-entra-app-registration.md`](runbook-entra-app-registration.md) | configurar Entra do zero: apps, escopo, App Roles, permissões |
| [`runbook-exchange-calendar.md`](runbook-exchange-calendar.md) | autorização de calendário no Exchange (PowerShell, Resource Scope, testes InScope) |
| [`handoff-exchange-rbac.md`](handoff-exchange-rbac.md) | pedido operacional ao administrador do Exchange |
| [`modelo-de-dados.md`](modelo-de-dados.md) | schema coluna a coluna e decisões de modelagem |
| [`etapa-4-7-biblioteca.md`](etapa-4-7-biblioteca.md) | histórico do desenho da Biblioteca de pautas |
| [`../infra/README.md`](../infra/README.md) | container do PostgreSQL local |
| [`../scripts/README.md`](../scripts/README.md) | utilitários (preflight do Entra) |
