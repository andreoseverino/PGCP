-- =============================================================================
-- harden-existing-cluster.sql — ENDURECIMENTO de um cluster JA EXISTENTE
--
-- Fecha o Achado A quando o cluster JA RODA e `pcgp_app` e o superusuario de
-- BOOTSTRAP do initdb (foi o POSTGRES_USER original).
--
-- PORQUE NAO BASTA "ALTER ROLE pcgp_app NOSUPERUSER":
--   O superusuario de bootstrap do initdb (OID 10) NAO pode ter o atributo
--   SUPERUSER removido nem ser derrubado — o PostgreSQL recusa
--   ("The bootstrap superuser must have the SUPERUSER attribute"). Rebaixar em
--   cima dele e impossivel. A saida correta e PARAR DE USAR esse papel na
--   aplicacao: renomeia-lo para fora do nome de runtime e criar um pcgp_app
--   NOVO, sem privilegio. O papel antigo vira superusuario de emergencia
--   (pcgp_initdb), que a aplicacao nunca usa.
--
-- PROCEDIMENTO EM DOIS PASSOS (troca de usuario de conexao no meio):
--
--   PASSO 1 — como o superusuario de bootstrap atual (pcgp_app), crie o
--             superusuario auxiliar a partir do qual o renome sera feito
--             (renomear o proprio papel da sessao nao e confiavel):
--
--     CREATE ROLE pcgp_bootstrap LOGIN SUPERUSER PASSWORD 'SENHA_BOOTSTRAP';
--
--   PASSO 2 — reconecte como pcgp_bootstrap e rode ESTE arquivo:
--
--     psql -U pcgp_bootstrap -d pcgp \
--       -v app_db=pcgp -v app_password='SENHA_APP' -v admin_password='SENHA_ADMIN' \
--       -f harden-existing-cluster.sql
--
--   PASSO 3 — aplique a 015 (grants de runtime + append-only) como pcgp_admin:
--     DB_MIGRATION_USER=pcgp_admin DB_MIGRATION_PASSWORD=... npm run db:migrate
--
-- Idempotente: rodar de novo nao quebra nada.
--
-- ESTADO FINAL:
--   pcgp_bootstrap  superusuario DBA/break-glass (esta sessao). Nao usado pela app.
--   pcgp_initdb     superusuario de bootstrap do initdb, renomeado. NOLOGIN e sem
--                   senha: nao e credencial utilizavel. Nao e dono de nenhum
--                   objeto da aplicacao PGCP e nao participa do caminho de
--                   execucao; permanece SUPERUSER so porque o Postgres nao deixa
--                   remover esse atributo do bootstrap superuser.
--   pcgp_admin      migration/dono (NOSUPERUSER). Dono do banco e dos objetos.
--   pcgp_app        runtime NOVO (NOSUPERUSER). Menor privilegio.
--
-- Variaveis psql: :app_db, :app_password, :admin_password
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- 1. Papel de MIGRATION/DONO (sem superusuario).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_admin') THEN
    CREATE ROLE pcgp_admin LOGIN;
  END IF;
END $$;

ALTER ROLE pcgp_admin
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'admin_password';

-- -----------------------------------------------------------------------------
-- 2. Posse do banco e dos objetos da aplicacao -> pcgp_admin (object-scoped).
--    Critico para o append-only: enquanto pcgp_app for DONO de audit_logs, pode
--    TRUNCATE/ALTER/desabilitar gatilho, e nenhum REVOKE protege.
-- -----------------------------------------------------------------------------
ALTER DATABASE :"app_db" OWNER TO pcgp_admin;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
       AND pg_get_userbyid(c.relowner) <> 'pcgp_admin'
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO pcgp_admin', r.relname);
    ELSIF r.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW public.%I OWNER TO pcgp_admin', r.relname);
    ELSIF r.relkind = 'm' THEN
      EXECUTE format('ALTER MATERIALIZED VIEW public.%I OWNER TO pcgp_admin', r.relname);
    ELSE
      EXECUTE format('ALTER TABLE public.%I OWNER TO pcgp_admin', r.relname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS assinatura
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) <> 'pcgp_admin'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pcgp_admin', r.assinatura);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Libera o nome `pcgp_app`: renomeia o superusuario de bootstrap para
--    pcgp_initdb. So age enquanto `pcgp_app` AINDA for superusuario — numa
--    segunda passada, `pcgp_app` ja e o runtime novo e nada acontece.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app' AND rolsuper) THEN
    ALTER ROLE pcgp_app RENAME TO pcgp_initdb;
  END IF;
END $$;

-- Torna o bootstrap renomeado INUTILIZAVEL como credencial: nao pode logar e
-- fica sem senha. Continua SUPERUSER porque o Postgres nao permite remover esse
-- atributo do bootstrap superuser do initdb — mas sem LOGIN e sem senha ele nao
-- e um vetor de acesso. Idempotente.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_initdb') THEN
    EXECUTE 'ALTER ROLE pcgp_initdb NOLOGIN PASSWORD NULL';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Runtime NOVO: pcgp_app, sem nenhum atributo administrativo.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    CREATE ROLE pcgp_app LOGIN;
  END IF;
END $$;

ALTER ROLE pcgp_app
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';

-- -----------------------------------------------------------------------------
-- 5. Conexao, uso de schema e default privileges apontando para o pcgp_app NOVO.
--    Remove default privileges herdados pelo papel renomeado (pcgp_initdb).
-- -----------------------------------------------------------------------------
GRANT CONNECT ON DATABASE :"app_db" TO pcgp_app;
GRANT CONNECT ON DATABASE :"app_db" TO pcgp_admin;
GRANT USAGE ON SCHEMA public TO pcgp_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_initdb') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE pcgp_admin IN SCHEMA public '
         || 'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM pcgp_initdb';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE pcgp_admin IN SCHEMA public '
         || 'REVOKE USAGE, SELECT ON SEQUENCES FROM pcgp_initdb';
  END IF;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE pcgp_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pcgp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pcgp_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pcgp_app;

-- Os grants de TABELA (DML) e o append-only de audit_logs vem da migration 015,
-- aplicada como pcgp_admin no passo 3 do procedimento acima.
