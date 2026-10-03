-- =============================================================================
-- 029_annual_agenda_body_year_unique.sql
--
-- UMA Agenda Anual por órgão colegiado por ano.
--
-- A Agenda Anual consolida as reuniões do órgão no exercício (028). Duas
-- agendas concorrentes para o mesmo órgão/ano não fazem sentido operacional e
-- impediriam associar reuniões automaticamente (para qual delas?). A 025 criou
-- só um índice comum `annual_agendas_body_year_idx`; aqui ele ganha a versão
-- ÚNICA.
--
-- SEM ESCOLHA ARBITRÁRIA: se já houver duplicata, a migration ABORTA com a
-- lista dos pares conflitantes — nenhuma agenda é apagada ou fundida aqui.
--
-- ADITIVA: nenhuma linha é alterada. O índice comum da 025 permanece (o único
-- cobre as mesmas consultas, mas removê-lo não é necessário para esta regra).
--
-- REVERSÃO (manual; o runner é forward-only):
--
--   DROP INDEX IF EXISTS annual_agendas_body_year_uk;
--   DELETE FROM schema_migrations WHERE version = '029_annual_agenda_body_year_unique.sql';
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

DO $$
DECLARE
  conflitos text;
BEGIN
  SELECT string_agg(format('%s/%s (%s agendas)', governance_body_id, year, n), '; ')
    INTO conflitos
    FROM (
      SELECT governance_body_id, year, count(*) AS n
        FROM annual_agendas
       GROUP BY governance_body_id, year
      HAVING count(*) > 1
    ) d;
  IF conflitos IS NOT NULL THEN
    RAISE EXCEPTION 'Agendas Anuais duplicadas por órgão/ano; resolva antes de aplicar a 029: %', conflitos;
  END IF;
END $$;

CREATE UNIQUE INDEX annual_agendas_body_year_uk ON annual_agendas (governance_body_id, year);

COMMENT ON INDEX annual_agendas_body_year_uk IS
  'Uma Agenda Anual por órgão colegiado por ano (029).';
