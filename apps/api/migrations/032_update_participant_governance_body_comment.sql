-- =============================================================================
-- 032_update_participant_governance_body_comment.sql
--
-- DOCUMENTACAO DE SCHEMA. So atualiza o comentario de
-- `participant_governance_bodies`, que a 031 gravou dizendo que o grupo "nao
-- altera reunioes existentes". A regra mudou depois da 031: entrar no grupo do
-- orgao tambem inclui a pessoa nas reunioes ABERTAS ja existentes do orgao
-- (respeitando a excecao de cada reuniao). Sair do grupo continua sem efeito
-- sobre reunioes existentes.
--
-- Nenhuma tabela, coluna, indice, trigger, constraint, grant, funcao ou dado.
--
-- REVERSAO (manual; runner forward-only) — restaura o comentario da 031:
--   COMMENT ON TABLE participant_governance_bodies IS
--     'Grupo de participacao do orgao colegiado (027/031): inclui a pessoa nas reunioes NOVAS do orgao. Nao autoriza nem e App Role; nao altera reunioes existentes.';
--   DELETE FROM schema_migrations WHERE version = '032_update_participant_governance_body_comment.sql';
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

COMMENT ON TABLE participant_governance_bodies IS
  'Participantes padrao do orgao colegiado. Entram nas reunioes novas do orgao e, ao entrar no grupo, nas reunioes abertas ja existentes, respeitando as exclusoes de cada reuniao. Sair do grupo nao altera reunioes existentes. Nao autoriza nem e App Role.';
