# apps/api

Backend da plataforma: **Node.js + Express + TypeScript + PostgreSQL**.

Estrutura mínima. Existe conexão com o banco, mas ainda **não** há tabelas de
negócio, migrations, ORM, autenticação ou integração com o frontend.

## Estrutura

```text
apps/api/
├── migrations/
│   └── 001_initial_schema.sql   # schema inicial (13 tabelas)
├── src/
│   ├── server.ts     # Express app + listen
│   ├── database.ts   # Pool do PostgreSQL + checagem de conexão
│   └── migrate.ts    # runner de migrations
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

Para adicionar uma migration, crie `002_<descricao>.sql` no diretório `migrations/`.
Nunca edite uma migration já aplicada — crie uma nova.

## Endpoints

| Método | Rota      | Situação        | Resposta                                            |
|--------|-----------|-----------------|-----------------------------------------------------|
| GET    | `/health` | banco acessível | `200` `{"status":"ok","database":"connected"}`       |
| GET    | `/health` | banco fora      | `503` `{"status":"degraded","database":"disconnected"}` |

A resposta nunca inclui host, usuário, senha ou connection string.

## Comandos

A partir da raiz do repositório:

```bash
npm run db:up        # sobe o PostgreSQL local (Docker)
npm run db:migrate   # aplica as migrations pendentes
npm run dev:api      # desenvolvimento com watch (tsx)
npm run build:api    # compila TypeScript -> apps/api/dist
npm run start:api    # executa o build compilado
npm run lint:api     # checagem de tipos (tsc --noEmit)
```

## Configuração

Copie o modelo e ajuste os valores:

```bash
cp apps/api/.env.example apps/api/.env
```

| Variável      | Padrão local | Descrição                                          |
|---------------|--------------|----------------------------------------------------|
| `PORT`        | `3333`       | Porta HTTP em que a API sobe                       |
| `DB_HOST`     | `localhost`  | Host do PostgreSQL                                 |
| `DB_PORT`     | `5434`       | Porta do PostgreSQL                                |
| `DB_NAME`     | `pgcp`       | Nome do banco                                      |
| `DB_USER`     | `pcgp_app`   | Usuário da aplicação                               |
| `DB_PASSWORD` | —            | Senha do usuário. Nunca versionar                  |
| `DB_SSL`      | `false`      | `true` quando o servidor exigir TLS                |

O arquivo `apps/api/.env` é a **única fonte de verdade** das credenciais locais:
`infra/docker-compose.yml` lê as mesmas variáveis para criar o container.

## Banco de dados

A conexão usa o driver `pg` diretamente, sem ORM. `src/database.ts` expõe um
`Pool` e a função `checkDatabaseConnection()`, que executa `SELECT 1`.

A API depende apenas das variáveis `DB_*` e funciona com qualquer PostgreSQL
padrão — o Docker é só a conveniência do ambiente local. Ver
[infra/docker-compose.yml](../../infra/docker-compose.yml).
