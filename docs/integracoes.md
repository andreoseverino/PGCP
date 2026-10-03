# Integrações — PGCP CONECTADO

Referência das integrações do PGCP: o que existe, como configurar, como testar e
o que ainda não está implementado.

> **Nenhum segredo neste documento.** Aqui constam apenas nomes de variáveis.
> Valores ficam em `apps/api/.env`, que não é versionado.

---

## Princípio

> Mock só permanece enquanto não existir fonte real disponível.

| Domínio | Fonte definitiva |
| --- | --- |
| Identidade corporativa | Microsoft Entra ID |
| Diretório de usuários (nome, e-mail, cargo, foto) | Microsoft Graph |
| Dados de negócio do PGCP | PostgreSQL |
| Calendário e convites | Outlook / Microsoft Graph |
| Reunião online | Microsoft Teams / Microsoft Graph |
| E-mail operacional | Microsoft Graph Mail |
| Assinatura da Ata | DocuSign eSignature |
| Auditoria funcional | PostgreSQL (`audit_logs`) |
| Telemetria técnica | Application Insights / Azure Monitor |

---

## Arquitetura

```
React / Vite (:3000)
        │
        ▼
API PGCP / Express (:3333)
        │
        ├── PostgreSQL (:5434)
        ├── Microsoft Graph
        ├── DocuSign
        └── Observabilidade
```

Integração que exige segredo **passa obrigatoriamente pela API**. O browser
nunca recebe segredo, nem para fazer a chamada externa ele mesmo.

Sem ORM, sem fila, sem cache distribuído, sem microserviço.

---

## Onde cada coisa mora

| | `apps/web` | `apps/api` |
| --- | --- | --- |
| Arquivo | `.env` (`VITE_*`) | `.env` |
| Conteúdo | apenas configuração **pública** | segredos, tokens, credenciais |
| Visibilidade | embutido no bundle, visível a qualquer visitante | somente no servidor |

Qualquer variável com prefixo `VITE_` vai para o JavaScript entregue ao
navegador. **Nunca** colocar segredo ali.

---

## Painel

`Configurações → Integrações`

Sub-abas: Visão Geral · Login / Entra ID · Microsoft Graph · Outlook / Calendário ·
Microsoft Teams · E-mail · PostgreSQL · DocuSign · Observabilidade.

Toda integração aparece no painel mesmo sem configuração — o painel mostra
**Não configurado**, nunca esconde.

### Estados

| Estado | Significado |
| --- | --- |
| `connected` | Verificada agora e respondendo |
| `configured` / *Não verificado* | Parâmetros presentes, mas nunca testada (ou sem teste possível nesta etapa) |
| `not_configured` | Falta variável obrigatória |
| `error` | Verificada e falhou |

Status positivo nunca é presumido. Sem verificação, `connected` é `null` e o
painel exibe *Não verificado*.

### Segredos no painel

Variável marcada como secreta mostra apenas `•••••••••••• ✓ Configurado` ou `—`.
A API devolve somente `configured: true/false`; o valor não sai do servidor —
nem mascarado, porque o tamanho da máscara já seria informação.

---

## Endpoints

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/integrations` | Catálogo completo com estado atual. Não executa verificação. |
| `GET` | `/integrations/:id/status` | Estado de uma integração. Não executa verificação. |
| `POST` | `/integrations/:id/test` | Executa a verificação **real** e devolve o estado atualizado. |

`POST` porque a chamada tem efeito: consulta o recurso externo e grava o
resultado como última verificação. O resultado fica em memória — reiniciar a API
volta tudo para *Não verificado*.

Ids: `entra`, `graph`, `outlook`, `teams-meeting`, `teams-messages`, `mail`,
`postgres`, `docusign`, `observability`.

O catálogo é declarativo, em `apps/api/src/integrations/registry.ts`. Adicionar
integração = adicionar entrada lá; o painel deriva daí.

---

## Verificações disponíveis hoje

| Integração | Tipo | O que prova | O que **não** prova |
| --- | --- | --- | --- |
| PostgreSQL | consulta real (`SELECT 1`) | banco no ar e credenciais válidas | — |
| Entra ID | alcançabilidade (documento OIDC do tenant) | tenant existe e responde | que client id/secret são válidos |
| DocuSign | alcançabilidade (host de OAuth) | host responde | conta e credenciais |
| Observabilidade | formato da connection string | string bem-formada, com `InstrumentationKey` | que telemetria chega |
| Graph, Outlook, Teams, E-mail | **nenhuma** | — | requerem token (Etapa 2) |

Nenhum botão retorna sucesso fabricado. Integração sem verificação possível
declara `testable: false` e o botão fica desabilitado, com o motivo escrito.

---

## Variáveis de ambiente

### `apps/web/.env` — públicas

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `VITE_API_URL` | opcional | Base da API. Padrão `http://localhost:3333`. |
| `VITE_ENTRA_TENANT_ID` | Etapa 2.5 | Tenant. Mesmo valor de `ENTRA_TENANT_ID`. |
| `VITE_ENTRA_SPA_CLIENT_ID` | Etapa 2.5 | Client id do **PGCP Web**. Não é o da API. |
| `VITE_ENTRA_REDIRECT_URI` | Etapa 2.5 | Ponte de redirect: `http://localhost:3000/auth/redirect.html`. Precisa bater exatamente. |
| `VITE_ENTRA_API_SCOPE` | Etapa 2.5 | `api://<ENTRA_API_CLIENT_ID>/access_as_user`. |

Não existe secret com prefixo `VITE_`. O MSAL em SPA usa PKCE, que dispensa
segredo no cliente.

### `apps/api/.env`

| Variável | Tipo | Obrigatória para | Descrição |
| --- | --- | --- | --- |
| `PORT` | pública | API | Porta HTTP. Padrão 3333. |
| `CORS_ORIGIN` | pública | API | Origens permitidas, separadas por vírgula. Nunca `*`. |
| `DB_HOST` | pública | PostgreSQL | Host do servidor. |
| `DB_PORT` | pública | PostgreSQL | Porta. 5434 no dev local. |
| `DB_NAME` | pública | PostgreSQL | Nome do banco. |
| `DB_USER` | pública | PostgreSQL | Usuário da aplicação. |
| `DB_PASSWORD` | **segredo** | PostgreSQL | Senha do usuário. |
| `DB_SSL` | pública | opcional | `true` quando o servidor exigir TLS. |
| `ENTRA_TENANT_ID` | pública | Entra, Graph, Outlook, Teams, Mail | Directory (tenant) id. Define `iss` e `tid` aceitos. |
| `ENTRA_API_CLIENT_ID` | pública | idem | Client id da **PGCP API**. É o `aud` esperado. |
| `ENTRA_SPA_CLIENT_ID` | pública | Entra | Client id do **PGCP Web**. É o `azp` esperado. |
| `ENTRA_API_APP_ID_URI` | pública | opcional | `api://<api-client-id>`. Monta o scope; **nunca** aceito como `aud`. |
| `ENTRA_API_SCOPE_NAME` | pública | opcional | Scope exigido em `scp`. Padrão `access_as_user`. |
| `ENTRA_API_CLIENT_SECRET` | **segredo** | **Etapa 5 (OBO)** | Não é necessário para validar token — o JWKS é público. |
| `GRAPH_BASE_URL` | pública | opcional | Padrão `https://graph.microsoft.com/v1.0`. |
| `MAIL_SENDER_ADDRESS` | pública | E-mail | Caixa remetente institucional. |
| `MEETING_LOCATIONS_ADDRESSES` | pública | Reunião presencial | JSON opcional com o endereço **oficial** de cada sede do catálogo. Sem valor, o convite leva só o nome da sede. |
| `DOCUSIGN_CLIENT_ID` | pública | DocuSign | Integration Key. |
| `DOCUSIGN_CLIENT_SECRET` | **segredo** | DocuSign | Secret Key. |
| `DOCUSIGN_ACCOUNT_ID` | pública | DocuSign | API Account ID. |
| `DOCUSIGN_OAUTH_BASE_PATH` | pública | DocuSign | `account-d.docusign.com` (demo). |
| `DOCUSIGN_BASE_PATH` | pública | opcional | `https://demo.docusign.net/restapi`. |
| `DOCUSIGN_REDIRECT_URI` | pública | opcional | Só no Authorization Code Grant. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | **segredo** | Observabilidade | Contém `InstrumentationKey`. |

