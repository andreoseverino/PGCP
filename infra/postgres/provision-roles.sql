-- =============================================================================
-- provision-roles.sql — TOPOLOGIA DE PAPEIS do PostgreSQL do PGCP
--
-- Fonte unica da separacao de privilegios. Executado por um SUPERUSUARIO
-- (bootstrap do cluster). Idempotente: serve tanto para provisionar um cluster
-- LIMPO quanto para endurecer um cluster EXISTENTE em que `pcgp_app` ainda e
-- superusuario.
--
--   pcgp_admin  papel de MIGRATION/DONO. Sem superusuario. Dono do banco e de
--               todos os objetos; roda migrations; concede privilegios de objeto.
--   pcgp_app    papel de RUNTIME da API. NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
--               NOREPLICATION, NOBYPASSRLS. Nao e dono de nada. So recebe o DML
--               que a aplicacao precisa — concedido pela migration 015, que roda
--               como pcgp_admin (dono das tabelas).
--
-- Este arquivo NAO concede privilegio de TABELA (isso e da migration 015, e
-- exige que as tabelas ja existam e sejam de pcgp_admin). Aqui ficam apenas os
-- atos de CLUSTER/DATABASE: criar papeis, definir atributos, transferir posse,
-- CONNECT, USAGE de schema e default privileges para tabelas futuras.
--
-- Variaveis psql obrigatorias (passe com -v ou pelo wrapper .sh):
--   :app_db          nome do banco da aplicacao (ex.: pcgp)
--   :app_password    senha do papel de runtime pcgp_app
--   :admin_password  senha do papel de migration pcgp_admin
--
-- Exemplo (endurecer cluster existente, rodando como o superusuario atual):
--   psql -v app_db=pcgp -v app_password='...' -v admin_password='...' \
--        -f infra/postgres/provision-roles.sql
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- 1. Papel de MIGRATION/DONO: pcgp_admin (sem superusuario).
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
-- 2. Papel de RUNTIME: pcgp_app (menor privilegio, sem nenhum atributo admin).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    CREATE ROLE pcgp_app LOGIN;
  END IF;
END $$;

-- Remove TODO atributo administrativo. Se `pcgp_app` era o superusuario de
-- bootstrap (caso do cluster existente), e AQUI que ele deixa de ser.
-- Feito depois de pcgp_admin ja existir e de a posse ser transferida (abaixo),
-- para nunca deixar o cluster sem dono dos objetos.
-- A remocao de SUPERUSER e o ultimo ato do arquivo (secao 6).
ALTER ROLE pcgp_app PASSWORD :'app_password';

-- -----------------------------------------------------------------------------
-- 3. Posse do banco e de todos os objetos -> pcgp_admin.
--
-- Critico para o append-only de audit_logs: o DONO de uma tabela pode
-- TRUNCATE, DROP, ALTER e DESABILITAR GATILHO independentemente de GRANT.
-- Enquanto pcgp_app for dono de audit_logs, nenhum REVOKE a protege. Por isso a
-- posse migra para pcgp_admin ANTES de o runtime ser restringido.
-- -----------------------------------------------------------------------------
ALTER DATABASE :"app_db" OWNER TO pcgp_admin;

-- Transfere a posse OBJETO A OBJETO, restrito ao schema public do banco atual.
--
-- Nao se usa REASSIGN OWNED aqui: ele tambem alcanca objetos compartilhados
-- (bancos template0/template1/postgres), que num cluster onde pcgp_app foi o
-- superusuario de bootstrap pertencem a ele — e reassinar template0 e proibido
-- ("required by the database system"). O laco abaixo toca so o que e da
-- aplicacao. Em cluster limpo, nada pertence a pcgp_app e o laco e no-op.
DO $$
DECLARE
  r record;
BEGIN
  -- Tabelas, sequences, views e afins.
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

  -- Funcoes e procedimentos (gatilhos acompanham a funcao).
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
-- 4. Acesso de conexao e de schema para o runtime.
-- -----------------------------------------------------------------------------
GRANT CONNECT ON DATABASE :"app_db" TO pcgp_app;
GRANT CONNECT ON DATABASE :"app_db" TO pcgp_admin;

-- USAGE no schema public (nao CREATE): o runtime enxerga e usa os objetos, mas
-- nao cria nem altera estrutura.
GRANT USAGE ON SCHEMA public TO pcgp_app;

-- -----------------------------------------------------------------------------
-- 5. Default privileges: tabelas/sequences FUTURAS criadas por pcgp_admin ja
--    nascem com o DML do runtime concedido. audit_logs e a excecao tratada pela
--    migration 015 (que revoga UPDATE/DELETE depois). Nunca GRANT ALL.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE pcgp_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pcgp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE pcgp_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pcgp_app;

-- -----------------------------------------------------------------------------
-- 6. ULTIMO ATO: remover os atributos administrativos do runtime.
--
-- Depois que pcgp_admin existe e ja e dono de tudo, e seguro tirar o poder de
-- pcgp_app. Se este papel era o superusuario de bootstrap, garanta que exista
-- OUTRO superusuario (DBA/break-glass) antes de rodar — senao o cluster fica
-- sem nenhum superusuario. Ver harden-existing-cluster.sql.
-- -----------------------------------------------------------------------------
ALTER ROLE pcgp_app
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
