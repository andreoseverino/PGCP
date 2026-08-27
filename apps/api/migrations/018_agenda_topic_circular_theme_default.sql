-- =============================================================================
-- 018_agenda_topic_circular_theme_default.sql
--
-- "Tema circular" como PADRÃO do tema mestre na Biblioteca.
--
-- Complementa a 017. Dois eixos distintos, de propósito:
--   `agenda_topics.is_circular_theme`        → VALOR PADRÃO da Biblioteca.
--   `meeting_agenda_items.is_circular_theme` → valor EFETIVO da pauta na reunião.
--
-- Ao vincular um tema da Biblioteca a uma reunião, o padrão é COPIADO para a
-- pauta da reunião (uma vez, no momento do vínculo). Depois os dois são
-- INDEPENDENTES: editar a pauta da reunião não mexe no mestre, e editar o mestre
-- não retroage para reuniões já existentes. Por isso a cópia é um snapshot no
-- INSERT do item (COALESCE na aplicação), NÃO um gatilho de propagação.
--
-- ADITIVA e segura: `NOT NULL DEFAULT false`. Temas antigos nascem não-circular;
-- nenhum backfill inventa que eram circulares.
--
-- O runner aplica dentro de uma transação: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE agenda_topics
  ADD COLUMN is_circular_theme boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN agenda_topics.is_circular_theme IS
  'Padrão de "tema circular" do tema mestre da Biblioteca. Ao vincular a uma reunião, é copiado para meeting_agenda_items.is_circular_theme (snapshot); depois os valores são independentes. Não retroage a reuniões existentes.';
