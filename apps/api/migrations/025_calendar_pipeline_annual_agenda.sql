-- =============================================================================
-- 025_calendar_pipeline_annual_agenda.sql
--
-- Reestruturacao do fluxo principal:
--
--   AGENDA ANUAL -> reserva antecipada -> CALENDARIO/OUTLOOK/TEAMS -> PIPELINE
--   -> preparacao -> PAUTAS -> TEMAS -> REUNIAO -> ATA/DECISOES/ACOES
--
-- TUDO AQUI E ADITIVO. Nenhuma coluna e renomeada ou removida, nenhuma linha e
-- reescrita. Registros existentes continuam validos pelos DEFAULTs.
--
-- 1. MODALIDADE (online | in_person) e LOCAL FISICO por CHAVE DE CATALOGO.
--
--    A 021 retirou o texto livre `location`. Ele NAO volta: o local agora e uma
--    chave do catalogo da aplicacao (`meetings/locations.ts`), e o endereco vem
--    da configuracao do ambiente — nunca digitado nem inventado. Toda reuniao
--    continua nascendo com Teams (`online_meeting_provider`, 014): no
--    presencial o Teams e contingencia.
--
--    Sem tabela de localidades de proposito: sao duas sedes conhecidas e os
--    enderecos oficiais ainda nao existem no repositorio. A validade da chave e
--    da aplicacao (nao CHECK) para uma sede nova nao exigir migration.
--
-- 2. PAUTA como agrupador de TEMAS.
--
--    Modelo conceitual: REUNIAO -> PAUTA -> TEMA. O que o codigo chama de
--    `meeting_agenda_items` sempre foi o assunto especifico (responsavel,
--    duracao, participantes, Chamar no Teams) — ou seja, o TEMA. Faltava o
--    agrupador (ex.: "Financas", "Auditoria"): `meeting_agendas`.
--
--    `meeting_agenda_items.meeting_agenda_id` e ANULAVEL: itens existentes
--    ficam como "temas sem pauta", sem backfill e sem adivinhar agrupamento.
--    A FK e COMPOSTA com `meeting_id` — o banco impede que um tema aponte para
--    a pauta de OUTRA reuniao (IDOR estrutural, nao so checagem de aplicacao).
--    Nao existe nivel intermediario ("bloco"): Pauta -> Tema, e so.
--
-- 3. AGENDA ANUAL + ORIGEM DA REUNIAO.
--
--    `annual_agendas` e o planejamento de um orgao num ano; `annual_agenda_items`
--    sao as datas previstas. Reservar cria a reuniao (`meetings`) e o evento
--    Outlook/Teams ANTES da aprovacao do planejamento — regra de produto: a
--    agenda de executivos e reservada cedo. A aprovacao da Agenda Anual e um
--    eixo proprio (`annual_agendas.status`), independente da reserva.
--
--    `meetings.origin` diz de onde a reuniao veio (manual | annual_agenda).
--    `annual_agenda_items.meeting_id` UNIQUE e o que impede reservar a mesma
--    data duas vezes (idempotencia estrutural da reserva).
--
-- REVERSAO (manual; o runner e forward-only e aplicaria qualquer .sql desta
-- pasta, por isso o "down" fica aqui em comentario):
--
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_annual_agenda_fk;
--   DROP TABLE IF EXISTS annual_agenda_items;
--   DROP TABLE IF EXISTS annual_agendas;
--   ALTER TABLE meeting_agenda_items DROP CONSTRAINT IF EXISTS meeting_agenda_items_agenda_fk;
--   ALTER TABLE meeting_agenda_items DROP COLUMN IF EXISTS meeting_agenda_id;
--   DROP TABLE IF EXISTS meeting_agendas;
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_modality_location_check;
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_modality_check;
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_origin_check;
--   ALTER TABLE meetings DROP COLUMN IF EXISTS annual_agenda_id,
--                        DROP COLUMN IF EXISTS origin,
--                        DROP COLUMN IF EXISTS physical_location_key,
--                        DROP COLUMN IF EXISTS modality;
--   DELETE FROM schema_migrations WHERE version = '025_calendar_pipeline_annual_agenda.sql';
--
--   Perde apenas o que esta migration criou (pautas-agrupadoras, agendas anuais,
--   modalidade/local). Reunioes, temas, participantes e eventos permanecem.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Modalidade e local fisico
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN modality text NOT NULL DEFAULT 'online',
  -- Chave do catalogo de locais (ex.: 'sede-matriz'). Nunca endereco livre.
  ADD COLUMN physical_location_key text;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_modality_check CHECK (modality IN ('online', 'in_person')),
  -- Presencial exige local; online nao carrega local. Linhas antigas sao
  -- 'online' + NULL e satisfazem a regra sem backfill.
  ADD CONSTRAINT meetings_modality_location_check CHECK (
    (modality = 'in_person') = (physical_location_key IS NOT NULL)
  ),
  ADD CONSTRAINT meetings_physical_location_key_len_check CHECK (
    physical_location_key IS NULL OR char_length(physical_location_key) BETWEEN 1 AND 64
  );

COMMENT ON COLUMN meetings.modality IS
  'online | in_person. Toda reuniao tem Teams (online_meeting_provider); no presencial ele e contingencia.';
COMMENT ON COLUMN meetings.physical_location_key IS
  'Chave do catalogo de locais da aplicacao (meetings/locations.ts). Endereco vem da configuracao, nunca digitado.';


-- ---------------------------------------------------------------------------
-- 2. Pauta (agrupador) -> Tema (meeting_agenda_items)
-- ---------------------------------------------------------------------------

CREATE TABLE meeting_agendas (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  title       text        NOT NULL,
  position    integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_agendas_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT meeting_agendas_position_check CHECK (position >= 1),
  -- Alvo da FK composta dos temas: (pauta, reuniao) juntos.
  CONSTRAINT meeting_agendas_id_meeting_uk UNIQUE (id, meeting_id)
);

