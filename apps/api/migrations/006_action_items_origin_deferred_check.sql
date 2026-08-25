-- =============================================================================
-- 006_action_items_origin_deferred_check.sql
--
-- Fecha a ultima lacuna estrutural da origem do FUP:
--
--   origin_meeting_id = NULL  +  origin_agenda_item_id = UUID
--
-- Esse estado nao tem significado — uma pauta sem dizer de que reuniao ela e —
-- e ate agora so a aplicacao o recusava. O PostgreSQL aceitava.
--
-- Estados validos, sem mudanca:
--
--   A. FUP geral                NULL    + NULL
--   B. FUP da reuniao           meeting + NULL
--   C. FUP de pauta             meeting + agenda item (coerentes, FK composta)
--
-- POR QUE NAO UM CHECK: a 4.8a provou que
--
--   CHECK (origin_agenda_item_id IS NULL OR origin_meeting_id IS NOT NULL)
--
-- torna a exclusao de reuniao dependente da ORDEM em que o PostgreSQL dispara
-- as acoes referenciais. Apagar a reuniao aciona duas, em comandos separados;
-- se a FK de `meetings` roda primeiro, existe um instante com reuniao nula e
-- pauta preenchida, e o CHECK reprova a linha — a reuniao fica impossivel de
-- excluir. E CHECK nao aceita DEFERRABLE: no PostgreSQL so UNIQUE, PRIMARY KEY,
-- REFERENCES e EXCLUDE aceitam.
--
-- A saida e uma CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED, que verifica
-- o estado FINAL da transacao. Os estados intermediarios das acoes de FK deixam
-- de importar: o que precisa ser coerente e o que fica gravado no COMMIT.
--
-- As TRES FKs de 001/005 permanecem intactas. Esta trigger tem a unica
-- responsabilidade que falta — nao reproduz "o item pertence aquela reuniao",
-- que ja e da FK composta.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Funcao de verificacao
-- -----------------------------------------------------------------------------
-- Le a linha PELO ID em vez de confiar em NEW: sendo a trigger diferida, NEW
-- carrega os valores de quando o comando rodou, nao os do fim da transacao. As
-- acoes de FK que rodam depois (SET NULL) nao aparecem em NEW — e sao
-- exatamente elas que precisam ser consideradas.
--
-- A linha pode ter sido apagada no meio da transacao; nesse caso nao ha o que
-- verificar e a funcao sai em silencio.
CREATE OR REPLACE FUNCTION action_items_check_origin_pairing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  meeting_id_atual    uuid;
  agenda_item_atual   uuid;
  encontrou           boolean;
BEGIN
  SELECT ai.origin_meeting_id, ai.origin_agenda_item_id, true
    INTO meeting_id_atual, agenda_item_atual, encontrou
    FROM action_items ai
   WHERE ai.id = NEW.id;

  IF NOT coalesce(encontrou, false) THEN
    RETURN NULL;
  END IF;

  IF agenda_item_atual IS NOT NULL AND meeting_id_atual IS NULL THEN
    RAISE EXCEPTION
      'action_items %: origin_agenda_item_id preenchido exige origin_meeting_id', NEW.id
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'action_items_origin_pairing',
            HINT = 'Informe a reuniao de origem junto da pauta, ou deixe as duas nulas.';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION action_items_check_origin_pairing() IS
  'Verifica no COMMIT que uma pauta de origem nunca fica sem a reuniao de origem. Le a linha pelo id porque NEW nao reflete os SET NULL das acoes de FK que rodam depois.';


-- -----------------------------------------------------------------------------
-- 2. Constraint trigger diferida
-- -----------------------------------------------------------------------------
-- INITIALLY DEFERRED: a verificacao roda no COMMIT, depois de todas as acoes
-- referenciais. Estados intermediarios sao permitidos de proposito.
--
-- Dispara em INSERT e em UPDATE das duas colunas — inclusive nos UPDATE que as
-- proprias FKs fazem, que e o caminho que o CHECK nao suportava.
--
-- Nao dispara em DELETE: linha apagada nao tem par para conferir.
CREATE CONSTRAINT TRIGGER action_items_origin_pairing
  AFTER INSERT OR UPDATE OF origin_meeting_id, origin_agenda_item_id
  ON action_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION action_items_check_origin_pairing();