Graph, Outlook, Teams e Mail usam o App Registration **da API**. O painel mostra
essas variáveis como *Herdado do Entra ID* nas integrações dependentes, em vez
de duplicá-las.

Deixar vazio é válido: a aplicação sobe normalmente e o painel informa o que falta.

---

## Os dois App Registrations

```
PGCP Web (SPA)                          PGCP API
public client, sem secret, PKCE         confidential client
Redirect URI (SPA): localhost:3000      Expose an API: api://<api-client-id>
Permissão: access_as_user da API          scope: access_as_user
Permissões Graph: NENHUMA                 manifest: requestedAccessTokenVersion = 2
                                        Permissões Graph vivem aqui
        │                                        ▲
        └──── access token (aud = API) ──────────┘
```

O SPA não recebe permissão nenhuma do Graph: todo acesso ao Graph nasce na API.
Em *Authorized client applications* da API, pré-autorizar o client id do SPA —
sem isso o usuário enfrenta um segundo prompt de consentimento.

### Ponte de redirect (MSAL v5)

No MSAL Browser v5 o fluxo de popup **não sonda mais a URL da janela filha**:
`PopupClient.waitForPopupResponse` aguarda uma mensagem num `BroadcastChannel`,
publicada por `broadcastResponseToMainFrame()`. É obrigatória uma página
dedicada de redirect.

| | |
| --- | --- |
| Página | `apps/web/auth/redirect.html` → `apps/web/src/auth/redirect.ts` |
| URL | `http://localhost:3000/auth/redirect.html` |
| Conteúdo | apenas `broadcastResponseToMainFrame()` — sem React, sem `msal.ts`, sem roteamento, sem `/me` |
| Build | declarada como segunda entrada em `vite.config.ts` (`build.rollupOptions.input`) |

Apontar o redirect para a raiz da aplicação faz o popup carregar o PGCP inteiro,
ninguém publica no canal, e o login expira com `timed_out` — com o popup parado
na tela de login. A mesma ponte atende o `logoutPopup`, que em v5 também a exige.

**Registrar no Azure** (PGCP Web → Autenticação → Aplicativo de página única):
`http://localhost:3000/auth/redirect.html`

### `requestedAccessTokenVersion` — obrigatório valer 2

No **PGCP API** → Manifesto:

```json
"requestedAccessTokenVersion": 2
```

O default de um registro *single tenant* é `null`, que o Entra trata como **1**.
Só é obrigatoriamente 2 quando o `signInAudience` inclui contas pessoais —
portanto **um registro novo nasce emitindo v1** e ninguém é avisado.

Foi exatamente a falha do primeiro login real: popup fechava, `GET /me`
respondia **401**, e a tela mostrava *"Sua credencial não foi aceita ou
expirou"*. Um access token v1 traz:

| Claim | v1 (emitido) | v2 (esperado pela API) |
| --- | --- | --- |
| `iss` | `https://sts.windows.net/{tid}/` | `https://login.microsoftonline.com/{tid}/v2.0` |
| `aud` | `api://<api-client-id>` (App ID URI) | `<api-client-id>` (GUID) |
| autorização do cliente | `appid` | `azp` |

`iss` e `aud` divergem, e o `jose` rejeita antes mesmo dos claims próprios do
PGCP. **Não adaptar o middleware para aceitar v1**: recusar o App ID URI como
`aud` é decisão de arquitetura, e foi ela que expôs o problema.

Depois de alterar o manifesto, **fazer logout no PGCP antes de tentar de novo** —
o MSAL guarda o token v1 em cache e o reutilizaria silenciosamente.

## Fase 5 — Integrações operacionais (desenho fechado, sem implementação)

> Etapa 5.1: auditoria e arquitetura.
> Etapa 5.2: implementação do calendário — migration 011, mapper, cliente de
> escrita no Graph e rota explícita de sincronização.
> Etapa 5.2a: correção do modelo de autorização. **Nenhum evento real foi
> criado.** A autorização de calendário é do **Exchange Online RBAC for
> Applications**, não de consentimento no App Registration. Teams, Mail e
> DocuSign continuam sem implementação.

### Ordem e escopo

| Integração | Papel | Situação |
|---|---|---|
| **Outlook / Calendário** | próxima integração operacional | desenho fechado abaixo |
| **Teams** | reunião online do MESMO evento — parte da definição de reunião do PGCP | **obrigatório em toda reunião nova** |
| **Mail** | notificação avulsa; **nunca** duplica o convite de calendário | adiado |
| **DocuSign** | domínio pronto desde a 4.11 | **bloqueado por ausência de credenciais** |

### Calendário — DUAS capacidades distintas

Confundi-las é o erro que custa caro aqui: uma é sobre a agenda de quem está
logado, a outra é sobre a agenda de terceiros.

| | **A. Ler o próprio calendário** | **B. Criar/alterar em calendário administrado** |
|---|---|---|
| Quem usa | **todos** os usuários ativos | somente operações autorizadas |
| Permissão | `Calendars.Read` **Delegated** | `Application Calendars.ReadWrite` |
| Onde é concedida | App Registration (Entra) | **Exchange Online RBAC for Applications** |
| Fluxo | **On-Behalf-Of** | client credentials (app-only) |
| Chamada Graph | `GET /me/calendarView` | `POST /users/{oid}/events` |
| Limite de alcance | a própria caixa, por natureza | **Resource Scope** do Exchange |
| Estado | implementado (5.2c) | implementado, aguardando autorização |

**Por que fluxos diferentes.** Ler a própria agenda tem a pessoa na sessão — o
`/me` resolve sozinho e o PGCP não precisa de acesso a caixa nenhuma. Agendar em
caixa alheia não pode depender da sessão do organizador, que nem está logado:
retry e reprocessamento precisam funcionar de madrugada.

**Não** conceder `Calendars.ReadWrite` (Application) no Entra em nenhum dos dois
casos — ver o requisito de infraestrutura abaixo.

### Perfis — App Role, não grupo no código

**Duas App Roles, e só:**

- **`PGCP.Assessoria`** — perfil FUNCIONAL. Cria, agenda, administra e conduz
  reuniões, e mantém os cadastros funcionais (órgãos de governança, tipos e
  naturezas de pauta).
- **`PGCP.Admin`** — perfil TÉCNICO. Usuários do PGCP, integrações, auditoria e
  configurações administrativas.

**Sem App Role** a pessoa continua sendo usuário do PGCP: lê o conteúdo
corporativo e cuida dos próprios FUPs. É esse perfil que servirá de base para a
futura experiência pública.

*Histórico: até a 5.4l a role funcional chamava-se `Meeting.Scheduler`; foi
substituída por `PGCP.Assessoria` e descontinuada.*

Independentes: nenhuma implica a outra. A única sobreposição é o OR deliberado
dos cadastros funcionais, centralizado em `requireAssessoriaOuAdmin`.

