# apps/api

Backend da plataforma: **Node.js + Express + TypeScript + PostgreSQL**, sem ORM.

Autenticação corporativa (Microsoft Entra ID), autorização por App Role, domínio
de reuniões persistido em PostgreSQL e integração real com Microsoft Graph e
Exchange Online.

## Estrutura

```text
apps/api/
├── migrations/             # .sql versionados, aplicados em ordem alfabética
├── src/
│   ├── server.ts           # Express app: guards globais, CORS, headers, rotas
│   ├── database.ts         # Pool do PostgreSQL (runtime) + checagem de conexão
│   ├── migrate.ts          # runner de migrations (pool próprio, credencial de DDL)
│   ├── http-error.ts       # erro com status HTTP; service lança, rota traduz
│   ├── config/             # fail-fast de configuração insegura em produção
│   ├── security/           # request id, log de segurança, rate limiting
│   ├── entra/              # configuração, verificação de token e middleware
│   ├── authz/              # App Roles (PGCP.Assessoria, PGCP.Admin)
│   ├── graph/              # cliente único do Microsoft Graph
│   ├── users/              # usuários do PGCP (PostgreSQL) + middleware de ativo
│   ├── directory/          # busca no diretório corporativo (Graph, só leitura)
│   ├── me/                 # identidade da sessão + provisionamento JIT
│   ├── meetings/           # reuniões: leitura, criação, edição, visibilidade
│   ├── meeting-notes/      # Anotações (documento operacional)
│   ├── meeting-minutes/    # Ata (documento formal) + modelo de assinatura
│   ├── agenda-topics/      # biblioteca de pautas + taxonomias
│   ├── action-items/       # FUP (acompanhamento)
│   ├── calendar/           # Outlook: sincronização e agenda própria
│   ├── governance-bodies/  # órgãos de governança
│   ├── integrations/       # catálogo e verificação real das integrações
│   └── audit/              # trilha corporativa (append-only, só leitura)
├── package.json
├── tsconfig.json
└── .env.example
```

## Migrations

Sem ORM. Migrations são arquivos `.sql` explícitos, aplicados em ordem alfabética por
`src/migrate.ts`, que registra o que já rodou na tabela `schema_migrations`.

```bash
npm run db:migrate   # a partir da raiz
```

- Cada migration roda na **própria transação**: falha faz `ROLLBACK` completo.
- Rodar novamente é seguro — migrations já aplicadas são ignoradas.
- `pg_advisory_lock` impede duas execuções simultâneas.
- Os `.sql` não contêm `BEGIN`/`COMMIT`: quem controla a transação é o runner.
- O runner usa `DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD` (papel dono, com DDL),
  **não** a credencial de runtime. Ele imprime `current_user` na saída, como
  evidência de que a separação de papéis está valendo.

Para adicionar uma migration, crie o próximo `NNN_<descricao>.sql` no diretório
`migrations/`. **Nunca edite uma migration já aplicada** — crie uma nova.

O modelo de dados está documentado em
[docs/modelo-de-dados.md](../../docs/modelo-de-dados.md).

## Autenticação e autorização

Três camadas, nesta ordem:

1. **Entra "Atribuição necessária = Sim"** — decide quem obtém token.
2. **`requireEntraAuth`** — valida assinatura (JWKS), `iss`, `aud`, `exp`/`nbf`,
   e depois `tid`, `oid`, `azp` e `scp`. Identidade é sempre `tid` + `oid`.
3. **`requireActivePgcpUser`** — a pessoa existe em `users` e está ativa.

Sobre essas camadas, as App Roles do claim `roles`: `PGCP.Assessoria` (opera
reuniões) e `PGCP.Admin` (administra a plataforma). São **independentes** —
nenhuma implica a outra. Detalhe em [docs/security.md](../../docs/security.md).

## Endpoints

