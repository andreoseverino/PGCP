-- Validacao de pautas e modelo de e-mail.
--
-- Separa TRES coisas que ate aqui aconteciam juntas na criacao da reuniao:
--
--   1. preparar a reuniao dentro do PGCP  (pautas, participantes, documentos)
--   2. validar as pautas com o aprovador  (PDF por e-mail, ato externo)
--   3. enviar o convite Outlook + Teams   (ato irreversivel para terceiros)
--
-- Antes, criar a reuniao ja disparava (3). O convite chegava na caixa dos
-- executivos antes de a pauta existir, e corrigir significava reenviar convite.
--
-- POR QUE COLUNAS NOVAS E NAO `meetings.status`:
--
--   `meetings.status` e o ciclo de vida da REUNIAO (scheduled, in_progress,
--   done). O ciclo da PAUTA e outro eixo: uma reuniao agendada pode estar com
--   pauta em preparacao, enviada ou aprovada. Espremer os dois na mesma coluna
--   obrigaria a inventar combinacoes e quebraria os filtros existentes.
--
--   Os valores 'needs_approval' e 'approved' existem no CHECK de
--   `meetings_status_check`, mas `meetings/update.ts` documenta que foram
--   aposentados e "nao voltam ao fluxo novo". Reaproveita-los mudaria o
--   significado de dado ja gravado.
--
-- "CONVITE ENVIADO" NAO GANHA COLUNA. Ja e representado por
-- `meeting_calendar_integrations.sync_status = 'synced'`, com o
-- `provider_event_id` como prova. Uma segunda fonte poderia discordar dela.


-- ---------------------------------------------------------------------------
-- 1. Ciclo de validacao da pauta
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN agenda_validation_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN agenda_validation_sent_at timestamptz,
  -- Endereco do aprovador. Dado de negocio: a Secretaria precisa saber a quem
  -- pediu validacao. Nao e credencial e nao e identidade — o aprovador pode
  -- nem ter conta no PGCP.
  ADD COLUMN agenda_validation_sent_to text,
  ADD COLUMN agenda_approved_at timestamptz,
  -- Quem marcou como aprovada DENTRO do PGCP. A aprovacao real acontece fora
  -- (por e-mail); esta coluna registra quem a declarou aqui, e por isso e
  -- RESTRICT: apagar o usuario apagaria a responsabilidade pelo ato.
  ADD COLUMN agenda_approved_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_agenda_validation_status_check
    CHECK (agenda_validation_status IN ('draft', 'sent', 'approved'));

-- Coerencia entre o estado e as marcas de tempo. Sem isto, 'approved' sem
-- `agenda_approved_at` seria representavel, e o relatorio nao teria como
-- distinguir "aprovada quando?" de "nunca aprovada".
ALTER TABLE meetings
  ADD CONSTRAINT meetings_agenda_validation_coerente_check CHECK (
    (agenda_validation_status = 'draft'
      AND agenda_validation_sent_at IS NULL
      AND agenda_approved_at IS NULL)
    OR (agenda_validation_status = 'sent'
      AND agenda_validation_sent_at IS NOT NULL
      AND agenda_approved_at IS NULL)
    OR (agenda_validation_status = 'approved'
      AND agenda_approved_at IS NOT NULL)
  );

COMMENT ON COLUMN meetings.agenda_validation_status IS
  'Ciclo da PAUTA: draft -> sent -> approved. Independente de meetings.status (ciclo da reuniao) e de meeting_calendar_integrations.sync_status (convite).';
COMMENT ON COLUMN meetings.agenda_validation_sent_to IS
  'E-mail do aprovador a quem a pauta foi enviada. Dado de negocio, nunca credencial.';
COMMENT ON COLUMN meetings.agenda_approved_by_user_id IS
  'Quem DECLAROU a aprovacao no PGCP. A aprovacao em si acontece fora do sistema.';

-- Reuniao preparada e reuniao pronta para convite sao as duas consultas que a
-- tela faz; o indice parcial cobre as duas sem pesar nas linhas ja aprovadas.
CREATE INDEX meetings_agenda_validation_status_idx
  ON meetings (agenda_validation_status)
  WHERE agenda_validation_status <> 'approved';


-- ---------------------------------------------------------------------------
-- 2. Modelo de e-mail configuravel
-- ---------------------------------------------------------------------------
--
-- Tabela, e nao variavel de ambiente: o texto e editado pela administracao pela
-- tela, precisa de trilha de quem mudou e nao pode exigir redeploy.
--
-- CHAVE, e nao linha livre: hoje existe um unico modelo
-- ('agenda_validation'). A chave evita que um segundo modelo futuro precise de
-- outra tabela, sem abrir espaco para registro solto sem significado.

CREATE TABLE email_templates (
  key              text        PRIMARY KEY,
  subject          text        NOT NULL,
  body             text        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Nulo apenas para a semente inicial, que nao tem autor humano.
  updated_by_user_id uuid      REFERENCES users (id) ON DELETE SET NULL,

  -- Tetos no BANCO, nao so no backend: defesa em profundidade contra corpo
  -- gigante chegando por uma rota futura que esqueca de validar.
  CONSTRAINT email_templates_subject_len_check CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT email_templates_body_len_check    CHECK (char_length(body) BETWEEN 1 AND 20000),
  CONSTRAINT email_templates_key_check         CHECK (key IN ('agenda_validation'))
);

COMMENT ON TABLE email_templates IS
  'Modelos de e-mail editaveis pela administracao. Texto puro com variaveis {{...}}; NUNCA HTML bruto vindo do usuario.';
COMMENT ON COLUMN email_templates.body IS
  'Corpo em TEXTO PURO. Variaveis suportadas: {{nome_reuniao}}, {{data_reuniao}}, {{solicitante}}, {{quantidade_pautas}}.';

CREATE TRIGGER email_templates_set_updated_at
  BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Semente. `ON CONFLICT DO NOTHING` mantem a migration reaplicavel sem
-- sobrescrever um texto que a administracao ja tenha ajustado.
INSERT INTO email_templates (key, subject, body) VALUES (
  'agenda_validation',
  'Validação de pautas — {{nome_reuniao}}',
  E'Olá,\n\n'
  || E'{{solicitante}} solicita a validação das pautas da reunião "{{nome_reuniao}}", '
  || E'marcada para {{data_reuniao}}.\n\n'
  || E'O documento em anexo consolida as {{quantidade_pautas}} pauta(s) previstas, '
  || E'com responsáveis, apresentadores e tempos.\n\n'
  || E'Por favor, revise e responda a este e-mail com a sua validação.\n\n'
  || E'--\nPGCP — Plataforma Corporativa de Gestão de Pautas'
) ON CONFLICT (key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 3. Privilegios do papel de runtime
-- ---------------------------------------------------------------------------
--
-- A migration 015 concedeu DML nas tabelas que existiam entao. Tabela criada
-- depois nasce sem GRANT para `pcgp_app`, e a API receberia "permission denied"
-- na primeira leitura. Mesma tolerancia da 015: sem o papel, apenas avisa.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcgp_app') THEN
    RAISE NOTICE 'Papel de runtime "pcgp_app" ausente: grants de email_templates ignorados.';
    RETURN;
  END IF;

  -- Sem DELETE: modelo de e-mail se edita, nao se apaga. A chave e fixa pelo
  -- CHECK, entao nao ha linha orfa a remover.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.email_templates TO pcgp_app';

  RAISE NOTICE 'Privilegios de email_templates concedidos a pcgp_app.';
END $$;
