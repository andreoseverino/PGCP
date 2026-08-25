-- =============================================================================
-- 001_initial_schema.sql
--
-- Schema inicial do PGCP. Reflete docs/modelo-de-dados.md (revisao 3).
--
-- O runner (apps/api/src/migrate.ts) aplica este arquivo dentro de uma
-- transacao: NAO incluir BEGIN/COMMIT aqui.
--
-- Ordem: cadastros independentes -> entidades principais -> vinculos ->
-- entidades operacionais. Nenhuma constraint e desabilitada.
--
-- UUID: gen_random_uuid() e nativo do PostgreSQL 13+ (sem CREATE EXTENSION).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Apoio: mantem updated_at coerente sem depender da aplicacao lembrar.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- NIVEL 0 - cadastros independentes (sem FK)
-- =============================================================================

-- Identidades reconhecidas pelo sistema.
-- Convidado externo NAO precisa existir aqui (ver meeting_participants).
CREATE TABLE users (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  upn         text,
  external_id text        UNIQUE,
  job_title   text,
  phone       text,
  user_type   text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  synced_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_user_type_check CHECK (user_type IN ('internal', 'external'))
);

COMMENT ON TABLE  users IS 'Identidades reconhecidas pelo sistema. Convidado externo sem conta vive em meeting_participants.';
COMMENT ON COLUMN users.external_id IS 'objectId do Entra ID. UNIQUE aceita multiplos NULL no PostgreSQL.';
COMMENT ON COLUMN users.job_title IS 'Cargo na empresa. Diferente de meeting_participants.role_in_meeting.';


