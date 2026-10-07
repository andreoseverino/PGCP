-- =============================================================================
-- 037_document_favorites.sql
--
-- FAVORITOS DA BIBLIOTECA — preferência PESSOAL de cada usuário.
--
-- Não altera o documento, não é classificação corporativa e não dá acesso a
-- nada: favoritar exige poder ler o documento (conferido pela aplicação com a
-- mesma política da Biblioteca), e a lista de Favoritos é sempre recortada pela
-- visibilidade atual — um favorito que a pessoa deixou de poder ver some.
--
-- Chave = o id OPACO da Biblioteca, porque Atas e Agenda Anual são documentos
-- GERADOS (sem linha em `documents`):
--   doc:<uuid>     anexo (`documents.id`)
--   ata:<uuid>     Ata da reunião (`meetings.id`)
--   agenda:<uuid>  versão vigente da Agenda Anual (`annual_agenda_versions.id`)
-- Sem FK para esses alvos (são três tabelas); o formato é conferido no CHECK.
--
-- Sem `audit_logs`: favoritar é preferência de leitura, não ato de governança
-- (mesma regra das leituras).
--
-- ADITIVA. Reversão (manual; runner forward-only):
--   DROP TABLE IF EXISTS document_favorites;
--   DELETE FROM schema_migrations WHERE version = '037_document_favorites.sql';
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE document_favorites (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Preferência pessoal: some com o usuário.
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_key  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT document_favorites_key_check CHECK (
    document_key ~ '^(doc|ata|agenda):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT document_favorites_user_key_uk UNIQUE (user_id, document_key)
);

COMMENT ON TABLE document_favorites IS
  'Favoritos da Biblioteca: preferência pessoal (usuário + id opaco do documento). Não altera o documento nem concede acesso.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 037 ignorados.';
    RETURN;
  END IF;
  -- Marcar e desmarcar; nunca alterar no lugar.
  EXECUTE 'REVOKE ALL ON public.document_favorites FROM pcgp_app';
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.document_favorites TO pcgp_app';
  RAISE NOTICE 'Privilegios da 037 concedidos a pcgp_app.';
END $$;
