-- =============================================================================
-- 009_meeting_minute_signature_processes.sql
--
-- Camada formal de aprovacao da Ata — modelo DEFINITIVO e provider-agnostic.
--
-- Separa quatro conceitos que a implementacao anterior misturava num array de
-- strings dentro do navegador:
--
--   meeting_minutes                     o documento e a revisao vigente
--   meeting_minute_signature_processes  a tentativa formal de assinar UMA revisao
--   meeting_minute_signers              quem precisa assinar aquele processo
--   provider / provider_reference       DocuSign ou equivalente, quando existir
--
-- NADA DE DOCUSIGN AQUI. Nenhuma coluna carrega envelope, aba, recipient,
-- webhook ou status especifico de fornecedor. `provider` guarda o identificador
-- ja usado pelo registro de integracoes (`docusign`), e `provider_reference`
-- guarda o identificador opaco que ele devolver. Uma integracao futura preenche
-- essas duas colunas e a de cada signatario; nao remodela nada.
--
-- NENHUM SEGREDO. Client id, secret, token e payload de fornecedor vivem em
-- variaveis de ambiente, como ja acontece em `integrations/registry.ts`. Nunca
-- nestas tabelas.
--
-- ASSINATURA PERTENCE A UMA REVISAO, nao a Ata em abstrato. Um processo da
-- revisao 5 nao aprova a revisao 6 — a regra e estrutural e esta garantida por
-- tres mecanismos independentes descritos na secao 4.
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Processo de assinatura
-- -----------------------------------------------------------------------------
CREATE TABLE meeting_minute_signature_processes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  meeting_minute_id  uuid        NOT NULL REFERENCES meeting_minutes (id) ON DELETE CASCADE,

  -- Revisao EXATA que foi enviada para assinatura. Nao e derivavel da Ata: o
  -- documento evolui, e o processo precisa continuar apontando para o que
  -- estava valendo quando ele nasceu.
  --
  -- Deliberadamente NAO existe FK composta para (meeting_minutes.id, revision):
  -- `revision` muda a cada edicao, e uma FK sobre coluna mutavel impediria
  -- qualquer edicao futura da Ata enquanto sobrevivesse um processo antigo,
  -- ate cancelado. A amarracao com a versao e feita pelo par snapshot/hash
  -- abaixo e validada na criacao pelo gatilho da secao 4.
  minute_revision    integer     NOT NULL,

  -- Estados de DOMINIO, nao do fornecedor:
  --   prepared     signatarios definidos, nada enviado
  --   in_progress  entregue ao fornecedor, coleta em andamento
  --   completed    todos os obrigatorios assinaram
  --   cancelled    decisao humana de inutilizar o processo
  --   failed       desfecho terminal vindo do fornecedor, sem decisao humana
  --
  -- `failed` existe hoje sem caminho para ser alcancado — mesma situacao ja
  -- aceita para `meeting_minutes.status = 'approved'`. Esta aqui porque um
  -- envelope recusado pelo fornecedor NAO e um cancelamento: dizer o contrario
  -- atribuiria a uma pessoa uma decisao que ela nao tomou.
  --
  -- Status especifico do fornecedor (`sent`, `delivered`, `voided`, ...) NAO
  -- entra nesta coluna. Se um dia precisar ser guardado, tera coluna propria.
  status             text        NOT NULL DEFAULT 'prepared',

  -- Identificador do fornecedor no MESMO vocabulario de integrations/registry:
  -- hoje so existiria 'docusign'. Nulo enquanto o processo for interno.
  provider           text,
  -- Identificador opaco devolvido pelo fornecedor (no DocuSign, o envelopeId).
  -- Nunca token, nunca credencial.
  provider_reference text,

  -- EVIDENCIA IMUTAVEL do que foi enviado. `meeting_minutes.content` evolui;
  -- estas duas colunas nao. O texto integral responde "o que foi assinado" e o
  -- hash responde "e o mesmo?" sem precisar comparar o documento inteiro — e e
  -- o que se entrega a um fornecedor ou a um auditor externo.
  --
  -- SHA-256 em hexadecimal minusculo, calculado na aplicacao sobre o UTF-8 do
  -- conteudo. Nao ha `digest()` aqui: pgcrypto nao esta instalado, e calcular
  -- na aplicacao mantem a evidencia igual a que o cliente do fornecedor envia.
  content_snapshot   text        NOT NULL,
  content_hash       text        NOT NULL,

  -- ON DELETE RESTRICT: nao se apaga quem preparou um processo formal. O
  -- sistema desativa usuario (`users.is_active`), nao remove.
  created_by_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  cancelled_at       timestamptz,

  CONSTRAINT meeting_minute_signature_processes_status_check CHECK (
    status IN ('prepared', 'in_progress', 'completed', 'cancelled', 'failed')
  ),

  CONSTRAINT meeting_minute_signature_processes_revision_check CHECK (minute_revision > 0),

  -- Marca temporal e estado andam juntos nos dois sentidos: nao ha processo
  -- concluido sem data de conclusao, nem data de conclusao em processo que nao
  -- concluiu.
  CONSTRAINT meeting_minute_signature_processes_completed_check CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT meeting_minute_signature_processes_cancelled_check CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),

  -- Referencia de fornecedor sem fornecedor nao identifica nada.
  CONSTRAINT meeting_minute_signature_processes_provider_check CHECK (
    provider_reference IS NULL OR provider IS NOT NULL
  ),

  CONSTRAINT meeting_minute_signature_processes_hash_check CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
  )
);

