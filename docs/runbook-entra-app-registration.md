# Runbook — Microsoft Entra ID e App Registrations do PGCP

Como configurar a identidade do PGCP em um tenant corporativo **do zero**, sem
precisar reconstruir as decisões que chegamos até aqui.

Público: quem administra o Microsoft Entra ID e o Microsoft 365 da organização.

> **Nenhum valor deste ambiente aparece aqui.** Onde houver `<PLACEHOLDER>`,
> substitua pelo valor do SEU tenant. Não versione secrets, GUIDs, e-mails,
> tokens ou domínios reais neste arquivo.

Placeholders usados:

```text
<TENANT-ID>            Directory (tenant) ID
<SPA-CLIENT-ID>        Application (client) ID do PGCP Web
<API-CLIENT-ID>        Application (client) ID da PGCP API
<API-CLIENT-SECRET>    segredo do cliente confidencial (só no servidor)
<API-SP-OBJECT-ID>     Object ID do SERVICE PRINCIPAL da PGCP API
<REDIRECT-URI>         URL de retorno do SPA
<API-APP-ID-URI>       Application ID URI da PGCP API
```

Documentos relacionados:

- [`runbook-exchange-calendar.md`](runbook-exchange-calendar.md) — autorização de
  calendário no Exchange Online (obrigatório para criar eventos)
- [`integracoes.md`](integracoes.md) — arquitetura das integrações e política de
  autorização dentro do produto

---

## PARTE A — Arquitetura de identidade

### 1. São DOIS aplicativos, não um

Confundir os dois é a origem da maioria dos erros de configuração.

#### PGCP Web

| | |
|---|---|
| Tipo | **SPA / public client** |
| Responsabilidade | autenticação interativa da pessoa, no navegador |
| Client secret | **não tem, e não pode ter** — código que roda no navegador não guarda segredo |
| Solicita token para | `<API-APP-ID-URI>/access_as_user` |
| Permissões do Graph | **nenhuma de aplicação** |

O SPA nunca chama o Microsoft Graph com credencial de aplicação. Ele obtém um
token **para a PGCP API** e nada mais.

#### PGCP API

| | |
|---|---|
| Tipo | **API / confidential client** |
| Responsabilidade | validar o token da pessoa, executar o backend, falar com o Graph quando necessário |
| Credencial | `<API-CLIENT-SECRET>` (ou, no futuro, certificado / identidade gerenciada) |
| Onde vive a credencial | **somente no servidor**, em variável de ambiente |

> O segredo da API **nunca** vai para o frontend, para o repositório, para um
> log ou para uma resposta HTTP. O painel de Integrações do PGCP mostra apenas
> `configurado: sim/não` para variáveis marcadas como secretas.

### 2. Fluxo resumido

```text
navegador
   │  login interativo (MSAL, PKCE)
   ▼
PGCP Web  ──solicita access_as_user──▶  Entra ID
   │
   │  access token destinado à PGCP API
   ▼
PGCP API  ──valida assinatura, iss, aud, exp/nbf, tid, oid, azp, scp──▶ segue
```

E, quando o backend precisa do Microsoft 365:

```text
PGCP API ──On-Behalf-Of (token da pessoa)──▶ Graph   recursos DELEGADOS
                                                     ex.: o próprio calendário

PGCP API ──client credentials (app-only)───▶ Graph   recursos de APLICAÇÃO
                                                     ex.: diretório, calendário
                                                     de mailbox autorizada
```

**O navegador nunca recebe token app-only.** Quem detém a credencial de
aplicação é o servidor; o navegador só carrega o token da própria pessoa.

---

## PARTE B — Expor uma API

### 3. Scope `access_as_user`

No App Registration **PGCP API**:

1. **Expor uma API** → definir o *Application ID URI* (`<API-APP-ID-URI>`).
2. **Adicionar um escopo**:

| Campo | Valor |
|---|---|
| Nome do escopo | `access_as_user` |
| Quem pode consentir | administradores e usuários (ou só admin, conforme a política do tenant) |
| Nome de exibição | `Acessar o PGCP como usuário` |
| Estado | Habilitado |

3. Em **Aplicativos cliente autorizados**, autorizar `<SPA-CLIENT-ID>` para esse
   escopo — assim o PGCP Web pede o token sem tela extra de consentimento.

