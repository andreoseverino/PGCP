# PGCP — Plataforma Corporativa de Gestão de Pautas

Gestão de reuniões de órgãos colegiados: pautas, participantes, atas, follow-ups (FUP),
trilha de auditoria e cadastros administrativos.

> **A sigla oficial do projeto é `PGCP`.** O diretório no disco ainda se chama
> `PCGP - Plataforma de Governança Corporativa`, grafia anterior mantida porque
> renomear a pasta é operação de máquina, não de código — opcional e sem efeito
> no funcionamento.

## Continuidade / Handoff

**Se você está assumindo o desenvolvimento do PGCP, comece por
[`docs/HANDOFF-CORPORATIVO.md`](docs/HANDOFF-CORPORATIVO.md).**

Ele reúne, num documento só, o produto, a arquitetura, o banco, as migrations,
as permissões, as regras de negócio, o estado de cada integração, as decisões
que não devem ser revertidas e as lacunas conhecidas — sem depender do histórico
de quem construiu.

Este README fica com o essencial do dia a dia: visão geral, estrutura, execução
local e estado atual.

## Segurança e go-live

**Fonte de verdade sobre segurança e prontidão de produção:
[`docs/security.md`](docs/security.md).** Reúne, num documento só, a auditoria
realizada, as correções aplicadas, o hardening do PostgreSQL (4 papéis de menor
privilégio) e de produção (fail-fast, rate limiting, headers), a revisão de
Entra/RBAC/Graph/CORS, logs e secrets, os riscos residuais, o estado atual de
readiness e o **contexto para agentes futuros** (o que não deve ser desfeito).

Para a liberação em produção, a checklist operacional em ordem de execução está
em [`docs/go-live.md`](docs/go-live.md); o detalhe de configuração de borda
(CSP, WAF, Log Analytics) em [`docs/producao-hardening.md`](docs/producao-hardening.md).

> **Estado:** código pronto do ponto de vista das validações locais
> (auditoria, hardening, `npm audit` = 0, build/typecheck/testes verdes). O
> go-live final **não** deve ser declarado concluído até os itens externos de
> `docs/go-live.md` serem validados no ambiente corporativo real.

## Estrutura do repositório

```text
/
├── apps/
│   ├── web/                 # Frontend React + TypeScript + Vite
│   └── api/                 # Backend Node.js + Express + TypeScript
│
├── packages/
│   └── contracts/           # Reservado para contratos/tipos compartilhados (vazio)
│
├── docs/                    # Documentação do projeto
├── infra/                   # PostgreSQL local (Docker) e provisionamento de papéis
├── scripts/                 # Scripts utilitários (pré-voo do Entra)
│
├── .gitignore
├── README.md
├── package.json             # Raiz do workspace (npm workspaces)
└── package-lock.json
```

O repositório usa **npm workspaces**. Os workspaces ativos são `apps/web` (`@pgcp/web`)
e `apps/api` (`@pgcp/api`). `packages/contracts` segue como pasta reservada e ainda
não possui `package.json` — hoje o contrato entre as camadas é declarado **duas
vezes**, na API e nos adaptadores do frontend. Ver
[packages/contracts/README.md](packages/contracts/README.md).

## Pré-requisitos

- Node.js 20+ (testado com Node 24)
- npm 10+
- Docker (apenas para subir o PostgreSQL de desenvolvimento local)

## Como executar

Todos os comandos rodam a partir da **raiz** do repositório:

```bash
# Instalar dependências (de todos os workspaces)
npm install
```

### Frontend — `apps/web`

```bash
npm run dev:web      # desenvolvimento em http://localhost:3000
npm run build:web    # build de produção -> apps/web/dist
npm run preview      # serve o build gerado
npm run lint:web     # checagem de tipos (tsc --noEmit)
```

`npm run dev` é um atalho para `npm run dev:web`.

### Banco de dados — PostgreSQL local

O PostgreSQL de desenvolvimento roda em container, com volume persistente:

```bash
npm run db:up        # sobe o PostgreSQL 17 em localhost:5434
npm run db:migrate   # aplica as migrations pendentes
npm run db:down      # para e remove o container (o volume é preservado)
npm run db:logs      # acompanha os logs do banco
```

