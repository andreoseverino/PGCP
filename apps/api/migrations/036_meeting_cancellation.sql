-- =============================================================================
-- 036_meeting_cancellation.sql
--
-- EXCLUIR REUNIÃO = CANCELAMENTO LÓGICO. Nada do histórico é apagado.
--
-- Até aqui `DELETE /meetings/:id` apagava a linha e a cascata levava
-- participantes, pautas, temas, Anotações, Ata, integração de calendário e — o
-- que esta migration impede — as VERSÕES da reunião (034). A reunião agora é
-- marcada como cancelada e sai dos fluxos ativos (Pipeline, Calendário, Agenda
-- Anual, exportação, grupos), mas continua legível como histórico: detalhe,
-- versões e PDFs, documentos, Ata, `audit_logs`.
--
--   cancelled_at / cancelled_by_user_id  quem cancelou e quando (par coerente)
--   calendar_event_cancelled_at          o evento do Outlook/Teams foi
--                                        cancelado no Graph. NULL com evento
--                                        existente = cancelamento EXTERNO
--                                        PENDENTE (falha do Graph), e repetir
--                                        a exclusão tenta de novo.
--
-- Garantias no BANCO (defesa em profundidade):
--   - reunião cancelada não volta: trigger recusa limpar `cancelled_at` e
--     recusa alterar qualquer outra coluna dela (só registrar o cancelamento
--     do evento externo);
--   - `meeting_versions` deixa de ter ON DELETE CASCADE: RESTRICT;
--   - o papel de runtime perde DELETE em `meetings` — não há mais exclusão
--     física pela aplicação.
--
-- Sem soft delete genérico: só a reunião precisava disso.
--
-- ADITIVA: nenhuma linha existente muda (todas ficam ativas).
--
-- REVERSÃO (manual; runner forward-only):
--   DROP TRIGGER IF EXISTS meetings_cancelada_imutavel ON meetings;
--   DROP FUNCTION IF EXISTS meetings_cancelada_imutavel();
--   ALTER TABLE meeting_versions DROP CONSTRAINT meeting_versions_meeting_fk;
--   ALTER TABLE meeting_versions ADD CONSTRAINT meeting_versions_meeting_id_fkey
--     FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE;
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_cancelled_pair_check,
--                        DROP CONSTRAINT IF EXISTS meetings_calendar_cancel_check;
--   ALTER TABLE meetings DROP COLUMN calendar_event_cancelled_at,
--                        DROP COLUMN cancelled_by_user_id, DROP COLUMN cancelled_at;
--   GRANT DELETE ON meetings TO pcgp_app;  -- só se o código anterior voltar
--   DELETE FROM schema_migrations WHERE version = '036_meeting_cancellation.sql';
--   (Reuniões canceladas voltariam a parecer ativas: reverter só com o código anterior.)
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE meetings
  ADD COLUMN cancelled_at                timestamptz,
  ADD COLUMN cancelled_by_user_id        uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN calendar_event_cancelled_at timestamptz;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_cancelled_pair_check
    CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)),
  -- Evento externo só é "cancelado" junto de uma reunião cancelada.
  ADD CONSTRAINT meetings_calendar_cancel_check
    CHECK (calendar_event_cancelled_at IS NULL OR cancelled_at IS NOT NULL);

-- Fluxos ativos filtram `cancelled_at IS NULL`.
CREATE INDEX meetings_active_start_idx ON meetings (start_at) WHERE cancelled_at IS NULL;

COMMENT ON COLUMN meetings.cancelled_at IS
  'Reunião cancelada/excluída logicamente (036). Sai dos fluxos ativos; histórico preservado. Nunca volta a NULL.';
COMMENT ON COLUMN meetings.calendar_event_cancelled_at IS
  'Evento do Outlook/Teams cancelado no Graph. NULL com evento existente = cancelamento externo pendente.';

CREATE FUNCTION meetings_cancelada_imutavel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelled_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.cancelled_at IS NULL THEN
    RAISE EXCEPTION 'Reunião cancelada não pode ser reativada.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Única mudança permitida: registrar o cancelamento do evento externo.
  IF (to_jsonb(NEW) - 'calendar_event_cancelled_at' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'calendar_event_cancelled_at' - 'updated_at') THEN
    RAISE EXCEPTION 'Reunião cancelada é somente leitura.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meetings_cancelada_imutavel
  BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION meetings_cancelada_imutavel();

-- Versões nunca somem por cascata.
ALTER TABLE meeting_versions DROP CONSTRAINT meeting_versions_meeting_id_fkey;
ALTER TABLE meeting_versions
  ADD CONSTRAINT meeting_versions_meeting_fk
  FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE RESTRICT;

-- O trigger da 034 permitia DELETE de versão só quando a reunião já não existia
-- (cascata). Sem cascata, nenhuma remoção é permitida.
CREATE OR REPLACE FUNCTION meeting_versions_imutavel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Versão da reunião não pode ser excluída.'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'Versão da reunião é imutável.'
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON TABLE meeting_versions IS
  'Versões auditáveis da reunião: snapshot imutável a cada alteração relevante persistida, inclusive o cancelamento (036). Nunca apagadas.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: revoke da 036 ignorado.';
    RETURN;
  END IF;
  EXECUTE 'REVOKE DELETE ON public.meetings FROM pcgp_app';
  RAISE NOTICE 'DELETE em meetings revogado de pcgp_app (036).';
END $$;