CREATE INDEX meeting_agendas_meeting_idx ON meeting_agendas (meeting_id, position);

CREATE TRIGGER meeting_agendas_set_updated_at
  BEFORE UPDATE ON meeting_agendas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE meeting_agendas IS
  'PAUTA da reuniao: agrupa TEMAS (meeting_agenda_items). Reuniao -> Pauta -> Tema; nao ha nivel intermediario.';

ALTER TABLE meeting_agenda_items
  ADD COLUMN meeting_agenda_id uuid;

-- COMPOSTA: o tema so pode apontar para uma pauta da MESMA reuniao. MATCH
-- SIMPLE (padrao): tema sem pauta (NULL) nao e verificado — compatibilidade.
-- Sem ON DELETE: excluir pauta com temas e recusado (a aplicacao responde 409).
ALTER TABLE meeting_agenda_items
  ADD CONSTRAINT meeting_agenda_items_agenda_fk
    FOREIGN KEY (meeting_agenda_id, meeting_id)
    REFERENCES meeting_agendas (id, meeting_id);

CREATE INDEX meeting_agenda_items_agenda_idx
  ON meeting_agenda_items (meeting_agenda_id)
  WHERE meeting_agenda_id IS NOT NULL;

COMMENT ON COLUMN meeting_agenda_items.meeting_agenda_id IS
  'Pauta (meeting_agendas) a que este TEMA pertence. NULL = tema sem pauta (itens anteriores a 025).';


-- ---------------------------------------------------------------------------
-- 3. Agenda Anual e origem da reuniao
-- ---------------------------------------------------------------------------

CREATE TABLE annual_agendas (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  governance_body_id   uuid        NOT NULL REFERENCES governance_bodies (id) ON DELETE RESTRICT,
  year                 integer     NOT NULL,
  title                text        NOT NULL,

  /*
   * Ciclo de APROVACAO do planejamento. NAO governa a reserva: reunioes podem
   * estar no calendario dos participantes com a agenda em 'draft' ou
   * 'pending_approval'.
   */
  status               text        NOT NULL DEFAULT 'draft',
  approval_sent_at     timestamptz,
  approval_sent_to     text,
  approved_at          timestamptz,
  approved_by_user_id  uuid        REFERENCES users (id) ON DELETE RESTRICT,

  created_by_user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT annual_agendas_year_check CHECK (year BETWEEN 2000 AND 2100),
  CONSTRAINT annual_agendas_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT annual_agendas_status_check CHECK (status IN ('draft', 'pending_approval', 'approved')),
  -- Mesma coerencia de 016 para a validacao de pautas.
  CONSTRAINT annual_agendas_status_coerente_check CHECK (
    (status = 'draft' AND approval_sent_at IS NULL AND approved_at IS NULL)
    OR (status = 'pending_approval' AND approval_sent_at IS NOT NULL AND approved_at IS NULL)
    OR (status = 'approved' AND approved_at IS NOT NULL)
  )
);

CREATE INDEX annual_agendas_body_year_idx ON annual_agendas (governance_body_id, year);

CREATE TRIGGER annual_agendas_set_updated_at
  BEFORE UPDATE ON annual_agendas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE annual_agendas IS
  'Planejamento anual das reunioes de um orgao. A reserva das agendas NAO espera a aprovacao (status).';

CREATE TABLE annual_agenda_items (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  annual_agenda_id  uuid        NOT NULL REFERENCES annual_agendas (id) ON DELETE CASCADE,
  title             text        NOT NULL,
  -- Data/horario PLANEJADOS. Depois da reserva, a verdade e a reuniao
  -- (`meetings.start_at`/`end_at`), editada pelo Pipeline.
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  timezone          text        NOT NULL DEFAULT 'America/Sao_Paulo',
  -- Reuniao criada pela reserva. UNIQUE: uma data prevista vira no maximo uma
  -- reuniao. SET NULL: excluir a reuniao devolve a data para "nao reservada".
  meeting_id        uuid        UNIQUE REFERENCES meetings (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT annual_agenda_items_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT annual_agenda_items_end_after_start_check CHECK (end_at > start_at)
);

CREATE INDEX annual_agenda_items_agenda_idx ON annual_agenda_items (annual_agenda_id, start_at);

CREATE TRIGGER annual_agenda_items_set_updated_at
  BEFORE UPDATE ON annual_agenda_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE meetings
  ADD COLUMN origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN annual_agenda_id uuid;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_origin_check CHECK (origin IN ('manual', 'annual_agenda')),
  -- SET NULL: excluir a Agenda Anual nao apaga reuniao ja reservada; `origin`
  -- continua dizendo de onde ela veio.
  ADD CONSTRAINT meetings_annual_agenda_fk
    FOREIGN KEY (annual_agenda_id) REFERENCES annual_agendas (id) ON DELETE SET NULL;

CREATE INDEX meetings_annual_agenda_idx ON meetings (annual_agenda_id) WHERE annual_agenda_id IS NOT NULL;

COMMENT ON COLUMN meetings.origin IS
  'De onde a reuniao veio: manual (Calendario) | annual_agenda (reserva da Agenda Anual).';


-- ---------------------------------------------------------------------------
-- 4. Privilegios do papel de runtime (tabelas novas nascem sem GRANT; mesma
--    tolerancia de 015/016/020: sem o papel, apenas avisa).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 025 ignorados.';
    RETURN;
  END IF;

  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_agendas TO pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.annual_agendas TO pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.annual_agenda_items TO pcgp_app';

  RAISE NOTICE 'Privilegios da 025 concedidos a pcgp_app.';
END $$;
