# PostgreSQL — modelo de acesso de menor privilégio

Fecha o **Achado A** da auditoria: a aplicação nunca opera como superusuário.

## Papéis

| Papel | Atributos | Uso | Credencial (.env) |
|---|---|---|---|
| `pcgp_bootstrap` | **SUPERUSER** | DBA / break-glass. Inicializa o cluster e provisiona papéis. **A aplicação nunca usa.** | `DB_BOOTSTRAP_USER` / `DB_BOOTSTRAP_PASSWORD` |
| `pcgp_admin` | NOSUPERUSER, dono do banco e dos objetos | Roda as **migrations** (`npm run db:migrate`). Cria/altera schema, concede privilégios. | `DB_MIGRATION_USER` / `DB_MIGRATION_PASSWORD` |
| `pcgp_app` | NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; dono de nada | **Runtime da API.** Só o DML necessário. `audit_logs` é append-only (INSERT/SELECT; nunca UPDATE/DELETE/TRUNCATE). | `DB_USER` / `DB_PASSWORD` |

> **`audit_logs` append-only** depende de `pcgp_app` **não ser dono** da tabela: o dono pode `TRUNCATE`/`ALTER`/desabilitar gatilho independentemente de `REVOKE`. Por isso a posse de todos os objetos é de `pcgp_admin`.

## Cluster LIMPO (novo ambiente)

O `docker-compose.yml` já faz tudo:

1. `POSTGRES_USER=pcgp_bootstrap` inicializa o cluster.
2. `init/00-provision-roles.sh` roda `provision-roles.sql` e cria `pcgp_admin` e `pcgp_app`.
3. `npm run db:migrate` (como `pcgp_admin`) cria as tabelas; a migration **015** concede o DML de runtime e trava `audit_logs`.

```
npm run db:up
npm run db:migrate
```

## Cluster EXISTENTE (endurecer sem recriar)

Quando `pcgp_app` já é o superusuário de bootstrap do `initdb`, ele **não pode** ser rebaixado nem removido (restrição do PostgreSQL). A saída é renomeá-lo para fora do nome de runtime e criar um `pcgp_app` novo e restrito. Ver o cabeçalho de [`harden-existing-cluster.sql`](harden-existing-cluster.sql):

```sql
-- PASSO 1 (como o superusuário atual, ex.: pcgp_app):
CREATE ROLE pcgp_bootstrap LOGIN SUPERUSER PASSWORD 'SENHA_BOOTSTRAP';
```
```sh
# PASSO 2 (reconecte como pcgp_bootstrap):
psql -U pcgp_bootstrap -d pcgp \
  -v app_db=pcgp -v app_password='SENHA_APP' -v admin_password='SENHA_ADMIN' \
  -f harden-existing-cluster.sql
# PASSO 3: aplica grants + append-only
DB_MIGRATION_USER=pcgp_admin DB_MIGRATION_PASSWORD='SENHA_ADMIN' npm run db:migrate
```

O superusuário de bootstrap renomeado vira `pcgp_initdb`, endurecido para **`NOLOGIN` e sem senha** — não é uma credencial utilizável. Permanece `SUPERUSER` apenas porque o Postgres não deixa remover esse atributo do bootstrap superuser do `initdb`. Ele **não é dono de nenhum objeto da aplicação PGCP e não participa do caminho de execução** (é dono apenas de objetos internos do próprio PostgreSQL, ligados ao bootstrap).

## Verificação

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'pcgp_%';
SELECT has_table_privilege('pcgp_app','audit_logs','INSERT');   -- t
SELECT has_table_privilege('pcgp_app','audit_logs','UPDATE');   -- f
SELECT has_table_privilege('pcgp_app','audit_logs','DELETE');   -- f
SELECT has_table_privilege('pcgp_app','audit_logs','TRUNCATE'); -- f
```