| Rota | Guarda |
|---|---|
| `GET /health` | **pública** — é ela que responde à monitoração |
| `GET /me` | token válido (provisiona na primeira entrada) |
| `GET /directory/users` | usuário ativo · rate limit |
| `GET /calendar/me` | usuário ativo · rate limit |
| `GET /meetings`, `GET /meetings/:id` | usuário ativo |
| `GET /meetings/:id/notes`, `GET /meetings/:id/minutes` | usuário ativo |
| `GET /agenda-topics*`, `GET /governance-bodies*` | usuário ativo |
| `GET`/`POST`/`PATCH` `/action-items*` | usuário ativo (escrita revalida o dono) |
| Mutações de `/meetings/**` (inclui `calendar-sync`, Anotações e Ata) | `PGCP.Assessoria` |
| Cadastros funcionais (órgãos, tipos, naturezas) | `PGCP.Assessoria` **ou** `PGCP.Admin` |
| `/integrations/**` | `PGCP.Admin` (guarda no router) · `test` com rate limit |
| `GET /users` | `PGCP.Admin` |
| `GET /audit-logs` | `PGCP.Admin` — somente leitura |

Nenhuma resposta inclui host, usuário, senha, connection string ou valor de
variável secreta. Rota inexistente responde `404` em JSON, no mesmo formato das
demais respostas de erro.

Escrita na trilha **não** passa por rota: cada operação de domínio grava a
própria entrada de `audit_logs` dentro da transação do ato, e a tabela é
append-only (o papel de runtime não tem `UPDATE`/`DELETE`/`TRUNCATE` nela).

## Comandos

A partir da raiz do repositório:

```bash
npm run db:up        # sobe o PostgreSQL local (Docker)
npm run db:migrate   # aplica as migrations pendentes
npm run dev:api      # desenvolvimento com watch (tsx)
npm run build:api    # compila TypeScript -> apps/api/dist
npm run start:api    # executa o build compilado
npm run lint:api     # checagem de tipos (tsc --noEmit)
npm test             # testes da API (node:test)
```

## Configuração

Copie o modelo e ajuste os valores:

```bash
cp apps/api/.env.example apps/api/.env
```

| Variável | Padrão local | Descrição |
|---|---|---|
| `PORT` | `3333` | Porta HTTP em que a API sobe |
| `CORS_ORIGIN` | `http://localhost:3000` | Origens permitidas. Nunca `*` |
| `DB_HOST` | `localhost` | Host do PostgreSQL |
| `DB_PORT` | `5434` | Porta do PostgreSQL |
| `DB_NAME` | `pcgp` | Nome do banco |
| `DB_USER` | `pcgp_app` | Papel de **runtime** (menor privilégio, sem DDL) |
| `DB_PASSWORD` | — | Senha do runtime. Nunca versionar |
| `DB_MIGRATION_USER` | `pcgp_admin` | Papel **dono**, usado só pelas migrations |
| `DB_MIGRATION_PASSWORD` | — | Senha do papel de migration. Nunca versionar |
| `DB_BOOTSTRAP_USER` | `pcgp_bootstrap` | Superusuário de bootstrap. Só o compose usa |
| `DB_BOOTSTRAP_PASSWORD` | — | Senha de bootstrap. Nunca versionar |
| `DB_SSL` | `false` | `true` quando o servidor exigir TLS (obrigatório em produção) |

As variáveis de integração (Entra, Graph, e-mail, observabilidade) estão
documentadas em [`.env.example`](.env.example) e em
[docs/integracoes.md](../../docs/integracoes.md).

> Os papéis do PostgreSQL usam a grafia `pcgp_*`. São nomes de papéis **já
> provisionados** nos clusters; renomeá-los é operação de infraestrutura, não de
> código. A sigla do produto continua sendo `PGCP`.

Em `NODE_ENV=production`, `src/config/production-guard.ts` **aborta a
inicialização** se o Entra não estiver configurado, se o CORS cair no default de
desenvolvimento / contiver `localhost` / `*` / `http://`, ou se `DB_SSL` não for
`true`. Preferimos não subir a subir inseguro.

## Banco de dados

A conexão usa o driver `pg` diretamente, sem ORM. `src/database.ts` expõe um
`Pool` e a função `checkDatabaseConnection()`, que executa `SELECT 1`.

A API depende apenas das variáveis `DB_*` e funciona com qualquer PostgreSQL
padrão — o Docker é só a conveniência do ambiente local. Ver
[infra/docker-compose.yml](../../infra/docker-compose.yml) e
[infra/postgres/README.md](../../infra/postgres/README.md).
