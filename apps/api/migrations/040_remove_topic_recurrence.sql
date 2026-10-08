-- =============================================================================
-- 040_remove_topic_recurrence.sql
--
-- REMOVE a recorrência do tema (039). Substituída pelo campo "Comitê"
-- (vínculo do tema a outros órgãos de governança): a auto-inclusão por
-- recorrência deixa de existir, junto com a coluna que a sustentava.
--
-- Sem reversão automática: os valores de `recurrence` são descartados.
-- =============================================================================

ALTER TABLE meeting_agenda_items DROP COLUMN IF EXISTS recurrence;
ALTER TABLE agenda_topics DROP COLUMN IF EXISTS recurrence;