| Capacidade | Exige |
|---|---|
| Entrar, ver Meu Calendário, abrir reunião, ingressar | usuário PGCP ativo |
| **Ler** reunião, pautas, Anotações e Ata | usuário PGCP ativo (Política A) |
| Criar reunião, editar cabeçalho, participantes, pautas | **`PGCP.Assessoria`** |
| Conduzir: iniciar/concluir pauta, postergar, retomar | **`PGCP.Assessoria`** |
| Escrever Anotações (`PUT /notes`) | **`PGCP.Assessoria`** |
| Escrever Ata e sanear (`PUT /minutes`, `clear-by-secretariat`) | **`PGCP.Assessoria`** |
| Sincronizar Outlook/Teams | **`PGCP.Assessoria`** |
| Ler FUP | **visibilidade herdada** — ver abaixo |
| Alterar/concluir FUP | **responsável** ou **`PGCP.Assessoria`** |
| Criar/editar/desativar órgão de governança | **`PGCP.Assessoria` OU `PGCP.Admin`** |
| Cadastros de tipo e natureza de pauta (escrita) | **`PGCP.Assessoria` OU `PGCP.Admin`** |
| Abrir a aba Administração | **`PGCP.Assessoria` OU `PGCP.Admin`** — conteúdo difere |
| Listar usuários do PGCP (`GET /users`) | **`PGCP.Admin`** — rota disponível, sem tela que a consuma |
| Painel de Integrações (ler status, testar) | **`PGCP.Admin`** |
| Trilha de auditoria (`GET /audit-logs`) | **`PGCP.Admin`** — somente leitura |
| Configurações administrativas | **`PGCP.Admin`** |
| Diretório do Graph (`GET /directory/users`) | usuário PGCP ativo — alimenta os seletores |

`clear-by-secretariat` mantém o nome no contrato: a Secretaria/Assessoria
autorizada é representada por `PGCP.Assessoria`. Não existe
`Meeting.Secretariat`.

**Perfil público:** decisão FUTURA, não implementada. A experiência pública
seria a de quem entra sem `PGCP.Assessoria` e sem `PGCP.Admin` — hoje esse
usuário já tem leitura corporativa e seus próprios FUPs, e nada além disso.

`updated_by_user_id` e `secretariat_cleared_by_user_id` continuam sendo
**autoria e auditoria** — registram quem fez, nunca autorizam quem pode.

**O que `PGCP.Assessoria` NÃO autoriza:** administração técnica — usuários do
PGCP, integrações, auditoria e configurações.

**O que `PGCP.Admin` NÃO autoriza:** operar reuniões. Administrar a plataforma
não é conduzir uma sessão, escrever Ata nem gerenciar FUP de terceiro.

#### `PGCP.Admin` — administração da plataforma

Implementada nas 5.4i e 5.4j. Domínio diferente de operar reuniões, e **sem
hierarquia**: `PGCP.Admin` não implica `PGCP.Assessoria` nem o contrário.

| Domínio | Guarda |
|---|---|
| `POST`/`PUT /governance-bodies` | `PGCP.Admin` |
| `POST`/`PATCH`/`DELETE /agenda-topics/taxonomy/*` | `PGCP.Admin` |
| `GET /users` (usuários do PGCP) | `PGCP.Admin` |
| `/integrations/*` | `PGCP.Admin` |
| `GET /audit-logs` | `PGCP.Admin` |

Na interface, Administração, Auditoria e Configurações só aparecem — e só são
renderizadas — com a role. O servidor revalida em cada rota.

**Trilha de auditoria:** somente leitura, paginada por cursor `(occurred_at,
id)`. Filtros aceitos: `limit`, `cursor`, `actorUserId`, `entityType`,
`entityId`, `dateFrom`, `dateTo` — parâmetro fora dessa lista vira 400. Não há
filtro por `status` nem por `action`, porque o serviço de leitura não os
suporta. `audit_logs` é **append-only**: não existe rota que crie, edite ou
limpe registro, e a tela não oferece nenhuma.

### Política de leitura — decisão de produto, não lacuna

> **Reuniões corporativas são visíveis a todos os usuários PGCP ativos.**
> (Política A, aprovada na 5.4e.)

Não é implementação faltando: é a regra escolhida depois de mapear o modelo
real. Duas razões:

1. **Não existe fonte de autorização por participação.** `meeting_participants`
   lista quem foi *convidado*; nos dados reais, a maioria dos participantes é
   snapshot textual, sem identidade. Usar essa tabela como ACL negaria acesso a
   quem participa de verdade.
2. **Quem cadastra a reunião, a Secretaria e quem prepara pauta consultam
   reuniões das quais não participam.** Uma regra por participação quebraria
   esse trabalho em silêncio.

> **O PGCP ainda NÃO oferece reunião restrita ou confidencial.**

Não há coluna de classificação em nenhuma tabela e a interface não trata
nenhuma reunião como reservada. Sessões reservadas, quando forem requisito,
serão uma feature própria — com coluna, regra explícita e definição de quem
classifica. **Não afirmar que o sistema tem confidencialidade: ele não tem.**

A política vive num lugar só: `apps/api/src/meetings/visibility.ts`.
`clausulaDeReuniaoVisivel()` devolve `TRUE` hoje e recebe os parâmetros que uma
regra futura usaria — apertar a leitura é editar essa função, e todos que herdam
apertam junto, sem tocar em outro módulo.

### Visibilidade de FUP — herdada, não reinventada

Leitura de reunião é a fonte de verdade e o FUP herda dela.

O FUP herda:

```
posso ver um FUP  ⇔  ele é MEU (identidade)                              OU
                     nasceu de uma reunião que eu posso ver (política acima)
```

"Meu" é `assigned_user_id` **ou** o par (`assignee_entra_tenant_id`,
`assignee_entra_object_id`) do token. Nome e e-mail iguais não dão acesso a
nada — um FUP com o mesmo nome apontando para outro `oid` continua invisível.

**FUP sem reunião de origem só é visível para o responsável.** Ausência de
vínculo não pode virar porta larga: seria o único caso em que apagar a origem
ampliaria o acesso.

A mesma cláusula vale na lista **e** na consulta por UUID: esconder de `GET
/action-items` e continuar servindo em `GET /action-items/:id` seria segurança
de fachada. Invisível responde **404**, igual a inexistente — dizer "403, existe
mas não é seu" confirmaria o registro para quem não pode vê-lo. Já quem PODE ver
e não pode alterar recebe **403**, que é a resposta honesta.

Alterar é outra permissão: só o **responsável** (a própria obrigação) ou quem
tem **`PGCP.Assessoria`** (mantém o FUP como mantém a reunião de origem).
Nenhuma App Role nova foi criada. Criar FUP continua aberto a usuário ativo.

**Regra vigente (5.4l):** `responsável OU PGCP.Assessoria`. É coerente com o
modelo atual, em que essa role já administra reunião, participantes e pautas.
`PGCP.Admin` **não** se estende a escrever Ata, Anotações ou conduzir a
execução — esses são papéis funcionais diferentes, ainda não modelados.

Na tela, botão de concluir só aparece para quem o servidor não recusaria —
cortesia, como sempre; a autoridade é o `PATCH`.

O papel chega no claim `roles` do token delegado. O grupo corporativo de
assessoria será atribuído ao App Role no Enterprise Application — **o código
nunca sabe o nome nem o GUID desse grupo**, e nada é autorizado por `jobTitle`,
nome ou e-mail.

O backend é a autoridade: cada rota revalida. Esconder o botão "Nova Reunião" é
cortesia com quem não pode, não controle de acesso.

**Configuração necessária:** declarar o App Role `PGCP.Assessoria` no manifesto
do App Registration da **API** (`allowedMemberTypes: ["User"]`) e atribuí-lo ao
grupo de assessoria no Enterprise Application.

### Ator, organizador e convidado

Três conceitos, três colunas — nunca o mesmo:

```
Maria (assessora)   created_by_user_id   quem executou o cadastro
João (Presidente)   organizer_*          de quem é o calendário
João + diretores    meeting_participants quem foi convidado
```

O organizador **não precisa de conta no PGCP**: a identidade dele é
`(organizer_entra_tenant_id, organizer_entra_object_id)`, e `organizer_user_id`
só é preenchido quando a pessoa também usa o sistema. `organizer_name` e
`organizer_email` são snapshot — exibição e endereço de entrega, nunca
identidade.

A auditoria registra **quem executou**: "Maria criou reunião", mesmo com o evento
indo para o calendário de João.

### Outlook — fluxo de autenticação (decisão revista na 5.2)

O cliente Graph é **app-only** (client credentials, escopo `.default`). Na 5.2
ele ganhou `graphRequest`, que aceita POST e PATCH; `graphGet` virou uma casca
fina sobre ele. Aquisição e cache de token continuam únicos.

