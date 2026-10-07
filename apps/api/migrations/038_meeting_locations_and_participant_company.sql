-- =============================================================================
-- 038_meeting_locations_and_participant_company.sql
--
-- 1. LOCAIS cadastrados na Administração (substituem o catálogo fixo da 025).
--
--    Até aqui o local físico era uma CHAVE de um catálogo no código
--    (`meetings/locations.ts`: "sede-matriz", "sede-leopoldo") com endereço vindo
--    de variável de ambiente. Agora é um cadastro reutilizável:
--    `meeting_locations`. As duas sedes antigas entram como locais INATIVOS
--    (endereço a completar), só para preservar reuniões que usem as chaves; a
--    Assessoria cadastra os locais reais.
--
--    Endereço: rua, número, cidade, UF e CEP obrigatórios para local ATIVO;
--    complemento, bairro e observação opcionais. Bairro opcional por
--    simplicidade (nem todo endereço corporativo o usa). Os campos são NULL no
--    banco só para os importados (inativos e sem endereço) — o CHECK exige o
--    endereço completo de todo local ativo.
--
--    Sem exclusão: o runtime não tem DELETE; inativar preserva o histórico.
--
-- 2. LOCAL NA REUNIÃO = referência + CÓPIA CONGELADA.
--
--    `meetings.physical_location_id` aponta para o cadastro;
--    `meetings.physical_location_snapshot` guarda nome e endereço DO MOMENTO da
--    escolha. Convite, versões, PDF e exportação usam a cópia: editar o cadastro
--    depois não muda nenhuma reunião — só uma nova escolha do local muda.
--    `physical_location_key` (025) fica como coluna DEPRECIADA (preservada,
--    não é mais escrita).
--
-- 3. PARTICIPANTES EXTERNOS: telefone deixa de ser obrigatório; `company`
--    (empresa) opcional. Nenhum valor existente muda; sem backfill.
--
-- Nada é apagado. Triggers de `meetings` ficam desligados só durante o
-- backfill (reunião cancelada é imutável pela 036; `updated_at` não deve mudar
-- por uma migração de esquema).
--
-- REVERSÃO (manual; runner forward-only):
--   ALTER TABLE external_participants DROP CONSTRAINT IF EXISTS external_participants_company_check;
--   ALTER TABLE external_participants DROP COLUMN IF EXISTS company;
--   -- telefone: só voltar a NOT NULL se nenhum registro estiver sem telefone
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_modality_location_check,
--                        DROP CONSTRAINT IF EXISTS meetings_location_snapshot_pair_check;
--   ALTER TABLE meetings ADD CONSTRAINT meetings_modality_location_check
--     CHECK ((modality = 'in_person') = (physical_location_key IS NOT NULL));
--   ALTER TABLE meetings DROP COLUMN physical_location_snapshot, DROP COLUMN physical_location_id;
--   DROP TABLE IF EXISTS meeting_locations;
--   DELETE FROM schema_migrations WHERE version = '038_meeting_locations_and_participant_company.sql';
--   (Reuniões presenciais criadas depois da 038 ficariam sem chave: reverter só
--   com o código anterior e sem reuniões presenciais novas.)
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE meeting_locations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Só os importados do catálogo antigo ('sede-matriz', 'sede-leopoldo').
  legacy_key          text        UNIQUE,
  name                text        NOT NULL,
  street              text,
  number              text,
  complement          text,
  neighborhood        text,
  city                text,
  -- UF em maiúsculas.
  state               text,
  -- CEP só com dígitos.
  postal_code         text,
  notes               text,
  is_active           boolean     NOT NULL DEFAULT true,
  -- NULL só nos importados (sem autor humano).
  created_by_user_id  uuid        REFERENCES users (id) ON DELETE RESTRICT,
  updated_by_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_locations_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT meeting_locations_street_check CHECK (street IS NULL OR char_length(btrim(street)) BETWEEN 2 AND 200),
  CONSTRAINT meeting_locations_number_check CHECK (number IS NULL OR char_length(btrim(number)) BETWEEN 1 AND 20),
  CONSTRAINT meeting_locations_complement_check CHECK (complement IS NULL OR char_length(complement) <= 120),
  CONSTRAINT meeting_locations_neighborhood_check CHECK (neighborhood IS NULL OR char_length(neighborhood) <= 120),
  CONSTRAINT meeting_locations_city_check CHECK (city IS NULL OR char_length(btrim(city)) BETWEEN 2 AND 120),
  CONSTRAINT meeting_locations_state_check CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  CONSTRAINT meeting_locations_postal_code_check CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{8}$'),
  CONSTRAINT meeting_locations_notes_check CHECK (notes IS NULL OR char_length(notes) <= 500),
  -- Local ATIVO tem endereço completo; só os importados (inativos) podem não ter.
  CONSTRAINT meeting_locations_active_address_check CHECK (
    NOT is_active OR (street IS NOT NULL AND number IS NOT NULL AND city IS NOT NULL AND state IS NOT NULL AND postal_code IS NOT NULL)
  ),
  CONSTRAINT meeting_locations_author_check CHECK (legacy_key IS NOT NULL OR created_by_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX meeting_locations_name_uk ON meeting_locations (lower(btrim(name)));

CREATE TRIGGER meeting_locations_set_updated_at
  BEFORE UPDATE ON meeting_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE meeting_locations IS
  'Locais físicos cadastrados na Administração para reunião presencial. Sem exclusão: inativar preserva o histórico. A reunião guarda cópia do endereço (physical_location_snapshot).';

-- Catálogo antigo -> locais inativos (só nome; o endereço vinha do ambiente).
INSERT INTO meeting_locations (legacy_key, name, is_active) VALUES
  ('sede-matriz', 'Sede Matriz', false),
  ('sede-leopoldo', 'Sede Leopoldo', false)
ON CONFLICT (legacy_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Reunião: referência + cópia congelada
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN physical_location_id uuid REFERENCES meeting_locations (id) ON DELETE RESTRICT,
  ADD COLUMN physical_location_snapshot jsonb;

ALTER TABLE meetings DISABLE TRIGGER meetings_cancelada_imutavel;
ALTER TABLE meetings DISABLE TRIGGER meetings_set_updated_at;

UPDATE meetings m
   SET physical_location_id = l.id,
       physical_location_snapshot = jsonb_build_object('id', l.id, 'name', l.name)
  FROM meeting_locations l
 WHERE l.legacy_key = m.physical_location_key;

ALTER TABLE meetings ENABLE TRIGGER meetings_set_updated_at;
ALTER TABLE meetings ENABLE TRIGGER meetings_cancelada_imutavel;

-- Chave desconhecida do catálogo (não deveria existir): aborta em vez de perder o dado.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM meetings WHERE physical_location_key IS NOT NULL AND physical_location_id IS NULL) THEN
    RAISE EXCEPTION 'Há reunião presencial com chave de local desconhecida; resolva antes de aplicar a 038.';
  END IF;
END $$;

ALTER TABLE meetings DROP CONSTRAINT meetings_modality_location_check;
ALTER TABLE meetings
  ADD CONSTRAINT meetings_modality_location_check
    CHECK ((modality = 'in_person') = (physical_location_id IS NOT NULL)),
  ADD CONSTRAINT meetings_location_snapshot_pair_check
    CHECK ((physical_location_id IS NULL) = (physical_location_snapshot IS NULL)),
  ADD CONSTRAINT meetings_location_snapshot_object_check
    CHECK (physical_location_snapshot IS NULL OR jsonb_typeof(physical_location_snapshot) = 'object');

COMMENT ON COLUMN meetings.physical_location_id IS
  'Local cadastrado (meeting_locations), só no presencial (038).';
COMMENT ON COLUMN meetings.physical_location_snapshot IS
  'Cópia congelada do local NO MOMENTO da escolha (nome e endereço). Convite, versões, PDF e exportação usam esta cópia.';
COMMENT ON COLUMN meetings.physical_location_key IS
  'DEPRECIADA desde a 038 (catálogo fixo da 025). Preservada; a aplicação não escreve mais.';

-- ---------------------------------------------------------------------------
-- Participantes externos: telefone opcional, empresa opcional
-- ---------------------------------------------------------------------------

ALTER TABLE external_participants ALTER COLUMN phone DROP NOT NULL;
-- O CHECK do formato (026) continua valendo quando há telefone (NULL passa).
ALTER TABLE external_participants
  ADD COLUMN company text,
  ADD CONSTRAINT external_participants_company_check
    CHECK (company IS NULL OR char_length(btrim(company)) BETWEEN 1 AND 200);

COMMENT ON COLUMN external_participants.phone IS 'Opcional desde a 038. Formato validado quando informado.';
COMMENT ON COLUMN external_participants.company IS 'Empresa/organização (opcional, 038).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 038 ignorados.';
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON public.meeting_locations FROM pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.meeting_locations TO pcgp_app';
  RAISE NOTICE 'Privilegios da 038 concedidos a pcgp_app.';
END $$;