No App Registration **PGCP Web**, adicionar a permissão delegada
`<API-APP-ID-URI>/access_as_user`.

### 4. O que o backend valida no token

Não é decoração: a API recusa o token que falhar em qualquer um destes pontos.

| Verificação | Por quê |
|---|---|
| **assinatura** (JWKS do tenant) | prova que o Entra emitiu |
| **`iss`** | emissor esperado do tenant |
| **`aud`** | o token foi emitido **para a PGCP API**, não para outra aplicação |
| **`exp` / `nbf`** | validade temporal |
| **`tid`** | tenant esperado |
| **`oid`** | identidade estável da pessoa — **é o que identifica quem é** |
| **`azp`** | qual aplicação cliente pediu o token |
| **`scp`** | contém `access_as_user` |

**Identidade é `tid` + `oid`.** Nunca `email`, `preferred_username` ou `upn` —
esses são atributos de exibição, podem mudar e podem ser reciclados.

#### `requestedAccessTokenVersion` = 2

No **manifesto da PGCP API**, `requestedAccessTokenVersion` precisa valer `2`.
Com `null` (padrão), o Entra emite token v1, cujo `aud` e cujo formato de claims
não correspondem ao que a API valida — o sintoma é 401 constante com token que
"parece certo".

---

## PARTE C — App Roles

### 5. As duas App Roles do PGCP

Ambas são declaradas no App Registration da **PGCP API** (nunca no SPA).

#### Role 1 — Assessoria do PGCP

| Campo | Valor |
|---|---|
| Nome de exibição | `Assessoria do PGCP` |
| Value | `PGCP.Assessoria` |
| Tipos de membro permitidos | Usuários/Grupos |
| Descrição | Cria, agenda, administra e conduz reuniões; mantém os cadastros funcionais |
| Estado | Habilitado |

Autoriza: criar reunião · editar cabeçalho · participantes · pautas · conduzir
(iniciar, concluir, postergar, retomar) · Anotações · Ata e saneamento · alterar
FUP de terceiro · sincronizar Outlook/Teams · manter órgãos de governança, tipos
e naturezas de pauta.

**Não autoriza administração técnica**: usuários do PGCP, integrações, auditoria
e configurações continuam exclusivos de `PGCP.Admin`.

> *Histórico: até a 5.4l a role funcional chamava-se `Meeting.Scheduler`. Foi
> substituída por `PGCP.Assessoria` e descontinuada — não existe mais no código.
> Se o seu tenant ainda a tiver declarada, remova-a do manifesto e das
> atribuições.*

#### Role 2 — Administrador do PGCP

| Campo | Valor |
|---|---|
| Nome de exibição | `Administrador do PGCP` |
| Value | `PGCP.Admin` |
| Tipos de membro permitidos | Usuários/Grupos |
| Descrição | Administra a plataforma: usuários, órgãos, integrações e auditoria |
| Estado | Habilitado |

Destinada a: usuários do PGCP · órgãos de governança · integrações · auditoria ·
configurações administrativas.

> **Estado no produto:** implementada. Os cadastros funcionais (órgãos, tipos e
> naturezas de pauta) aceitam **`PGCP.Assessoria` OU `PGCP.Admin`**. As rotas
> **exclusivas** de `PGCP.Admin` são:
>
> ```text
> GET    /users                          (usuários do PGCP; NÃO é o diretório)
> GET    /integrations
> GET    /integrations/:id/status
> POST   /integrations/:id/test
> GET    /audit-logs
> ```
>
> E, com `PGCP.Assessoria` **ou** `PGCP.Admin`:
>
> ```text
> POST   /governance-bodies
> PUT    /governance-bodies/:id          (inclui desativar via isActive)
> POST   /agenda-topics/taxonomy/:kind
> PATCH  /agenda-topics/taxonomy/:kind/:id
> DELETE /agenda-topics/taxonomy/:kind/:id
> ```
>
> Continuam abertos a qualquer usuário PGCP ativo: `GET /governance-bodies`,
> `GET /agenda-topics/taxonomy/:kind`, `GET /directory/users` e toda a leitura
> corporativa de reuniões.

#### Sem App Role

