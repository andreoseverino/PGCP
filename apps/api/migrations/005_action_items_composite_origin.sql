-- =============================================================================
-- 005_action_items_composite_origin.sql
--
-- Leva para o banco a integridade da ORIGEM do FUP.
--
-- Ate aqui `origin_meeting_id` e `origin_agenda_item_id` eram duas FKs
-- INDEPENDENTES: cada uma apontava para uma linha existente, mas nada obrigava
-- as duas a falarem da mesma reuniao. O banco aceitaria uma pauta da reuniao B
-- declarada como originada na reuniao A. A checagem existia so na aplicacao.
--
-- Tres formas de origem continuam validas:
--
--   A. FUP geral                     meeting NULL   + item NULL
--   B. FUP da reuniao, sem pauta      meeting UUID   + item NULL
--   C. FUP de pauta                   meeting UUID   + item UUID (coerentes)
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. A FK isolada da pauta PERMANECE
-- -----------------------------------------------------------------------------
-- Tentador remove-la por parecer redundante com a composta. Nao e.
--
-- Excluir a reuniao dispara duas acoes referenciais em comandos separados. Se a
-- FK de `meetings` roda primeiro, `origin_meeting_id` fica nulo — e a partir
-- dai, sob MATCH SIMPLE, a linha deixa de ser considerada referenciadora pela
-- composta. Quando os itens de pauta caem por CASCADE logo em seguida, a
-- composta NAO dispara, e `origin_agenda_item_id` fica apontando para uma linha
-- que nao existe mais.
--
-- A FK isolada nao depende do estado da outra coluna e fecha esse buraco. As
-- duas convivem: ambas fazem SET NULL na mesma coluna, o que e idempotente.

-- -----------------------------------------------------------------------------
-- 2. FK composta: o item precisa ser DAQUELA reuniao
-- -----------------------------------------------------------------------------
-- Referencia o UNIQUE (meeting_id, id) criado em 004.
--
-- MATCH SIMPLE (o padrao, escrito aqui para nao virar duvida depois): quando
-- QUALQUER coluna do par e nula, a verificacao inteira e pulada. E exatamente o
-- que o caso B precisa — reuniao preenchida, pauta nula. MATCH FULL exigiria as
-- duas ou nenhuma e proibiria o FUP originado so da reuniao.
--
-- ON DELETE SET NULL (origin_agenda_item_id): sintaxe do PostgreSQL 15+, que
-- limita o SET NULL as colunas listadas. Excluir a pauta de origem apaga a
-- referencia a ela e PRESERVA `origin_meeting_id` — o FUP continua sabendo de
-- qual reuniao nasceu. Sem a lista, o SET NULL zeraria o par inteiro e essa
-- memoria se perderia.
ALTER TABLE action_items
  ADD CONSTRAINT action_items_origin_fk
  FOREIGN KEY (origin_meeting_id, origin_agenda_item_id)
  REFERENCES meeting_agenda_items (meeting_id, id)
  MATCH SIMPLE
  ON DELETE SET NULL (origin_agenda_item_id);


-- -----------------------------------------------------------------------------
-- 3. Por que NAO ha CHECK exigindo reuniao junto da pauta
-- -----------------------------------------------------------------------------
-- Efeito colateral do MATCH SIMPLE: com `origin_meeting_id` nulo e
-- `origin_agenda_item_id` preenchido, a verificacao tambem e pulada. A tentacao
-- e fechar isso com
--
--   CHECK (origin_agenda_item_id IS NULL OR origin_meeting_id IS NOT NULL)
--
-- mas esse CHECK torna a exclusao de uma reuniao dependente da ORDEM em que o
-- PostgreSQL dispara as acoes referenciais. Apagar a reuniao aciona duas, em
-- comandos separados: a FK de `meetings` zera `origin_meeting_id`, e a FK
-- composta — via CASCADE nos itens de pauta — zera `origin_agenda_item_id`. Se
-- a primeira roda antes, existe um instante com reuniao nula e pauta
-- preenchida, e o CHECK reprova a linha: a reuniao fica impossivel de excluir
-- por causa de um FUP que nasceu dela.
--
-- Nao da para adiar a verificacao: no PostgreSQL so UNIQUE, PRIMARY KEY,
-- REFERENCES e EXCLUDE aceitam DEFERRABLE — CHECK nao. E nao da para zerar as
-- duas colunas pela FK de `meetings`, porque as colunas do ON DELETE SET NULL
-- precisam fazer parte da propria chave estrangeira.
--
-- Este caso segue coberto pela aplicacao, que devolve 400 explicando que a
-- pauta precisa vir com a reuniao. Um CHECK que transforma exclusao de reuniao
-- numa falha dependente de ordem seria pior do que a lacuna que ele fecha.


-- -----------------------------------------------------------------------------
-- 4. Documentacao no proprio schema
-- -----------------------------------------------------------------------------
-- `origin_meeting_id -> meetings` continua existindo: e ela que cobre o caso B,
-- em que a FK composta nao verifica nada. O FUP sobrevive a exclusao da origem
-- sem origem nenhuma, que e o desfecho correto: a acao existiu.
COMMENT ON COLUMN action_items.origin_meeting_id IS
  'Reuniao que originou a acao. NULL em FUP geral. Preservado quando apenas a pauta de origem e excluida.';

COMMENT ON COLUMN action_items.origin_agenda_item_id IS
  'Pauta que originou a acao. Verificada pela FK composta contra (meeting_id, id): nunca aponta para pauta de outra reuniao. NULL quando o FUP nasceu da reuniao como um todo.';
