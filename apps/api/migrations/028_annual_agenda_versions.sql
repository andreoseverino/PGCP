-- =============================================================================
-- 028_annual_agenda_versions.sql
--
-- AGENDA ANUAL como consolidação das reuniões do Calendário + versão aprovada.
--
-- O vínculo reunião -> Agenda Anual JÁ existe (025): `meetings.annual_agenda_id`.
-- Ele vale para qualquer reunião do órgão/ano, inclusive as criadas no
-- Calendário (`origin = 'manual'`): `origin` diz onde a reunião nasceu, não se
-- ela faz parte do planejamento. Nenhuma tabela de vínculo nova; nenhuma cópia
-- de reunião, pauta ou tema.
--
-- O que falta é PERSISTIR O QUE FOI SUBMETIDO/APROVADO. O PDF era sempre
-- regerado do estado vigente: depois de uma alteração no Pipeline (novo título,
-- nova data), o "documento aprovado" mudaria retroativamente.
--
-- 1. annual_agenda_versions — uma linha por ENVIO para aprovação.
--
--    `snapshot` (jsonb) é o conteúdo exatamente como foi enviado ao aprovador:
--    agenda, órgão, ano, reuniões (título, data, horário, fuso), pautas e temas.
--    Registrar a aprovação marca A VERSÃO ENVIADA como aprovada — não tira uma
--    foto nova (o aprovador aprovou o que recebeu, não o que existe agora).
--
--    Desfechos: aprovada (`approved_at`) ou retirada (`withdrawn_at`). Uma vez
--    decidida, a linha não muda mais. Em aberto (enviada, sem desfecho): no
--    máximo uma por agenda. Aprovada: no máximo uma por agenda (sem fluxo de
--    revisão V2/V3 nesta etapa).
--
--    IMUTABILIDADE em duas camadas:
--      - privilégios: o papel de runtime só faz SELECT/INSERT e UPDATE das
--        colunas de desfecho; nunca DELETE nem UPDATE do snapshot;
--      - trigger: recusa alterar conteúdo, recusa mudar desfecho já decidido e
--        recusa DELETE — vale até para o dono das tabelas.
--
-- 2. Integridade órgão da reunião = órgão da Agenda Anual.
--
--    Trigger em `meetings`: uma reunião só pode apontar para Agenda Anual do
--    MESMO órgão (ao associar e ao trocar o órgão da reunião). Defesa
--    estrutural contra associação indevida; a aplicação já valida antes.
--    Não revalida linhas existentes (só INSERT/UPDATE futuros).
--
-- TUDO ADITIVO: nenhuma coluna existente muda, nenhuma linha é reescrita.
--
-- REVERSÃO (manual; o runner é forward-only):
--
--   DROP TRIGGER IF EXISTS meetings_annual_agenda_body_check ON meetings;
--   DROP FUNCTION IF EXISTS meetings_annual_agenda_mesmo_orgao();
--   DROP TABLE IF EXISTS annual_agenda_versions;   -- remove triggers/índices dela
--   DROP FUNCTION IF EXISTS annual_agenda_versions_imutavel();
--   DELETE FROM schema_migrations WHERE version = '028_annual_agenda_versions.sql';
--
--   Perde apenas o histórico de versões enviadas/aprovadas. Agendas, reuniões,
--   pautas, temas e eventos permanecem.
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Versões enviadas para aprovação
-- ---------------------------------------------------------------------------