Quem entra sem nenhuma das duas continua sendo usuário do PGCP: lê o conteúdo
corporativo — reuniões, pautas, Anotações, Ata — e cuida dos próprios FUPs. É
esse perfil que servirá de base para a futura experiência pública; nada precisa
ser atribuído no Entra para ele.

#### As duas são INDEPENDENTES

```text
PGCP.Admin       ⇏  PGCP.Assessoria
PGCP.Assessoria  ⇏  PGCP.Admin
```

Não há hierarquia. Uma pessoa pode ter **nenhuma**, **só uma** ou **as duas** —
quem administra a plataforma e quem conduz as reuniões costumam ser pessoas
diferentes, e o modelo respeita isso. Quem precisa das duas coisas recebe as
duas atribuições no Entra.

### 6. Como atribuir uma App Role

```text
Microsoft Entra ID
  → Aplicativos empresariais
  → PGCP API
  → Usuários e grupos
  → Adicionar usuário/grupo
  → Selecionar a FUNÇÃO
```

> ### ⚠ Armadilha: `Default Access`
>
> Ao adicionar a pessoa ou o grupo, **selecione explicitamente a função**
> (`Assessoria do PGCP` ou `Administrador do PGCP`). Se o campo de função
> ficar como **`Default Access`**, a atribuição é criada, aparece na lista e
> **não** coloca nada no claim `roles` — o PGCP continuará recusando a operação.
>
> Isto **já aconteceu** durante a homologação: o botão "Nova Reunião" não
> aparecia, a atribuição existia, e o motivo era exatamente esse.
>
> Como conferir: na lista de *Usuários e grupos*, a coluna **Função** precisa
> mostrar o nome da role — nunca "Default Access".

Recomendação: atribuir a **grupos** corporativos (ex.: o grupo da assessoria),
não a pessoas uma a uma. O código do PGCP **nunca** conhece o nome nem o GUID
do grupo — ele lê apenas o claim `roles`.

### 7. Efeito no token

Depois da atribuição, um novo login produz um token com:

```json
{
  "roles": [
    "PGCP.Assessoria",
    "PGCP.Admin"
  ]
}
```

conforme as funções realmente atribuídas — uma, outra, as duas, ou o claim
ausente.

O PGCP lê esse claim **no servidor**. E:

- App Roles **não são persistidas** na tabela `users`;
- a fonte de verdade é o **token assinado pelo Entra**;
- o frontend não decodifica token para decidir permissão — ele consulta `GET /me`,
  que devolve as roles válidas daquele token.

> **Depois de atribuir ou remover uma role: sair do PGCP e entrar novamente.**
> O claim vem do token; o token em uso continua com o conteúdo antigo até
> expirar.

---

## PARTE D — Microsoft Graph

### 8. Matriz das permissões realmente necessárias

Conferida contra o código, não contra a intenção:

| Permissão | Tipo | Onde | Uso |
|---|---|---|---|
| `<API-APP-ID-URI>/access_as_user` | Delegada | **PGCP Web** | obter token para a PGCP API |
| `Calendars.Read` | **Delegada** | **PGCP API** | a pessoa vê o próprio calendário do Outlook, via On-Behalf-Of |
| `User.Read.All` | **Aplicação** | **PGCP API** | busca no diretório corporativo (app-only) |

Só isso. Qualquer outra permissão listada abaixo, em "o que NÃO conceder", está
fora de propósito.

### 9. Calendário próprio — `Calendars.Read` delegada

```text
pessoa autenticada
   → PGCP API (token access_as_user)
   → On-Behalf-Of
   → Graph GET /me/calendarView
```

Alimenta o calendário da **Visão Geral**. Consequências do desenho:

- é **`Calendars.Read`**, não `ReadWrite`: quem só visualiza não precisa escrever;
- a leitura acontece **com a identidade da própria pessoa** — ninguém vê o
  calendário de outra pessoa por este caminho;
- **eventos pessoais do Outlook NÃO são persistidos no PostgreSQL.** A agenda é
  lida na hora e exibida; o PGCP não mantém cópia.

Exige **admin consent** da permissão delegada no tenant (ou consentimento da
pessoa, conforme a política).

### 10. Diretório — `User.Read.All` de aplicação

```text
PGCP API ──app-only──▶ Graph GET /users?$search=...&$select=...&$count=true
                       (cabeçalho ConsistencyLevel: eventual)
```

