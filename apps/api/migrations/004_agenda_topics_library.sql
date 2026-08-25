-- =============================================================================
-- 004_agenda_topics_library.sql
--
-- Modelo DEFINITIVO da Biblioteca de pautas. Fecha quatro frentes:
--
--   A. procedencia estrutural da pauta postergada (par composto)
--   B. tipo e natureza como cadastros relacionais, com seed canonico
--   C. participantes de pauta com o mesmo modelo de identidade de 003
--   D. vinculo com reunioes — nada a criar: ja existe
--
-- Desenho auditado e aprovado em docs/etapa-4-7-biblioteca.md.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- A. Procedencia da copia postergada
-- -----------------------------------------------------------------------------
-- Postergar uma pauta cria uma copia na Biblioteca. Ate agora a ligacao entre a
-- copia e a origem era um ID com semantica embutida montado no navegador
-- (`pauta-post-<meetingId>-<itemId>`), que servia de trava de idempotencia. Isso
-- sai: identidade nao carrega significado, e a garantia passa a ser do banco.

-- Alvo da FK composta. Redundante em conteudo — `id` sozinho ja e unico — mas o
-- PostgreSQL so aceita REFERENCES contra unicidade DECLARADA, e e o par que
-- precisa ser verificado.
ALTER TABLE meeting_agenda_items
  ADD CONSTRAINT meeting_agenda_items_meeting_id_id_uk UNIQUE (meeting_id, id);

ALTER TABLE agenda_topics
  ADD COLUMN source_meeting_id     uuid,
  ADD COLUMN source_agenda_item_id uuid;

-- MATCH FULL: ou os dois preenchidos, ou os dois nulos. Meia procedencia —
-- apontar a reuniao sem apontar a pauta — deixaria de ser rastreavel e nao
-- serviria para achar a copia depois.
--
-- O par referenciado garante de quebra que a pauta pertence MESMO a reuniao
-- informada: duas FKs independentes aceitariam item da reuniao A com origem
-- declarada na reuniao B.
--
-- ON DELETE SET NULL: excluida a origem, os dois campos ficam nulos JUNTOS e a
-- pauta da Biblioteca PERMANECE. Consequencia aceita: sem procedencia ela vira
-- indistinguivel de uma pauta manual, e o Retomar deixa de encontra-la.
ALTER TABLE agenda_topics
  ADD CONSTRAINT agenda_topics_source_fk
  FOREIGN KEY (source_meeting_id, source_agenda_item_id)
  REFERENCES meeting_agenda_items (meeting_id, id)
  MATCH FULL
  ON DELETE SET NULL;

-- Idempotencia ESTRUTURAL: no maximo uma copia automatica por (reuniao, pauta).
-- Parcial porque pauta criada a mao nao tem procedencia, e varios NULL nao
-- podem colidir entre si. Remover a copia (Retomar) libera postergar de novo.
CREATE UNIQUE INDEX agenda_topics_source_uk
  ON agenda_topics (source_meeting_id, source_agenda_item_id)
  WHERE source_meeting_id IS NOT NULL AND source_agenda_item_id IS NOT NULL;

COMMENT ON COLUMN agenda_topics.source_meeting_id IS
  'Reuniao de ORIGEM da copia automatica criada ao postergar. Nulo em pauta criada manualmente na Biblioteca. Pareado com source_agenda_item_id.';

COMMENT ON COLUMN agenda_topics.source_agenda_item_id IS
  'Item de pauta que originou esta copia. UNICA forma de localizar a copia automatica: nunca buscar por titulo, responsavel ou nome.';

-- Reafirma a semantica do campo vizinho, que NAO serve a este proposito: ele
-- liga item de reuniao a item de reuniao (a pauta reaparecendo numa sessao
-- futura), nao agenda_topic a item de reuniao.
COMMENT ON COLUMN meeting_agenda_items.postponed_from_item_id IS
  'Item de OUTRA reuniao do qual este item nasceu. Conceito distinto de agenda_topics.source_agenda_item_id, que aponta a copia da Biblioteca para sua origem.';


-- -----------------------------------------------------------------------------
-- B. Tipo e natureza — cadastros relacionais
-- -----------------------------------------------------------------------------
-- As tabelas existem desde 001 e estavam vazias; o vocabulario vivia como texto
-- livre no navegador. Passam a ser a fonte, e `agenda_topics` referencia pelos
-- IDs que ja possui — sem coluna de rotulo textual.
--
-- SEED: apenas os valores CANONICOS versionados no codigo (apps/web/src/App.tsx),
-- que sao os defaults quando o navegador nao tem nada gravado. Uma migration nao
-- le localStorage: valores customizados que existam so na maquina de alguem NAO
-- sao migrados por aqui, e a 4.7b decide se importa uma vez ou descarta.
--
-- ON CONFLICT pelo UNIQUE de `name`: reaplicar nao duplica.
INSERT INTO agenda_topic_types (name) VALUES
  ('Pauta Excepcional'),
  ('Pauta Regular')
ON CONFLICT (name) DO NOTHING;