Calendário usa **`Calendars.ReadWrite` do tipo Application** — não On-Behalf-Of:

```
navegador --access_as_user--> API PGCP --client credentials--> Entra
                                                                 |
                                     POST /users/{oid}/events  <──┘
```

Motivo da revisão: com OBO, sincronizar dependeria de a sessão do organizador
estar aberta naquele instante. Retry, reconciliação e qualquer processamento
assíncrono ficariam impossíveis sempre que a pessoa não estivesse logada — e é
justamente no retry que a integração precisa funcionar.

A caixa alvo vem de `meetings.organizer_entra_object_id` (par
`organizer_entra_tenant_id` + `organizer_entra_object_id`, migration 012 — o
organizador não precisa ter conta no PGCP), e as chamadas usam
`/users/{oid}/events`. **Não existe `/me` em app-only.**

#### Resumo verificado no código (revisão 025)

| Fluxo | OAuth | Token | Tipo de permissão | Identidade / caixa | Permissão Graph | Código |
|---|---|---|---|---|---|---|
| Convite Outlook + Teams (criar/atualizar evento, inclusive reserva da Agenda Anual) | Client credentials | App-only, escopo `https://graph.microsoft.com/.default` | **Application** | Caixa do **organizador** (`/users/{organizer_entra_object_id}/events`) | `Calendars.ReadWrite` via **Exchange RBAC for Applications** (Resource Scope) | `graph/client.ts` (`acquireTokenByClientCredential`), `calendar/service.ts` |
| Teams meeting | — (mesmo PATCH/POST do evento) | idem | idem | idem | idem (`isOnlineMeeting` + `onlineMeetingProvider=teamsForBusiness` no evento) | `calendar/mapper.ts` |
| Diretório (busca / checagem de e-mail duplicado) | Client credentials | App-only | **Application** | — | `User.Read.All` | `graph/client.ts` |
| E-mail de validação de pautas e da Agenda Anual | **On-Behalf-Of** | Delegado, escopo `https://graph.microsoft.com/Mail.Send` | **Delegated** | Caixa de **quem está na sessão** (`/me/sendMail`) | `Mail.Send` | `mail/send.ts` |

Nenhum dos fluxos usa `Mail.Send` Application. O convite em si não é e-mail do
PGCP: é o Exchange que notifica os `attendees` do evento.

**`202 Accepted` não é entrega.** `/me/sendMail` devolve 202 quando o Microsoft
365 ACEITA a mensagem; a entrega ao destinatário depende do Exchange e do
servidor de destino. O PGCP só marca a Agenda Anual como enviada depois do
202 (falha do OBO ou do Graph não cria versão nem muda o status), guarda a
cópia em Itens Enviados (`saveToSentItems: true`) e registra no log
estruturado `request-id`/`client-request-id` (sem token, corpo ou
destinatário). Destinatário externo é aceito. Quando o Graph aceitou e o
e-mail não chegou, o diagnóstico é do Exchange/DNS do domínio remetente:
Itens Enviados, NDR, message trace (`internetMessageId`), spam/quarentena do
destino, política de envio externo e autenticação do domínio (SPF único, DKIM
do Microsoft 365, DMARC). No QA de 03/10/2026 o domínio remetente do tenant de
teste tinha **dois registros SPF** (inválido pela RFC 7208), **sem DKIM** do
Microsoft 365 e DMARC `p=none` — pendência de configuração do tenant, não do
código.

O SPA continua sem nenhuma permissão do Graph; o navegador só envia o token da
API do PGCP. Token e segredo do Graph nunca saem do backend.

## Documentos — AWS S3

> Nenhum nome real de bucket, conta, ARN, role ou região neste documento.

**Implementado (código).** Cliente `@aws-sdk/client-s3` em
`apps/api/src/documents/storage.ts`, com `PutObject`/`GetObject`/`DeleteObject`
(o Delete só como compensação de upload cujo metadado falhou). Configuração por
ambiente:

| Variável | Uso |
|---|---|
| `PGCP_DOCUMENTS_BUCKET` | bucket privado dos anexos (obrigatória em produção) |
| `AWS_REGION` | região do bucket (obrigatória em produção) |
| `PGCP_DOCUMENTS_KMS_KEY_ID` | opcional: SSE-KMS; ausente = SSE-S3 (`AES256`) |
| `DOCUMENT_MAX_SIZE_BYTES` | opcional: limite de upload (padrão 20 MB, teto 100 MB) |

Credenciais pela cadeia padrão do SDK (role da instância/tarefa, SSO local).
Sem bucket/região o PGCP sobe normalmente e só as operações de arquivo
respondem 503. Tempo-limite de 30 s por operação; erros mapeados (objeto
inexistente 404, tempo 504, acesso/credencial 503, demais 502) e logados sem
chave nem conteúdo. O navegador nunca fala com o S3: upload e download passam
pela API, então o bucket **não precisa de CORS**.

**Pendente de infraestrutura AWS** (não criado, não inventado):

- bucket privado, com Block Public Access ligado e Object Ownership
  "bucket owner enforced" (sem ACL);
- região definida pela equipe de infraestrutura;
- IAM role do backend com `s3:PutObject`, `s3:GetObject` e `s3:DeleteObject`
  restritos a `arn:aws:s3:::<bucket>/meetings/*` (sem `s3:ListBucket`: a API
  nunca lista o bucket); `kms:GenerateDataKey`/`kms:Decrypt` na chave, se
  SSE-KMS;
- opcional: chave KMS dedicada, versionamento/lifecycle do bucket, política de
  bucket negando transporte sem TLS (`aws:SecureTransport = false`);
- futuro: antivírus dos anexos; guardar no S3 os PDFs gerados (Agenda Anual
  enviada/aprovada, Ata final).

> **Requisito de infraestrutura — e uma correção importante.**
>
> **Não** conceder `Calendars.ReadWrite` (Application) no App Registration do
> Entra. As duas autorizações são **aditivas**: um grant tenant-wide no Entra
> passa por cima do Resource Scope do Exchange e devolve à aplicação exatamente
> o acesso irrestrito que o escopo existe para impedir.
>
> A autorização de calendário vem do **Exchange Online RBAC for Applications**:
> papel `Application Calendars.ReadWrite` atribuído ao service principal do PGCP,
> limitado por um **Resource Scope**.
>
> `User.Read.All` (Application, Entra) é o modelo do **diretório** e não muda —
> diretório e calendário são capacidades diferentes.

### Outlook — organizador

`meetings.organizer_entra_tenant_id` + `organizer_entra_object_id` (012). A
caixa de destino é resolvida por essa identidade, nunca por nome, por
`organizer` textual ou por e-mail digitado. `organizer_user_id` só enriquece o
vínculo quando o organizador também tem conta no PGCP.

Sem `organizer_entra_object_id` a reunião não pode sincronizar
(`organizer_without_entra_identity`). Não escolher uma caixa substituta.

### Outlook — fonte de verdade

```
PGCP     = fonte de verdade da reunião corporativa
Outlook  = projeção dessa reunião no calendário
```

PGCP → Outlook: criação e edição propagam. Outlook → PGCP: **não** propaga.
Alteração feita no Outlook não muda pauta, quórum, Ata nem estado do PGCP.
Sincronização bidirecional só com requisito funcional explícito.

### Outlook — campos que sincronizam

`title`, `description`, `start_at`, `end_at`, `timezone`, `meeting_link`,
`modality`, `physical_location_key` (025) e o conjunto de participantes.

**Modalidade e local físico (migration 025).** Toda reunião tem Teams no próprio
evento; a modalidade só muda o que acompanha o convite:

| Modalidade | Teams (`isOnlineMeeting`) | `location` do evento | Corpo do convite |
|---|---|---|---|
| `online` | sim | **omitido** (igual ao comportamento anterior) | descrição |
| `in_person` | **sim, como contingência** | nome da sede + endereço **se configurado** | "Reunião presencial — Local: …" + aviso de contingência do Teams |