-- Orgaos colegiados. Fonte oficial de classificacao das reunioes (Decisao 1).
CREATE TABLE governance_bodies (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  icon       text,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE governance_bodies IS 'Conselho de Administracao, Diretoria Executiva, Conselho Fiscal, Comites, Assembleia.';


-- Cadastro: Pauta Regular / Pauta Excepcional.
CREATE TABLE agenda_topic_types (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- Cadastro: Deliberativa / Informativa / Debate Estrategico / Remuneracao / ...
CREATE TABLE agenda_topic_natures (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- =============================================================================
-- NIVEL 1 - entidades principais
-- =============================================================================

CREATE TABLE meetings (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  governance_body_id   uuid        NOT NULL REFERENCES governance_bodies (id) ON DELETE RESTRICT,
  organizer_user_id    uuid        REFERENCES users (id) ON DELETE RESTRICT,
  title                text        NOT NULL,
  description          text,
  start_at             timestamptz NOT NULL,
  end_at               timestamptz NOT NULL,
  timezone             text        NOT NULL DEFAULT 'America/Sao_Paulo',
  location             text,
  meeting_link         text,
  status               text        NOT NULL,
  recurrence           text,
  pending_requirements text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetings_status_check CHECK (
    status IN ('draft', 'scheduled', 'needs_approval', 'in_progress', 'done', 'approved', 'closed')
  ),
  CONSTRAINT meetings_end_after_start_check CHECK (end_at > start_at)
);

COMMENT ON COLUMN meetings.timezone IS 'Identificador IANA (ex.: America/Sao_Paulo). Nunca abreviacao como BRT/EST.';
COMMENT ON COLUMN meetings.status IS 'Ciclo de vida da REUNIAO. Independente de meeting_minutes.status.';
COMMENT ON COLUMN meetings.organizer_user_id IS 'Nulo quando o organizador e um setor, nao uma pessoa.';


CREATE TABLE agenda_topics (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title                      text        NOT NULL,
  description                text,
  owner_user_id              uuid        REFERENCES users (id) ON DELETE RESTRICT,
  governance_body_id         uuid        REFERENCES governance_bodies (id) ON DELETE RESTRICT,
  agenda_topic_type_id       uuid        REFERENCES agenda_topic_types (id) ON DELETE RESTRICT,
  agenda_topic_nature_id     uuid        REFERENCES agenda_topic_natures (id) ON DELETE RESTRICT,
  estimated_duration_minutes integer,
  generates_action_item      boolean     NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  agenda_topics IS 'Biblioteca de pautas reutilizaveis. Sem contexto de reuniao.';
COMMENT ON COLUMN agenda_topics.estimated_duration_minutes IS 'Minutos inteiros. Nunca string "HH:mm" ou "30 mins".';


CREATE TABLE audit_logs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  actor_name    text        NOT NULL,
  actor_role    text,
  action        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text,
  entity_label  text,
  status        text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_status_check CHECK (status IN ('success', 'failure'))
);

COMMENT ON TABLE  audit_logs IS 'Trilha append-only. A aplicacao nunca deve executar UPDATE ou DELETE aqui. Sem updated_at por design.';
COMMENT ON COLUMN audit_logs.actor_name IS 'Snapshot: o log nao muda se a pessoa for renomeada. Aceita ator nao-pessoa (ex.: System Sync API).';


-- =============================================================================
-- NIVEL 2 - dependem das entidades principais
-- =============================================================================

-- Aceita convidado externo sem conta: user_id NULL + display_name/email.
CREATE TABLE meeting_participants (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       uuid        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  user_id          uuid        REFERENCES users (id) ON DELETE RESTRICT,
  display_name     text,
  email            text,
  participant_type text        NOT NULL,
  role_in_meeting  text,
  is_confirmed     boolean     NOT NULL DEFAULT false,
  attended         boolean,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_participants_type_check CHECK (participant_type IN ('internal', 'external')),
  CONSTRAINT meeting_participants_identity_check CHECK (user_id IS NOT NULL OR display_name IS NOT NULL)
);

COMMENT ON COLUMN meeting_participants.user_id IS 'NULL = convidado externo sem conta. Nunca criar usuario ficticio para preencher.';
COMMENT ON COLUMN meeting_participants.participant_type IS 'Relacao com a empresa. Nao e redundante com user_id: pessoa externa pode ter conta.';
COMMENT ON COLUMN meeting_participants.role_in_meeting IS 'Papel naquela sessao. Nao e perfil de acesso.';

-- Indices unicos PARCIAIS: um UNIQUE comum trataria cada NULL como distinto
-- e deixaria a mesma pessoa entrar varias vezes na mesma reuniao.
CREATE UNIQUE INDEX meeting_participants_meeting_user_uk
  ON meeting_participants (meeting_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX meeting_participants_meeting_guest_email_uk
  ON meeting_participants (meeting_id, lower(email))
  WHERE user_id IS NULL AND email IS NOT NULL;


-- Pauta DENTRO de uma reuniao. Instancia de agenda_topics (ou item avulso).
CREATE TABLE meeting_agenda_items (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id             uuid        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  agenda_topic_id        uuid        REFERENCES agenda_topics (id) ON DELETE SET NULL,
  title                  text        NOT NULL,
  position               integer     NOT NULL,
  scheduled_start_time   time,
  duration_minutes       integer,
  presenter_label        text,
  execution_status       text        NOT NULL DEFAULT 'pending',
  postponed_from_item_id uuid        REFERENCES meeting_agenda_items (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_agenda_items_execution_status_check CHECK (
    execution_status IN ('pending', 'presenting', 'completed', 'postponed')
  ),
  -- DEFERRABLE permite reordenar varios itens na mesma transacao sem violar
  -- a unicidade no meio do caminho. Atencao: constraint deferrable nao pode
  -- ser alvo de ON CONFLICT.
  CONSTRAINT meeting_agenda_items_position_uk UNIQUE (meeting_id, position)
    DEFERRABLE INITIALLY IMMEDIATE
);

COMMENT ON COLUMN meeting_agenda_items.title IS 'Copia no momento da inclusao: a ata reflete o texto daquela sessao mesmo que a pauta da biblioteca mude depois.';
COMMENT ON COLUMN meeting_agenda_items.agenda_topic_id IS 'NULL = item criado direto na reuniao, sem origem na biblioteca.';
COMMENT ON COLUMN meeting_agenda_items.presenter_label IS 'Apresentador coletivo/textual: Todos, Comite Financeiro, Diretoria. Pessoas vao em meeting_agenda_item_presenters.';


-- Ata: uma por reuniao (1:1 garantido pelo UNIQUE em meeting_id).
CREATE TABLE meeting_minutes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid        NOT NULL UNIQUE REFERENCES meetings (id) ON DELETE CASCADE,
  content    text,
  status     text        NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_minutes_status_check CHECK (
    status IN ('draft', 'under_review', 'approved', 'closed')
  )
);

COMMENT ON COLUMN meeting_minutes.status IS 'Ciclo de vida da ATA, independente de meetings.status. Reuniao encerrada pode ter ata em elaboracao.';


-- Participantes de uma pauta da BIBLIOTECA. So usuarios reais (Decisao E).
CREATE TABLE agenda_topic_participants (
  agenda_topic_id uuid        NOT NULL REFERENCES agenda_topics (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agenda_topic_id, user_id)
);

COMMENT ON TABLE agenda_topic_participants IS 'Convidado externo nao entra aqui: a biblioteca nao tem contexto de reuniao. O externo e vinculado ao meeting_agenda_item.';


-- =============================================================================
-- NIVEL 3 - vinculo entre itens de pauta e participantes
-- =============================================================================

-- UNICA forma de registrar apresentador pessoa (Decisao C).
-- Aponta para meeting_participants (nao users) para que convidado externo
-- sem conta possa apresentar.
CREATE TABLE meeting_agenda_item_presenters (
  meeting_agenda_item_id uuid        NOT NULL REFERENCES meeting_agenda_items (id) ON DELETE CASCADE,
  meeting_participant_id uuid        NOT NULL REFERENCES meeting_participants (id) ON DELETE CASCADE,
  is_lead                boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_agenda_item_id, meeting_participant_id)
);

COMMENT ON COLUMN meeting_agenda_item_presenters.is_lead IS 'Apresentador principal. No maximo um por item, garantido por indice unico parcial.';

CREATE UNIQUE INDEX meeting_agenda_item_presenters_single_lead_uk
  ON meeting_agenda_item_presenters (meeting_agenda_item_id)
  WHERE is_lead;


-- =============================================================================
-- NIVEL 4 - entidades operacionais
-- =============================================================================

-- FUP. Origem por relacionamento real; origin_label so quando nao ha relacao.
CREATE TABLE action_items (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 text        NOT NULL,
  description           text,
  assigned_user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  origin_meeting_id     uuid        REFERENCES meetings (id) ON DELETE SET NULL,
  origin_agenda_item_id uuid        REFERENCES meeting_agenda_items (id) ON DELETE SET NULL,
  governance_body_id    uuid        REFERENCES governance_bodies (id) ON DELETE RESTRICT,
  origin_label          text,
  due_date              date,
  status                text        NOT NULL DEFAULT 'open',
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_items_status_check CHECK (status IN ('open', 'completed', 'cancelled'))
);

COMMENT ON TABLE  action_items IS 'FUP. Excluir a reuniao ou a pauta de origem NAO apaga a acao: SET NULL preserva o historico.';
COMMENT ON COLUMN action_items.due_date IS 'Prazo. Atraso e SEMPRE derivado (current_date - due_date), nunca armazenado.';
COMMENT ON COLUMN action_items.origin_label IS 'Texto livre apenas quando nao existe origem estruturada.';


-- =============================================================================
-- INDICES
-- Colunas de FK nao cobertas por PK/UNIQUE ja existente, mais as colunas
-- temporais que as telas atuais usam para filtrar e ordenar.
--
-- Deliberadamente NAO criados (ja cobertos):
--   meeting_minutes.meeting_id                        -> UNIQUE
--   meeting_agenda_items.meeting_id                   -> UNIQUE (meeting_id, position)
--   agenda_topic_participants.agenda_topic_id         -> coluna lider da PK
--   meeting_agenda_item_presenters.meeting_agenda_item_id -> coluna lider da PK
-- =============================================================================

CREATE INDEX meetings_governance_body_id_idx        ON meetings (governance_body_id);
CREATE INDEX meetings_organizer_user_id_idx         ON meetings (organizer_user_id);
CREATE INDEX meetings_start_at_idx                  ON meetings (start_at);

CREATE INDEX meeting_participants_meeting_id_idx    ON meeting_participants (meeting_id);
CREATE INDEX meeting_participants_user_id_idx       ON meeting_participants (user_id);

CREATE INDEX agenda_topics_owner_user_id_idx        ON agenda_topics (owner_user_id);
CREATE INDEX agenda_topics_governance_body_id_idx   ON agenda_topics (governance_body_id);
CREATE INDEX agenda_topics_type_id_idx              ON agenda_topics (agenda_topic_type_id);
CREATE INDEX agenda_topics_nature_id_idx            ON agenda_topics (agenda_topic_nature_id);

CREATE INDEX meeting_agenda_items_topic_id_idx      ON meeting_agenda_items (agenda_topic_id);
CREATE INDEX meeting_agenda_items_postponed_idx     ON meeting_agenda_items (postponed_from_item_id);

CREATE INDEX agenda_topic_participants_user_id_idx  ON agenda_topic_participants (user_id);

CREATE INDEX meeting_agenda_item_presenters_participant_id_idx
  ON meeting_agenda_item_presenters (meeting_participant_id);

CREATE INDEX action_items_assigned_user_id_idx      ON action_items (assigned_user_id);
CREATE INDEX action_items_origin_meeting_id_idx     ON action_items (origin_meeting_id);
CREATE INDEX action_items_origin_agenda_item_id_idx ON action_items (origin_agenda_item_id);
CREATE INDEX action_items_governance_body_id_idx    ON action_items (governance_body_id);
CREATE INDEX action_items_due_date_idx              ON action_items (due_date);

CREATE INDEX audit_logs_actor_user_id_idx           ON audit_logs (actor_user_id);
CREATE INDEX audit_logs_occurred_at_idx             ON audit_logs (occurred_at);


-- =============================================================================
-- TRIGGERS updated_at
-- Somente nas tabelas que possuem a coluna. audit_logs fica de fora por ser
-- append-only; as duas tabelas de vinculo nao tem updated_at.
-- =============================================================================

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER governance_bodies_set_updated_at
  BEFORE UPDATE ON governance_bodies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER agenda_topic_types_set_updated_at
  BEFORE UPDATE ON agenda_topic_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER agenda_topic_natures_set_updated_at
  BEFORE UPDATE ON agenda_topic_natures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER meetings_set_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER agenda_topics_set_updated_at
  BEFORE UPDATE ON agenda_topics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER meeting_participants_set_updated_at
  BEFORE UPDATE ON meeting_participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER meeting_agenda_items_set_updated_at
  BEFORE UPDATE ON meeting_agenda_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER meeting_minutes_set_updated_at
  BEFORE UPDATE ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER action_items_set_updated_at
  BEFORE UPDATE ON action_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
