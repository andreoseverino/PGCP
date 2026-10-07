-- =============================================================================
-- 035_governance_body_external_chair.sql
--
-- PRESIDENTE DA MESA EXTERNO.
--
-- A 023 só aceitava pessoa do Microsoft Entra ID (par tenant/oid). A Mesa
-- passa a aceitar também uma pessoa EXTERNA, do cadastro que o PGCP já tem para
-- isso (`external_participants`, 026) — sem conta no PGCP, sem identidade
-- Microsoft, sem App Role. Ser presidente da Mesa NÃO concede acesso a nada:
-- é dado de exibição da Ata, como já era para o presidente do Entra.
--
-- Identidade do externo = a FK (não o nome). `chair_name` continua como
-- snapshot de exibição para os dois casos; a leitura prefere o nome atual do
-- cadastro externo.
--
-- RESTRICT: o cadastro externo que preside uma Mesa não é removido em silêncio
-- (a aplicação responde 409 e pede para trocar o presidente antes).
--
-- Exatamente UMA origem por vez: Entra XOR externo (ou nenhuma).
--
-- ADITIVA: nenhuma linha existente é alterada.
--
-- REVERSÃO (manual; runner forward-only):
--   ALTER TABLE governance_bodies DROP CONSTRAINT IF EXISTS governance_bodies_chair_single_source_check;
--   ALTER TABLE governance_bodies DROP CONSTRAINT IF EXISTS governance_bodies_chair_external_needs_name_check;
--   ALTER TABLE governance_bodies DROP COLUMN IF EXISTS chair_external_participant_id;
--   DELETE FROM schema_migrations WHERE version = '035_governance_body_external_chair.sql';
--   (Órgãos com presidente externo ficam só com o `chair_name` de exibição.)
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE governance_bodies
  ADD COLUMN chair_external_participant_id uuid
    REFERENCES external_participants (id) ON DELETE RESTRICT;

ALTER TABLE governance_bodies
  ADD CONSTRAINT governance_bodies_chair_single_source_check CHECK (
    chair_entra_object_id IS NULL OR chair_external_participant_id IS NULL
  ),
  ADD CONSTRAINT governance_bodies_chair_external_needs_name_check CHECK (
    chair_external_participant_id IS NULL OR length(btrim(COALESCE(chair_name, ''))) > 0
  );

CREATE INDEX governance_bodies_chair_external_idx
  ON governance_bodies (chair_external_participant_id)
  WHERE chair_external_participant_id IS NOT NULL;

COMMENT ON COLUMN governance_bodies.chair_external_participant_id IS
  'Presidente da Mesa EXTERNO (external_participants). Exclusivo com chair_entra_object_id. Não concede acesso ao PGCP.';
