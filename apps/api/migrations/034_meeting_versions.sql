-- =============================================================================
-- 034_meeting_versions.sql
--
-- VERSÕES DA REUNIÃO — "fotografia" auditável a cada alteração relevante.
--
-- Mesmo desenho da Agenda Anual (028): o DADO ESTRUTURADO é a fonte técnica da
-- versão (`snapshot` jsonb, imutável); o PDF é a representação visual, gerado
-- deterministicamente desse snapshot sob demanda. Nenhum byte vai ao S3 aqui:
-- versionar não pode depender de um armazenamento externo configurado — uma
-- falha do bucket faria a edição da reunião falhar.
--
-- QUANDO NASCE UMA VERSÃO: no fim da MESMA transação da mutação da reunião
-- (criação, cabeçalho, participantes, pautas, temas, ordem, postergação, convite
-- Outlook/Teams criado). A aplicação compara o hash do conteúdo novo com o da
-- última versão: igual = nenhuma versão (abrir e salvar sem mudar nada não gera
-- foto). Mutação que falha faz ROLLBACK e leva a versão junto.
--
--   snapshot.conteudo  o que define a versão (entra no hash)
--   snapshot.contexto  informação do momento que NÃO cria versão sozinha
--                      (nome do órgão, Presidente da Mesa, validação de pautas,
--                      último envio ao Outlook) — mudar o órgão no cadastro não
--                      pode criar versão de toda reunião do órgão.
--
-- IMUTABILIDADE em duas camadas (mesmo padrão da 028):
--   privilégios  o runtime só faz SELECT e INSERT;
--   trigger      recusa UPDATE sempre e DELETE enquanto a reunião existir.
--
-- EXCLUSÃO DA REUNIÃO: ON DELETE CASCADE, como Ata, Anotações e participantes.
-- A exclusão em si fica na trilha (`audit_logs`, "Reunião excluída"). A ação
-- referencial roda com o dono da tabela, e o trigger a permite porque a reunião
-- já não existe naquele instante.
--
-- ADITIVA: nenhuma tabela existente é alterada.
--
-- REVERSÃO (manual; runner forward-only):
--   DROP TABLE IF EXISTS meeting_versions;
--   DROP FUNCTION IF EXISTS meeting_versions_imutavel();
--   DELETE FROM schema_migrations WHERE version = '034_meeting_versions.sql';
--   (Perde só o histórico de versões; reuniões e auditoria permanecem.)
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE meeting_versions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  version             integer     NOT NULL,
  snapshot            jsonb       NOT NULL,
  -- SHA-256 (hex) de `snapshot.conteudo` canônico, calculado na aplicação.
  content_hash        text        NOT NULL,
  -- O que mudou em relação à versão anterior ("Criação", "Participantes", ...).
  change_summary      text        NOT NULL,
  created_by_user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_versions_number_uk UNIQUE (meeting_id, version),
  CONSTRAINT meeting_versions_version_check CHECK (version > 0),
  CONSTRAINT meeting_versions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT meeting_versions_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meeting_versions_summary_check CHECK (char_length(btrim(change_summary)) BETWEEN 1 AND 300)
);

CREATE INDEX meeting_versions_meeting_idx ON meeting_versions (meeting_id, version DESC);

COMMENT ON TABLE meeting_versions IS
  'Versões auditáveis da reunião: snapshot imutável a cada alteração relevante persistida. O PDF é gerado do snapshot.';
COMMENT ON COLUMN meeting_versions.snapshot IS
  '{ schema, conteudo, contexto }. Só `conteudo` entra no hash e decide se há versão nova.';

CREATE FUNCTION meeting_versions_imutavel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Só a cascata da exclusão da reunião remove versões.
    IF EXISTS (SELECT 1 FROM meetings WHERE id = OLD.meeting_id) THEN
      RAISE EXCEPTION 'Versão da reunião não pode ser excluída.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Versão da reunião é imutável.'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER meeting_versions_imutavel
  BEFORE UPDATE OR DELETE ON meeting_versions
  FOR EACH ROW EXECUTE FUNCTION meeting_versions_imutavel();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 034 ignorados.';
    RETURN;
  END IF;
  -- Os privilégios padrão do schema dariam UPDATE/DELETE: restringidos.
  EXECUTE 'REVOKE ALL ON public.meeting_versions FROM pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT ON public.meeting_versions TO pcgp_app';
  RAISE NOTICE 'Privilegios da 034 concedidos a pcgp_app.';
END $$;
