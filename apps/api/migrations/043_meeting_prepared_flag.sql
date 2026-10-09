-- =============================================================================
-- 043_meeting_prepared_flag.sql
--
-- MARCA "PREPARADA" NA AGENDA ANUAL (10/2026). Na Agenda Anual, quem monta a
-- reunião marca "Preparada" quando termina de cadastrar pautas e temas — só
-- SINALIZAÇÃO para a equipe ver o andamento.
--
-- NÃO É ESTADO DE FLUXO: não muda `status`, não gera versão da reunião (034),
-- não dispara convite, e-mail ou Graph, não trava edição. Desmarcar é livre.
--
--   prepared_at            quando foi marcada (NULL = não marcada)
--   prepared_by_user_id    quem marcou
--
-- Regra (CHECK): desmarcada não tem autor. Marcada pode perder o autor se o
-- usuário for excluído (ON DELETE SET NULL) — a marca continua.
-- Privilégios: pcgp_app já tem UPDATE em meetings (015).
--
-- TUDO ADITIVO: reuniões existentes ficam não marcadas.
--
-- REVERSÃO (manual):
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_prepared_check,
--     DROP COLUMN IF EXISTS prepared_by_user_id, DROP COLUMN IF EXISTS prepared_at;
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE meetings
  ADD COLUMN prepared_at timestamptz,
  ADD COLUMN prepared_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_prepared_check
    CHECK (prepared_at IS NOT NULL OR prepared_by_user_id IS NULL);

COMMENT ON COLUMN meetings.prepared_at IS
  'Marca "Preparada" da Agenda Anual: só sinalização, sem efeito em fluxo, versão ou convite.';
COMMENT ON COLUMN meetings.prepared_by_user_id IS 'Quem marcou a reunião como preparada.';