O local é **chave de catálogo** (`sede-matriz`, `sede-leopoldo` em
`apps/api/src/meetings/locations.ts`), nunca texto livre. O **endereço oficial não
existe no repositório** e não é presumido: vem de `MEETING_LOCATIONS_ADDRESSES`
(JSON por chave, `apps/api/.env`). Sem ele o convite leva só o nome da sede.

Presencial → online **depois** do convite: o PATCH no mesmo evento envia
`location: { displayName: "" }` e `locations: []`, o que apaga o local físico
anterior no Outlook (omitir a propriedade não apagaria). Vale para todo PATCH de
reunião online — inclusive eventos legados que ainda tinham `location` da época
anterior à 021. Mesmo `provider_event_id`, mesmo Teams; POST de reunião online
não envia remoção (não há local anterior).

**Não** sincronizam: pautas, estado de execução, FUP, Anotações, Ata, processo de
assinatura, Biblioteca. São conteúdo de governança, não do compromisso.

### Outlook — configuração Exchange (pré-requisito do primeiro teste)

Estado verificado em 19/08/2026 contra o tenant, por leitura do próprio service
principal:

| Fato | Situação |
|---|---|
| Service principal da API existe no Entra | ✅ `PGCP API` |
| Papéis de aplicação concedidos | **exatamente 1** — o id corresponde ao publicamente documentado de `User.Read.All` |
| `Calendars.ReadWrite` (Application) no Entra | **NÃO concedida** — nada a remover |
| `GET /users/{oid}/calendar` | **403 `ErrorAccessDenied`** |
| Credencial Graph app-only | ✅ funcionando (diretório responde) |

O código `ErrorAccessDenied` vem do **Exchange**; falta de permissão no Entra
costuma responder `Authorization_RequestDenied`. O cliente Graph passou a
distinguir os dois casos na mensagem de erro, para o administrador não mexer na
camada errada.

**O que o time Exchange precisa fazer.** O handoff pronto para entregar à
administração está em [`handoff-exchange-rbac.md`](handoff-exchange-rbac.md),
com placeholders, os dois testes de escopo e a lista de confirmação. Resumo:

1. **Service principal no Exchange Online.** Registrar/referenciar o service
   principal da aplicação (`New-ServicePrincipal` / `Get-ServicePrincipal`),
   usando o *App ID* e o *Object ID* do service principal já existente no Entra.
2. **Resource Scope.** Criar um escopo que delimite as caixas alcançáveis
   (`New-ManagementScope` com filtro de destinatário — por grupo, departamento ou
   atributo customizado, conforme a governança definir).
3. **Atribuição do papel.** `New-ManagementRoleAssignment` com
   `-Role "Application Calendars.ReadWrite"`, o service principal como
   `-App`, e o escopo criado em `-CustomResourceScope`.
4. **Teste de autorização.** `Test-ServicePrincipalAuthorization` contra uma
   mailbox dentro do escopo — e, para provar que o escopo funciona, contra uma
   **fora** dele, que deve falhar.

Nenhum segredo entra nesta documentação, e nada disso é executado pela aplicação.

### Outlook — escopo do primeiro teste

Para o smoke test, **não** liberar todas as caixas corporativas. Começar com
**uma mailbox de teste** ou uma caixa explicitamente autorizada para homologação,
e confirmar que o Resource Scope está mesmo limitando — validando o sucesso
dentro do escopo **e a recusa fora dele**. Ampliar só depois, conforme a
governança corporativa decidir.

> **Duas autorizações distintas, que não se substituem.**
>
> O **Exchange RBAC** limita *quais mailboxes a aplicação alcança*.
> O **RBAC do PGCP** (ainda inexistente) definirá *quais usuários podem mandar o
> PGCP realizar a operação* — criar convite, atualizar, reprocessar e, no futuro,
> cancelar.
>
> Hoje qualquer usuário PGCP ativo consegue chamar `calendar-sync`. Isso precisa
> ser resolvido **antes** de conceder acesso a mailboxes reais em produção.

### Outlook — modelo de vínculo (migration 011)

`meeting_calendar_integrations`, e não colunas em `meetings`: a reunião continua
válida com o convite `pending` ou `failed`, e estado operacional de rede não
pertence à tabela que descreve a reunião.

| Coluna | Papel |
|---|---|
| `meeting_id` + `provider` | UNIQUE — uma integração por reunião e fornecedor |
| `owner_user_id` | `users.id` do dono da caixa; a identidade Entra sai daqui |
| `provider_event_id` | id do evento, obtido como **ImmutableId** |
| `web_link`, `join_url` | devolvidos pelo Graph; `join_url` é o link do Teams e NÃO se mistura com `meetings.meeting_link`, que é o link digitado à mão |
| `idempotency_key` | reenviada em toda criação, como `event.transactionId` |
| `sync_status` | `pending` / `synced` / `failed` / `stale` — ver quadro abaixo |
| `last_synced_at`, `last_error` | mensagem legível, nunca payload |

Sem backfill: nenhuma reunião existente ganhou vínculo.

#### Estados da projeção — banco e tela

Quatro estados no banco, e eles **não** são reescritos pela interface:

| `sync_status` | Significado |
|---|---|
| `pending` | evento ainda não provisionado; tentativa inicial pendente |
| `synced` | PGCP e evento Microsoft alinhados |
| `failed` | a tentativa falhou e **ainda não existe** `provider_event_id` |
| `stale` | o evento existe, mas não reflete o estado atual do PGCP |

Uma falha de PATCH num evento que já existe permanece `stale` com `last_error`
preenchido — e continua certo: o evento está lá, apenas desatualizado. Nada
converte isso para `failed`.

A tela precisa de uma distinção a mais, porque para quem lê "atualização
pendente" e "a Microsoft recusou" não são a mesma notícia:

| Estado no banco | `last_error` | Rótulo na tela |
|---|---|---|
| `synced` | — | **Sincronizado** |
| `pending` (ou sem integração) | — | **Sincronização pendente** |
| `stale` | vazio | **Atualização pendente** |
| `stale` | preenchido | **Falha na sincronização** |
| `failed` | qualquer | **Falha na sincronização** |

A derivação vive em `calendarVisualState` (`apps/web/src/lib/calendar-sync.ts`) e
é só apresentação: o servidor continua sendo a autoridade sobre `sync_status`.

Na falha, o cartão diz primeiro o que aconteceu em linguagem funcional — *"Não
foi possível atualizar o convite no Outlook e Microsoft Teams. A reunião continua
salva no PGCP."* — e depois o motivo que o servidor gravou. `last_error` é texto
sanitizado (sem token, cabeçalho, payload ou stack) e costuma ser acionável, como
"participante sem e-mail utilizável"; fora do estado de falha ele não aparece.

**Enviar convite da reunião** aparece em tudo que não seja `synced`, e apenas
para quem tem `PGCP.Assessoria` — em `synced` não há o que recuperar. Cobre dois
momentos, e `pending` os separa: o **primeiro envio** (a reunião foi preparada e
ainda não convidou ninguém) e o **reenvio** (falhou, ou a reunião mudou e o
convite desatualizou).

**Desde a migration 025 o convite NÃO depende de pauta aprovada.** Agendar é
reservar: o Calendário chama `POST /meetings` e, em seguida,
`POST /meetings/:id/calendar-sync`, antes da aprovação do planejamento. A
reserva pela Agenda Anual (`POST /annual-agendas/:id/reserve`) não tem mais ação
na interface — a rota fica por compatibilidade; o fluxo começa pela reunião
criada no Calendário. O
gate `agenda_not_approved` (409) foi retirado; a aprovação das pautas continua
exigida para **iniciar** a reunião (`meetings/meeting-start.ts`).

### Outlook — idempotência

A chave nasce com a linha e **não muda em timeout** — é exatamente o caso em que
o evento pode ter sido criado sem a resposta voltar, e repetir com a mesma chave
é o que impede o segundo evento. Havendo `provider_event_id`, a operação vira
PATCH nesse id.

**Não há reconciliação por consulta.** Nada de `$filter` por título, data ou
participante. Se um dia surgir a necessidade real de reencontrar um evento perdido
sem `provider_event_id`, a alternativa a avaliar é uma propriedade estendida do
Outlook contendo o UUID da reunião — decisão a reportar antes, não a improvisar.

