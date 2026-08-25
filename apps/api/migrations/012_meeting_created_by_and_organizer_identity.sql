-- =============================================================================
-- 012_meeting_created_by_and_organizer_identity.sql
--
-- Separa tres conceitos que ate aqui eram a mesma coluna:
--
--   created_by  quem EXECUTOU o cadastro no PGCP (usuario autenticado)
--   organizer   pessoa em cuja caixa o evento do Outlook sera criado
--   attendee    quem foi convidado (ja modelado em meeting_participants)
--
-- O caso que exige a separacao e real e comum: a assessora cadastra a reuniao,
-- mas o evento pertence ao calendario do Presidente.
--
--   created_by = Maria (assessora)
--   organizer  = Joao (Presidente)
--
-- ANTES: `createMeeting` gravava `organizer_user_id = actor.userId`. Isto e,
-- "quem criou" era gravado como "de quem e o calendario" — as duas coisas so
-- coincidiam porque ninguem ainda cadastrava em nome de outra pessoa.
--
-- ORGANIZADOR NAO PRECISA DE CONTA NO PGCP. Exigir que o Presidente entrasse
-- uma vez no sistema so para poder ser organizador seria criar um requisito
-- artificial. A identidade primaria dele e a MICROSOFT — (tenant, oid) —, o
-- mesmo padrao ja usado em meeting_participants, agenda_topic_participants e
-- meeting_minute_signers.
--
-- NUNCA reconciliar organizador por nome, e-mail ou cargo. `organizer_name` e
-- `organizer_email` sao snapshot de exibicao e endereco de entrega.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Quem cadastrou
-- -----------------------------------------------------------------------------
ALTER TABLE meetings
  -- ON DELETE RESTRICT: nao se apaga quem cadastrou uma reuniao. O sistema
  -- desativa usuario (`users.is_active`), nao remove.
  ADD COLUMN created_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT;

/*
 * BACKFILL com semantica auditada, nao com chute.
 *
 * Ate esta migration, `createMeeting` gravava o ator autenticado em
 * `organizer_user_id`. Historicamente, portanto, aquela coluna significava
 * "quem cadastrou" — e copiar o valor e a leitura CORRETA do passado, nao uma
 * aproximacao.
 *
 * O organizador permanece como esta: nas reunioes existentes as duas pessoas
 * eram de fato a mesma, e reescrever `organizer_user_id` inventaria uma
 * distincao que nao existiu.
 */
UPDATE meetings SET created_by_user_id = organizer_user_id WHERE created_by_user_id IS NULL;

-- NOT NULL depois do backfill: toda reuniao nova nasce de um usuario
-- autenticado, e o valor vem do token — nunca do corpo da requisicao.
ALTER TABLE meetings ALTER COLUMN created_by_user_id SET NOT NULL;

CREATE INDEX meetings_created_by_user_id_idx ON meetings (created_by_user_id);

COMMENT ON COLUMN meetings.created_by_user_id IS
  'users.id de quem cadastrou a reuniao no PGCP. Vem do usuario autenticado, nunca do corpo da requisicao. Distinto do organizador.';

-- -----------------------------------------------------------------------------
-- 2. Identidade do organizador
-- -----------------------------------------------------------------------------
ALTER TABLE meetings
  -- Identidade MICROSOFT do organizador: tid + oid. E ela que resolve a caixa
  -- em /users/{oid}/events, e e ela que o Exchange Resource Scope filtra.
  ADD COLUMN organizer_entra_tenant_id uuid,
  ADD COLUMN organizer_entra_object_id uuid,
  -- Snapshot de exibicao, capturado no momento da escolha no diretorio.
  ADD COLUMN organizer_name text,
  -- Endereco de entrega do convite. NAO e identidade.
  ADD COLUMN organizer_email text;

/*
 * Backfill da identidade Microsoft a partir de quem ja e organizador com conta
 * no PGCP. Nao inventa nada: copia o que `users` ja sabe sobre a mesma pessoa.
 */
UPDATE meetings m
   SET organizer_entra_tenant_id = u.entra_tenant_id,
       organizer_entra_object_id = u.entra_object_id,
       organizer_name            = u.name,
       organizer_email           = u.email
  FROM users u
 WHERE u.id = m.organizer_user_id
   AND m.organizer_entra_object_id IS NULL
   AND u.entra_object_id IS NOT NULL;

ALTER TABLE meetings
  -- O par nasce e morre junto: meia identidade nao identifica ninguem.
  ADD CONSTRAINT meetings_organizer_entra_pairing_check CHECK (
    (organizer_entra_object_id IS NULL) = (organizer_entra_tenant_id IS NULL)
  ),

  -- Identidade Microsoft exige nome: a evidencia de quem organiza precisa ser
  -- legivel mesmo para quem nao tem conta no PGCP.
  ADD CONSTRAINT meetings_organizer_entra_needs_name_check CHECK (
    organizer_entra_object_id IS NULL OR length(btrim(COALESCE(organizer_name, ''))) > 0
  );

COMMENT ON COLUMN meetings.organizer_user_id IS
  'users.id do organizador quando ele tem conta no PGCP. ANULAVEL: organizar nao exige conta aqui. A identidade primaria e o par (organizer_entra_tenant_id, organizer_entra_object_id).';

COMMENT ON COLUMN meetings.organizer_entra_object_id IS
  'oid do organizador no Entra. Identidade MICROSOFT — e ela que resolve a caixa do calendario. Nunca substituida por nome ou e-mail.';

COMMENT ON COLUMN meetings.organizer_name IS
  'Snapshot de exibicao do organizador no momento da escolha. Nunca serve para reconciliar pessoa.';

COMMENT ON COLUMN meetings.organizer_email IS
  'Endereco de entrega do convite. NAO e identidade.';

CREATE INDEX meetings_organizer_entra_idx
  ON meetings (organizer_entra_tenant_id, organizer_entra_object_id)
  WHERE organizer_entra_object_id IS NOT NULL;
