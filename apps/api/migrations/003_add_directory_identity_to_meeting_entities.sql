-- =============================================================================
-- 003_add_directory_identity_to_meeting_entities.sql
--
-- Permite que pessoas do diretorio corporativo apareçam nos dados de reuniao
-- ANTES de existirem em `users`.
--
-- O modelo de 001 previa duas naturezas de pessoa: usuario do PGCP (user_id) e
-- convidado externo anonimo (user_id NULL + display_name). Com o Microsoft
-- Graph em producao surgiu uma terceira: alguem da organizacao, escolhido no
-- diretorio, que ainda nao entrou no PGCP e por isso nao tem linha em `users`.
-- Sem identidade Microsoft essa pessoa entrava como convidado anonimo, e nao
-- havia como reconhece-la quando o JIT a provisionasse depois.
--
-- Tres identificadores, NUNCA intercambiaveis:
--
--   users.id                          -> identidade INTERNA do PGCP (PK, FKs)
--   entra_tenant_id + entra_object_id -> identidade MICROSOFT (tid + oid)
--   *_label / display_name            -> SNAPSHOT textual, para exibir
--
-- O snapshot existe para a tela renderizar um nome sem consultar o Graph a cada
-- abertura. Ele NAO se atualiza sozinho: se a pessoa mudar de nome no
-- diretorio, o snapshot continua com o valor do momento da escolha. Esta
-- migration nao cria nenhum mecanismo de sincronizacao.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
--
-- ESCOPO. Nao toca em: meetings.id, governance_body_id, status,
-- execution_status, presenter_label, meeting_agenda_item_presenters,
-- meeting_minutes, agenda_topic_types e agenda_topic_natures.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. meeting_participants
-- -----------------------------------------------------------------------------
-- `display_name` e `email` ja existem desde 001 e sao campos NEUTROS de
-- snapshot: nada neles pressupoe convidado externo. Sao reaproveitados para a
-- pessoa do diretorio em vez de ganharem gemeos `participant_name` /
-- `participant_email`, que significariam a mesma coisa com outro nome.
ALTER TABLE meeting_participants
  ADD COLUMN entra_object_id uuid,
  ADD COLUMN entra_tenant_id uuid;

-- Mesmo padrao de `users_entra_identity_pairing_check`: comparar dois IS NULL
-- devolve sempre boolean nao-nulo, entao o CHECK nunca passa por omissao.
ALTER TABLE meeting_participants
  ADD CONSTRAINT meeting_participants_entra_pairing_check
  CHECK ((entra_object_id IS NULL) = (entra_tenant_id IS NULL));

-- Identidade Microsoft exige o nome junto. Sem snapshot, exibir o participante
-- obrigaria uma consulta ao Graph a cada render — e a lista de presenca
-- pararia de funcionar sempre que o Graph estivesse fora do ar.
ALTER TABLE meeting_participants
  ADD CONSTRAINT meeting_participants_entra_needs_name_check
  CHECK (entra_object_id IS NULL OR length(btrim(coalesce(display_name, ''))) > 0);

