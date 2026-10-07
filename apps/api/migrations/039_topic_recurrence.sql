-- =============================================================================
-- 039_topic_recurrence.sql
--
-- RECORRÊNCIA DO TEMA. Mesmo padrão do "Tema circular" (017/018):
--   `agenda_topics.recurrence`        → VALOR PADRÃO da Biblioteca;
--   `meeting_agenda_items.recurrence` → valor EFETIVO naquela reunião (copiado
--                                      do padrão na inclusão, ajustável).
--
-- NULL = não se repete. Valores: weekly (7 dias), biweekly (14 dias),
-- monthly (1 mês), quarterly (3 meses).
--
-- Efeito (aplicação, não banco): ao CRIAR uma reunião nova, entra
-- automaticamente, como tema sem pauta, todo tema da Biblioteca cuja ÚLTIMA
-- ocorrência em reunião do MESMO órgão (não cancelada, anterior à nova) tem
-- recorrência e cuja data + intervalo já chegou na data da reunião nova.
-- Reuniões já existentes não mudam (sem vínculo vivo).
--
-- Só colunas novas, NULL: nenhum dado muda.
--
-- REVERSÃO (manual; runner forward-only):
--   ALTER TABLE meeting_agenda_items DROP COLUMN IF EXISTS recurrence;
--   ALTER TABLE agenda_topics DROP COLUMN IF EXISTS recurrence;
--   DELETE FROM schema_migrations WHERE version = '039_topic_recurrence.sql';
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE agenda_topics
  ADD COLUMN recurrence text,
  ADD CONSTRAINT agenda_topics_recurrence_check
    CHECK (recurrence IS NULL OR recurrence IN ('weekly', 'biweekly', 'monthly', 'quarterly'));

ALTER TABLE meeting_agenda_items
  ADD COLUMN recurrence text,
  ADD CONSTRAINT meeting_agenda_items_recurrence_check
    CHECK (recurrence IS NULL OR recurrence IN ('weekly', 'biweekly', 'monthly', 'quarterly'));

COMMENT ON COLUMN agenda_topics.recurrence IS
  'Recorrência PADRÃO do tema (039): NULL = não se repete; weekly | biweekly | monthly | quarterly.';
COMMENT ON COLUMN meeting_agenda_items.recurrence IS
  'Recorrência do tema NESTA reunião (039). Define quando o tema entra automaticamente em reunião NOVA do mesmo órgão.';
