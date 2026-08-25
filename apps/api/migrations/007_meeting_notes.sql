-- =============================================================================
-- 007_meeting_notes.sql
--
-- Anotacoes da reuniao — documento OPERACIONAL de trabalho.
--
-- NAO e a Ata. `meeting_minutes` continua intocada e tratada em onda propria:
--
--   meeting_notes    rascunho vivo, editado durante a reuniao, sem ciclo formal
--   meeting_minutes  documento formal, com status (draft/under_review/approved)
--
-- Compartilhar a tabela obrigaria um dos dois a carregar colunas que nao usa e
-- misturaria um texto que muda a cada tecla com um que passa por aprovacao.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE meeting_notes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- UNIQUE: um documento de anotacoes por reuniao. A regra funcional atual e
  -- essa, e criar varios sem requisito real so adiantaria a pergunta "qual
  -- deles e o certo".
  meeting_id         uuid        NOT NULL UNIQUE REFERENCES meetings (id) ON DELETE CASCADE,

  -- HTML do Tiptap, preservado como o editor produz. Nao e convertido para
  -- texto, markdown nem JSON: o proprio editor reanalisa esse HTML contra o
  -- schema dele na leitura, e qualquer no ou atributo fora do schema e
  -- descartado ali.
  content_html       text        NOT NULL DEFAULT '',

  -- Versao ATUAL, para controle de concorrencia. NAO e historico: nada e
  -- guardado alem da revisao vigente. Comeca em 1 na primeira gravacao; a
  -- leitura de uma reuniao sem nota devolve 0, que e a revisao que o cliente
  -- informa para criar o documento.
  revision           integer     NOT NULL DEFAULT 1,

  -- users.id de quem gravou por ultimo. Identidade INTERNA do PGCP — nunca
  -- nome, e-mail ou oid do Entra ocupando esse papel.
  -- ON DELETE SET NULL: desativar ou remover um usuario nao pode apagar as
  -- anotacoes da reuniao.
  updated_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_notes_revision_check CHECK (revision > 0)
);

-- ON DELETE CASCADE em `meeting_id` segue o padrao das demais filhas de
-- `meetings` (meeting_participants, meeting_agenda_items, meeting_minutes):
-- anotacao sem reuniao nao tem significado. Diferente de `action_items`, que
-- sobrevive a exclusao da origem porque a ACAO existiu por conta propria.
COMMENT ON TABLE meeting_notes IS
  'Anotacoes de trabalho da reuniao. Documento operacional, distinto da Ata (meeting_minutes), que tem ciclo formal proprio.';

COMMENT ON COLUMN meeting_notes.content_html IS
  'HTML produzido pelo editor Tiptap. Preservado sem conversao; a sanitizacao acontece na releitura pelo schema do editor.';

COMMENT ON COLUMN meeting_notes.revision IS
  'Versao atual, para detectar lost update. NAO e historico: revisoes anteriores nao sao guardadas.';

COMMENT ON COLUMN meeting_notes.updated_by_user_id IS
  'users.id de quem gravou por ultimo. Identidade interna do PGCP, nunca substituida por nome, e-mail ou entra_object_id.';

-- `meeting_id` ja tem indice pelo UNIQUE. Este cobre "quem editou o que".
CREATE INDEX meeting_notes_updated_by_user_id_idx ON meeting_notes (updated_by_user_id);

CREATE TRIGGER meeting_notes_set_updated_at
  BEFORE UPDATE ON meeting_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
