-- =============================================================================
-- 042_future_topics.sql
--
-- TEMAS FUTUROS na Biblioteca (10/2026). Um tema pode ser cadastrado como
-- "futuro": ainda sem reunião, com MÊS/ANO e COMITÊ previstos. A Biblioteca
-- separa as abas "Temas Regulares" e "Temas Futuros".
--
--   is_future                     tema futuro?
--   expected_month                mês/ano previsto (gravado como dia 1)
--   expected_governance_body_id   comitê previsto
--
-- Regras (CHECK): tema futuro tem os DOIS campos; tema regular não tem nenhum.
--
-- VIRA REGULAR AO ENTRAR NUMA REUNIÃO: trigger em meeting_agenda_items. Quando
-- um item passa a apontar para um tema da Biblioteca (INSERT ou troca de
-- agenda_topic_id), o tema deixa de ser futuro e perde os campos previstos —
-- por qualquer caminho de código (Biblioteca na reunião, Agenda Anual, etc.).
-- O trigger roda com o papel de quem escreve (pcgp_app já tem UPDATE em
-- agenda_topics).
--
-- TUDO ADITIVO: temas existentes ficam regulares (DEFAULT false).
--
-- REVERSÃO (manual):
--   DROP TRIGGER IF EXISTS meeting_agenda_items_tema_regular ON meeting_agenda_items;
--   DROP FUNCTION IF EXISTS tornar_tema_regular_ao_vincular();
--   ALTER TABLE agenda_topics DROP CONSTRAINT IF EXISTS agenda_topics_future_check,
--     DROP CONSTRAINT IF EXISTS agenda_topics_expected_month_check,
--     DROP COLUMN IF EXISTS expected_governance_body_id,
--     DROP COLUMN IF EXISTS expected_month, DROP COLUMN IF EXISTS is_future;
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE agenda_topics
  ADD COLUMN is_future boolean NOT NULL DEFAULT false,
  ADD COLUMN expected_month date,
  ADD COLUMN expected_governance_body_id uuid REFERENCES governance_bodies (id) ON DELETE RESTRICT;

ALTER TABLE agenda_topics
  ADD CONSTRAINT agenda_topics_expected_month_check
    CHECK (expected_month IS NULL OR EXTRACT(DAY FROM expected_month) = 1),
  ADD CONSTRAINT agenda_topics_future_check
    CHECK (
      (is_future AND expected_month IS NOT NULL AND expected_governance_body_id IS NOT NULL)
      OR (NOT is_future AND expected_month IS NULL AND expected_governance_body_id IS NULL)
    );

CREATE INDEX agenda_topics_expected_body_idx
  ON agenda_topics (expected_governance_body_id)
  WHERE expected_governance_body_id IS NOT NULL;

COMMENT ON COLUMN agenda_topics.is_future IS
  'Tema futuro (ainda sem reunião). Vira regular sozinho ao ser vinculado a uma reunião (trigger).';
COMMENT ON COLUMN agenda_topics.expected_month IS 'Mês/ano previsto do tema futuro (dia 1).';
COMMENT ON COLUMN agenda_topics.expected_governance_body_id IS 'Comitê previsto do tema futuro.';

CREATE FUNCTION tornar_tema_regular_ao_vincular() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agenda_topic_id IS NOT NULL THEN
    UPDATE agenda_topics
       SET is_future = false, expected_month = NULL, expected_governance_body_id = NULL
     WHERE id = NEW.agenda_topic_id AND is_future;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meeting_agenda_items_tema_regular
  AFTER INSERT OR UPDATE OF agenda_topic_id ON meeting_agenda_items
  FOR EACH ROW EXECUTE FUNCTION tornar_tema_regular_ao_vincular();