Usado para escolher: **organizador** · **participante** · **responsável por
pauta** · **responsável por FUP**.

Regras que o código já garante:

- a filtragem acontece **no Graph** — nada de baixar o diretório e filtrar em
  memória;
- termo de busca obrigatório, com mínimo de caracteres, teto de resultados e
  paginação limitada — **não existe consulta que devolva o diretório inteiro**;
- a identidade final gravada é **`tid` + `oid`**, nunca o e-mail. E-mail é
  snapshot de exibição.

Exige **admin consent** (permissão de aplicação).

---

## PARTE E — O que NÃO conceder no Entra

### 11. ⚠ Regra crítica do calendário

> ### NÃO conceda `Calendars.ReadWrite` **Application** tenant-wide no App Registration
>
> Essa permissão daria à aplicação acesso de escrita a **todas as caixas de
> correio do tenant**. O PGCP **não** precisa disso e o desenho evita isso de
> propósito.

O PGCP obtém `Application Calendars.ReadWrite` por outro caminho:

```text
Exchange Online RBAC for Applications
   + Resource Scope
   → limita QUAIS mailboxes podem ser organizadoras
```

As duas concessões são **aditivas e diferentes**: a do Entra é ampla e
irrestrita; a do Exchange é restrita a um escopo de mailboxes. Queremos a
segunda.

Detalhes operacionais (PowerShell, criação do Resource Scope, testes
`InScope`): **[`runbook-exchange-calendar.md`](runbook-exchange-calendar.md)**.
Este runbook não repete aquele conteúdo.

### 12. Teams — `OnlineMeetings.ReadWrite` **não** é necessária

O PGCP cria a reunião do Teams **dentro do próprio evento do Outlook**:

```json
{ "isOnlineMeeting": true, "onlineMeetingProvider": "teamsForBusiness" }
```

e recebe de volta `onlineMeeting.joinUrl`. **Não existe uma segunda API de
criação de reunião Teams no produto** — `/communications/onlineMeetings` criaria
um recurso independente do calendário, que não é o que queremos.

Portanto: não conceder `OnlineMeetings.ReadWrite`.

### 13. `Mail.Send` — ainda não

Não está configurada, e não deve ser adicionada agora.

Motivo: **convite e atualização de reunião já saem pelo Outlook/Exchange**.
Mandar e-mail do PGCP para repetir isso faria a mesma reunião chegar duas vezes,
com dois textos que podem divergir.

`Mail.Send` só entra se houver necessidade real de notificação **própria** do
PGCP — obrigações de governança, como cobrança de FUP. Enquanto isso, essas
obrigações aparecem dentro do aplicativo, em *Minhas Pendências*.

### 14. DocuSign não é Microsoft

DocuSign **não pertence** ao App Registration do Entra. É integração futura,
separada, com credenciais próprias. **Não existe configuração real ainda** — não
procure por ela no Entra.

---

## PARTE F — Exchange Online

### 15. Calendário app-only para organizadores

Duas metades, em dois lugares:

```text
Entra ID
  → identifica o SERVICE PRINCIPAL da PGCP API  (<API-SP-OBJECT-ID>)

Exchange Online
  → Application Calendars.ReadWrite
  → atribuída ao service principal
  → COM Resource Scope
  → limita as mailboxes que podem ser ORGANIZADORAS
```

O Resource Scope limita **quem organiza**, não **quem é convidado**: qualquer
pessoa pode ser participante de um evento criado pelo PGCP, dentro ou fora do
escopo.

Homologação obrigatória — os dois testes:

| Teste | Resultado esperado |
|---|---|
| mailbox autorizada | `InScope = True` |
| mailbox de controle (fora do escopo) | `InScope = False` |

Um escopo que devolve `True` para tudo não é escopo. Procedimento completo:
[`runbook-exchange-calendar.md`](runbook-exchange-calendar.md).

---

## PARTE G — Implantação em novo ambiente

### 16. Checklist

Ordem importa: as roles precisam existir **antes** de o código passar a exigi-las.

