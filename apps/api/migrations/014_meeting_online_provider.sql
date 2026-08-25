-- =============================================================================
-- 014_meeting_online_provider.sql
--
-- Reuniao online no PROPRIO evento de calendario.
--
-- O PGCP nao cria uma "reuniao Teams" paralela. Quem transforma o evento em
-- reuniao online e o proprio Calendar API: `isOnlineMeeting` +
-- `onlineMeetingProvider` no evento fazem o Graph provisionar a reuniao e
-- devolver `onlineMeeting.joinUrl`. A API `/communications/onlineMeetings` cria
-- um recurso INDEPENDENTE do calendario — nao e o que este produto quer.
--
-- Por isso nao existe tabela de Teams: um evento, um vinculo
-- (`meeting_calendar_integrations`), um `join_url`.
--
-- IRREVERSIBILIDADE. A Microsoft documenta que, depois de habilitada, a reuniao
-- online do evento PERMANECE online e o provider nao pode ser trocado. Um
-- toggle ingenuo true<->false mentiria: desmarcar no PGCP nao desfaz nada do
-- outro lado, e a tela passaria a exibir um estado que o calendario nao tem.
--
-- A regra implementada abaixo acompanha a realidade do Graph:
--
--   join_url IS NULL      a reuniao online ainda nao foi provisionada;
--                         escolher e desescolher e livre
--   join_url IS NOT NULL  o Graph ja criou; a escolha congela
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE meetings
  -- NULO = reuniao sem reuniao online (presencial ou com link externo digitado
  -- em `meeting_link`). Nao e "desligado": e a ausencia da escolha.
  ADD COLUMN online_meeting_provider text;

ALTER TABLE meetings
  -- Vocabulario do Graph. Hoje so o Teams; outro provider entraria aqui, nao
  -- num campo booleano que nao saberia dizer QUAL reuniao online e.
  ADD CONSTRAINT meetings_online_provider_check CHECK (
    online_meeting_provider IS NULL OR online_meeting_provider IN ('teamsForBusiness')
  );

COMMENT ON COLUMN meetings.online_meeting_provider IS
  'Provider da reuniao online do proprio evento de calendario (ex.: teamsForBusiness). NULO quando nao ha reuniao online. Congela depois que o Graph provisiona o joinUrl.';

-- -----------------------------------------------------------------------------
-- Congelamento depois do provisionamento
-- -----------------------------------------------------------------------------
CREATE FUNCTION meetings_freeze_online_provider()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  join_existente text;
BEGIN
  IF NEW.online_meeting_provider IS NOT DISTINCT FROM OLD.online_meeting_provider THEN
    RETURN NEW;
  END IF;

  SELECT join_url
    INTO join_existente
    FROM meeting_calendar_integrations
   WHERE meeting_id = NEW.id
     AND join_url IS NOT NULL
   LIMIT 1;

  IF join_existente IS NOT NULL THEN
    /*
     * O Graph ja provisionou a reuniao online. Ela nao volta atras: desmarcar
     * aqui deixaria o PGCP afirmando algo que o calendario contradiz, e os
     * convidados continuariam com um link que a tela diria nao existir.
     *
     * Para uma reuniao sem Teams, o caminho e outra reuniao.
     */
    RAISE EXCEPTION
      'A reuniao online ja foi provisionada e nao pode ser desfeita nem trocada de provider.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER meetings_freeze_online_provider
  BEFORE UPDATE OF online_meeting_provider ON meetings
  FOR EACH ROW EXECUTE FUNCTION meetings_freeze_online_provider();

COMMENT ON FUNCTION meetings_freeze_online_provider() IS
  'Impede desligar ou trocar a reuniao online depois que o Graph devolveu o joinUrl. Antes disso a escolha e livre.';