-- UM processo ativo por Ata. Dois processos abertos ao mesmo tempo tornariam a
-- pergunta "esta revisao esta em assinatura?" ambigua. Processos encerrados
-- (completed/cancelled/failed) acumulam a vontade: sao o historico formal.
CREATE UNIQUE INDEX meeting_minute_signature_processes_active_uk
  ON meeting_minute_signature_processes (meeting_minute_id)
  WHERE status IN ('prepared', 'in_progress');

CREATE INDEX meeting_minute_signature_processes_minute_idx
  ON meeting_minute_signature_processes (meeting_minute_id);

CREATE INDEX meeting_minute_signature_processes_created_by_idx
  ON meeting_minute_signature_processes (created_by_user_id);

CREATE TRIGGER meeting_minute_signature_processes_set_updated_at
  BEFORE UPDATE ON meeting_minute_signature_processes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE meeting_minute_signature_processes IS
  'Tentativa formal de assinar UMA revisao da Ata. Provider-agnostic: DocuSign preenche provider/provider_reference sem remodelar nada.';

COMMENT ON COLUMN meeting_minute_signature_processes.minute_revision IS
  'Revisao exata enviada para assinatura. Assinaturas desta revisao nao aprovam nenhuma outra.';

COMMENT ON COLUMN meeting_minute_signature_processes.content_snapshot IS
  'Copia integral do texto enviado. Evidencia do que foi assinado, independente da evolucao de meeting_minutes.content.';

COMMENT ON COLUMN meeting_minute_signature_processes.content_hash IS
  'SHA-256 hexadecimal do UTF-8 de content_snapshot, calculado na aplicacao.';

COMMENT ON COLUMN meeting_minute_signature_processes.provider IS
  'Identificador do fornecedor no mesmo vocabulario de integrations/registry (ex.: docusign). Nunca credencial.';

