-- =============================================================================
-- 020_meeting_agenda_item_participants.sql
--
-- Participantes POR PAUTA da reunião (Opção A).
--
-- REGRA DE NEGÓCIO (Opção A): todo participante vinculado a uma pauta existe
-- OBRIGATORIAMENTE também em `meeting_participants`. Por isso o vínculo aponta
-- para `meeting_participants` — e NÃO para o diretório — de modo que a invariante
-- "está na reunião" seja ESTRUTURAL (FK), não uma regra que possa furar.
--
-- NÃO reutiliza `meeting_agenda_item_presenters`: apresentador é outro conceito
-- (Decisão C). Aqui é "quem participa da discussão daquela pauta".
--
-- PK composta => a mesma pessoa não pode ser vinculada duas vezes à mesma pauta.
-- ON DELETE CASCADE nos dois lados:
--   excluir a pauta          -> some o vínculo;
--   remover a pessoa DA REUNIÃO -> some o vínculo.
-- REGRA DE NEGÓCIO: remover a pessoa DE UMA PAUTA remove-a DA REUNIÃO inteira —
-- apaga o `meeting_participant`, e o CASCADE deste lado elimina os vínculos dela
-- com ESTA e com as DEMAIS pautas da reunião. Mesma remoção da aba Participantes
-- (calendário desatualizado + auditoria).
--
-- SNAPSHOT: ao vincular um tema da Biblioteca, os `agenda_topic_participants` do
-- tema são resolvidos/criados como `meeting_participants` e vinculados à pauta;
-- depois, independentes do tema.
-- =============================================================================

CREATE TABLE meeting_agenda_item_participants (
  meeting_agenda_item_id uuid        NOT NULL REFERENCES meeting_agenda_items (id) ON DELETE CASCADE,
  meeting_participant_id uuid        NOT NULL REFERENCES meeting_participants (id) ON DELETE CASCADE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_agenda_item_id, meeting_participant_id)
);

-- Busca "quais pautas esta pessoa participa" e limpeza por participante.
CREATE INDEX meeting_agenda_item_participants_participant_idx
  ON meeting_agenda_item_participants (meeting_participant_id);

COMMENT ON TABLE meeting_agenda_item_participants IS
  'Participantes POR PAUTA (Opção A). Vincula meeting_agenda_items a meeting_participants: todo participante de pauta existe também na reunião. NÃO é apresentador (ver meeting_agenda_item_presenters).';

-- ---------------------------------------------------------------------------
-- Privilégios do papel de runtime (tabela nova nasce sem GRANT; mesma
-- tolerância das migrations 015/016: sem o papel, apenas avisa).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants de meeting_agenda_item_participants ignorados.';
    RETURN;
  END IF;

  -- Sem UPDATE: o vínculo é criado ou removido, nunca alterado no lugar.
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.meeting_agenda_item_participants TO pcgp_app';

  RAISE NOTICE 'Privilegios de meeting_agenda_item_participants concedidos a pcgp_app.';
END $$;