INSERT INTO agenda_topic_natures (name) VALUES
  ('Deliberativa'),
  ('Informativa'),
  ('Debate Estratégico'),
  ('Remuneração'),
  ('Compliance / CVM')
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE agenda_topic_types IS
  'Cadastro de tipo de pauta. Identidade e o id; o nome e rotulo e pode ser corrigido sem quebrar vinculo.';

COMMENT ON TABLE agenda_topic_natures IS
  'Cadastro de natureza de pauta. Identidade e o id; o nome e rotulo.';


-- -----------------------------------------------------------------------------
-- C. Participantes de pauta — modelo de identidade de 003
-- -----------------------------------------------------------------------------
-- A tabela nascera com PK (agenda_topic_id, user_id) e `user_id NOT NULL`, o que
-- so admitia usuario do PGCP. O produto ja trabalha com tres naturezas de
-- pessoa, e as outras duas nao cabiam sem inventar usuario.
--
-- A tabela esta vazia, entao a evolucao e por ALTER — preserva as FKs existentes
-- para `agenda_topics` (CASCADE) e `users` (RESTRICT) em vez de recria-las.
ALTER TABLE agenda_topic_participants DROP CONSTRAINT agenda_topic_participants_pkey;

ALTER TABLE agenda_topic_participants
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE agenda_topic_participants
  ADD CONSTRAINT agenda_topic_participants_pkey PRIMARY KEY (id);

ALTER TABLE agenda_topic_participants
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE agenda_topic_participants
  ADD COLUMN entra_object_id uuid,
  ADD COLUMN entra_tenant_id uuid,
  ADD COLUMN display_name    text,
  ADD COLUMN email           text,
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();

-- Mesmo padrao de `users` e `meeting_participants`: comparar dois IS NULL
-- devolve boolean nao-nulo, entao o CHECK nunca passa por omissao.
ALTER TABLE agenda_topic_participants
  ADD CONSTRAINT agenda_topic_participants_entra_pairing_check
  CHECK ((entra_object_id IS NULL) = (entra_tenant_id IS NULL));

-- A linha precisa representar alguem: conta no PGCP ou, na falta dela, um nome.
ALTER TABLE agenda_topic_participants
  ADD CONSTRAINT agenda_topic_participants_identity_check
  CHECK (user_id IS NOT NULL OR display_name IS NOT NULL);

-- Identidade Microsoft sem nome obrigaria uma consulta ao Graph so para exibir
-- a lista — que pararia de funcionar com o Graph fora do ar.
ALTER TABLE agenda_topic_participants
  ADD CONSTRAINT agenda_topic_participants_entra_needs_name_check
  CHECK (entra_object_id IS NULL OR length(btrim(coalesce(display_name, ''))) > 0);

-- Unicidade DENTRO da pauta, nunca global: a mesma pessoa participa de varias
-- pautas diferentes. Parciais porque as duas colunas-chave aceitam NULL.
CREATE UNIQUE INDEX agenda_topic_participants_topic_user_uk
  ON agenda_topic_participants (agenda_topic_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX agenda_topic_participants_topic_entra_uk
  ON agenda_topic_participants (agenda_topic_id, entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL AND entra_tenant_id IS NOT NULL;

-- Convidado externo, sem conta e fora do diretorio: o e-mail e a unica chave
-- disponivel. Mesma regra ja usada em meeting_participants desde 001.
CREATE UNIQUE INDEX agenda_topic_participants_topic_guest_email_uk
  ON agenda_topic_participants (agenda_topic_id, lower(email))
  WHERE user_id IS NULL AND entra_object_id IS NULL AND email IS NOT NULL;

CREATE TRIGGER agenda_topic_participants_set_updated_at
  BEFORE UPDATE ON agenda_topic_participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE agenda_topic_participants IS
  'Participantes de uma pauta da biblioteca. Aceita usuario do PGCP, pessoa do diretorio sem conta e convidado externo. NUNCA criar usuario ficticio para preencher user_id.';

COMMENT ON COLUMN agenda_topic_participants.user_id IS
  'NULL = pessoa sem conta no PGCP. Reconciliar depois SOMENTE por (entra_tenant_id, entra_object_id) — nunca por nome, e-mail ou UPN.';

COMMENT ON COLUMN agenda_topic_participants.display_name IS
  'SNAPSHOT do nome no momento da inclusao. Permite montar a lista sem consultar o Microsoft Graph. Nao se atualiza sozinho.';


-- -----------------------------------------------------------------------------
-- D. Vinculo com reunioes — nada a criar
-- -----------------------------------------------------------------------------
-- "Reuniao Vinculada" e o mesmo conceito de a pauta estar na agenda da reuniao,
-- e a relacao ja existe desde 001:
--
--   agenda_topics.id <- meeting_agenda_items.agenda_topic_id -> meetings.id
--
-- Uma pauta pode aparecer em N reunioes. Nenhuma coluna `linked_meeting_id` e
-- criada: seria um segundo caminho para o mesmo fato, e o casamento por titulo
-- que a tela usava sai junto — titulo nunca e identidade.
COMMENT ON COLUMN meeting_agenda_items.agenda_topic_id IS
  'Pauta da biblioteca que originou este item. Tambem e a UNICA forma de saber em quais reunioes uma pauta esta vinculada — nunca casar por titulo.';
