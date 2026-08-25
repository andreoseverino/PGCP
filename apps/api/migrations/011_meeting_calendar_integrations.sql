-- =============================================================================
-- 011_meeting_calendar_integrations.sql
--
-- Vinculo entre a reuniao do PGCP e o evento no calendario externo.
--
--   PGCP    = fonte de verdade da reuniao corporativa
--   Outlook = projecao dessa reuniao no calendario
--
-- Sem sincronizacao bidirecional: alteracao feita no Outlook nao muda pauta,
-- quorum, Ata nem estado do PGCP.
--
-- TABELA PROPRIA, e nao colunas em `meetings`. Tres motivos:
--   1. cardinalidade — hoje Outlook, amanha outro provider;
--   2. ciclo de vida proprio — a reuniao e valida com sync `pending` ou
--      `failed`, e nao faz sentido `meetings` carregar estado de rede;
--   3. `meetings` continua descrevendo a reuniao, nao a entrega dela.
--
-- PostgreSQL e Graph NAO compartilham transacao. Esta tabela existe justamente
-- para nao fingir atomicidade: a reuniao commita primeiro, o evento vem depois,
-- e o estado da chamada distribuida fica registrado aqui.
--
-- SEM BACKFILL. Nenhuma linha e criada para reuniao existente: um vinculo sem
-- evento do outro lado seria uma afirmacao falsa sobre o calendario de alguem.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE meeting_calendar_integrations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  meeting_id           uuid        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,

  -- Identificador do fornecedor. Provider-agnostic por desenho; hoje so
  -- 'outlook' tem implementacao.
  provider             text        NOT NULL DEFAULT 'outlook',

  -- Caixa onde o evento vive. IDENTIDADE INTERNA (`users.id`), da qual se
  -- resolve o par (entra_tenant_id, entra_object_id) para chamar
  -- /users/{id}/calendar/events. Nunca nome, nunca e-mail digitado.
  --
  -- ON DELETE RESTRICT: nao se apaga o dono de um evento que existe la fora.
  owner_user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  -- Identificador do evento no fornecedor. Para o Graph, obtido com
  -- `Prefer: IdType="ImmutableId"` — o id padrao muda quando o item e movido
  -- entre pastas, e um identificador persistido nao pode ter essa propriedade.
  provider_event_id    text,
  -- Só quando o evento NAO estiver no calendario padrao da caixa.
  provider_calendar_id text,

  -- Devolvidos pelo Graph. `join_url` chega quando o evento nasce como reuniao
  -- online (Teams); e ele que alimenta `meetings.meeting_link`.
  web_link             text,
  join_url             text,

  /*
   * IDEMPOTENCIA.
   *
   * Gerada UMA vez, junto da linha, e reenviada em toda tentativa de criacao —
   * no Outlook, como `event.transactionId`. Timeout NAO gera chave nova: e
   * exatamente o caso em que o evento pode ter sido criado sem a resposta ter
   * voltado, e repetir com a mesma chave e o que impede o segundo evento.
   *
   * Nome provider-agnostic de proposito: `transactionId` e vocabulario do
   * Outlook, e o conceito nao e.
   */
  idempotency_key      uuid        NOT NULL DEFAULT gen_random_uuid(),

  /*
   * pending  linha criada, evento ainda nao existe
   * synced   evento existe e reflete a reuniao
   * failed   a ultima tentativa falhou; `last_error` diz o que aconteceu
   * stale    o evento existe, mas a reuniao mudou depois da ultima sincronizacao
   */
  sync_status          text        NOT NULL DEFAULT 'pending',

  last_synced_at       timestamptz,
  -- MENSAGEM, nunca payload do fornecedor, token ou corpo de resposta.
  last_error           text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_calendar_integrations_provider_check
    CHECK (provider IN ('outlook')),

  CONSTRAINT meeting_calendar_integrations_status_check
    CHECK (sync_status IN ('pending', 'synced', 'failed', 'stale')),

  -- `synced` e `stale` afirmam que existe evento do outro lado. Sem o
  -- identificador, a afirmacao nao se sustenta.
  CONSTRAINT meeting_calendar_integrations_event_required_check
    CHECK (sync_status NOT IN ('synced', 'stale') OR provider_event_id IS NOT NULL),

  -- Evento sincronizado tem data de sincronizacao.
  CONSTRAINT meeting_calendar_integrations_synced_at_check
    CHECK (sync_status <> 'synced' OR last_synced_at IS NOT NULL)
);

-- UMA integracao por reuniao e provider. E o que impede dois eventos para a
-- mesma reuniao mesmo que a rota de sincronizacao seja chamada em paralelo.
CREATE UNIQUE INDEX meeting_calendar_integrations_meeting_provider_uk
  ON meeting_calendar_integrations (meeting_id, provider);

-- A chave de idempotencia e unica por fornecedor: reusa-la em outra reuniao
-- faria o fornecedor tratar duas reunioes distintas como a mesma tentativa.
CREATE UNIQUE INDEX meeting_calendar_integrations_idempotency_uk
  ON meeting_calendar_integrations (provider, idempotency_key);

-- Um evento so pode estar vinculado a uma reuniao.
CREATE UNIQUE INDEX meeting_calendar_integrations_event_uk
  ON meeting_calendar_integrations (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX meeting_calendar_integrations_owner_idx
  ON meeting_calendar_integrations (owner_user_id);

-- Fila de trabalho: o que ainda precisa de sincronizacao.
CREATE INDEX meeting_calendar_integrations_pendentes_idx
  ON meeting_calendar_integrations (sync_status)
  WHERE sync_status IN ('pending', 'failed', 'stale');

CREATE TRIGGER meeting_calendar_integrations_set_updated_at
  BEFORE UPDATE ON meeting_calendar_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE meeting_calendar_integrations IS
  'Projecao da reuniao do PGCP no calendario externo. PGCP e a fonte de verdade; nao ha sincronizacao de volta.';

COMMENT ON COLUMN meeting_calendar_integrations.owner_user_id IS
  'users.id do dono da caixa onde o evento vive. A identidade Entra e resolvida a partir dele, nunca de nome ou e-mail digitado.';

COMMENT ON COLUMN meeting_calendar_integrations.provider_event_id IS
  'Identificador do evento no fornecedor. No Graph, obtido como ImmutableId para nao mudar quando o item e movido de pasta.';

COMMENT ON COLUMN meeting_calendar_integrations.idempotency_key IS
  'Chave reenviada em toda tentativa de criacao (no Outlook, event.transactionId). Timeout nao gera chave nova.';

COMMENT ON COLUMN meeting_calendar_integrations.last_error IS
  'Mensagem legivel do ultimo erro. Nunca payload do fornecedor, token ou corpo de resposta.';

COMMENT ON COLUMN meeting_calendar_integrations.sync_status IS
  'pending: sem evento ainda. synced: evento reflete a reuniao. failed: ultima tentativa falhou. stale: evento existe mas a reuniao mudou depois.';