-- -----------------------------------------------------------------------------
-- 2. Signatarios
-- -----------------------------------------------------------------------------
-- Mesmo modelo de identidade ja consolidado em `meeting_participants`:
--
--   users.id                        identidade INTERNA do PGCP
--   entra_tenant_id + object_id     identidade MICROSOFT (tid + oid)
--   display_name / email            snapshot de exibicao e de entrega
--
-- Nunca intercambiaveis, e nunca se reconcilia por nome, e-mail ou UPN.
-- NENHUM usuario e criado para satisfazer FK: `user_id` e anulavel justamente
-- para caber quem nao tem conta no PGCP.
CREATE TABLE meeting_minute_signers (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  signature_process_id uuid        NOT NULL
                                   REFERENCES meeting_minute_signature_processes (id) ON DELETE CASCADE,

  -- ON DELETE RESTRICT: nao se apaga quem foi convocado a assinar.
  user_id              uuid        REFERENCES users (id) ON DELETE RESTRICT,

  entra_tenant_id      uuid,
  entra_object_id      uuid,

  -- Snapshot obrigatorio: a evidencia precisa dizer QUEM foi convocado com o
  -- nome que valia naquele momento, mesmo que a pessoa nao tenha conta aqui.
  display_name         text        NOT NULL,
  -- Necessario para quem so pode ser alcancado por e-mail (externo). Nao e
  -- identidade: nunca serve para reconciliar pessoa.
  email                text,

  -- Texto livre, como `meeting_participants.role_in_meeting`. Nao existe
  -- taxonomia de papel no produto, e inventar uma aqui seria decidir sozinho
  -- quem assina. Ver o relatorio da 4.11.
  role_label           text,

  -- Ordem desejada de coleta. Nao implica dependencia hoje; existe para o
  -- fornecedor que a respeita.
  signing_order        integer     NOT NULL DEFAULT 1,
  -- Signatario opcional nao impede a conclusao do processo.
  required             boolean     NOT NULL DEFAULT true,

  status               text        NOT NULL DEFAULT 'pending',
  signed_at            timestamptz,

  -- Identificador do destinatario no fornecedor (no DocuSign, o recipientId).
  provider_reference   text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_minute_signers_status_check CHECK (
    status IN ('pending', 'signed', 'declined')
  ),

  -- Data de assinatura e estado assinado sao a mesma afirmacao.
  CONSTRAINT meeting_minute_signers_signed_at_check CHECK (
    (status = 'signed') = (signed_at IS NOT NULL)
  ),

  -- O par do Entra nasce e morre junto. Meia identidade (so tenant ou so oid)
  -- nao identifica ninguem e e recusada pelo banco.
  CONSTRAINT meeting_minute_signers_entra_pairing_check CHECK (
    (entra_object_id IS NULL) = (entra_tenant_id IS NULL)
  ),

  -- Precisa haver ao menos um caminho real ate a pessoa: conta no PGCP,
  -- identidade Microsoft ou e-mail. Só um nome digitado nao e signatario.
  CONSTRAINT meeting_minute_signers_identity_check CHECK (
    user_id IS NOT NULL
    OR entra_object_id IS NOT NULL
    OR length(btrim(COALESCE(email, ''))) > 0
  ),

  CONSTRAINT meeting_minute_signers_display_name_check CHECK (
    length(btrim(display_name)) > 0
  ),

  CONSTRAINT meeting_minute_signers_signing_order_check CHECK (signing_order > 0)
);