CREATE TABLE annual_agenda_versions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: agenda com versão enviada/aprovada não é excluída.
  annual_agenda_id     uuid        NOT NULL REFERENCES annual_agendas (id) ON DELETE RESTRICT,
  version              integer     NOT NULL,
  snapshot             jsonb       NOT NULL,
  sent_at              timestamptz NOT NULL DEFAULT now(),
  -- Destinatário do pedido (e-mail do aprovador), como em annual_agendas.approval_sent_to.
  sent_to              text        NOT NULL,
  sent_by_user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Quem REGISTROU a aprovação no PGCP (a resposta do aprovador chega por e-mail).
  approved_at          timestamptz,
  approved_by_user_id  uuid        REFERENCES users (id) ON DELETE RESTRICT,
  withdrawn_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT annual_agenda_versions_number_uk UNIQUE (annual_agenda_id, version),
  CONSTRAINT annual_agenda_versions_version_check CHECK (version > 0),
  CONSTRAINT annual_agenda_versions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT annual_agenda_versions_sent_to_check CHECK (char_length(btrim(sent_to)) BETWEEN 3 AND 320),
  CONSTRAINT annual_agenda_versions_approver_pair_check
    CHECK ((approved_at IS NULL) = (approved_by_user_id IS NULL)),
  CONSTRAINT annual_agenda_versions_single_outcome_check
    CHECK (approved_at IS NULL OR withdrawn_at IS NULL)
);

-- No máximo uma versão EM ABERTO (enviada, sem desfecho) por agenda.
CREATE UNIQUE INDEX annual_agenda_versions_open_uk
  ON annual_agenda_versions (annual_agenda_id)
  WHERE approved_at IS NULL AND withdrawn_at IS NULL;

-- No máximo uma versão APROVADA por agenda.
CREATE UNIQUE INDEX annual_agenda_versions_approved_uk
  ON annual_agenda_versions (annual_agenda_id)
  WHERE approved_at IS NOT NULL;

COMMENT ON TABLE annual_agenda_versions IS
  'Versões da Agenda Anual enviadas para aprovação. snapshot = conteúdo exatamente como enviado; imutável.';
COMMENT ON COLUMN annual_agenda_versions.snapshot IS
  'Agenda, órgão, ano, reuniões (título/data/horário/fuso), pautas e temas no momento do envio. Nunca atualizado.';

CREATE FUNCTION annual_agenda_versions_imutavel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Versão da Agenda Anual não pode ser excluída.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.annual_agenda_id IS DISTINCT FROM OLD.annual_agenda_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
     OR NEW.sent_to IS DISTINCT FROM OLD.sent_to
     OR NEW.sent_by_user_id IS DISTINCT FROM OLD.sent_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Conteúdo da versão da Agenda Anual é imutável.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.approved_at IS NOT NULL OR OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'Versão da Agenda Anual já decidida não pode ser alterada.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER annual_agenda_versions_imutavel
  BEFORE UPDATE OR DELETE ON annual_agenda_versions
  FOR EACH ROW EXECUTE FUNCTION annual_agenda_versions_imutavel();


-- ---------------------------------------------------------------------------
-- 2. Reunião só pertence a Agenda Anual do mesmo órgão
-- ---------------------------------------------------------------------------

CREATE FUNCTION meetings_annual_agenda_mesmo_orgao() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  orgao_da_agenda uuid;
BEGIN
  IF NEW.annual_agenda_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT governance_body_id INTO orgao_da_agenda FROM annual_agendas WHERE id = NEW.annual_agenda_id;
  IF orgao_da_agenda IS DISTINCT FROM NEW.governance_body_id THEN
    RAISE EXCEPTION 'A reunião e a Agenda Anual precisam ser do mesmo órgão colegiado.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meetings_annual_agenda_body_check
  BEFORE INSERT OR UPDATE OF annual_agenda_id, governance_body_id ON meetings
  FOR EACH ROW EXECUTE FUNCTION meetings_annual_agenda_mesmo_orgao();


-- ---------------------------------------------------------------------------
-- 3. Privilégios do papel de runtime
--
--    O bootstrap concede `arwd` por DEFAULT PRIVILEGES a toda tabela nova; aqui
--    isso é RESTRINGIDO: sem DELETE e sem UPDATE do snapshot.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 028 ignorados.';
    RETURN;
  END IF;

  EXECUTE 'REVOKE ALL ON public.annual_agenda_versions FROM pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT ON public.annual_agenda_versions TO pcgp_app';
  EXECUTE 'GRANT UPDATE (approved_at, approved_by_user_id, withdrawn_at) ON public.annual_agenda_versions TO pcgp_app';

  RAISE NOTICE 'Privilegios da 028 concedidos a pcgp_app.';
END $$;
