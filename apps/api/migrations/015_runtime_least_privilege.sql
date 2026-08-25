-- =============================================================================
-- 015_runtime_least_privilege.sql
--
-- Privilegios de objeto do papel de RUNTIME da aplicacao (`pcgp_app`).
--
-- Esta migration roda como o papel de MIGRATION (`pcgp_admin`), que passou a ser
-- o DONO de todas as tabelas. Dono pode conceder; por isso os GRANTs abaixo
-- funcionam sem superusuario.
--
-- SEPARACAO DE PAPEIS (fechada aqui, no nivel de objeto):
--
--   pcgp_admin  dono das tabelas, roda migrations, concede privilegios
--   pcgp_app    runtime da API — SOMENTE o DML de que a aplicacao precisa
--
-- A criacao dos papeis e a remocao dos atributos administrativos
-- (NOSUPERUSER, NOBYPASSRLS, ...) sao ato de CLUSTER, nao de schema: vivem em
-- infra/postgres (provisionamento) porque exigem CREATE ROLE / ALTER ROLE, que
-- `pcgp_admin` deliberadamente NAO tem. Aqui ficam apenas os GRANTs de objeto.
--
-- IDEMPOTENTE e TOLERANTE: se o papel `pcgp_app` ainda nao existir (setup minimo
-- de desenvolvedor com um unico usuario), os grants sao ignorados com aviso, em
-- vez de quebrar a migration. Em producao o papel existe (provisionado antes).
--
-- audit_logs: APPEND-ONLY para o runtime. `pcgp_app` pode SELECT e INSERT, nunca
-- UPDATE, DELETE ou TRUNCATE. Como `pcgp_app` tambem nao e mais DONO da tabela,
-- nao pode desabilitar gatilho nem ALTER — o dono e `pcgp_admin`.
--
-- schema_migrations: bookkeeping do runner. O runtime NAO recebe acesso; e do
-- `pcgp_admin`, e so.
--
-- O runner aplica este arquivo dentro de uma transacao: NAO incluir BEGIN/COMMIT.
-- =============================================================================

DO $$
DECLARE
  tabela text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE
      'Papel de runtime "pcgp_app" ausente: grants de menor privilegio ignorados. '
      'Provisione os papeis (infra/postgres) antes de rodar em producao.';
    RETURN;
  END IF;

  -- DML nas tabelas da aplicacao, uma a uma, EXCETO a bookkeeping de migrations.
  -- Nunca GRANT ALL: TRUNCATE, REFERENCES e TRIGGER ficam de fora de proposito.
  FOR tabela IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO pcgp_app', tabela);
  END LOOP;

  -- audit_logs volta a ser APENAS append-only para o runtime.
  -- REVOKE de privilegio que o papel nao tem e no-op; garante o estado final.
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT ON public.audit_logs TO pcgp_app';

  -- O runtime nunca le nem escreve a bookkeeping de migrations.
  EXECUTE 'REVOKE ALL ON public.schema_migrations FROM pcgp_app';

  RAISE NOTICE 'Privilegios de runtime aplicados a pcgp_app (append-only em audit_logs).';
END $$;