Antes do primeiro `db:up`, crie o `.env` da API (o compose lê as credenciais dele):

```bash
cp apps/api/.env.example apps/api/.env   # e defina uma DB_PASSWORD
```

O Docker é apenas conveniência do ambiente local. A API depende só das variáveis
`DB_*` e funciona com qualquer PostgreSQL padrão. Definição em
[infra/docker-compose.yml](infra/docker-compose.yml).

O schema é criado por migrations SQL versionadas em
[apps/api/migrations/](apps/api/migrations/), aplicadas por `npm run db:migrate`.
Rodar o comando mais de uma vez é seguro: cada migration é aplicada uma única vez.
Modelo de dados documentado em [docs/modelo-de-dados.md](docs/modelo-de-dados.md).

### Backend — `apps/api`

```bash
npm run dev:api      # desenvolvimento com watch em http://localhost:3333
npm run build:api    # compila TypeScript -> apps/api/dist
npm run start:api    # executa o build compilado
npm run lint:api     # checagem de tipos (tsc --noEmit)
```

`/health` é a **única** rota pública da API — é ela que responde à monitoração:

```bash
curl http://localhost:3333/health
# banco acessível -> 200 {"status":"ok","database":"connected"}
# banco fora      -> 503 {"status":"degraded","database":"disconnected"}
```

Todas as demais exigem token do Entra; o inventário de rotas e suas guardas está
em [apps/api/README.md](apps/api/README.md).

### Ambos

```bash
npm run build        # build do frontend e do backend
npm run lint         # checagem de tipos de ambos
npm test             # testes da API (node:test)
npm run entra:check  # pré-voo dos App Registrations do Entra (não exige login)
```

Frontend e backend rodam em processos separados — abra dois terminais e execute
`npm run dev:web` em um e `npm run dev:api` no outro. Cada script da raiz apenas
delega para o workspace correspondente; também é possível rodar diretamente dentro
de `apps/web` ou `apps/api`.

## Variáveis de ambiente

Cada app tem seu próprio modelo de variáveis. Para configurar o ambiente local,
copie os arquivos e preencha os valores:

```bash
cp apps/web/.env.example apps/web/.env
cp apps/api/.env.example apps/api/.env
```

> Use `.env`, não `.env.local`: `npm run entra:check` lê exatamente
> `apps/web/.env` e `apps/api/.env` para comparar os dois App Registrations, e
> com `.env.local` ele reporta o arquivo como ausente. O `apps/api/.env` também
> é a fonte das credenciais lidas por `infra/docker-compose.yml`.

Nenhuma credencial real deve ser versionada. Arquivos `.env*` são ignorados pelo
`.gitignore`, com exceção dos próprios `.env.example`.

## Microsoft Entra e Microsoft 365

O PGCP usa **dois** App Registrations, e a distinção importa:

| Aplicativo | Tipo | Papel |
|---|---|---|
| **PGCP Web** | SPA / public client | autenticação interativa no navegador. **Sem client secret** |
| **PGCP API** | API / confidential client | valida o token, executa o backend e fala com o Microsoft Graph. O segredo vive **só no servidor** |

O SPA pede um token para a API (`access_as_user`); quem conversa com o Graph é
sempre o backend — por *On-Behalf-Of* quando o recurso é da própria pessoa, ou
app-only quando é da aplicação.

### Perfis

| Perfil | O que faz |
|---|---|
| **Usuário PGCP** (sem App Role) | consulta o conteúdo corporativo (reuniões, pautas, Anotações, Ata) e cuida dos seus FUPs. É também a base da futura experiência pública |
| **Assessoria do PGCP** (`PGCP.Assessoria`) | cria, agenda, administra e conduz reuniões — pautas, participantes, Ata, Outlook e Teams — e mantém os cadastros funcionais (órgãos, tipos e naturezas de pauta) |
| **Administrador do PGCP** (`PGCP.Admin`) | administra tecnicamente a plataforma: usuários, integrações, auditoria e configurações — e também os cadastros funcionais |

As duas App Roles são **independentes** — nenhuma implica a outra. Uma pessoa
pode ter nenhuma, uma ou as duas; com as duas, soma as capacidades. As roles vêm
no claim `roles` do token e **não** são gravadas no banco.

