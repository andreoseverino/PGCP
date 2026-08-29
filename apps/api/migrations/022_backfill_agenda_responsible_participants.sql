-- =============================================================================
-- 022_backfill_agenda_responsible_participants.sql
--
-- Repara a invariante:
--   responsavel pessoa de uma pauta pertence aos participantes da pauta.
--
-- Somente pares Entra completos e inequívocos sao usados. Nomes nunca entram
-- em comparacao de identidade. A migration apenas acrescenta vinculos ausentes:
-- nao remove nem atualiza participantes existentes e nao altera o schema.
-- =============================================================================

-- Pautas de reuniao: o responsavel ja precisa existir como participante da
-- MESMA reuniao. A PK composta torna a insercao idempotente.
INSERT INTO meeting_agenda_item_participants
            (meeting_agenda_item_id, meeting_participant_id)
SELECT ai.id, mp.id
  FROM meeting_agenda_items ai
  JOIN meeting_participants mp
    ON mp.meeting_id = ai.meeting_id
   AND mp.entra_tenant_id = ai.responsible_entra_tenant_id
   AND mp.entra_object_id = ai.responsible_entra_object_id
 WHERE ai.responsible_entra_tenant_id IS NOT NULL
   AND ai.responsible_entra_object_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Biblioteca: quando o responsavel ja tem conta PGCP, preserva o users.id;
-- caso contrario grava a identidade Entra e o snapshot de nome existentes no
-- proprio topico. Os indices parciais por user e por Entra evitam duplicidade.
INSERT INTO agenda_topic_participants
            (agenda_topic_id, user_id, display_name,
             entra_tenant_id, entra_object_id)
SELECT t.id,
       u.id,
       t.responsible_label,
       t.responsible_entra_tenant_id,
       t.responsible_entra_object_id
  FROM agenda_topics t
  LEFT JOIN users u
    ON u.entra_tenant_id = t.responsible_entra_tenant_id
   AND u.entra_object_id = t.responsible_entra_object_id
 WHERE t.responsible_entra_tenant_id IS NOT NULL
   AND t.responsible_entra_object_id IS NOT NULL
ON CONFLICT DO NOTHING;
