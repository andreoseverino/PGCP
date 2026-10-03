-- =============================================================================
-- 031_meeting_participant_exclusions.sql
--
-- EXCECAO POR REUNIAO para a inclusao automatica de participantes.
--
-- A partir desta revisao, os GRUPOS DE PARTICIPACAO incluem pessoas
-- automaticamente:
--
--   Grupo do Orgao colegiado  participant_governance_bodies (027) -> ao CRIAR
--                             a reuniao do orgao
--   Participantes padrao      agenda_topic_participants (Biblioteca) -> quando
--   do Tema                   o tema entra na reuniao (copia ja existente, 020)
--
-- Remover a pessoa de UMA reuniao nao mexe no grupo. Esta tabela lembra que
-- ela foi removida DAQUELA reuniao, para que nenhuma inclusao automatica
-- posterior (ex.: tema da Biblioteca adicionado depois) a traga de volta.
-- Adicionar a pessoa a mao na mesma reuniao apaga a excecao.
--
-- Identidade = a mesma de `meeting_participants` (o que foi removido):
--   pessoa Microsoft  (entra_tenant_id, entra_object_id)
--   convidado         e-mail (externo do PGCP ou convidado avulso)
-- Sem FK para external_participants/directory_people: a excecao e sobre a
-- pessoa NA REUNIAO, e participantes padrao do Tema nao vivem nesses
-- cadastros. Apagar um cadastro nao deixa excecao orfa de sentido — ela segue
-- valendo so para a reuniao, e some com ela (CASCADE).
--
-- Aditiva: nenhuma linha existente e lida ou alterada.
--
-- REVERSAO (manual; runner forward-only):
--   DROP TABLE IF EXISTS meeting_participant_exclusions;
--   COMMENT ON TABLE participant_governance_bodies IS
--     'Classificacao pessoa <-> orgao colegiado (0..N). So sugestao; nao autoriza nem inclui em reuniao.';
--   DELETE FROM schema_migrations WHERE version = '031_meeting_participant_exclusions.sql';
--   (So junto com o codigo anterior a esta revisao: o codigo atual grava e le a
--   excecao ao remover/incluir participante e falharia sem a tabela.)
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE meeting_participant_exclusions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  entra_tenant_id     uuid,
  entra_object_id     uuid,
  -- Snapshot do endereco no momento da remocao (convidado e identificado por ele).
  email               text,
  created_by_user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_participant_exclusions_entra_pairing_check
    CHECK ((entra_tenant_id IS NULL) = (entra_object_id IS NULL)),
  CONSTRAINT meeting_participant_exclusions_identity_check
    CHECK (entra_object_id IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT meeting_participant_exclusions_email_check
    CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 320)
);

-- A mesma pessoa nao e excluida duas vezes da mesma reuniao.
CREATE UNIQUE INDEX meeting_participant_exclusions_entra_uk
  ON meeting_participant_exclusions (meeting_id, entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL;

CREATE UNIQUE INDEX meeting_participant_exclusions_email_uk
  ON meeting_participant_exclusions (meeting_id, lower(email))
  WHERE entra_object_id IS NULL;

COMMENT ON TABLE meeting_participant_exclusions IS
  'Pessoa removida explicitamente desta reuniao: a inclusao automatica (grupo do orgao, participantes padrao do tema) nao a traz de volta. Nao altera os grupos.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 031 ignorados.';
    RETURN;
  END IF;
  -- Criada ou apagada, nunca alterada no lugar.
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.meeting_participant_exclusions TO pcgp_app';
  RAISE NOTICE 'Privilegios da 031 concedidos a pcgp_app.';
END $$;

-- Metadado (sem dado): o vinculo pessoa <-> orgao da 027 passa a ser o GRUPO DO
-- ORGAO, que inclui a pessoa nas reunioes NOVAS do orgao. participant_topics
-- continua so sugestao (participantes padrao do tema = agenda_topic_participants).
COMMENT ON TABLE participant_governance_bodies IS
  'Grupo de participacao do orgao colegiado (027/031): inclui a pessoa nas reunioes NOVAS do orgao. Nao autoriza nem e App Role; nao altera reunioes existentes.';