```text
Aplicativos
[ ] criar/conferir o App Registration PGCP Web (SPA)
[ ] configurar o SPA redirect URI            → <REDIRECT-URI>
[ ] criar/conferir o App Registration PGCP API
[ ] confirmar requestedAccessTokenVersion = 2 no manifesto da API

API protegida
[ ] expor a API com o escopo access_as_user
[ ] autorizar PGCP Web (<SPA-CLIENT-ID>) a chamar a PGCP API
[ ] configurar a credencial de backend      → <API-CLIENT-SECRET>, só no servidor

Permissões do Graph
[ ] configurar Calendars.Read     (Delegada,  na PGCP API)
[ ] configurar User.Read.All      (Aplicação, na PGCP API)
[ ] conceder admin consent quando necessário

App Roles
[ ] criar a App Role PGCP.Assessoria ("Assessoria do PGCP")
[ ] criar a App Role PGCP.Admin      ("Administrador do PGCP")
[ ] atribuir PGCP.Assessoria ao grupo da assessoria/secretaria
[ ] atribuir PGCP.Admin aos administradores da plataforma
[ ] conferir que NENHUMA atribuição ficou como "Default Access"

O que NÃO deve existir
[ ] confirmar que Calendars.ReadWrite Application NÃO está no App Registration
[ ] confirmar que OnlineMeetings.ReadWrite NÃO foi concedida
[ ] confirmar que Mail.Send NÃO foi concedida

Exchange
[ ] executar o runbook-exchange-calendar.md
[ ] testar InScope = True  (mailbox autorizada)
[ ] testar InScope = False (mailbox de controle)

Validação ponta a ponta
[ ] testar login no PGCP
[ ] confirmar os claims de roles em GET /me (depois de novo login)
[ ] testar o calendário próprio na Visão Geral
[ ] testar criação de reunião: evento Outlook + Teams com joinUrl
```

### 17. Matriz "precisa / não precisa"

| Item | Necessário? | Tipo | Para quê | Observação |
|---|---|---|---|---|
| `access_as_user` | **SIM agora** | Escopo delegado (PGCP API) | o SPA obtém token para a API | autorizar o SPA como cliente conhecido |
| `PGCP.Assessoria` | **SIM agora** | App Role (PGCP API) | operar reuniões e manter cadastros funcionais | atribuir a grupo, nunca "Default Access" |
| `PGCP.Admin` | **SIM agora** | App Role (PGCP API) | administrar a plataforma | implementada; sem ela, as áreas administrativas não aparecem |
| `Calendars.Read` | **SIM agora** | Delegada (PGCP API) | calendário próprio via OBO | não é `ReadWrite` |
| `User.Read.All` | **SIM agora** | Aplicação (PGCP API) | busca no diretório | exige admin consent |
| `Calendars.ReadWrite` **Application no Entra** | **NÃO** | Aplicação | — | daria escrita em todas as mailboxes; usar Exchange RBAC |
| `Application Calendars.ReadWrite` **no Exchange** | **SIM agora** | Exchange RBAC + Resource Scope | criar/alterar evento nas mailboxes autorizadas | ver runbook do Exchange |
| `OnlineMeetings.ReadWrite` | **NÃO** | Aplicação/Delegada | — | Teams nasce dentro do próprio evento |
| `Mail.Send` | **FUTURO** | Aplicação | notificações próprias do PGCP | só se houver requisito real |
| Client secret **no SPA** | **NÃO** | — | — | público não guarda segredo, jamais |
| Client secret **na API** | **SIM agora** | Credencial confidencial | OBO e app-only | só no servidor; rotacionar conforme a política |

---

## 18. Sintomas e causas frequentes

| Sintoma | Causa provável |
|---|---|
| 401 constante, token "parece válido" | `requestedAccessTokenVersion` diferente de `2`, ou `aud` de outra aplicação |
| Ação recusada mesmo com atribuição feita | atribuição ficou em **Default Access** |
| Assessoria recusada mesmo "tendo a role" | a conta tem uma role antiga, não `PGCP.Assessoria` |
| Role atribuída e o PGCP não vê | token antigo — sair e entrar de novo |
| `403 ErrorAccessDenied` ao criar evento | mailbox do organizador fora do Resource Scope (Exchange) |
| `403 Authorization_RequestDenied` no diretório | falta `User.Read.All` de aplicação ou o admin consent |
| Calendário próprio vazio ou com erro de consentimento | `Calendars.Read` delegada sem consentimento |
