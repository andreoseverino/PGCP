-- =============================================================================
-- 010_signature_process_immutability.sql
--
-- Imutabilidade da evidencia, congelamento do roster e transicoes validas do
-- processo de assinatura.
--
-- A 009 modelou o dominio. Faltava a integridade: uma sonda contra este banco
-- mostrou que um processo criado para a Ata X revisao 1 podia ser reescrito por
-- UPDATE como sendo da Ata Y revisao 99, com outro texto e outro hash; que o
-- roster aceitava ganhar signatario depois de `completed`; e que um processo
-- terminal podia voltar para `prepared`. Nada disso passava por endpoint ou
-- servico — mas "so o servico se comporta" nao e integridade.
--
-- ESTA MIGRATION SO RESTRINGE. Nao cria caminho para `signed`, `completed` nem
-- `approved`, e nao toca em `meeting_minutes.status`. A conclusao real continua
-- dependendo de evidencia externa que ainda nao existe.
--
-- SEM pgcrypto: `sha256()` e nativa do core desde o PostgreSQL 11 e devolve o
-- mesmo valor que `node:crypto` para o mesmo texto UTF-8 — verificado.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Criacao do processo: evidencia coerente e nascimento em `prepared`
-- -----------------------------------------------------------------------------
-- A aplicacao continua calculando o hash; aqui o banco CONFERE por conta
-- propria. Sem isto, `content_snapshot` e `content_hash` podiam descrever
-- documentos diferentes — o CHECK da 009 valida so o formato hexadecimal.
--
-- Gatilho e nao CHECK de proposito: `convert_to` e marcada `stable`, nao
-- `immutable`, e expressao nao-imutavel dentro de CHECK e uma armadilha que so
-- aparece num restore com outro encoding. Em funcao de gatilho, `stable` e
-- perfeitamente valida.
CREATE FUNCTION meeting_minute_signature_process_check_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'prepared' THEN
    -- Processo nasce em `prepared` e caminha por transicoes validadas. Nascer
    -- pronto seria pular exatamente as barreiras que existem para ser cumpridas.
    RAISE EXCEPTION
      'Processo de assinatura nasce com status prepared (informado %).', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.content_hash <> encode(sha256(convert_to(NEW.content_snapshot, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION
      'content_hash nao corresponde ao SHA-256 de content_snapshot.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER meeting_minute_signature_processes_check_evidence
  BEFORE INSERT ON meeting_minute_signature_processes
  FOR EACH ROW EXECUTE FUNCTION meeting_minute_signature_process_check_evidence();

-- -----------------------------------------------------------------------------
-- 2. Atualizacao do processo: imutabilidade, provider set-once, transicoes
-- -----------------------------------------------------------------------------
CREATE FUNCTION meeting_minute_signature_process_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obrigatorios      integer;
  nao_assinados     integer;
BEGIN
  -- ---------------------------------------------------------------------
  -- 2.1 Evidencia imutavel — em QUALQUER estado, inclusive terminal.
  --
  -- O processo representa um documento e uma revisao especificos para sempre.
  -- Cancelar nao autoriza reescrever a historia: outro documento ou outra
  -- revisao exigem OUTRO processo.
  -- ---------------------------------------------------------------------
  IF NEW.meeting_minute_id  IS DISTINCT FROM OLD.meeting_minute_id
     OR NEW.minute_revision  IS DISTINCT FROM OLD.minute_revision
     OR NEW.content_snapshot IS DISTINCT FROM OLD.content_snapshot
     OR NEW.content_hash     IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at       IS DISTINCT FROM OLD.created_at
     OR NEW.id               IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION
      'A evidencia do processo de assinatura e imutavel: documento, revisao, snapshot, hash, autor e data de criacao nao mudam. Crie um novo processo.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------------
  -- 2.2 Fornecedor: set-once, e so enquanto o processo nao e terminal.
  --
  -- Depois de associado a um envio real, o processo nao migra em silencio para
  -- outro envelope — e processo encerrado nao ganha associacao tardia.
  -- ---------------------------------------------------------------------
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN

    IF OLD.status IN ('completed', 'cancelled', 'failed') THEN
      RAISE EXCEPTION
        'Processo com status % nao aceita associacao a fornecedor.', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'provider ja associado e nao pode ser alterado.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.provider_reference IS NOT NULL
       AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
      RAISE EXCEPTION 'provider_reference ja associado e nao pode ser alterado.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- 2.3 Transicoes. Estado terminal nao ressuscita.
  --
  -- O congelamento do roster so e verdadeiro se ninguem puder devolver o
  -- processo para `prepared` e reabrir a configuracao.
  --
  --   prepared     -> prepared | in_progress | cancelled | failed
  --   in_progress  -> in_progress | completed | cancelled | failed
  --   completed    -> completed
  --   cancelled    -> cancelled
  --   failed       -> failed
  --
  -- Tentativa fracassada vira `failed` e a proxima e um processo NOVO.
  -- ---------------------------------------------------------------------
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'prepared'    AND NEW.status IN ('in_progress', 'cancelled', 'failed'))
      OR
      (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled', 'failed'))
    ) THEN
      RAISE EXCEPTION
        'Transicao de status invalida: % -> %.', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- 2.4 `completed` estruturalmente verdadeiro.
  --
  -- Concluir exige roster com ao menos um obrigatorio e NENHUM obrigatorio
  -- fora de `signed`. Signatario opcional nao bloqueia.
  --
  -- Esta barreira IMPEDE um `completed` incoerente; ela nao produz nenhum.
  -- Marcar signatario como assinado continua dependendo de evidencia externa
  -- que o sistema ainda nao possui, e a Ata NAO e aprovada aqui.
  -- ---------------------------------------------------------------------
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT count(*) FILTER (WHERE required),
           count(*) FILTER (WHERE required AND status <> 'signed')
      INTO obrigatorios, nao_assinados
      FROM meeting_minute_signers
     WHERE signature_process_id = NEW.id;

    IF obrigatorios = 0 THEN
      RAISE EXCEPTION
        'Processo sem signatario obrigatorio nao pode ser concluido.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF nao_assinados > 0 THEN
      RAISE EXCEPTION
        'Processo nao pode ser concluido: % signatario(s) obrigatorio(s) sem assinatura.', nao_assinados
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER meeting_minute_signature_processes_guard_update
  BEFORE UPDATE ON meeting_minute_signature_processes
  FOR EACH ROW EXECUTE FUNCTION meeting_minute_signature_process_guard_update();

-- -----------------------------------------------------------------------------
-- 3. Roster: composicao so enquanto o processo esta em `prepared`
-- -----------------------------------------------------------------------------
-- Depois que o processo sai de `prepared`, ninguem entra e ninguem sai. Erro no
-- roster se resolve cancelando o processo e abrindo outro — nao fazendo a
-- realidade caber no processo antigo.
CREATE FUNCTION meeting_minute_signers_guard_roster()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  processo_status text;
  processo_id     uuid := COALESCE(NEW.signature_process_id, OLD.signature_process_id);
BEGIN
  SELECT status INTO processo_status
    FROM meeting_minute_signature_processes
   WHERE id = processo_id;

  IF NOT FOUND THEN
    /*
     * O processo nao existe mais: e a exclusao em cascata (reuniao -> Ata ->
     * processo -> signatarios), que roda DEPOIS da linha pai sumir. Barrar aqui
     * impediria apagar qualquer reuniao que tivesse tido assinatura.
     */
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF processo_status <> 'prepared' THEN
    RAISE EXCEPTION
      'O roster esta congelado: processo com status % nao aceita inclusao nem exclusao de signatario.',
      processo_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER meeting_minute_signers_guard_insert
  BEFORE INSERT ON meeting_minute_signers
  FOR EACH ROW EXECUTE FUNCTION meeting_minute_signers_guard_roster();

CREATE TRIGGER meeting_minute_signers_guard_delete
  BEFORE DELETE ON meeting_minute_signers
  FOR EACH ROW EXECUTE FUNCTION meeting_minute_signers_guard_roster();

-- -----------------------------------------------------------------------------
-- 4. Signatario: identidade imutavel, configuracao so em `prepared`,
--    evidencia so em `in_progress`
-- -----------------------------------------------------------------------------
CREATE FUNCTION meeting_minute_signers_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  processo_status text;
BEGIN
  SELECT status INTO processo_status
    FROM meeting_minute_signature_processes
   WHERE id = NEW.signature_process_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Processo de assinatura % nao encontrado.', NEW.signature_process_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- ---------------------------------------------------------------------
  -- 4.1 Identidade imutavel em QUALQUER estado, inclusive `prepared`.
  --
  -- Trocar a pessoa e DELETE de um e INSERT de outro, enquanto o processo
  -- ainda esta em `prepared`. Transformar A em B por UPDATE apagaria de quem
  -- era a convocacao original.
  --
  -- `signature_process_id` entra na lista: mover um signatario de um processo
  -- para outro contornaria todo o resto.
  -- ---------------------------------------------------------------------
  IF NEW.id                   IS DISTINCT FROM OLD.id
     OR NEW.signature_process_id IS DISTINCT FROM OLD.signature_process_id
     OR NEW.user_id           IS DISTINCT FROM OLD.user_id
     OR NEW.entra_tenant_id   IS DISTINCT FROM OLD.entra_tenant_id
     OR NEW.entra_object_id   IS DISTINCT FROM OLD.entra_object_id
     OR NEW.display_name      IS DISTINCT FROM OLD.display_name
     OR NEW.email             IS DISTINCT FROM OLD.email
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'A identidade de um signatario e imutavel. Para trocar a pessoa, remova e inclua outra enquanto o processo estiver em prepared.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------------
  -- 4.2 Configuracao da convocacao: so enquanto o processo se compoe.
  -- ---------------------------------------------------------------------
  IF (NEW.required      IS DISTINCT FROM OLD.required
      OR NEW.signing_order IS DISTINCT FROM OLD.signing_order
      OR NEW.role_label  IS DISTINCT FROM OLD.role_label)
     AND processo_status <> 'prepared' THEN
    RAISE EXCEPTION
      'Processo com status % nao aceita alteracao de required, signing_order ou role_label.',
      processo_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------------
  -- 4.3 Evidencia de assinatura: so enquanto a coleta acontece.
  --
  -- `in_progress` e o unico estado em que assinar faz sentido. A integridade
  -- entre `status` e `signed_at` ja e garantida pelo CHECK da 009:
  -- (status = 'signed') = (signed_at IS NOT NULL).
  --
  -- Nada nesta migration marca ninguem como assinado.
  -- ---------------------------------------------------------------------
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.signed_at IS DISTINCT FROM OLD.signed_at)
     AND processo_status <> 'in_progress' THEN
    RAISE EXCEPTION
      'Processo com status % nao aceita alteracao de status ou data de assinatura do signatario.',
      processo_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------------
  -- 4.4 Referencia do destinatario no fornecedor: set-once.
  --
  -- Pode nascer enquanto o processo se compoe (`prepared`) ou durante a coleta
  -- (`in_progress`), para a integracao futura associar o recipient. Depois de
  -- definida, nao muda; processo terminal nao recebe associacao nova.
  -- ---------------------------------------------------------------------
  IF NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    IF processo_status NOT IN ('prepared', 'in_progress') THEN
      RAISE EXCEPTION
        'Processo com status % nao aceita associacao de signatario a fornecedor.', processo_status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.provider_reference IS NOT NULL THEN
      RAISE EXCEPTION 'provider_reference do signatario ja associado e nao pode ser alterado.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER meeting_minute_signers_guard_update
  BEFORE UPDATE ON meeting_minute_signers
  FOR EACH ROW EXECUTE FUNCTION meeting_minute_signers_guard_update();

-- -----------------------------------------------------------------------------
-- 5. Documentacao
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION meeting_minute_signature_process_check_evidence() IS
  'Na criacao: processo nasce prepared e content_hash tem de ser o SHA-256 UTF-8 de content_snapshot. sha256() e nativa do core; pgcrypto nao e usado.';

COMMENT ON FUNCTION meeting_minute_signature_process_guard_update() IS
  'Evidencia imutavel, provider set-once nao-terminal, transicoes validas e completed so com todos os signatarios obrigatorios assinados.';

COMMENT ON FUNCTION meeting_minute_signers_guard_roster() IS
  'Roster so se compoe com o processo em prepared. Cascata de exclusao passa: quando o processo ja nao existe, nao ha o que congelar.';

COMMENT ON FUNCTION meeting_minute_signers_guard_update() IS
  'Identidade do signatario imutavel sempre; configuracao so em prepared; status/signed_at so em in_progress; provider_reference set-once.';