A única sobreposição é deliberada: **órgãos de governança, tipos e naturezas de
pauta** aceitam `PGCP.Assessoria` **ou** `PGCP.Admin`.

> *Histórico: até a 5.4l existiu a App Role `Meeting.Scheduler`, substituída por
> `PGCP.Assessoria` e descontinuada.*

### Permissões do Microsoft Graph

| Permissão | Tipo | Para quê |
|---|---|---|
| `Calendars.Read` | Delegada | a pessoa vê o **próprio** calendário do Outlook na Visão Geral |
| `User.Read.All` | Aplicação | busca no diretório corporativo (organizador, participante, responsável) |

Criar e alterar eventos usa **Exchange Online RBAC for Applications** com
*Resource Scope*, que limita quais mailboxes podem ser **organizadoras**.

### O que deliberadamente NÃO é concedido

| Item | Estado | Por quê |
|---|---|---|
| `Calendars.ReadWrite` **Application** no Entra | **NÃO** | daria escrita em todas as mailboxes do tenant; usamos o escopo do Exchange |
| `OnlineMeetings.ReadWrite` | **NÃO** | o Teams nasce dentro do próprio evento do Outlook (`isOnlineMeeting` + `onlineMeetingProvider`) |
| `Mail.Send` (**Delegada**, via OBO) | **concedida e validada** | envia as pautas para validação em PDF, pela caixa do próprio usuário. A versão **Aplicação** não é usada |

Detalhes operacionais:

- [`docs/HANDOFF-CORPORATIVO.md`](docs/HANDOFF-CORPORATIVO.md) — **porta de entrada** para quem assume o projeto
- [`docs/runbook-entra-app-registration.md`](docs/runbook-entra-app-registration.md) — configurar o Entra do zero
- [`docs/runbook-exchange-calendar.md`](docs/runbook-exchange-calendar.md) — autorização de calendário no Exchange
- [`docs/integracoes.md`](docs/integracoes.md) — arquitetura das integrações e política de autorização

## Estado atual

**Frontend** — consome a API real. Reuniões, pautas, participantes, Anotações,
Ata, FUP e órgãos vêm do PostgreSQL; o `localStorage` guarda apenas preferência
de interface, como o idioma.

**Backend** — Node.js + Express com autenticação Entra, autorização por App
Role, e integrações reais com Microsoft Graph (diretório, calendário) e Exchange
Online.

**Banco** — PostgreSQL 17 via driver `pg`, **sem ORM**. Migrations versionadas em
`apps/api/migrations`, aplicadas com `npm run db:migrate`.

```text
React (apps/web) ──REST + token Entra──▶ Node/Express (apps/api) ──pg──▶ PostgreSQL
                                                │
                                                └──▶ Microsoft Graph / Exchange Online
```

| Capacidade | Estado |
|---|---|
| Entra SSO | ✅ |
| Diretório via Graph | ✅ |
| Calendário do Outlook | ✅ |
| Exchange RBAC (Resource Scope) | ✅ |
| Microsoft Teams no próprio evento | ✅ |
| `PGCP.Assessoria` — Assessoria do PGCP | ✅ perfil funcional (reuniões + cadastros) |
| `PGCP.Admin` — Administrador do PGCP | ✅ perfil técnico (usuários, integrações, auditoria) |
| Auditoria (trilha corporativa) | ✅ funcional, restrita a `PGCP.Admin` |
| Validação de pautas (PDF) antes do convite | ✅ implementada — convite bloqueado até a aprovação |
| `Mail.Send` (Delegada + OBO) | ✅ envio real validado no tenant; ⚠️ pós-envio a revalidar |
| DocuSign | ⏳ futuro |

> `PGCP.Admin` protege criação e edição de órgãos de governança, a lista de
> usuários do PGCP, os cadastros de tipo e natureza de pauta e o painel de
> Integrações; e esconde Administração, Auditoria e Configurações de quem não a
> tem. A leitura corporativa e o Directory Picker seguem abertos a qualquer
> usuário ativo. `GET /audit-logs` lê a trilha real, paginada por cursor, e é
> **somente leitura**: `audit_logs` é append-only e não existe rota que edite ou
> limpe registro.
