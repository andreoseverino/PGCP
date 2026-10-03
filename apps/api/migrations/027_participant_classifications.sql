-- =============================================================================
-- 027_participant_classifications.sql
--
-- CLASSIFICACAO de pessoas por Orgaos colegiados (0..N) e Temas (0..N), para
-- SUGERIR participantes. Nao e autorizacao, nao e App Role, nao inclui
-- ninguem em reuniao ou tema automaticamente.
--
-- Duas origens de pessoa, sem misturar identidades:
--
--   external_participants (026)  externo do PGCP — ja existe
--   directory_people (NOVA)      pessoa do Microsoft Entra ID com
--                                classificacao no PGCP. So o par
--                                (tenant, oid) + snapshot de nome/e-mail.
--                                NAO e `users` (so quem fez login vira user,
--                                no JIT) e NAO e external_participant. Uma linha
--                                existe apenas para quem foi explicitamente
--                                vinculado pela Administracao — nada de
--                                sincronizar o tenant.
--
-- TEMAS = Biblioteca de Temas (`agenda_topics`), o catalogo reutilizavel. A
-- ocorrencia do tema numa reuniao (`meeting_agenda_items`) NAO e usada aqui.
-- Por que nao reaproveitar `agenda_topic_participants`: aquela relacao e
-- COPIADA para a reuniao quando o tema e vinculado (snapshot 020) — usa-la
-- como classificacao adicionaria pessoas automaticamente. Esta e outra
-- relacao, sobre o MESMO catalogo.
--
-- Duas tabelas de vinculo (orgao, tema), cada uma com sujeito exclusivo:
-- externo XOR pessoa do diretorio (CHECK num_nonnulls = 1). Indices unicos
-- parciais impedem vinculo duplicado.
--
-- COMPATIBILIDADE COM 026: o `external_participants.governance_body_id`
-- existente vira vinculo N:N aqui (backfill). A coluna NAO e removida nesta
-- migration; deixa de ser lida e escrita pela aplicacao (depreciada).
--
-- REVERSAO (manual; runner forward-only):
--   DROP TABLE IF EXISTS participant_topics;
--   DROP TABLE IF EXISTS participant_governance_bodies;
--   DROP TABLE IF EXISTS directory_people;
--   DELETE FROM schema_migrations WHERE version = '027_participant_classifications.sql';
--   (external_participants.governance_body_id segue intacta com o valor da 026.)
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE directory_people (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identidade Microsoft: tenant vem do token de quem vinculou, oid do Graph.
  entra_tenant_id     uuid        NOT NULL,
  entra_object_id     uuid        NOT NULL,
  -- Snapshot para exibicao/convite, lido do Graph no vinculo. Nunca identidade.
  display_name        text        NOT NULL,
  email               text,
  created_by_user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT directory_people_name_check CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 300),
  CONSTRAINT directory_people_identity_uk UNIQUE (entra_tenant_id, entra_object_id)
);

CREATE TRIGGER directory_people_set_updated_at
  BEFORE UPDATE ON directory_people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE directory_people IS
  'Pessoa do Entra ID com classificacao no PGCP (orgaos/temas). Nao e usuario, nao e externo, nao autoriza nada.';

CREATE TABLE participant_governance_bodies (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  external_participant_id  uuid        REFERENCES external_participants (id) ON DELETE CASCADE,
  directory_person_id      uuid        REFERENCES directory_people (id) ON DELETE CASCADE,
  -- Orgaos nao sao apagados (is_active); RESTRICT protege o vinculo.
  governance_body_id       uuid        NOT NULL REFERENCES governance_bodies (id) ON DELETE RESTRICT,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT participant_governance_bodies_subject_check
    CHECK (num_nonnulls(external_participant_id, directory_person_id) = 1)
);

CREATE UNIQUE INDEX participant_governance_bodies_external_uk
  ON participant_governance_bodies (external_participant_id, governance_body_id)
  WHERE external_participant_id IS NOT NULL;
CREATE UNIQUE INDEX participant_governance_bodies_directory_uk
  ON participant_governance_bodies (directory_person_id, governance_body_id)
  WHERE directory_person_id IS NOT NULL;
-- Sugestao parte do orgao: "quem esta classificado neste orgao?"
CREATE INDEX participant_governance_bodies_body_idx
  ON participant_governance_bodies (governance_body_id);

CREATE TABLE participant_topics (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  external_participant_id  uuid        REFERENCES external_participants (id) ON DELETE CASCADE,
  directory_person_id      uuid        REFERENCES directory_people (id) ON DELETE CASCADE,
  -- Tema do CATALOGO (Biblioteca). Excluir o tema da Biblioteca remove a
  -- classificacao (metadado), nunca a pessoa.
  agenda_topic_id          uuid        NOT NULL REFERENCES agenda_topics (id) ON DELETE CASCADE,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT participant_topics_subject_check
    CHECK (num_nonnulls(external_participant_id, directory_person_id) = 1)
);

CREATE UNIQUE INDEX participant_topics_external_uk
  ON participant_topics (external_participant_id, agenda_topic_id)
  WHERE external_participant_id IS NOT NULL;
CREATE UNIQUE INDEX participant_topics_directory_uk
  ON participant_topics (directory_person_id, agenda_topic_id)
  WHERE directory_person_id IS NOT NULL;
CREATE INDEX participant_topics_topic_idx ON participant_topics (agenda_topic_id);

COMMENT ON TABLE participant_governance_bodies IS
  'Classificacao pessoa <-> orgao colegiado (0..N). So sugestao; nao autoriza nem inclui em reuniao.';
COMMENT ON TABLE participant_topics IS
  'Classificacao pessoa <-> tema da Biblioteca (agenda_topics, 0..N). So sugestao; nao inclui em tema/reuniao.';

-- ---------------------------------------------------------------------------
-- Backfill: orgao unico da 026 vira vinculo N:N. Coluna antiga preservada.
-- ---------------------------------------------------------------------------
INSERT INTO participant_governance_bodies (external_participant_id, governance_body_id)
SELECT id, governance_body_id
  FROM external_participants
 WHERE governance_body_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN external_participants.governance_body_id IS
  'DEPRECIADA desde a 027: substituida por participant_governance_bodies (N:N). Valor preservado da 026; a aplicacao nao le nem escreve.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 027 ignorados.';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.directory_people TO pcgp_app';
  -- Vinculos sao substituidos (DELETE + INSERT), nunca alterados no lugar.
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.participant_governance_bodies TO pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.participant_topics TO pcgp_app';
  RAISE NOTICE 'Privilegios da 027 concedidos a pcgp_app.';
END $$;