### Outlook — falha e retry

PostgreSQL commita primeiro; o Graph vem depois. A reunião nunca é desfeita
porque o calendário ficou indisponível.

```
POST /meetings            → reunião + integração `pending`  (uma transação)
POST /meetings/:id/calendar-sync → chamada ao Graph
                                   ├─ 2xx  → synced, event id, webLink, joinUrl
                                   └─ erro → failed (ou stale, se já havia evento)
```

**Na criação, a sincronização é automática** — depois do COMMIT, nunca dentro
dele:

```
POST /meetings
  ├─ transação PostgreSQL: reunião + participantes + pautas + trilha
  │                        + integração `pending` com idempotency_key
  ├─ COMMIT
  ├─ POST /users/{organizer_oid}/events   (isOnlineMeeting + provider)
  │     ├─ 2xx  → synced, provider_event_id, web_link, join_url
  │     └─ erro → failed, last_error sanitizado — e o 201 continua valendo
  └─ 201 com o estado REAL da projeção, relido do banco
```

Falha da Microsoft **não** desfaz a reunião e não pede que ninguém a recrie: a
tela mostra "Falha ao criar o convite no Outlook/Teams" com a ação **Tentar
sincronizar novamente**, que reusa a mesma `idempotency_key` e por isso nunca
cria um segundo evento.

**Na edição, a sincronização também é automática — mas só depois de uma ação
explícita.** Nunca durante digitação: não há `onChange`, `onBlur` nem `useEffect`
chamando a API. O gatilho é o mesmo que o usuário já conhece — *Salvar
Alterações*, *Adicionar participante*, *Remover participante*.

O que decide se há chamada externa **não** é a rota, e sim o estado que a
transação deixou:

```
mutação → COMMIT → integração ficou `stale`? → sim: UMA tentativa de sync
                                             → não: nada sai para a Microsoft
```

`syncCalendarAfterMutationIfNeeded(meetingId, actor)` lê a integração e só age em
`stale`. Como `stale` só nasce de `CAMPOS_QUE_DESATUALIZAM` e da lista de
participantes, mutação interna (FUP, Anotações, Ata, pauta, status,
`pendingRequirements`) continua sem tocar no Outlook. **O payload do convite não
foi ampliado** para justificar sincronização.

| Estado da integração | Próxima mutação projetada |
|---|---|
| `stale` | uma tentativa automática |
| `synced` | nada a reprojetar |
| `pending` | a criação já tentou; não se insiste sozinho |
| `failed` | fica no botão de tentar de novo — reenviar a cada edição seria bater de novo em quem já respondeu que está fora |

`POST /meetings/:id/calendar-sync` deixou de ser etapa do fluxo normal e passou a
ser **recuperação**: aparece para `failed` e `stale`, some quando está `synced`, e
só para quem tem `PGCP.Assessoria`.

Falha da Microsoft **nunca** vira erro HTTP da mutação: o PostgreSQL gravou, logo
a edição aconteceu. O corpo da resposta é relido depois da tentativa, então a
tela recebe o estado final da projeção sem precisar de um GET extra.

### Outlook — participantes sem endereço

Origem do endereço: `users.email` para quem tem conta; `mail` (ou UPN utilizável)
capturado no momento da escolha no diretório; e-mail digitado para externo.
**Nunca derivado do nome.**

Faltando endereço para alguém, a sincronização é **bloqueada** e a tela lista
nominalmente quem precisa ser corrigido. Convite parcial em silêncio faria a tela
afirmar que todos foram convidados quando alguém ficou de fora.

`meeting_participants.email` continua anulável: a reunião existe sem endereço; o
que não acontece sem ele é o convite.

### Outlook — timezone (a validar no smoke test)

O PGCP guarda IANA (`America/Sao_Paulo`) e envia esse identificador em
`dateTimeTimeZone.timeZone`, com a hora **local** do fuso em `dateTime`.

O mapper recusa antes de chamar o Graph aquilo que o próprio runtime não
reconhece como fuso. **Isso não é garantia de aceitação pelo Graph**: o
`Intl.DateTimeFormat` valida o identificador do lado do Node, e o serviço do
outro lado tem sua própria lista de fusos suportados. Os dois conjuntos não são
o mesmo.

Validar explicitamente `America/Sao_Paulo` no primeiro smoke test. **Nenhum mapa
IANA → Windows foi criado antecipadamente**; se o Graph recusar, parar e reportar
antes de implementar conversão.

### Outlook — Teams no MESMO evento

Reunião online é propriedade do evento de calendário, não um objeto paralelo:

| Campo Graph (`/me/events`) | Papel |
|---|---|
| `isOnlineMeeting: true` | pede reunião online ao criar o evento |
| `onlineMeetingProvider: "teamsForBusiness"` | fornecedor |
| `onlineMeeting.joinUrl` | link devolvido pelo Graph |

A escolha fica em `meetings.online_meeting_provider` (014) e o link devolvido em
`meeting_calendar_integrations.join_url` — **não** em `meetings.meeting_link`,
que continua sendo o link digitado à mão para salas de terceiros. São duas
origens diferentes e sobrepô-las apagaria uma delas.

`OnlineMeetings.ReadWrite` **não** é necessária: pelo evento, `Calendars.ReadWrite`
basta. `/communications/onlineMeetings` criaria um recurso independente do
calendário — não é o que este produto quer.

#### Toda reunião do PGCP é um evento do Outlook com Teams

Não é opção, preferência nem configuração. É a definição:

```
reunião PGCP  →  1 evento no Outlook
                 └─ o MESMO evento com isOnlineMeeting = true
                    e onlineMeetingProvider = teamsForBusiness
                    └─ joinUrl persistido em meeting_calendar_integrations
```

| Papel | Quem |
|---|---|
| Fonte de verdade | **PGCP** — pauta, quórum, execução, Ata, assinatura |
| Calendário e convite | **Outlook** — o evento é projeção da reunião |
| Reunião online | **Teams**, dentro desse mesmo evento |

Quem decide é o servidor: `online_meeting_provider` **não** vem do corpo da
requisição. Um cliente antigo, um script ou um `curl` criam reunião com Teams do
mesmo jeito — não existe reunião do PGCP sem Teams para se pedir. A tela também
não oferece a escolha; o modal apenas informa que convite e reunião online são
criados automaticamente.

**Reuniões legadas** (criadas antes desta regra) continuam sem
`online_meeting_provider` e são exibidas como legadas. Não há backfill: alterar
o calendário de terceiros sem ninguém pedir seria pior do que o registro
honesto de que aquela reunião nasceu antes.

#### O provider não é removido nem trocado

Toda reunião nova nasce com `teamsForBusiness`, **definido pelo backend na
criação** — não vem do corpo da requisição e não há tela que o escolha. Não
existe, portanto, decisão do usuário a preservar: existe uma regra do produto.

Duas barreiras somadas garantem isso:

| Onde | Regra |
|---|---|
| **Contrato** | `PATCH /meetings/:id` aceita `"teamsForBusiness"` e recusa `null`, `""` e qualquer outro fornecedor |
| **Microsoft** | depois que o Graph provisiona a reunião online, ela não volta a ser offline nem troca de fornecedor |

O motivo é comportamento determinístico e *retry* seguro: entre a criação no
PostgreSQL e a sincronização existe uma janela em que o Graph pode ter falhado —
ou ter criado o evento sem que a resposta voltasse. Se o provider pudesse sumir
nessa janela, haveria duas verdades sobre a mesma reunião e "tentar de novo"
viraria aposta sobre qual delas vale. Sem essa possibilidade, o caminho diante
de um erro é sempre o mesmo: **corrigir a causa e sincronizar de novo**.

O gatilho `meetings_freeze_online_provider` (014) barra a mudança quando já há
`join_url`. A regra de produto é mais forte que o gatilho e vive no contrato:
`PATCH /meetings/:id` aceita `onlineMeetingProvider: "teamsForBusiness"` e
**recusa** `null`, `""` e qualquer outro fornecedor. Não existe rota, botão ou
caixa de seleção que desligue Teams.

