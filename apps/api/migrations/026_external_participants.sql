-- =============================================================================
-- 026_external_participants.sql
--
-- Cadastro local de PARTICIPANTES EXTERNOS: pessoas que precisam participar de
-- reunioes, mas NAO existem no tenant corporativo (Entra ID).
--
-- PARTICIPANTE != USUARIO.
--
--   users                  pessoa AUTENTICADA no PGCP (Entra + App Roles),
--                          provisionada so no login (JIT). Nao e reaproveitada
--                          aqui: uma linha em `users` e uma identidade do sistema.
--   external_participants  pessoa que so PARTICIPA: sem login, sem App Role,
--                          sem identidade Microsoft. Existe para ser convidada.
--
-- Nome: o dominio ja chama de `external` quem participa sem identidade
-- corporativa (`meeting_participants.participant_type = 'external'`, decisao 6
-- do modelo). Esta tabela e o CADASTRO reutilizavel dessas pessoas.
--
-- Pessoas do Entra NAO sao copiadas para ca: continuam vindo do diretorio
-- (`/directory/users`), sob as regras atuais. A tela consolida as duas origens;
-- o banco nao mistura.
--
-- Uso em reuniao: ao convidar, a pessoa vira uma linha comum de
-- `meeting_participants` (user_id NULL, sem par Entra, participant_type
-- 'external', display_name + email como snapshot) — exatamente o convidado
-- externo que o modelo ja suporta desde 001. O convite do Outlook so precisa do
-- e-mail. Sem FK de `meeting_participants` para ca: a reuniao guarda o snapshot
-- daquela sessao, e remover o cadastro nao altera reunioes passadas.
--
-- ORGAO COLEGIADO: um so, opcional, pelo cadastro existente
-- (`governance_bodies`). O modelo nao tem relacao N:N de pessoa com orgao;
-- criar uma agora seria estrutura sem requisito. Limitacao documentada.
--
-- ADITIVA. Reversao manual (o runner e forward-only):
--   DROP TABLE IF EXISTS external_participants;
--   DELETE FROM schema_migrations WHERE version = '026_external_participants.sql';
--
-- Aplicada dentro de uma transacao pelo runner: NAO incluir BEGIN/COMMIT aqui.
-- =============================================================================

CREATE TABLE external_participants (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name           text        NOT NULL,
  email               text        NOT NULL,
  -- TEXTO, nunca numero: preserva DDI/DDD, zeros a esquerda e formatacao.
  phone               text        NOT NULL,
  governance_body_id  uuid        REFERENCES governance_bodies (id) ON DELETE RESTRICT,
  created_by_user_id  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Tetos no banco tambem (defesa em profundidade, mesmo padrao da 016).
  CONSTRAINT external_participants_name_check  CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 200),
  CONSTRAINT external_participants_email_check CHECK (
    char_length(email) BETWEEN 3 AND 254 AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  ),
  CONSTRAINT external_participants_phone_check CHECK (phone ~ '^[0-9+() -]{6,30}$')
);

-- E-mail unico SEM diferenciar maiusculas: mesmo criterio do indice parcial de
-- convidados de `meeting_participants` (001).
CREATE UNIQUE INDEX external_participants_email_uk ON external_participants (lower(email));

CREATE INDEX external_participants_body_idx
  ON external_participants (governance_body_id)
  WHERE governance_body_id IS NOT NULL;

CREATE TRIGGER external_participants_set_updated_at
  BEFORE UPDATE ON external_participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE external_participants IS
  'Participantes externos (fora do Entra) cadastrados no PGCP. NAO sao usuarios: sem login, sem App Role, sem identidade Microsoft.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants da 026 ignorados.';
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_participants TO pcgp_app';
  RAISE NOTICE 'Privilegios da 026 concedidos a pcgp_app.';
END $$;