-- Uma pessoa nao pode ser convocada duas vezes no mesmo processo. Tres indices
-- porque sao tres identidades distintas, e cada uma so vale quando presente —
-- mesmo desenho de `meeting_participants`.
CREATE UNIQUE INDEX meeting_minute_signers_process_user_uk
  ON meeting_minute_signers (signature_process_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX meeting_minute_signers_process_entra_uk
  ON meeting_minute_signers (signature_process_id, entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL AND entra_tenant_id IS NOT NULL;

CREATE UNIQUE INDEX meeting_minute_signers_process_email_uk
  ON meeting_minute_signers (signature_process_id, lower(email))
  WHERE user_id IS NULL AND entra_object_id IS NULL AND email IS NOT NULL;

CREATE INDEX meeting_minute_signers_process_idx
  ON meeting_minute_signers (signature_process_id);

CREATE INDEX meeting_minute_signers_user_idx
  ON meeting_minute_signers (user_id);

CREATE TRIGGER meeting_minute_signers_set_updated_at
  BEFORE UPDATE ON meeting_minute_signers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE meeting_minute_signers IS
  'Pessoas convocadas a assinar um processo. Suporta usuario PGCP, pessoa do Entra sem conta e externo por e-mail, sem criar usuario fake.';

COMMENT ON COLUMN meeting_minute_signers.display_name IS
  'Snapshot de exibicao no momento da convocacao. Nunca serve como identidade nem para reconciliacao.';

COMMENT ON COLUMN meeting_minute_signers.provider_reference IS
  'Identificador do destinatario no fornecedor (no DocuSign, recipientId). Preenchido pela integracao futura.';

-- -----------------------------------------------------------------------------
-- 3. Pre-condicao: so revisao saneada entra em assinatura
-- -----------------------------------------------------------------------------
-- Regra: existe processo formal para a revisao ATUAL somente quando
--
--   meeting_minutes.status = 'under_review'
--   AND secretariat_cleared_revision = revision
--
-- Editar depois do saneamento devolve a Ata para `draft` e derruba a igualdade,
-- entao o conteudo alterado nao consegue entrar em assinatura.
--
-- Vive no banco, e nao so no servico, porque e a autoridade final: nenhum
-- caminho — script, correcao manual, endpoint futuro — pode criar um processo
-- sobre revisao nao saneada.
CREATE FUNCTION meeting_minute_signature_process_precondition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ata record;
BEGIN
  SELECT status, revision, secretariat_cleared_revision
    INTO ata
    FROM meeting_minutes
   WHERE id = NEW.meeting_minute_id
     FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ata % nao encontrada.', NEW.meeting_minute_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.minute_revision <> ata.revision THEN
    RAISE EXCEPTION
      'Processo de assinatura deve referenciar a revisao vigente da Ata (informada %, vigente %).',
      NEW.minute_revision, ata.revision
      USING ERRCODE = 'check_violation';
  END IF;

  IF ata.status <> 'under_review'
     OR ata.secretariat_cleared_revision IS DISTINCT FROM ata.revision THEN
    RAISE EXCEPTION
      'A revisao % da Ata nao esta saneada pela Secretaria e nao pode entrar em assinatura.',
      ata.revision
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER meeting_minute_signature_processes_precondition
  BEFORE INSERT ON meeting_minute_signature_processes
  FOR EACH ROW EXECUTE FUNCTION meeting_minute_signature_process_precondition();

-- -----------------------------------------------------------------------------
-- 4. Congelamento: revisao em assinatura nao muda por baixo do processo
-- -----------------------------------------------------------------------------
-- Enquanto houver processo `prepared` ou `in_progress`, o CONTEUDO daquela
-- revisao fica congelado. Para alterar: cancelar o processo, editar (nova
-- revision), sanear de novo e abrir novo processo. Assinatura antiga nunca e
-- reaproveitada para conteudo novo.
--
-- So o conteudo e barrado. `status`, `secretariat_cleared_*` e as marcas de
-- tempo continuam podendo mudar — e por elas que o processo conclui e a Ata
-- chega a `approved`.
CREATE FUNCTION meeting_minutes_block_content_while_signing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ativo uuid;
BEGIN
  IF OLD.content IS NOT DISTINCT FROM NEW.content THEN
    RETURN NEW;
  END IF;

  SELECT id
    INTO ativo
    FROM meeting_minute_signature_processes
   WHERE meeting_minute_id = NEW.id
     AND status IN ('prepared', 'in_progress')
   LIMIT 1;

  IF ativo IS NOT NULL THEN
    RAISE EXCEPTION
      'A revisao % da Ata esta em processo de assinatura e nao pode ser alterada. Cancele o processo antes de editar.',
      OLD.revision
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER meeting_minutes_block_content_while_signing
  BEFORE UPDATE OF content ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION meeting_minutes_block_content_while_signing();
