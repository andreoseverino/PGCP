-- =============================================================================
-- 013_calendar_owner_follows_organizer.sql
--
-- Remove `meeting_calendar_integrations.owner_user_id`.
--
-- A 011 modelou o dono da caixa como `users.id`, partindo de uma premissa que a
-- 012 derrubou: a de que o organizador sempre teria conta no PGCP. Agora
-- organizar exige apenas identidade Microsoft — o Presidente nao precisa ter
-- entrado no sistema para ter uma reuniao no calendario dele.
--
-- A correcao NAO e acrescentar colunas de identidade Entra aqui. A caixa de
-- destino E o organizador da reuniao, e `meetings` ja guarda essa identidade
-- desde a 012:
--
--   meetings.organizer_entra_tenant_id
--   meetings.organizer_entra_object_id
--
-- Repetir o dado na integracao criaria duas verdades sobre a mesma pessoa, com
-- a garantia de divergirem no dia em que o organizador for trocado.
--
-- A tabela continua guardando o que so ela sabe: o vinculo com o evento
-- externo, a chave de idempotencia e o estado da sincronizacao.
--
-- SEM PERDA DE DADO: a tabela esta vazia. Nenhum evento externo foi criado ate
-- aqui, e nenhuma integracao existe.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

-- Guarda: se um dia esta migration rodar num banco com integracoes, a decisao
-- precisa ser revista antes, nao silenciosamente aplicada.
DO $$
DECLARE
  existentes integer;
BEGIN
  SELECT count(*) INTO existentes FROM meeting_calendar_integrations;
  IF existentes > 0 THEN
    RAISE EXCEPTION
      'Ha % integracao(oes) de calendario. Remover owner_user_id exigiria migrar o vinculo com o organizador primeiro.',
      existentes;
  END IF;
END $$;

DROP INDEX IF EXISTS meeting_calendar_integrations_owner_idx;

ALTER TABLE meeting_calendar_integrations DROP COLUMN owner_user_id;

COMMENT ON TABLE meeting_calendar_integrations IS
  'Projecao da reuniao do PGCP no calendario externo. A caixa de destino e o ORGANIZADOR da reuniao (meetings.organizer_entra_object_id); esta tabela guarda o vinculo com o evento, a idempotencia e o estado da sincronizacao. PGCP e a fonte de verdade; nao ha sincronizacao de volta.';
