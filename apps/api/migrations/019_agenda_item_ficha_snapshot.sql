-- =============================================================================
-- 019_agenda_item_ficha_snapshot.sql
--
-- Ficha cadastral da PAUTA DAQUELA REUNIÃO (snapshot efetivo).
--
-- Até aqui, Tipo, Natureza, Descrição e "Tema de FUP" viviam SÓ no tema mestre
-- da Biblioteca (`agenda_topics`). A pauta da reunião só os enxergava por JOIN no
-- `agenda_topic_id`. Esta migration dá à pauta da reunião a sua PRÓPRIA cópia,
-- para que ela tenha ficha independente — igual ao que a 017 fez com o Tema
-- circular.
--
-- SEMÂNTICA (idêntica à do `is_circular_theme`):
--   `agenda_topics.*`        -> tema mestre, valor-padrão da Biblioteca
--   `meeting_agenda_items.*` -> SNAPSHOT efetivo naquela reunião
-- Ao vincular/criar a partir da Biblioteca, o valor é COPIADO uma vez (snapshot,
-- no INSERT do item, via COALESCE na aplicação). Depois, INDEPENDENTES: editar o
-- mestre não retroage; editar a pauta da reunião não altera o mestre.
--
-- "Tema de FUP" é APENAS classificação. NÃO cria nem vincula `action_items`.
--
-- ADITIVA e retrocompatível: colunas nullable (Tipo/Natureza/Descrição) e
-- `generates_action_item NOT NULL DEFAULT false`. Sem backfill: pautas antigas
-- ficam Tipo/Natureza/Descrição = NULL e FUP = false. Histórico preservado.
--
-- FK das taxonomias com ON DELETE SET NULL (e NÃO RESTRICT como em
-- `agenda_topics`): o snapshot é uma cópia de conveniência; a exclusão física de
-- um tipo/natureza já é barrada pelo caminho da Administração quando há tema em
-- uso, e degradar o snapshot a NULL evita um erro cru de FK vindo de um item de
-- reunião que ninguém contabilizou naquela verificação.
--
-- O runner aplica dentro de uma transação: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE meeting_agenda_items
  ADD COLUMN agenda_topic_type_id   uuid REFERENCES agenda_topic_types   (id) ON DELETE SET NULL,
  ADD COLUMN agenda_topic_nature_id uuid REFERENCES agenda_topic_natures (id) ON DELETE SET NULL,
  ADD COLUMN description            text,
  ADD COLUMN generates_action_item  boolean NOT NULL DEFAULT false;

CREATE INDEX meeting_agenda_items_type_id_idx   ON meeting_agenda_items (agenda_topic_type_id);
CREATE INDEX meeting_agenda_items_nature_id_idx ON meeting_agenda_items (agenda_topic_nature_id);

COMMENT ON COLUMN meeting_agenda_items.agenda_topic_type_id IS
  'Tipo da pauta NESTA reunião (snapshot). Copiado de agenda_topics.agenda_topic_type_id ao vincular; depois independente.';
COMMENT ON COLUMN meeting_agenda_items.agenda_topic_nature_id IS
  'Natureza da pauta NESTA reunião (snapshot). Copiado de agenda_topics.agenda_topic_nature_id ao vincular; depois independente.';
COMMENT ON COLUMN meeting_agenda_items.description IS
  'Descrição/Objetivo de debate NESTA reunião (snapshot). Copiado de agenda_topics.description ao vincular; depois independente.';
COMMENT ON COLUMN meeting_agenda_items.generates_action_item IS
  'Classificação "Tema de FUP" NESTA reunião (snapshot). Apenas classifica — NÃO cria action_items. Copiado de agenda_topics.generates_action_item ao vincular; depois independente.';
