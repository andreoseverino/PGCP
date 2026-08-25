-- =============================================================================
-- 002_add_entra_identity_to_users.sql
--
-- Prepara users para a identidade corporativa Microsoft Entra ID.
-- NAO implementa SSO: apenas o schema que o SSO vai usar depois.
--
-- Decisao de arquitetura:
--   users.id                          -> identificador INTERNO do PGCP (PK)
--   entra_tenant_id + entra_object_id -> identidade MICROSOFT (tid + oid)
--   email                             -> ATRIBUTO (exibicao, busca, contato)
--
-- O e-mail deixa de ser identificador tecnico: pode mudar, pode ser reciclado
-- e nao e estavel o suficiente para amarrar uma identidade.
--
-- Aplicado dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Identidade Microsoft
-- -----------------------------------------------------------------------------
-- NULL enquanto o SSO nao existe e para registros locais/demonstracao.
ALTER TABLE users
  ADD COLUMN entra_object_id uuid,
  ADD COLUMN entra_tenant_id uuid;

-- Coerencia do par: ou os dois preenchidos, ou os dois nulos.
-- Comparar dois IS NULL produz sempre boolean nao-nulo, entao o CHECK nunca
-- passa por omissao (um CHECK que resulta em NULL seria aceito pelo Postgres).
ALTER TABLE users
  ADD CONSTRAINT users_entra_identity_pairing_check
  CHECK ((entra_object_id IS NULL) = (entra_tenant_id IS NULL));

-- Unicidade apenas quando ha identidade Microsoft. Parcial porque a coluna
-- aceita NULL e um UNIQUE comum trataria cada NULL como distinto.
-- tenant primeiro: serve tanto a busca do par quanto "usuarios de um tenant".
CREATE UNIQUE INDEX users_entra_identity_uk
  ON users (entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL AND entra_tenant_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. E-mail deixa de ser identidade tecnica
-- -----------------------------------------------------------------------------
-- Remove a unicidade case-sensitive criada em 001. O e-mail continua NOT NULL
-- (dado obrigatorio), mas nao identifica mais o usuario.
ALTER TABLE users DROP CONSTRAINT users_email_key;

-- Indice NAO-unico: preserva a busca por e-mail exato que a UI ja faz,
-- sem reintroduzir regra de identidade.
CREATE INDEX users_email_idx ON users (email);


-- -----------------------------------------------------------------------------
-- 3. Remove external_id (superseded)
-- -----------------------------------------------------------------------------
-- external_id foi criado em 001 como "objectId do Entra ID". entra_object_id
-- agora cobre esse papel com o tipo correto (uuid) e pareado ao tenant.
-- Manter as duas deixaria duas colunas disputando "identidade externa".
-- O UNIQUE users_external_id_key cai junto com a coluna.
ALTER TABLE users DROP COLUMN external_id;


-- -----------------------------------------------------------------------------
-- 4. Documentacao no proprio schema
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN users.id IS
  'PK INTERNA do PGCP. Todas as FKs do sistema apontam para ca. Nunca exposta como identidade Microsoft.';

COMMENT ON COLUMN users.entra_object_id IS
  'oid do Microsoft Entra ID. Estavel por identidade. NULL enquanto nao houver SSO.';

COMMENT ON COLUMN users.entra_tenant_id IS
  'tid do Microsoft Entra ID. Junto com entra_object_id forma a identidade Microsoft unica.';

COMMENT ON COLUMN users.email IS
  'ATRIBUTO: exibicao, busca, comunicacao e notificacoes. NAO e identidade tecnica, NAO e unico e NAO deve ser usado para resolver o usuario autenticado.';

COMMENT ON COLUMN users.upn IS
  'User Principal Name do Entra. Parece e-mail e pode mudar: tambem NAO e identidade tecnica.';
