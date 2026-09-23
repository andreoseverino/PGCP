-- =============================================================================
-- 023_governance_body_chair.sql
--
-- Presidente da Mesa por orgao colegiado.
--
-- ATE AQUI, a Ata descobria "quem preside" vasculhando os PARTICIPANTES da
-- reuniao por um cargo que combinasse com /chair|president/i — ou seja, o
-- mesmo orgao podia sair com presidentes diferentes de uma reuniao para outra,
-- dependendo de quem alguem digitou como cargo naquele dia. O presidente da
-- mesa e um FATO DO ORGAO, nao da reuniao: cadastra-lo uma vez em
-- `governance_bodies` e deixar toda Ata daquele orgao herdar o mesmo dado e
-- que evita essa divergencia.
--
-- MESMO PADRAO DE IDENTIDADE do organizador da reuniao (migration 012): par
-- Microsoft (tenant, oid) como identidade primaria, snapshot de nome para
-- exibicao. O presidente nao precisa ter conta no PGCP.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE governance_bodies
  ADD COLUMN chair_entra_tenant_id uuid,
  ADD COLUMN chair_entra_object_id uuid,
  -- Snapshot de exibicao, capturado no momento da escolha no diretorio.
  ADD COLUMN chair_name text;

ALTER TABLE governance_bodies
  -- O par nasce e morre junto: meia identidade nao identifica ninguem.
  ADD CONSTRAINT governance_bodies_chair_entra_pairing_check CHECK (
    (chair_entra_object_id IS NULL) = (chair_entra_tenant_id IS NULL)
  ),

  -- Identidade Microsoft exige nome: a Ata precisa mostrar algo legivel mesmo
  -- para quem nao tem conta no PGCP.
  ADD CONSTRAINT governance_bodies_chair_entra_needs_name_check CHECK (
    chair_entra_object_id IS NULL OR length(btrim(COALESCE(chair_name, ''))) > 0
  );

COMMENT ON COLUMN governance_bodies.chair_entra_object_id IS
  'oid do Presidente da Mesa no Entra. Identidade MICROSOFT do orgao, nao da reuniao. Nunca substituida por nome.';

COMMENT ON COLUMN governance_bodies.chair_name IS
  'Snapshot de exibicao do Presidente da Mesa no momento da escolha. Nunca serve para reconciliar pessoa.';

CREATE INDEX governance_bodies_chair_entra_idx
  ON governance_bodies (chair_entra_tenant_id, chair_entra_object_id)
  WHERE chair_entra_object_id IS NOT NULL;