-- A mesma pessoa Microsoft nao entra duas vezes na mesma reuniao. Parcial pelo
-- mesmo motivo dos outros dois indices da tabela: um UNIQUE comum trataria
-- cada NULL como distinto e nao impediria nada.
CREATE UNIQUE INDEX meeting_participants_meeting_entra_uk
  ON meeting_participants (meeting_id, entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL AND entra_tenant_id IS NOT NULL;

COMMENT ON COLUMN meeting_participants.entra_object_id IS
  'oid do Entra da pessoa escolhida no diretorio. Identidade MICROSOFT, distinta de users.id: participante de reuniao nao precisa ter conta no PGCP. NULL para convidado externo fora do diretorio.';

COMMENT ON COLUMN meeting_participants.entra_tenant_id IS
  'tid do Entra. Junto com entra_object_id forma a identidade Microsoft. Nunca gravar oid sozinho: oid so e unico dentro de um tenant.';

COMMENT ON COLUMN meeting_participants.display_name IS
  'SNAPSHOT do nome no momento da inclusao. Serve tanto ao convidado externo quanto a pessoa do diretorio, e permite montar a lista de presenca sem consultar o Graph. Nao se atualiza sozinho.';

COMMENT ON COLUMN meeting_participants.user_id IS
  'NULL = pessoa sem conta no PGCP. Pode ser convidado externo (sem entra_object_id) ou alguem do diretorio que ainda nao fez login (com entra_object_id). Nunca criar usuario ficticio para preencher.';


-- -----------------------------------------------------------------------------
-- 2. meeting_agenda_items - RESPONSAVEL pela pauta
-- -----------------------------------------------------------------------------
-- Responsavel e conceito DISTINTO de apresentador:
--
--   responsible_*                  -> quem responde pela pauta
--   presenter_label                -> apresentador coletivo/textual
--   meeting_agenda_item_presenters -> apresentador pessoa
--
-- As duas estruturas de apresentador ficam intactas. Reaproveita-las para o
-- responsavel obrigaria a pessoa a ser participante da reuniao — vinculo que o
-- produto separou de proposito.
ALTER TABLE meeting_agenda_items
  ADD COLUMN responsible_label           text,
  ADD COLUMN responsible_entra_object_id uuid,
  ADD COLUMN responsible_entra_tenant_id uuid;

ALTER TABLE meeting_agenda_items
  ADD CONSTRAINT meeting_agenda_items_responsible_pairing_check
  CHECK ((responsible_entra_object_id IS NULL) = (responsible_entra_tenant_id IS NULL));

ALTER TABLE meeting_agenda_items
  ADD CONSTRAINT meeting_agenda_items_responsible_needs_label_check
  CHECK (responsible_entra_object_id IS NULL OR length(btrim(coalesce(responsible_label, ''))) > 0);

COMMENT ON COLUMN meeting_agenda_items.responsible_label IS
  'Responsavel pela pauta, como texto. Aceita pessoa ("Ana Souza"), area, orgao e coletivo ("Todos", "Comite de Auditoria"). Quando e pessoa do diretorio, e o SNAPSHOT do nome e vem acompanhado do par entra_*.';

COMMENT ON COLUMN meeting_agenda_items.responsible_entra_object_id IS
  'oid do responsavel quando ele e uma pessoa do diretorio. NULL para responsavel coletivo, area ou texto legado. Identidade MICROSOFT, nao users.id.';

COMMENT ON COLUMN meeting_agenda_items.responsible_entra_tenant_id IS
  'tid do responsavel. Pareado com responsible_entra_object_id.';


-- -----------------------------------------------------------------------------
-- 3. agenda_topics - RESPONSAVEL da pauta na biblioteca
-- -----------------------------------------------------------------------------
-- `owner_user_id` continua existindo e continua significando usuario INTERNO do
-- PGCP (FK para users). Nao serve ao responsavel escolhido no diretorio, que
-- pode nao ter linha em users — por isso colunas proprias em vez de esticar a
-- semantica da coluna existente.
ALTER TABLE agenda_topics
  ADD COLUMN responsible_label           text,
  ADD COLUMN responsible_entra_object_id uuid,
  ADD COLUMN responsible_entra_tenant_id uuid;

ALTER TABLE agenda_topics
  ADD CONSTRAINT agenda_topics_responsible_pairing_check
  CHECK ((responsible_entra_object_id IS NULL) = (responsible_entra_tenant_id IS NULL));

ALTER TABLE agenda_topics
  ADD CONSTRAINT agenda_topics_responsible_needs_label_check
  CHECK (responsible_entra_object_id IS NULL OR length(btrim(coalesce(responsible_label, ''))) > 0);

COMMENT ON COLUMN agenda_topics.responsible_label IS
  'Responsavel pela pauta da biblioteca, como texto. Mesma semantica de meeting_agenda_items.responsible_label: aceita pessoa, area e coletivo.';

COMMENT ON COLUMN agenda_topics.owner_user_id IS
  'Usuario INTERNO do PGCP dono da pauta. NAO e o mesmo que responsible_*: aqui exige-se conta no PGCP, la nao.';


-- -----------------------------------------------------------------------------
-- 4. action_items - FUP sem exigir conta no PGCP
-- -----------------------------------------------------------------------------
-- `assigned_user_id` era NOT NULL, o que impedia atribuir um FUP a alguem do
-- diretorio que ainda nao entrou no PGCP. A tela ja permite escolher qualquer
-- pessoa do diretorio; a unica forma de satisfazer a FK seria criar usuario
-- ficticio, o que e proibido.
ALTER TABLE action_items ALTER COLUMN assigned_user_id DROP NOT NULL;

ALTER TABLE action_items
  ADD COLUMN assignee_name             text,
  ADD COLUMN assignee_entra_object_id  uuid,
  ADD COLUMN assignee_entra_tenant_id  uuid;

ALTER TABLE action_items
  ADD CONSTRAINT action_items_assignee_pairing_check
  CHECK ((assignee_entra_object_id IS NULL) = (assignee_entra_tenant_id IS NULL));

-- Um FUP sem responsavel nao e um FUP. Afrouxar a FK nao pode virar permissao
-- para acao orfa: ou aponta para users, ou carrega identidade Microsoft.
ALTER TABLE action_items
  ADD CONSTRAINT action_items_has_assignee_check
  CHECK (
    assigned_user_id IS NOT NULL
    OR (assignee_entra_object_id IS NOT NULL AND assignee_entra_tenant_id IS NOT NULL)
  );

-- Sem linha em users, o nome so pode vir do snapshot. Sem ele a lista de FUPs
-- exigiria uma consulta ao Graph por item so para escrever quem responde.
ALTER TABLE action_items
  ADD CONSTRAINT action_items_entra_assignee_needs_name_check
  CHECK (assignee_entra_object_id IS NULL OR length(btrim(coalesce(assignee_name, ''))) > 0);

-- A tela de FUP filtra por responsavel ("minhas acoes"), e para quem ainda nao
-- tem users.id o filtro so pode ser pelo par Microsoft.
CREATE INDEX action_items_assignee_entra_idx
  ON action_items (assignee_entra_tenant_id, assignee_entra_object_id)
  WHERE assignee_entra_object_id IS NOT NULL;

COMMENT ON COLUMN action_items.assigned_user_id IS
  'Responsavel COM conta no PGCP. NULL quando o responsavel e uma pessoa do diretorio que ainda nao entrou — nesse caso assignee_entra_* identifica e assignee_name exibe.';

COMMENT ON COLUMN action_items.assignee_name IS
  'SNAPSHOT do nome do responsavel, para exibir sem consultar o Graph. Obrigatorio quando a atribuicao e por identidade Microsoft. Redundante — e dispensavel — quando ha assigned_user_id, porque users.name ja responde.';

COMMENT ON COLUMN action_items.assignee_entra_object_id IS
  'oid do responsavel no Entra. Identidade MICROSOFT, distinta de users.id. Quando a pessoa fizer login, o JIT cria a linha em users e o FUP pode ser reconciliado por (tenant, oid).';

COMMENT ON COLUMN action_items.assignee_entra_tenant_id IS
  'tid do responsavel. Pareado com assignee_entra_object_id.';
