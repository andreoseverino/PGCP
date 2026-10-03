-- =============================================================================
-- 030_meeting_session_type.sql
--
-- TIPO da reunião (Ordinária | Extraordinária) e TÍTULO PADRONIZADO.
--
-- O título das reuniões segue um padrão corporativo, montado pelo servidor:
--
--   09:00 | Cielo | Reunião Extraordinária do Comitê de Riscos (PRESENCIAL)
--   └hora┘         └──── tipo ────┘     └──── órgão ────┘  └─ formato ─┘
--
-- Hora, órgão e formato já estão na reunião (`start_at`/`timezone`,
-- `governance_body_id`, `modality`); faltava o tipo. Com ele gravado, o
-- servidor RECOMPÕE o título sempre que hora, órgão, formato ou tipo mudam
-- (Calendário/Pipeline). A versão aprovada da Agenda Anual não muda: o título
-- aprovado está congelado no snapshot (028).
--
-- NULL = reunião anterior a esta migration: o título livre é preservado até
-- alguém escolher o tipo no Pipeline. Nenhuma linha é reescrita aqui.
--
-- REVERSÃO (manual; o runner é forward-only):
--
--   ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_session_type_check;
--   ALTER TABLE meetings DROP COLUMN IF EXISTS session_type;
--   DELETE FROM schema_migrations WHERE version = '030_meeting_session_type.sql';
--
--   Os títulos já montados continuam como texto; só deixam de ser recompostos.
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE meetings ADD COLUMN session_type text;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_session_type_check
  CHECK (session_type IS NULL OR session_type IN ('ordinary', 'extraordinary'));

COMMENT ON COLUMN meetings.session_type IS
  'Tipo da reunião: ordinary | extraordinary. Preenchido = título padronizado, recomposto pelo servidor. NULL = legado (título livre).';
