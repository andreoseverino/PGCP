-- =============================================================================
-- 024_action_item_vp_responsavel.sql
--
-- "VP responsavel" do FUP: o executivo que responde pelo tema perante a
-- governanca. DELIBERADAMENTE texto livre, sem vinculo com o diretorio nem
-- com um cadastro — decisao explicita do produto, e DIFERENTE de
-- `assignee_*` (quem de fato executa a acao, esse sim ligado a identidade).
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE action_items ADD COLUMN vp_responsavel text;

COMMENT ON COLUMN action_items.vp_responsavel IS
  'VP responsavel pelo tema perante a governanca. Texto livre, por decisao explicita: nao e o mesmo campo que assignee_* (quem executa a acao).';
