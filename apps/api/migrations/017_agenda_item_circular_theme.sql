-- =============================================================================
-- 017_agenda_item_circular_theme.sql
--
-- "Tema circular" da PAUTA DAQUELA REUNIÃO.
--
-- O fato de uma pauta ser circular pertence ao CONTEXTO da reunião: o mesmo
-- tema da Biblioteca pode ser circular numa reunião e não em outra. Por isso a
-- coluna vive em `meeting_agenda_items`, NÃO em `agenda_topics`.
--
-- ADITIVA e segura: `NOT NULL DEFAULT false`. Nenhum backfill inventando que
-- pautas antigas eram circulares — todas as existentes ficam `false`. Item
-- importado da Biblioteca também nasce `false` (a Biblioteca não carrega o
-- conceito hoje); o usuário marca por reunião, na edição da pauta.
--
-- O runner aplica dentro de uma transação: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE meeting_agenda_items
  ADD COLUMN is_circular_theme boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN meeting_agenda_items.is_circular_theme IS
  'Marca se a pauta é um tema circular NESTA reunião. Propriedade da pauta da reunião, não do tema mestre da Biblioteca. Default false: pautas antigas e importadas nascem não-circulares.';