Para uma reunião sem Teams, o caminho é outra reunião.

Na tela, a consequência é direta: a opção só é editável **antes** de existir;
depois vira estado. `MeetingDetailView` mostra `Microsoft Teams` com
`Aguardando sincronização com Outlook`, `Falha na sincronização` (com a ação de
sincronizar de novo que já existia) ou o botão **Ingressar na reunião**, quando o
`joinUrl` chegou. Falha nunca sugere desativar Teams como conserto.

**Nunca** criar um evento no Outlook e uma reunião Teams separada para a mesma
reunião do PGCP.

### Fronteira: logística da reunião × obrigação de governança

Uma linha decide quem fala com quem, e existe para não haver duas mensagens
sobre o mesmo fato:

| Responsável | Assunto | Exemplos |
|---|---|---|
| **Exchange / Outlook** | logística do compromisso | reunião criada, horário ou local alterados, participante incluído ou removido, lembrete de início, link do Teams |
| **PGCP** | obrigação de governança | FUP atribuído, FUP vencendo, FUP vencido |

O PGCP **não** repete nada da coluna de cima. Convite, atualização e lembrete de
reunião já saem do Exchange para a caixa de cada participante; mandar de novo
faria a mesma reunião chegar duas vezes, com dois textos que podem divergir.

**Hoje (5.4b), a única obrigação notificada é o FUP — e apenas dentro do
aplicativo.** "Minhas Pendências", na Visão Geral, lista os FUPs abertos do
usuário autenticado, agrupados em *vencidos*, *vencem em até 3 dias* e *demais*.
A lista vem de `GET /action-items?assignedToMe=true&status=open`: quem decide o
que é "meu" é o servidor, comparando `assigned_user_id` ou o par
(tenant, oid) do token — nunca nome, e-mail ou rótulo. Atraso continua derivado
de `due_date`; nada disso é persistido.

Sem canal, sem tabela de notificação, sem serviço, sem agendador.

#### Roadmap — registrado, não implementado

| Item | O que seria | Depende de |
|---|---|---|
| E-mail do PGCP | aviso imediato de FUP atribuído e de outras obrigações acionáveis | `Mail.Send`, caixa remetente definida, endereço de quem não tem conta PGCP |
| Resumo diário | UM e-mail por pessoa por dia com FUPs vencendo e vencidos — nunca um por item | gatilho temporal, que não existe na API request-driven de hoje |
| Teams proativo | mensagem/cartão no Teams | integração SEPARADA da reunião: permissões de chat/canal caem em *protected APIs* e exigem outro modelo técnico. Decisão futura |

Convite, lembrete e link de **assinatura** ficam fora desta lista por decisão
anterior: quando o DocuSign entrar, quem convida o signatário é o DocuSign; o
PGCP envia documento e signatários e depois acompanha status e evidência.

### Outlook — convite ≠ e-mail

O convite de calendário tem mecanismo próprio de *attendees* e notificação: o
Graph envia ao criar o evento. **Não** disparar `Mail.Send` para repetir o
convite. Mail fica para notificação funcional que exija mensagem separada
(cobrança de FUP, aviso de Ata liberada), quando houver requisito.

### DocuSign — decisão funcional

A assinatura **não acontece dentro do PGCP**. Papéis:

```
PGCP                                    DocuSign
────────────────────────────────────    ──────────────────────────────
usuário autorizado escolhe signatários
prepara processo (revisão + snapshot)
envia documento + signatários  ───────> cria envelope
                                        envia e-mail aos signatários
                                        pessoa assina no ambiente DocuSign
acompanha status               <─────── webhook / consulta
registra evidência
```

Nenhuma escolha automática de signatário: não existe no produto conceito que
determine quem assina (`role_in_meeting` é texto livre; `governance_bodies` não
tem quadro de membros). A seleção é explícita, na tela da Ata, e aceita usuário
PGCP, pessoa do Entra sem conta e externo por e-mail.

O convite de assinatura é responsabilidade do DocuSign. O PGCP **não** duplica
esse e-mail com `Mail.Send`.

Ligação com o domínio já existente (migrations 009/010):

| Campo | Preenchimento futuro |
|---|---|
| `meeting_minute_signature_processes.provider` | `docusign` |
| `meeting_minute_signature_processes.provider_reference` | `envelopeId` |
| `meeting_minute_signers.provider_reference` | `recipientId` |

Ambos são *set-once* e recusados em processo terminal. `content_snapshot`,
`content_hash` e o congelamento do roster continuam sendo a evidência de **qual
revisão** foi enviada.

Estados de domínio (`prepared`, `in_progress`, `completed`, `cancelled`,
`failed`) permanecem provider-agnostic. Status específicos do DocuSign (`sent`,
`delivered`, `voided`) não entram em `status`; se precisarem ser guardados, terão
coluna própria.

**Webhook**: o retorno assíncrono (assinou, recusou, envelope concluído,
cancelado) atualizará `meeting_minute_signers.status`/`signed_at` e, quando todos
os obrigatórios assinarem, `processo → completed` e `Ata → approved` na mesma
transação. A futura implementação deve **validar a origem** dos eventos antes de
alterar qualquer estado.

**Nunca** persistir nas tabelas de domínio: secret, access token, refresh token,
payload completo do fornecedor.

### DocuSign — bloqueio

Não há credenciais disponíveis (`DOCUSIGN_CLIENT_ID`, `DOCUSIGN_CLIENT_SECRET`,
`DOCUSIGN_ACCOUNT_ID`). O painel reporta `not_configured` e lista o que falta.

A sonda atual mede apenas alcançabilidade do host de OAuth e **não** valida
conta nem credencial — a distinção entre *serviço acessível* e *integração
autenticada e operacional* está explícita na própria mensagem. Não marcar como
conectado por alcance de URL.

### Autorização — dívida que atravessa a Fase 5

Autenticação ≠ autorização. Estas operações exigirão autorização funcional
(RBAC) antes de produção, e **nenhuma** delas pode ser autorizada por
`job_title`, nome, e-mail ou regra hardcoded:

- sincronizar reunião com o Outlook
- reenviar/reprocessar sincronização
- cancelar convite
- selecionar signatários
- preparar assinatura
- cancelar processo de assinatura
- enviar ao DocuSign

### Auditoria das integrações

Eventos factuais a registrar **quando as ações existirem**: `Evento Outlook
criado`, `Evento Outlook atualizado`, `Sincronização Outlook falhou`, `Processo
enviado para assinatura`, `Processo de assinatura cancelado`, `Ata aprovada`.

Nunca registrar: access token, refresh token, client secret, conteúdo da Ata,
snapshot, payload do Graph, payload do DocuSign.

---

## App Registration — permissões

Princípio de menor privilégio: pedir na etapa em que a funcionalidade entra.

| Permissão | App Registration | Tipo | Admin consent | Etapa | Motivo |
| --- | --- | --- | --- | --- | --- |
| `openid`, `profile`, `offline_access` | Web (SPA) | Delegated | não | 2 | login OIDC e refresh token |
| `access_as_user` (da PGCP API) | Web (SPA) | Delegated | não | 2 | único token que o browser adquire |
| `User.Read.All` | API | **Application** | **sim** | 3 | sync de diretório sem sessão: nome, e-mail, UPN, cargo **e foto** |
| `User.Read` | API | Delegated | não | 3 | perfil do próprio usuário via OBO |
| `Application Calendars.ReadWrite` | — **Exchange Online RBAC**, não o App Registration | Application | n/a — atribuição no Exchange | 5 | criar/editar o evento na caixa do organizador, sem depender da sessão dele, com Resource Scope limitando as caixas |
| `OnlineMeetings.ReadWrite` | API | Delegated (OBO) | não | 5 | criar reunião Teams e obter join URL |
| `Mail.Send` | API | **Delegated (OBO)** | admin consent | **5.5 — ✅ concedida** | enviar as pautas para validação (PDF) pela caixa do próprio usuário. A versão **Application** NÃO é usada |
| `Chat.Create` + `ChatMessage.Send` | API | **Delegated (OBO)** | **concedido** | **implementado** | mensagem manual e chamada automática 1:1 aos participantes da pauta, enviadas como o usuário autenticado |

