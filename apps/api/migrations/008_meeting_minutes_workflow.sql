-- =============================================================================
-- 008_meeting_minutes_workflow.sql
--
-- Ata da reuniao — concorrencia por revisao e saneamento pela Secretaria.
--
-- Evolui `meeting_minutes` (criada na 001). NAO cria segunda tabela: a Ata ja
-- tinha lugar proprio, com `status` de ciclo formal, e uma tabela concorrente
-- so criaria a pergunta "qual das duas vale".
--
-- CONTEUDO E TEXTO PURO, nao HTML. A tela edita a Ata em <textarea> monoespaco
-- e exporta como text/plain. Diferente de `meeting_notes.content_html`, que sai
-- de um editor Tiptap. A diferenca e real e esta preservada aqui.
--
-- ESTADOS NESTA ONDA: apenas 'draft' e 'under_review' tem caminho honesto.
-- 'approved' permanece no CHECK para o fluxo futuro de assinatura, mas nenhuma
-- operacao desta etapa o produz — hoje ele so era alcancado por duas
-- assinaturas ficticias ("M. Davis", "L. Chen") embutidas na tela. 'closed'
-- continua legado: nunca foi escrito por ninguem.
--
-- ASSINATURA NAO ENTRA AQUI. Nenhuma coluna para assinante, hash ou selo: nao
-- existe assinatura real para guardar, e uma coluna vazia esperando o mock
-- antigo seria convite para reintroduzi-lo.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Conteudo
-- -----------------------------------------------------------------------------
-- `content` nasceu anulavel, e "NULL" e "texto vazio" acabariam significando a
-- mesma coisa por dois caminhos diferentes. A tabela esta vazia, entao o
-- estreitamento nao reescreve nada: cria uma Ata sem conteudo como '' e pronto.
UPDATE meeting_minutes SET content = '' WHERE content IS NULL;

ALTER TABLE meeting_minutes
  ALTER COLUMN content SET DEFAULT '',
  ALTER COLUMN content SET NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Concorrencia
-- -----------------------------------------------------------------------------
ALTER TABLE meeting_minutes
  -- Revisao VIGENTE, para detectar lost update. NAO e historico: revisoes
  -- anteriores nao sao guardadas em lugar nenhum. Comeca em 1 na primeira
  -- gravacao; a leitura de uma reuniao sem Ata devolve 0, que e a revisao que o
  -- cliente informa para criar o documento.
  ADD COLUMN revision integer NOT NULL DEFAULT 1,

  -- users.id de quem gravou por ultimo. Identidade INTERNA do PGCP — nunca
  -- nome, e-mail ou entra_object_id ocupando esse papel.
  -- ON DELETE SET NULL: desativar ou remover um usuario nao pode apagar a Ata.
  ADD COLUMN updated_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE meeting_minutes
  ADD CONSTRAINT meeting_minutes_revision_check CHECK (revision > 0);

-- -----------------------------------------------------------------------------
-- 3. Saneamento pela Secretaria
-- -----------------------------------------------------------------------------
-- A tela chamava isso de "Camada 1 — saneamento pela Secretaria" e guardava
-- dois campos soltos no localStorage: um boolean e o NOME de quem clicou. O
-- nome nao e identidade, e o boolean nao dizia QUAL texto foi conferido — a
-- pessoa saneava, editava tudo em seguida e o visto continuava valendo.
--
-- Aqui o visto e amarrado a uma revisao concreta. A revisao atual so esta
-- saneada quando `secretariat_cleared_revision = revision`; qualquer edicao
-- posterior avanca `revision` e o visto deixa de valer sozinho, sem apagar o
-- registro de que a revisao anterior FOI conferida.
ALTER TABLE meeting_minutes
  ADD COLUMN secretariat_cleared_at         timestamptz,
  ADD COLUMN secretariat_cleared_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN secretariat_cleared_revision   integer;

ALTER TABLE meeting_minutes
  -- Os tres nascem e morrem juntos: um visto sem autor, sem data ou sem
  -- revisao conferida nao significa nada.
  --
  -- `by_user_id` fica DE FORA do par obrigatorio de proposito: a FK e
  -- ON DELETE SET NULL, entao remover o usuario que saneou anularia essa coluna
  -- e derrubaria um CHECK que a exigisse. O fato "esta revisao foi saneada
  -- nesta data" sobrevive a saida da pessoa da empresa; so a autoria se perde.
  ADD CONSTRAINT meeting_minutes_secretariat_pairing_check CHECK (
    (secretariat_cleared_at IS NULL AND secretariat_cleared_revision IS NULL)
    OR
    (secretariat_cleared_at IS NOT NULL AND secretariat_cleared_revision IS NOT NULL)
  ),

  -- Nao da para ter conferido uma revisao que ainda nao existe.
  ADD CONSTRAINT meeting_minutes_cleared_revision_range_check CHECK (
    secretariat_cleared_revision IS NULL
    OR (secretariat_cleared_revision > 0 AND secretariat_cleared_revision <= revision)
  );

-- -----------------------------------------------------------------------------
-- 4. Documentacao e indices
-- -----------------------------------------------------------------------------
COMMENT ON TABLE meeting_minutes IS
  'Ata da reuniao — documento FORMAL, com ciclo proprio. Distinta de meeting_notes, que e rascunho operacional. Nada e copiado automaticamente de uma para a outra.';

COMMENT ON COLUMN meeting_minutes.content IS
  'Texto PURO da Ata, como a tela edita e exporta (text/plain). Nao e HTML.';

COMMENT ON COLUMN meeting_minutes.revision IS
  'Versao atual, para detectar lost update. NAO e historico: revisoes anteriores nao sao guardadas.';

COMMENT ON COLUMN meeting_minutes.updated_by_user_id IS
  'users.id de quem gravou por ultimo. Identidade interna do PGCP, nunca substituida por nome, e-mail ou entra_object_id.';

COMMENT ON COLUMN meeting_minutes.secretariat_cleared_revision IS
  'Revisao do conteudo que a Secretaria conferiu. A revisao atual so esta saneada quando este valor for igual a revision.';

COMMENT ON COLUMN meeting_minutes.status IS
  'Ciclo de vida da ATA, independente de meetings.status. Nesta onda apenas draft e under_review tem caminho honesto; approved aguarda a assinatura real e closed e legado inativo.';

-- `meeting_id` ja tem indice pelo UNIQUE. Estes cobrem "quem mexeu no que".
CREATE INDEX meeting_minutes_updated_by_user_id_idx
  ON meeting_minutes (updated_by_user_id);

CREATE INDEX meeting_minutes_secretariat_cleared_by_user_id_idx
  ON meeting_minutes (secretariat_cleared_by_user_id);
