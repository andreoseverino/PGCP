-- =============================================================================
-- 033_documents.sql
--
-- DOCUMENTOS — metadados no PostgreSQL; bytes no AWS S3 (bucket privado).
--
-- O PostgreSQL e a FONTE DE VERDADE: contexto (reuniao, tema DA reuniao,
-- Agenda Anual), autoria, data, tipo e filtros vem daqui. A chave do objeto no
-- S3 (`object_key`) e so endereco de armazenamento — nenhuma regra de negocio a
-- interpreta e nenhuma tela lista o bucket.
--
-- CONTEXTO (exatamente um):
--   reuniao             meeting_id; opcionalmente o TEMA DAQUELA REUNIAO
--                       (meeting_agenda_item_id) — nunca o tema da Biblioteca:
--                       o mesmo tema em outra reuniao e outro contexto.
--   Agenda Anual        annual_agenda_version_id (versao enviada/aprovada),
--                       sem reuniao. Previsto para guardar o PDF oficial no S3
--                       (ainda nao gravado nesta versao; hoje e gerado do
--                       snapshot imutavel sob demanda).
--
-- INTEGRIDADE: FK COMPOSTA (meeting_id, meeting_agenda_item_id) ->
-- meeting_agenda_items (meeting_id, id) (UNIQUE da 004): o tema precisa ser da
-- MESMA reuniao, inclusive por chamada direta. Sem CASCADE: documento de
-- governanca nao some porque a reuniao/tema saiu — a aplicacao recusa a
-- exclusao com documentos (RESTRICT e a ultima barreira).
--
-- `source`: 'user' (enviado por pessoa) | 'pgcp' (gerado pelo sistema).
-- Sem exclusao nesta versao (sem DELETE para o runtime): subir outro arquivo e
-- outro documento; nao ha versionamento.
--
-- Aditiva: nenhuma linha existente e lida ou alterada.
--
-- REVERSAO (manual; runner forward-only):
--   DROP TABLE IF EXISTS documents;
--   DELETE FROM schema_migrations WHERE version = '033_documents.sql';
--   (Objetos ja enviados ao S3 ficam no bucket: remover por inventario, nao
--   por varredura de prefixo, se for o caso.)
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE documents (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source                    text        NOT NULL,
  meeting_id                uuid        REFERENCES meetings (id) ON DELETE RESTRICT,
  meeting_agenda_item_id    uuid,
  annual_agenda_version_id  uuid        REFERENCES annual_agenda_versions (id) ON DELETE RESTRICT,
  -- Nome ORIGINAL, so para exibicao/download (nunca parte da chave do S3).
  original_filename         text        NOT NULL,
  description               text,
  -- MIME decidido pelo SERVIDOR a partir da extensao permitida.
  mime_type                 text        NOT NULL,
  size_bytes                bigint      NOT NULL,
  sha256                    text        NOT NULL,
  object_key                text        NOT NULL,
  uploaded_by_user_id       uuid        REFERENCES users (id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_source_check CHECK (source IN ('user', 'pgcp')),
  CONSTRAINT documents_context_check CHECK (
    num_nonnulls(meeting_id, annual_agenda_version_id) = 1
    AND (meeting_agenda_item_id IS NULL OR meeting_id IS NOT NULL)
  ),
  CONSTRAINT documents_user_author_check CHECK (source <> 'user' OR uploaded_by_user_id IS NOT NULL),
  CONSTRAINT documents_filename_check CHECK (char_length(btrim(original_filename)) BETWEEN 1 AND 255),
  CONSTRAINT documents_description_check CHECK (description IS NULL OR char_length(description) <= 500),
  CONSTRAINT documents_size_check CHECK (size_bytes > 0),
  CONSTRAINT documents_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT documents_object_key_uk UNIQUE (object_key),
  CONSTRAINT documents_meeting_item_fk
    FOREIGN KEY (meeting_id, meeting_agenda_item_id)
    REFERENCES meeting_agenda_items (meeting_id, id) ON DELETE RESTRICT
);

CREATE INDEX documents_meeting_idx ON documents (meeting_id, created_at DESC) WHERE meeting_id IS NOT NULL;
CREATE INDEX documents_item_idx ON documents (meeting_agenda_item_id) WHERE meeting_agenda_item_id IS NOT NULL;
CREATE INDEX documents_agenda_version_idx ON documents (annual_agenda_version_id) WHERE annual_agenda_version_id IS NOT NULL;
CREATE INDEX documents_created_at_idx ON documents (created_at DESC);

COMMENT ON TABLE documents IS
  'Documentos do PGCP: metadados e contexto (reuniao, tema da reuniao ou versao da Agenda Anual). Bytes no AWS S3 privado (object_key); o PostgreSQL e a fonte de verdade. Sem exclusao nesta versao.';
COMMENT ON COLUMN documents.meeting_agenda_item_id IS
  'Tema DESTA reuniao (meeting_agenda_items), nunca o tema da Biblioteca. FK composta garante a mesma reuniao.';
COMMENT ON COLUMN documents.object_key IS
  'Endereco do objeto no bucket (ids estaveis). Nunca devolvido ao cliente nem interpretado como regra de negocio.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 033 ignorados.';
    RETURN;
  END IF;
  -- Documento e registrado e lido; nao e alterado nem apagado pelo runtime
  -- (os privilegios padrao do schema concederiam UPDATE/DELETE: revogados).
  EXECUTE 'GRANT SELECT, INSERT ON public.documents TO pcgp_app';
  EXECUTE 'REVOKE UPDATE, DELETE ON public.documents FROM pcgp_app';
  RAISE NOTICE 'Privilegios da 033 concedidos a pcgp_app.';
END $$;