**Não** solicitar `ProfilePhoto.Read.All` enquanto `User.Read.All` estiver em uso:
`User.Read.All` já cobre a foto, e manter as duas seria privilégio redundante.

`User.ReadBasic.All` foi descartado: em contexto de **aplicação** não concede
foto, o que obrigaria a somar `ProfilePhoto.Read.All` — dois grants em vez de um.

Mensagens do Teams por permissão de **aplicação** caem em *protected APIs* e
exigem aprovação da Microsoft; delegado via OBO não. Somado ao fato de que criar
evento em nome do organizador é semanticamente correto, Application fica restrito
ao sync de diretório, o único fluxo genuinamente sem usuário na sessão.

Nada relacionado a transcrição ou gravação: **o PGCP não terá transcrição.**

---

## Auditoria funcional × observabilidade técnica

Conceitos distintos, destinos distintos.

| | Auditoria funcional | Observabilidade técnica |
| --- | --- | --- |
| Onde | PostgreSQL, `audit_logs` | Application Insights |
| Registra | criou reunião, postergou pauta, liberou Ata, concluiu FUP | exception, latência, falha de dependência, correlação |
| Público | governança, compliance | engenharia |
| Retenção | regra de negócio | regra técnica |

Não misturar. Erro de API não é evento de governança; aprovação de Ata não é
métrica de latência.

---

## Autenticação da API (Etapa 2 — **validada em produção local**)

Primeiro login corporativo real aceito em **17/08/2026**. O painel só declara
`connected` depois que um access token é efetivamente validado — ver
*Ponte de redirect* e *`requestedAccessTokenVersion`* acima para os dois defeitos
encontrados no caminho.


`GET /me` exige `Authorization: Bearer <access token>`. Verificações, em ordem:

| # | Verificação | Valor esperado | Falha |
| --- | --- | --- | --- |
| 1 | Formato do header | `Bearer <jwt>` | 401 |
| 2 | Configuração presente | `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_SPA_CLIENT_ID` | 503 |
| 3 | Assinatura (JWKS do tenant) | RS256 | 401 |
| 4 | `iss` | `https://login.microsoftonline.com/{tenant}/v2.0` | 401 |
| 5 | `exp` / `nbf` | válidos, tolerância 60s | 401 |
| 6 | `aud` | `ENTRA_API_CLIENT_ID` — **nunca** o Application ID URI | 401 |
| 7 | `tid` | `ENTRA_TENANT_ID` | 401 |
| 8 | `oid` | presente | 401 |
| 9 | `azp` | `ENTRA_SPA_CLIENT_ID` | **403** |
| 10 | `scp` | contém `ENTRA_API_SCOPE_NAME` | **403** |

403 significa autenticado mas não autorizado; 401, credencial inválida.

Token do Microsoft Graph é rejeitado no passo 6: seu `aud` é
`https://graph.microsoft.com` ou `00000003-0000-0000-c000-000000000000`.

**Identidade é `tid` + `oid`.** `email`, `preferred_username` e `upn` são
atributos mutáveis; `sub` é *pairwise* (muda entre aplicações). Nenhum dos
quatro é usado para identificar ou autorizar.

JWKS via `jose`/`createRemoteJWKSet`: cache de 24h, refetch em `kid`
desconhecido (rotação) e *cooldown* de 30s para que token forjado com `kid`
aleatório não vire vetor de DoS.

`/health` é público. `/integrations` segue público **temporariamente** — o
frontend ainda não adquire token; passa a exigir autenticação na Etapa 2.5.

## O que ainda não está implementado

### Provisionamento (JIT) — Etapa 2.4

Quem autoriza o acesso é o **Entra**: *Aplicativos Empresariais → PGCP Web →
Atribuição necessária = **Sim***, com os usuários/grupos autorizados atribuídos
lá. Uma identidade que chega à API com token válido já passou por esse filtro.

Por isso `GET /me` provisiona na primeira entrada, em vez de recusar:

| Situação | Resultado |
| --- | --- |
| encontrado + ativo | **200** |
| encontrado + inativo | **403 `user_inactive`** — JIT **nunca** reativa |
| não encontrado | provisiona → **200** |
| sem e-mail utilizável | **422 `user_email_unavailable`** |

Busca e criação usam exclusivamente `(entra_tenant_id, entra_object_id)`.

**Idempotência:** `INSERT … ON CONFLICT (entra_tenant_id, entra_object_id)
WHERE … DO NOTHING RETURNING`, seguido de re-leitura quando não há retorno. O
`ON CONFLICT` repete o predicado porque o índice único é **parcial**. É
`DO NOTHING` — não `DO UPDATE` — porque JIT é provisionamento inicial, não
sincronização: um login não sobrescreve nome ou e-mail já gravados.

**Grava apenas:** `name`, `email`, `upn`, `user_type='internal'`,
`is_active=true` e o par Entra. **Não** grava `job_title`, `synced_at` nem foto —
isso vem do Graph na Etapa 3.

**Nenhum privilégio é concedido**, porque o modelo não tem papel funcional
global: `users` não possui coluna de papel, e as únicas colunas "role" são
`audit_logs.actor_role` (descritiva) e `meeting_participants.role_in_meeting`
(papel dentro de uma reunião). Quando houver RBAC, revisar o provisionamento.

O `POST /me/bootstrap` de desenvolvimento foi **removido**: cumpriu a função de
criar o primeiro usuário e o JIT o substitui integralmente. Não existe segundo
caminho de provisionamento.
- **Provisionamento JIT** (2.4). Quando existir: identidade é `tid` + `oid`;
  `email` é preferencial; `preferred_username` só pode preencher `users.email` se
  for um endereço realmente utilizável — caso contrário o provisionamento deve
  **falhar de forma explícita**, nunca inventar um endereço.
- **Diretório real.** Concluído para busca sob demanda: `cielo_synced_users` e o
  tipo `EntraUser` foram removidos, e toda escolha de pessoa passa pelo
  `DirectoryUserPicker` → `GET /directory/users` → Microsoft Graph. O que falta é
  **persistir**: `authorEntraObjectId` e `Participant.entraObjectId` só existem
  no estado do navegador. Fotos continuam fora do escopo.
- **Reuniões no banco.** `meetings` e quase todo o resto vivem em `localStorage`.
  Apenas `governance_bodies` usa API + PostgreSQL.
- **Teams — mensagem e chamada por pauta.** "Mensagem" e "Chamar" na aba
  Anotações usam a API PGCP, OBO e Graph delegado para chats 1:1; destinatários
  vêm da relação persistida da pauta e o retorno suporta sucesso parcial. Em
  "Chamar", texto, cronograma e link são resolvidos no backend. Validado por
  testes automatizados e manualmente em contas Teams corporativas reais; a
  mensagem manual, a chamada, o hyperlink e a apresentação HTML foram confirmados.
- **DocuSign.** Catálogo e painel prontos; falta escolher o grant (JWT Grant é o
  candidato) e o cliente eSignature. Não ligado à Ata.
- **Observabilidade.** Falta o exportador OpenTelemetry na API. Sem ele nada é
  enviado, mesmo com a connection string preenchida.

---

## Como testar localmente

```bash
npm run db:up          # PostgreSQL em :5434
npm run db:migrate     # aplica as migrations
npm run dev:api        # API em :3333
npm run dev            # frontend em :3000
```

Verificação rápida:

```bash
curl -s http://localhost:3333/health
curl -s http://localhost:3333/integrations
curl -s -X POST http://localhost:3333/integrations/postgres/test
```

No painel: `Configurações → Integrações → PostgreSQL → Testar conexão`.
As demais integrações devem aparecer como **Não configurado** até que as
variáveis correspondentes sejam preenchidas em `apps/api/.env`.
