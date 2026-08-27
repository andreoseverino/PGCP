# Modelo de dados — PGCP

> **Status:** revisão 4 — schema aplicado no PostgreSQL (migrations `001` e `002`).
> **Data:** 14/08/2026
> **Base da análise:** `apps/web/src` (App.tsx, types.ts, initialData.ts e 12 componentes)

Este documento deriva o modelo de dados **do que o frontend já faz hoje**, não de uma
arquitetura genérica. Cada afirmação aponta para o código que a sustenta.

---

## 0. Decisões aprovadas

| # | Decisão | Efeito no modelo |
|---|---|---|
| 1 | `governance_bodies` é a fonte oficial de órgãos | `meeting_categories` **sai** da v1; `meetings` referencia órgão |
| 2 | `timestamptz` + timezone IANA | `start_at`/`end_at`; `timezone` default `America/Sao_Paulo`; nunca `BRT`/`EST` |
| 3 | `due_date` no lugar de `daysLate` | Atraso é **calculado**, nunca armazenado |
| 4 | Ata entra na v1 | `meeting_minutes` (sem assinatura, sem versionamento, sem fluxo formal) |
| 5 | Sem usuários artificiais | Mocks quebrados **não** serão migrados; seed futuro será limpo |
| 6 | Convidado externo sem conta | `meeting_participants.user_id` **NULL** + `display_name`/`email` |
| 7 | Contadores derivados | `expectedParticipantsCount` e `agendaItemsCount` **não viram coluna** |
| 8 | PK `uuid` gerado no PostgreSQL | `gen_random_uuid()`; IDs amigáveis serão campo separado |

| # | Decisão | Efeito no modelo |
|---|---|---|
| A | Toda reunião pertence a um órgão | `meetings.governance_body_id` **NOT NULL** |
| B | Ciclos de reunião e de ata são independentes | Dois `status` separados; `approved_by_secretariat` **removido** |
| C | Apresentador pessoa só via N:N | `presenter_participant_id` **removido**; sobra `presenter_label` para coletivos |
| D | Seed adiado | Nenhuma massa de dados definida nesta etapa |
| E | Biblioteca não tem convidado externo | `agenda_topic_participants` referencia só `users` |

| # | Decisão | Efeito no modelo |
|---|---|---|
| F | Identidade Microsoft por `oid` + `tid` | `users.entra_object_id` + `entra_tenant_id`, com CHECK de par e UNIQUE parcial |
| G | E-mail não é identidade técnica | `UNIQUE` de `users.email` removido; vira índice não-único |
| H | `external_id` removido | Superseded por `entra_object_id` (mesmo conceito, tipo correto, pareado ao tenant) |

**Total da primeira versão: 13 tabelas. Nenhuma decisão em aberto.**

### Estado no banco

| Migration | Conteúdo |
|---|---|
| `001_initial_schema.sql` | As 13 tabelas, PKs, FKs, CHECKs, índices e triggers |
| `002_add_entra_identity_to_users.sql` | Identidade Entra em `users`; e-mail deixa de ser identidade |

Aplicadas por `npm run db:migrate`. Ver [apps/api/migrations/](../apps/api/migrations/).

---

## 1. Resumo do domínio atual

O PGCP (Plataforma Corporativa de Gestão de Pautas) gerencia o ciclo de vida de reuniões
de órgãos colegiados (conselhos, diretoria, comitês):

**agendar reunião → montar pauta → registrar participantes → executar a sessão →
gerar ata → aprovar → desdobrar em ações de acompanhamento (FUP)**

Tudo roda 100% no navegador. Não há backend consumido pelo frontend.

### Onde os dados vivem hoje

> Atualização (Etapa 3.8): `cielo_synced_users` e o tipo `EntraUser` **não existem
> mais**. O diretório de pessoas é o Microsoft Graph, consultado sob demanda via
> `GET /directory/users`. As linhas abaixo que os citam descrevem o estado de
> 14/08/2026 e ficam como histórico da derivação.

| Camada | Chave / local | Conteúdo |
|---|---|---|
| ~~`localStorage` global~~ | ~~`cielo_meetings`~~ | Migrado para `meetings` (4.4) |
| | ~~`cielo_synced_users`~~ | Removido — diretório real no Graph (3.8) |
| | ~~`cielo_standalone_agendas`~~ | Migrado para `agenda_topics` (4.7b) |
| | ~~`cielo_action_items`~~ | Migrado para `action_items` (4.8) |
| | `cielo_audit_logs` | **Pendente** — trilha local até existir `GET /audit-logs`. Ver 4.12 |
| | ~~`cielo_categories`~~ | **Removido sem substituto** (4.12) — cadastro do protótipo, sem consumidor |
| | ~~`cielo_organs`~~ | Migrado para `governance_bodies` |
| | ~~`cielo_pauta_types`~~ | Migrado para `agenda_topic_types` (4.7a) |
| | ~~`cielo_pauta_natures`~~ | Migrado para `agenda_topic_natures` (4.7a) |
| | ~~`cielo_system_settings`~~ | **Removido** (4.12) — era write-only; configuração real em `apps/api/.env` |
| | `cielo_lang` | Idioma — **preferência de dispositivo, fica no navegador** |
| ~~`localStorage` por reunião~~ | ~~`cielo_meeting_notes_{id}`~~ | Migrado para `meeting_notes` (4.9) |
| | ~~`cielo_meeting_topics_done_{id}`~~ | Migrado para `meeting_agenda_items.execution_status` (4.6) |
| | ~~`cielo_meeting_topic_states_{id}`~~ | Idem; "Apresentando" é efêmero por decisão |
| ~~`localStorage` por reunião~~ | ~~`cielo_minutes_text_{id}`~~ | Migrado para `meeting_minutes.content` (4.10) |
| | ~~`cielo_minutes_status_{id}`~~ | Migrado para `meeting_minutes.status` (4.10) |
| | ~~`cielo_minutes_sec_app_{id}`~~ | Migrado para `meeting_minutes.secretariat_cleared_*` (4.10) |
| | ~~`cielo_minutes_sigs_{id}`~~ | **Removido sem substituto** — eram nomes fictícios. Ver 5.12 |
| **Só em memória** | `transcriptSegments` | Transcrição — hardcoded, **nunca persistida** |
| | `agendaItemStatuses` | Status de execução de cada item de pauta |
| | `completedItems`, `emailsSent`, `escalatedItems`, `fupsLaunched` | Feedback de UI simulado |

> **Achado:** a transcrição e o status de execução das pautas se perdem a cada reload.
> São as duas informações que hoje **parecem** funcionar mas não sobrevivem à sessão.

---

## 2. Entidades encontradas

| # | Estrutura no código | Onde vive | Destino na v1 |
|---|---|---|---|
| 1 | ~~`EntraUser`~~ (removido) | ~~`cielo_synced_users`~~ | `users` (via JIT no login) + Graph sob demanda |
| 2 | `Meeting` | `cielo_meetings` | `meetings` |
| 3 | `Participant` | aninhado em `Meeting.participants` | `meeting_participants` |
| 4 | `AgendaItem` | aninhado em `Meeting.agenda` | `meeting_agenda_items` |
| 5 | `StandaloneAgenda` | `cielo_standalone_agendas` | `agenda_topics` |
| 6 | `ActionItem` | `cielo_action_items` | `action_items` |
| 7 | `AuditLog` | `cielo_audit_logs` | `audit_logs` — **escrita já real; falta `GET /audit-logs` para a leitura** |
| 8 | ~~`CategoryItem`~~ | ~~`cielo_categories`~~ | **Removido na 4.12** — não era órgão, tipo nem natureza |
| 9 | `organs` | `cielo_organs` | `governance_bodies` |
| 10 | `pautaTypes` | `cielo_pauta_types` | `agenda_topic_types` |
| 11 | `pautaNatures` | `cielo_pauta_natures` | `agenda_topic_natures` |
| 12 | Ata (4 chaves soltas) | `cielo_minutes_*_{id}` | `meeting_minutes` — **concluído na 4.10**; camada formal na 4.11 |
| 13 | `SystemSettings` | `cielo_system_settings` | fase posterior (segredo → cofre) |
| 14 | `transcriptSegments` | memória | fase posterior |

---

## 3. Inconsistências encontradas

Diagnóstico do estado atual do frontend. Cada item indica a decisão que o resolve.

### 3.1 Pessoas são identificadas por **string de nome**, não por ID

Um mesmo ser humano aparece como texto livre em seis lugares:

| Campo | Arquivo |
|---|---|
| `Participant.name` | `types.ts:13` |
| `AgendaItem.author` / `members[]` | `types.ts:24-25` |
| `ActionItem.assignedUser.name` | `types.ts:101` |
| `AuditLog.user` | `types.ts:69` |
| `StandaloneAgenda.author` / `participants[]` | `types.ts:32,37` |

Só `StandaloneAgenda.authorId` (`types.ts:33`) tem vínculo real com `EntraUser`.

Nos mocks: o cadastro tem `M. Davis` (user-2) e `L. Chen` (user-3), mas os FUPs atribuem
a `Marcus Davies` e `Lydia Chen` (`initialData.ts:275,287`) — nomes inexistentes no
cadastro, assim como `J. Doe`, `A. Brown` e `C. Davis`.

→ **Resolvido por FK real + Decisão 5** (mocks não serão migrados; seed limpo).

### 3.2 `AgendaItem.author` nem sempre é uma pessoa

Valores reais em `initialData.ts`: `"M. Davis"`, `"Finance Committee"`, `"Strategy Group"`,
`"Audit Committee"`, `"Everyone"`, `"Succession Committee"`, `"Lead Security Auditor"`,
`"Compensation Adviser"`, `"Acquisitions Team / Shareholders"`, `""`.

Não é acidente de mock: o formulário usa `"Todos"` como padrão
(`ScheduleMeetingModal.tsx:223`, `MeetingDetailView.tsx:453`). O recurso **permite**
apresentador coletivo.

→ **Resolvido pela Decisão C**: pessoas vão para a N:N `meeting_agenda_item_presenters`
(5.9); coletivos ficam em `meeting_agenda_items.presenter_label` (5.8). Nunca se cria
usuário fictício para representar `"Todos"` ou um comitê.

### 3.3 `ActionItem.origin` guarda a origem em **quatro formatos diferentes**

| Formato | Origem no código |
|---|---|
| `"Finance Comm."` (abreviação informal) | `initialData.ts:272` |
| Nome do órgão de governança | `FupListView.tsx:82` |
| `meeting.category` (categoria da reunião) | `MeetingDetailView.tsx:339,352` |
| `"{pauta} (Reunião: {título})"` (concatenação) | `MeetingDetailView.tsx:2225` |

O FUP **sabe** de qual reunião e de qual pauta nasceu — mas joga fora a relação e guarda
uma frase.

→ **Resolvido** por `origin_meeting_id` + `origin_agenda_item_id` (5.10).

### 3.4 Importar uma pauta da biblioteca para a reunião **perde o vínculo**

`ScheduleMeetingModal.tsx:1021-1033` copia `title`, `duration` e `author` da
`StandaloneAgenda` para um novo `AgendaItem` e **descarta `sa.id`**. A deduplicação é
feita comparando títulos em minúsculas.

→ **Resolvido** pela separação `agenda_topics` × `meeting_agenda_items` (5.7 / 5.8).

### 3.5 `Meeting.category` mistura dois vocabulários incompatíveis

- Mocks: `"Board Meeting"`, `"Committee"`, `"Shareholder"`
- Formulário grava `CategoryItem.name`: `"Reunião Ordinária de Diretoria"`,
  `"Assembleia Geral Extraordinária"` (`ScheduleMeetingModal.tsx:25`)

→ **Resolvido pela Decisão 1**: o campo passa a ser `governance_body_id`.

### 3.6 O cadastro de "Órgão de governança" estava órfão

`organs` era criado em `AdministrationView` e usado **exclusivamente** como dropdown de
origem de FUP (`FupListView.tsx:317,402`). **Nenhuma reunião referenciava um órgão.**
Ao mesmo tempo `categories` continha justamente nomes de órgãos
(`"Comitê de Auditoria Financeira"`, `"Comitê de Ética e Compliance"`).

→ **Resolvido pela Decisão 1**: `governance_bodies` vira a fonte oficial e passa a ser
referenciado por `meetings`, `agenda_topics` e `action_items`.

### 3.7 Status de execução da pauta é frágil e efêmero

`agendaItemStatuses` é `Record<number, ...>` indexado pela **posição no array**
(`MeetingDetailView.tsx:417`), inicializado como `{}` e nunca persistido. Ao adiar um
item, o código o move para o fim do array e reindexa todos os status
(`MeetingDetailView.tsx:629-663`). Um reload zera tudo.

→ **Resolvido** por `execution_status` + `position` em linha própria (5.8).

### 3.8 `daysLate` é um retrato, não um prazo

`ActionItem.daysLate: number` (`types.ts:99`) guarda "dias em atraso" como número fixo
digitado no formulário (`FupListView.tsx:53`). Sem data de vencimento, o atraso **não é
recalculável** e envelhece errado.

→ **Resolvido pela Decisão 3**: `due_date`, atraso derivado.

### 3.9 Data, hora e duração sem formato canônico

- Reunião: `date` + `startTime` + `endTime` + `timeZone` em 4 strings (`types.ts:47-50`),
  com `"BRT"` nos mocks e `"EST"` como padrão do formulário (`ScheduleMeetingModal.tsx:29`)
- Duração: documentada como `"HH:mm"` (`types.ts:31`), mas gravada como `"30 mins"` /
  `"15 mins"` em `ScheduleMeetingModal.tsx:222` e `MeetingDetailView.tsx:454`
- O parser usa `durationStr.match(/(\d+)/)` e pega o **primeiro** inteiro
  (`MeetingDetailView.tsx:428`) — para `"00:45"` isso resulta em **0 minutos**
- `createdAt` é gravado já formatado: `"15 de Mai, 2026"` (`App.tsx:375-379`) —
  não é ordenável nem parseável

→ **Resolvido pela Decisão 2** (timestamptz + IANA) e por duração em **minutos inteiros**.

*(Observação factual sobre o parser, não uma correção — o frontend não será alterado.)*

### 3.10 Contadores denormalizados divergem da realidade

`expectedParticipantsCount` e `agendaItemsCount` (`types.ts:54-55`) são digitados à mão:

| Reunião | Diz | Array real |
|---|---|---|
| `meet-1` | 12 participantes | 6 |
| `meet-4` | 154 participantes / 2 pautas | 4 / **3** |
| `meet-5` | 5 pautas | **nenhum array de pauta** |
| `meet-6` | 4 pautas | **nenhum array de pauta** |

→ **Resolvido pela Decisão 7**: derivar com `COUNT`. O `154` é descartado como ambíguo;
se representar quórum/público esperado, ganha campo próprio e explícito no futuro.

### 3.11 Outros

- **Dois status disputando o mesmo ciclo:** `Meeting.status` tem 7 valores
  (`types.ts:53`) e `minutesStatus` tem 4 (`MeetingDetailView.tsx:118`), com `"Approved"`
  e `"Closed"` em ambos. Assinar a ata escreve nos dois (`MeetingDetailView.tsx:321-323`).
  → **Resolvido pela Decisão B**: os dois ciclos ficam separados e independentes no banco.
- **Campos de apresentação como dado:** `initials` e `avatarUrl` repetidos em cada
  participante (deriváveis); `AuditLog.icon` (`types.ts:72`) guarda nome de ícone Material.
- **Ator de auditoria nem sempre é pessoa:** `"System Sync API"` (`initialData.ts:202`).
- **Organizador nem sempre é pessoa:** padrão do formulário é
  `"Secretaria Geral de Governança"` (`ScheduleMeetingModal.tsx:31`).
- **`clientSecret` em texto no localStorage** (`types.ts:81`) — não pode virar coluna comum.
- **`StandaloneAgenda.isFUP: boolean`** (`types.ts:38`) convive com a entidade
  `ActionItem`; são coisas diferentes com o mesmo nome.

---

## 4. Nomenclatura técnica

A interface continua em português. Código, API e banco usam o vocabulário abaixo.

| Conceito (UI, pt-BR) | Nome técnico | Tabela | Vem de |
|---|---|---|---|
| Usuário / Pessoa | `User` | `users` | `EntraUser` |
| Órgão de governança | `GovernanceBody` | `governance_bodies` | `organs` + `CategoryItem` |
| Tipo de pauta | `AgendaTopicType` | `agenda_topic_types` | `pautaTypes` |
| Natureza da pauta | `AgendaTopicNature` | `agenda_topic_natures` | `pautaNatures` |
| Reunião | `Meeting` | `meetings` | `Meeting` |
| Participante da reunião | `MeetingParticipant` | `meeting_participants` | `Participant` |
| Pauta (biblioteca) | `AgendaTopic` | `agenda_topics` | `StandaloneAgenda` |
| Pauta na reunião | `MeetingAgendaItem` | `meeting_agenda_items` | `AgendaItem` |
| FUP / Ação | `ActionItem` | `action_items` | `ActionItem` |
| Ata | `MeetingMinutes` | `meeting_minutes` | `MeetingMinutes` |
| Processo de assinatura | `SignatureProcess` | `meeting_minute_signature_processes` | — (sem UI) |
| Signatário | `Signer` | `meeting_minute_signers` | — (sem UI) |
| Log de auditoria | `AuditLog` | `audit_logs` | `AuditLog` |

### Termos aposentados

| Termo atual | Problema | Substituto |
|---|---|---|
| `StandaloneAgenda` | "standalone" descreve estado, não conceito | `AgendaTopic` |
| `organs` | anglicismo ambíguo | `governance_bodies` |
| `CategoryItem` / `category` | vocabulário duplicado com órgão | `governance_body` |
| `Participant.role` | colide com "perfil de acesso" | `role_in_meeting` |
| `daysLate` | retrato, não prazo | `due_date` |
| `isFUP` | confunde pauta com ação | `generates_action_item` |
| `timeZone` (`"BRT"`) | abreviação ambígua e sem DST | `timezone` (IANA) |

### Convenções

- Tabelas `snake_case` plural; colunas `snake_case`.
- PK: `id uuid DEFAULT gen_random_uuid()`. FK: `{entidade_singular}_id`.
- Timestamps `timestamptz`, sufixo `_at`. Toda tabela: `created_at`, `updated_at`.
- Status: `text` + `CHECK`, não `ENUM` nativo (evita `ALTER TYPE` a cada valor novo).
- Cadastros auxiliares usam `is_active`, nunca `DELETE`.

> **Nota sobre UUID:** PostgreSQL 17 oferece `gen_random_uuid()` (v4) no core.
> `uuidv7()`, que dá melhor localidade de índice, só existe a partir do PostgreSQL 18.
> Como a v1 roda em PG 17, fica `gen_random_uuid()`; a troca por v7 é possível depois
> sem mudar o tipo da coluna.

---

## 5. Modelo relacional

> **Atualização (Etapa 4.12 — saneamento final).** `initialData.ts` foi removido
> do repositório: reuniões, pautas, FUPs, trilha de auditoria, categorias e
> configurações de demonstração deixaram de existir. Os nomes de teste
> sobreviveram apenas em `apps/web/src/auth/mock-login-people.ts`, que só é
> alcançável quando o Entra ID **não** está configurado. O agendamento não
> pré-preenche mais participantes nem pautas fictícias, e nenhum fluxo conectado
> gera identidade no navegador. Restam no `localStorage`: `cielo_lang`
> (preferência de dispositivo, legítima) e `cielo_audit_logs` (pendência
> conhecida — ver a linha do `AuditLog` acima).

### 5.1 `users`

Identidades reconhecidas pelo sistema. **Não** é o cadastro de "toda pessoa que já
apareceu numa reunião" — convidado externo não precisa existir aqui (Decisão 6).

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | `gen_random_uuid()` — **identidade interna** |
| `name` | text | sim | |
| `email` | text | sim | **atributo, NÃO identidade** — sem UNIQUE |
| `upn` | text | não | User Principal Name (Entra). Parece e-mail, **não é identidade** |
| `entra_object_id` | uuid | não | `oid` do Entra ID |
| `entra_tenant_id` | uuid | não | `tid` do Entra ID |
| `job_title` | text | não | Cargo na empresa |
| `phone` | text | não | |
| `user_type` | text | sim | `internal` \| `external` |
| `is_active` | boolean | sim | default `true` |
| `synced_at` | timestamptz | não | último sync do diretório |
| `created_at` / `updated_at` | timestamptz | sim | |

**Fora:** `initials` e `avatarUrl` — apresentação, deriváveis.

#### Dois conceitos distintos de identidade

| Conceito | Campo(s) | Papel |
|---|---|---|
| **Identidade interna do PGCP** | `users.id` (uuid, PK) | Alvo de **todas** as FKs do sistema. Nunca muda, nunca é exposta como identidade Microsoft. |
| **Identidade corporativa Microsoft** | `entra_tenant_id` + `entra_object_id` | Par que identifica unicamente uma conta no Entra ID. Preenchido quando o SSO existir. |

Ambos são `NULL` enquanto não houver SSO e para registros locais/demonstração.

**Restrições:**

```text
CHECK ((entra_object_id IS NULL) = (entra_tenant_id IS NULL))
UNIQUE (entra_tenant_id, entra_object_id) WHERE ambos IS NOT NULL
```

O `CHECK` impede meia identidade (só `oid` ou só `tid`). Foi escrito comparando dois
`IS NULL` — ambos os lados são booleanos não-nulos, então o `CHECK` nunca resulta em
`NULL`, o que o PostgreSQL aceitaria silenciosamente.

O `UNIQUE` é **parcial**: um índice único comum trataria cada `NULL` como distinto e não
protegeria nada. `tenant` vem primeiro para servir também a consultas por tenant.
O mesmo `oid` em tenants diferentes são identidades **distintas** e ambas são aceitas.

#### Por que o e-mail não é identidade

`users.email` **não tem UNIQUE** (removido na migration `002`). Motivos:

- e-mail muda (casamento, troca de domínio, rebranding) e pode ser reciclado por outra
  pessoa — não é estável o bastante para amarrar uma identidade;
- o Entra ID já fornece um identificador estável e imutável (`oid`);
- resolver o usuário autenticado por e-mail é um vetor de sequestro de conta se o
  provedor não garantir que o endereço foi verificado.

O e-mail continua sendo atributo para **exibição, busca, comunicação e notificações**,
com índice **não-único** (`users_email_idx`) para busca por valor exato.

> Quando o SSO for implementado, a resolução do usuário deve ser sempre
> `WHERE entra_tenant_id = tid AND entra_object_id = oid` — **nunca** por `email` ou `upn`.

### 5.2 `governance_bodies`

**Fonte oficial dos órgãos** (Decisão 1). Absorve `organs` e `CategoryItem`.
Conselho de Administração, Diretoria Executiva, Conselho Fiscal, Comitês, Assembleia.

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `name` | text | sim | UNIQUE |
| `icon` | text | não | ícone Material — usado pela UI atual (`CategoryItem.icon`) |
| `is_active` | boolean | sim | mapeia `"Ativo"`/`"Inativo"` |
| `created_at` / `updated_at` | timestamptz | sim | |

> Se no futuro surgir classificação de **sessão** (Ordinária / Extraordinária / Especial),
> ela vira `meeting_categories` como conceito **separado** — não reabre este.

### 5.3 `agenda_topic_types` e `agenda_topic_natures`

Duas tabelas de mesma forma, para "Pauta Regular/Excepcional" e
"Deliberativa/Informativa/Debate Estratégico/Remuneração/Compliance-CVM".
São editáveis pelo usuário em Administração → tabela, não enum.

| Campo | Tipo | Obrig. |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | sim (UNIQUE) |
| `is_active` | boolean | sim |
| `created_at` / `updated_at` | timestamptz | sim |

### 5.4 `meetings`

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `governance_body_id` | uuid FK → `governance_bodies` | **sim** | Decisões 1 e A — `NOT NULL` |
| `title` | text | sim | |
| `description` | text | não | |
| `start_at` | timestamptz | sim | instante absoluto |
| `end_at` | timestamptz | sim | `CHECK (end_at > start_at)` |
| `timezone` | text | sim | **IANA**, default `'America/Sao_Paulo'` |
| `location` | text | não | |
| `meeting_link` | text | não | link digitado à mão (Webex, Meet, sala virtual de terceiro) |
| `online_meeting_provider` | text | não | 014. Reunião nova nasce sempre `'teamsForBusiness'`, por regra de domínio (não vem do corpo). NULO só em reunião legada; o contrato não aceita `null` de volta |
| `status` | text | sim | ver abaixo |
| `organizer_user_id` | uuid FK → `users` | não | nullable (3.11: às vezes é um setor) |
| `recurrence` | text | não | rótulo (`"Mensal"`) — recurso ainda não implementado |
| `pending_requirements` | text | não | ← `missingRequirementText` |
| `created_at` / `updated_at` | timestamptz | sim | |

**Status:** `draft`, `scheduled`, `needs_approval`, `in_progress`, `done`, `approved`,
`closed` — os 7 valores atuais, normalizados.

**Por que `timezone` além de `timestamptz`:** `timestamptz` guarda o instante absoluto,
mas perde a intenção local. Para exibir "10:00 em São Paulo", calcular recorrência e
tratar horário de verão corretamente, é preciso saber o fuso original. Guardar
`'America/Sao_Paulo'` (IANA) resolve; `"BRT"` não resolveria, pois abreviações são
ambíguas e não carregam regra de DST.

**Fora (Decisão 7):** `expectedParticipantsCount`, `agendaItemsCount` → `COUNT`.

### 5.5 `meeting_participants`

Pessoa participando de uma reunião. **Aceita convidado externo sem conta** (Decisão 6).

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `meeting_id` | uuid FK → `meetings` | sim | `ON DELETE CASCADE` |
| `user_id` | uuid FK → `users` | **não** | `NULL` = convidado sem conta |
| `display_name` | text | não | nome exibido; obrigatório quando `user_id` é nulo |
| `email` | text | não | contato do convidado externo |
| `participant_type` | text | sim | `internal` \| `external` |
| `role_in_meeting` | text | não | "Presidente", "Conselheiro", "Secretária"… |
| `is_confirmed` | boolean | sim | default `false` ← `confirmed` |
| `attended` | boolean | não | presença efetiva (não existe hoje) |
| `created_at` / `updated_at` | timestamptz | sim | |

**Restrições:**

```text
CHECK (user_id IS NOT NULL OR display_name IS NOT NULL)
UNIQUE (meeting_id, user_id)          WHERE user_id IS NOT NULL
UNIQUE (meeting_id, lower(email))     WHERE user_id IS NULL AND email IS NOT NULL
```

Os `UNIQUE` são **parciais** de propósito: um índice único comum trataria cada `NULL`
como distinto e permitiria a mesma pessoa várias vezes. Assim, usuários não duplicam por
`user_id` e convidados não duplicam por e-mail, sem impedir vários convidados sem e-mail.

> `participant_type` não é redundante com `user_id`: uma pessoa **externa** pode ter
> conta (`users.user_type = 'external'`). O campo descreve a relação com a empresa; o
> `user_id` descreve se ela tem identidade no sistema.

> `role_in_meeting` é o papel **naquela sessão** — `M. Davis` é "Board Chairman" em
> `meet-1` e "Executive Board Member" em `meet-4`. Distinto de `users.job_title` (cargo)
> e de perfil de acesso, que **não existe** hoje.

### 5.6 `agenda_topics` — biblioteca de pautas

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `title` | text | sim | |
| `description` | text | não | |
| `owner_user_id` | uuid FK → `users` | não | ← `author`/`authorId` |
| `governance_body_id` | uuid FK → `governance_bodies` | não | ← `category` |
| `agenda_topic_type_id` | uuid FK → `agenda_topic_types` | não | ← `pautaType` |
| `agenda_topic_nature_id` | uuid FK → `agenda_topic_natures` | não | ← `pautaNature` |
| `estimated_duration_minutes` | integer | não | **inteiro** — resolve 3.9 |
| `generates_action_item` | boolean | sim | default `false` ← `isFUP` |
| `is_circular_theme` | boolean | sim | `NOT NULL DEFAULT false` (018). **Valor PADRÃO** de tema circular do tema mestre. Copiado para a pauta ao vincular a uma reunião (ver 5.8) |
| `created_at` / `updated_at` | timestamptz | sim | |

**Removido:** `meetingId`. O vínculo com reunião é `meeting_agenda_items`.

**Tema circular — dois eixos.** `agenda_topics.is_circular_theme` é o **padrão** da
Biblioteca; `meeting_agenda_items.is_circular_theme` (5.8) é o valor **efetivo** da
pauta naquela reunião. Ao vincular um tema à reunião, o padrão é **copiado uma vez**
(snapshot no INSERT do item, via `COALESCE`) e a partir daí os dois são
**independentes**: editar a pauta da reunião não altera a Biblioteca, e editar a
Biblioteca não retroage para reuniões existentes. Pauta sem informação explícita e
sem vínculo nasce `false`.

### 5.7 `agenda_topic_participants`

Forma normalizada de `StandaloneAgenda.participants[]` (hoje lista de nomes).
Aponta **só para `users`** porque a seleção vem do cadastro (`UnlinkedAgendasView`).

| Campo | Tipo |
|---|---|
| `agenda_topic_id` | uuid FK → `agenda_topics`, PK composta, `CASCADE` |
| `user_id` | uuid FK → `users`, PK composta, `RESTRICT` |
| `created_at` | timestamptz |

**Convidado externo não entra aqui** (Decisão E). A biblioteca é um catálogo sem
contexto de reunião, e participante externo pertence a uma sessão específica. Quando a
pauta for adicionada a uma reunião, o externo é vinculado ao `meeting_agenda_item`
correspondente, via `meeting_agenda_item_presenters` → `meeting_participants`.
Nunca se cria usuário fictício para permitir vínculo na biblioteca.

### 5.8 `meeting_agenda_items` — pauta **dentro** de uma reunião

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `meeting_id` | uuid FK → `meetings` | sim | `ON DELETE CASCADE` |
| `agenda_topic_id` | uuid FK → `agenda_topics` | **não** | null = item criado direto na reunião |
| `title` | text | sim | cópia no momento da inclusão (registro histórico) |
| `position` | integer | sim | ordem — substitui o índice do array |
| `scheduled_start_time` | time | não | ← `time` |
| `duration_minutes` | integer | não | inteiro |
| `presenter_label` | text | não | apresentador **coletivo/textual** (`"Todos"`, `"Comitê Financeiro"`) |
| `execution_status` | text | sim | `pending`\|`presenting`\|`completed`\|`postponed` |
| `postponed_from_item_id` | uuid FK → `meeting_agenda_items` | não | rastreia adiamento |
| `is_circular_theme` | boolean | sim | `NOT NULL DEFAULT false` (017). Valor **EFETIVO** de tema circular desta pauta na reunião. Ao vincular da Biblioteca, é copiado de `agenda_topics.is_circular_theme` (snapshot); depois independente. Sem informação explícita e sem vínculo → `false` |
| `agenda_topic_type_id` | uuid FK → `agenda_topic_types` | não | `ON DELETE SET NULL` (019). **Snapshot** do Tipo da Biblioteca |
| `agenda_topic_nature_id` | uuid FK → `agenda_topic_natures` | não | `ON DELETE SET NULL` (019). **Snapshot** da Natureza da Biblioteca |
| `description` | text | não | (019) **Snapshot** de Descrição/Objetivo de debate |
| `generates_action_item` | boolean | sim | `NOT NULL DEFAULT false` (019). **Snapshot** de "Tema de FUP" — só **classificação**, NÃO cria `action_items` |
| `created_at` / `updated_at` | timestamptz | sim | |

**Ficha cadastral da pauta — snapshot Biblioteca → reunião (019).** `agenda_topics`
continua o **tema mestre** (valor-padrão); `meeting_agenda_items` guarda o **snapshot
efetivo** daquela pauta naquela reunião. Ao **vincular/criar a partir da Biblioteca**, o
backend **copia uma vez** (COALESCE no INSERT do item) — título, responsável, duração,
Tipo, Natureza, Tema circular, Tema de FUP e Descrição — e preserva `agenda_topic_id` como
procedência. **Depois disso são independentes**: editar o mestre **não** retroage a
reuniões existentes; editar a pauta da reunião **não** altera o mestre. Pauta criada direto
na reunião (sem vínculo) grava os valores explícitos; ausentes ficam `NULL`/`false`. Os FKs
de Tipo/Natureza usam `ON DELETE SET NULL` (e não `RESTRICT` como em `agenda_topics`): o
snapshot degrada em vez de emitir erro cru se um cadastro for excluído. Regras de
reabertura da validação (016) e de RBAC valem para estes campos como para os demais.

**`UNIQUE (meeting_id, position)` DEFERRABLE** — ordem determinística sem travar a
reordenação (o arrasta-e-solta troca várias posições na mesma transação).

`title` é duplicado de propósito: a ata precisa refletir o texto **daquela sessão** mesmo
que a pauta da biblioteca mude depois. `agenda_topic_id` preserva a rastreabilidade que
hoje se perde (3.4).

**Não existe FK única de apresentador** (Decisão C). Apresentadores pessoa vivem
exclusivamente em `meeting_agenda_item_presenters` (5.9), o que permite **um ou vários**
por pauta. `presenter_label` cobre apenas o que não é pessoa.

### 5.9 `meeting_agenda_item_presenters` — apresentadores pessoa

**Única forma de registrar apresentador pessoa** (Decisão C). Absorve
`AgendaItem.author` (hoje um nome só) e `AgendaItem.members[]`. Aponta para
`meeting_participants` — não para `users` — porque a UI vincula **participantes daquela
reunião** ao item (`ScheduleMeetingModal.tsx:878`), e assim um convidado externo sem
conta pode apresentar.

| Campo | Tipo |
|---|---|
| `meeting_agenda_item_id` | uuid FK → `meeting_agenda_items`, PK composta, `CASCADE` |
| `meeting_participant_id` | uuid FK → `meeting_participants`, PK composta, `CASCADE` |
| `is_lead` | boolean, default `false` — apresentador principal, quando houver vários |
| `created_at` | timestamptz |

`is_lead` preserva a noção de "autor principal" que `AgendaItem.author` tinha, sem voltar
a limitar a pauta a um único apresentador. Índice único parcial garante no máximo um
principal por item:

```text
UNIQUE (meeting_agenda_item_id) WHERE is_lead
```

**Regras de uso**

| Situação | Como registrar |
|---|---|
| Uma pessoa apresenta | 1 linha, `is_lead = true` |
| Várias pessoas apresentam | N linhas, uma com `is_lead = true` |
| Convidado externo apresenta | linha apontando para o `meeting_participant` sem `user_id` |
| `"Todos"`, `"Comitê Financeiro"`, `"Diretoria"`, `"Convidados"` | `presenter_label` no item; **nenhuma linha aqui** |

Nunca criar usuário nem participante fictício para representar um coletivo.

### 5.10 `action_items` — FUP

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `title` | text | sim | |
| `description` | text | não | |
| `assigned_user_id` | uuid FK → `users` | sim | seleção vem do cadastro (`FupListView.tsx:73`) |
| `origin_meeting_id` | uuid FK → `meetings` | não | **relação real** |
| `origin_agenda_item_id` | uuid FK → `meeting_agenda_items` | não | **relação real** |
| `governance_body_id` | uuid FK → `governance_bodies` | não | quando a origem é o órgão |
| `origin_label` | text | não | texto livre só quando não há origem estruturada |
| `due_date` | date | não | **Decisão 3** |
| `status` | text | sim | `open` \| `completed` \| `cancelled` |
| `completed_at` | timestamptz | não | |
| `created_at` / `updated_at` | timestamptz | sim | |

**`Overdue` e `Due Today` deixam de existir como dado.** São derivados:

```text
overdue    := status = 'open' AND due_date < current_date
due_today  := status = 'open' AND due_date = current_date
days_late  := GREATEST(current_date - due_date, 0)
```

### 5.11 `meeting_minutes` — ata (Decisão 4)

Uma ata por reunião. Escopo mínimo: **texto + status**.

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `meeting_id` | uuid FK → `meetings` | sim | **UNIQUE** — 1:1; `ON DELETE CASCADE` |
| `content` | text | sim | Texto **puro**, não HTML. `DEFAULT ''` desde a 008 |
| `status` | text | sim | `draft`\|`under_review`\|`approved`\|`closed` |
| `revision` | integer | sim | Versão vigente, para *lost update*. Não é histórico |
| `updated_by_user_id` | uuid FK → `users` | não | `ON DELETE SET NULL` |
| `secretariat_cleared_at` | timestamptz | não | Quando a Secretaria saneou |
| `secretariat_cleared_by_user_id` | uuid FK → `users` | não | `ON DELETE SET NULL` |
| `secretariat_cleared_revision` | integer | não | **Qual revisão** foi saneada |
| `created_at` / `updated_at` | timestamptz | sim | |

A revisão atual só está saneada quando `secretariat_cleared_revision = revision`.
Editar o conteúdo depois do visto avança `revision` e devolve `status` para
`draft` — o visto não acompanha texto que mudou.

**Os dois ciclos de vida são independentes** (Decisão B):

- `meetings.status` — ciclo da **reunião** (agendada → em andamento → encerrada)
- `meeting_minutes.status` — ciclo da **ata** (rascunho → revisão → aprovada → encerrada)

Uma reunião pode estar `closed` enquanto a ata ainda está `draft` ou `under_review`.
O frontend atual escreve nos dois ao assinar (`MeetingDetailView.tsx:321-323`); o banco
não replica esse acoplamento.

**`approved_by_secretariat` foi removido** (Decisão B): duplicava informação que
`status = 'approved'` já representa.

**Assinatura NÃO mora aqui** (4.11): nem `signatures jsonb`, nem `signer_names text[]`,
nem `signature_image`. O fluxo formal tem tabelas próprias — ver 5.12.

`approved` e `closed` permanecem no CHECK sem caminho honesto para serem produzidos:
`approved` dependerá da conclusão de um processo de assinatura real, e `closed` continua
legado inativo, sem significado definido. Nenhum dos dois é escolhido pelo navegador.

### 5.12 `meeting_minute_signature_processes` e `meeting_minute_signers`

Camada formal de aprovação (migration 009). **Provider-agnostic**: DocuSign preencherá
`provider` / `provider_reference` sem remodelar o domínio.

| Conceito | Onde vive |
|---|---|
| Documento e revisão vigente | `meeting_minutes` |
| Tentativa formal de assinar **uma** revisão | `meeting_minute_signature_processes` |
| Quem precisa assinar aquele processo | `meeting_minute_signers` |
| Fornecedor | `provider` + `provider_reference` (vazios hoje) |

Regras estruturais garantidas pelo banco:

1. Processo só nasce sobre revisão `under_review` com `secretariat_cleared_revision = revision`
   (gatilho `meeting_minute_signature_processes_precondition`).
2. `minute_revision` fixa a revisão coberta; `content_snapshot` + `content_hash` (SHA-256)
   guardam a evidência do que foi enviado, independente da evolução da Ata.
3. Enquanto houver processo `prepared`/`in_progress`, o **conteúdo** daquela revisão fica
   congelado (gatilho `meeting_minutes_block_content_while_signing`).
4. Um processo ativo por Ata (índice parcial único).

Signatário aceita as três identidades do sistema — `users.id`, par `(entra_tenant_id,
entra_object_id)` ou e-mail para externo — e exige ao menos uma. Nenhum usuário é criado
para satisfazer FK, e nunca se reconcilia por nome.

Integridade fechada pela migration 010:

| Regra | Barreira |
|---|---|
| Evidência (`meeting_minute_id`, `minute_revision`, `content_snapshot`, `content_hash`, `created_by_user_id`, `created_at`) imutável em qualquer estado | gatilho `..._guard_update` |
| `content_hash` = SHA-256 UTF-8 de `content_snapshot` na criação | gatilho `..._check_evidence` (usa `sha256()` nativo; sem pgcrypto) |
| Processo nasce em `prepared` | gatilho `..._check_evidence` |
| Transições: terminal não ressuscita | gatilho `..._guard_update` |
| `completed` exige ≥1 signatário obrigatório e nenhum obrigatório fora de `signed` | gatilho `..._guard_update` |
| `provider` / `provider_reference` set-once e só fora de estado terminal | gatilho `..._guard_update` |
| Roster só se compõe com o processo em `prepared` | gatilhos `..._guard_insert` / `..._guard_delete` |
| Identidade do signatário imutável sempre; configuração só em `prepared`; `status`/`signed_at` só em `in_progress`; `provider_reference` set-once | gatilho `meeting_minute_signers_guard_update` |

A 010 **apenas restringe**: não escreve em `meeting_minutes`, não produz `signed`,
`completed` nem `approved`. A conclusão real continuará dependendo de evidência externa.

**Sem rotas HTTP e sem UI nesta versão:** preparar e cancelar processo são atos de
governança, e o sistema ainda distingue apenas usuário *autenticado*, não *autorizado a
homologar*. Nenhuma operação marca signatário como assinado — isso exigirá evidência
externa real.

### 5.13 `audit_logs`

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `occurred_at` | timestamptz | sim | ← `timestamp` |
| `actor_user_id` | uuid FK → `users` | **não** | null quando o ator é sistema |
| `actor_name` | text | sim | **snapshot** — o log não muda se a pessoa mudar |
| `actor_role` | text | não | snapshot |
| `action` | text | sim | |
| `entity_type` | text | sim | |
| `entity_id` | text | não | |
| `entity_label` | text | não | ← `entity` (hoje guarda o nome, não o tipo) |
| `status` | text | sim | `success` \| `failure` |
| `created_at` | timestamptz | sim | |

**Sem `updated_at`, sem `UPDATE`/`DELETE`:** trilha é append-only.
**`icon` não entra** — apresentação; a UI deriva de `action`.
`actor_name` como snapshot atende `"System Sync API"`, que não é pessoa.

---

## 6. Relacionamentos e cardinalidades

| De | Para | Card. | Obrig. | Ao excluir o pai |
|---|---|---|---|---|
| `meetings` | `governance_bodies` | N:1 | **sim** | `RESTRICT` |
| `meetings` | `users` (organizador) | N:1 | opcional | `RESTRICT` |
| `meeting_participants` | `meetings` | N:1 | sim | `CASCADE` |
| `meeting_participants` | `users` | N:1 | **opcional** | `RESTRICT` |
| `meeting_minutes` | `meetings` | **1:1** | sim | `CASCADE` |
| `meeting_agenda_items` | `meetings` | N:1 | sim | `CASCADE` |
| `meeting_agenda_items` | `agenda_topics` | N:1 | opcional | `SET NULL` |
| `meeting_agenda_item_presenters` | `meeting_agenda_items` / `meeting_participants` | **N:N** | — | `CASCADE` |
| `agenda_topics` | `users` (owner) | N:1 | opcional | `RESTRICT` |
| `agenda_topics` | `governance_bodies` | N:1 | opcional | `RESTRICT` |
| `agenda_topics` | `agenda_topic_types` / `_natures` | N:1 | opcional | `RESTRICT` |
| `agenda_topic_participants` | `agenda_topics` / `users` | N:N | — | `CASCADE` / `RESTRICT` |
| `action_items` | `users` (responsável) | N:1 | sim | `RESTRICT` |
| `action_items` | `meetings` (origem) | N:1 | opcional | `SET NULL` |
| `action_items` | `meeting_agenda_items` (origem) | N:1 | opcional | `SET NULL` |
| `action_items` | `governance_bodies` | N:1 | opcional | `RESTRICT` |
| `meeting_minute_signature_processes` | `meeting_minutes` | N:1 | sim | `CASCADE` |
| `meeting_minute_signature_processes` | `users` (preparou) | N:1 | sim | `RESTRICT` |
| `meeting_minute_signers` | `meeting_minute_signature_processes` | N:1 | sim | `CASCADE` |
| `meeting_minute_signers` | `users` | N:1 | **opcional** | `RESTRICT` |
| `audit_logs` | `users` (ator) | N:1 | opcional | `SET NULL` |

**Regras gerais**

- `CASCADE` só onde o filho não existe sem o pai: participantes, itens de pauta e ata de
  uma reunião.
- Pessoas e cadastros auxiliares nunca são apagados em cascata — usar `is_active`.
- Excluir uma reunião **não** apaga os FUPs que ela gerou: `SET NULL` + `origin_label`
  preserva o histórico da ação.

---

## 7. Tabelas da primeira versão — 13

| # | Tabela | Finalidade | Grupo |
|---|---|---|---|
| 1 | `users` | Identidades reconhecidas pelo sistema | Núcleo |
| 2 | `governance_bodies` | Órgãos colegiados — fonte oficial de classificação | Núcleo |
| 3 | `meetings` | Reuniões/sessões | Núcleo |
| 4 | `meeting_participants` | Quem participa de cada reunião (aceita externo sem conta) | Núcleo |
| 5 | `agenda_topics` | Biblioteca de pautas reutilizáveis | Núcleo |
| 6 | `meeting_agenda_items` | Pauta usada numa reunião: ordem, duração, execução | Núcleo |
| 7 | `agenda_topic_types` | Cadastro: Regular / Excepcional | Auxiliar |
| 8 | `agenda_topic_natures` | Cadastro: Deliberativa / Informativa / … | Auxiliar |
| 9 | `agenda_topic_participants` | N:N pauta da biblioteca ↔ usuários | Vínculo |
| 10 | `meeting_agenda_item_presenters` | **Única** forma de registrar apresentador pessoa (1..N por pauta) | Vínculo |
| 11 | `action_items` | FUP, com origem rastreável e `due_date` | Operacional |
| 12 | `meeting_minutes` | Ata: texto + status próprio (1:1 com reunião) | Operacional |
| 13 | `audit_logs` | Trilha append-only | Operacional |

**Mudança vs. revisão 1:** `meeting_categories` saiu (Decisão 1), `meeting_minutes`
entrou (Decisão 4). Total permanece 13.

### Por que os auxiliares e vínculos não são antecipação

`AdministrationView` já tem quatro abas de CRUD (`users`, `organs`, `pautaTypes`,
`pautaNatures`) e existe modal próprio de vinculação de participantes a pautas
(`ScheduleMeetingModal.tsx:878`). Sem essas tabelas, telas que **já funcionam** deixariam
de funcionar.

---

## 8. Fases posteriores

| Tabela / tema | Por que não agora |
|---|---|
| `meeting_minutes_signatures` | Assinar é `signatures.push(nome)` (`MeetingDetailView.tsx:307`). Sem certificado, hash ou carimbo de tempo. Modelar agora seria inventar requisito. |
| `meeting_minutes_versions` | Versionamento explicitamente adiado (Decisão 4). |
| `meeting_transcript_segments` | Hardcoded no componente, nunca persistido (`MeetingDetailView.tsx:102`). Gravação é `setTimeout` de 1,8s. |
| `documents` / `attachments` | **Não existe aba de documentos.** As abas são Overview, Agendas, Transcript, Minutes, Fup, Participants. Nomes de PDF aparecem só como texto em log mockado. |
| `roles` / `permissions` | **Não existe controle de acesso.** `currentUser` é hardcoded (`App.tsx:624`). |
| `meeting_categories` | Só quando existir classificação de sessão real (Ordinária/Extraordinária/Especial) — Decisão 1. |
| `integration_settings` | `clientSecret` exige cofre (Key Vault / Secrets Manager), não coluna. |
| `approved_by_user_id` / `approved_at` na ata | Campos de aprovação formal, quando houver fluxo real. Substituem o booleano removido na Decisão B — não voltar a usar flag. |
| `approvals` (fluxo formal) | Hoje é booleano + contagem de assinaturas ≥ 2 (`MeetingDetailView.tsx:321`). |
| Seed / massa de demonstração | Adiado (Decisão D). Definir depois: quantidade de usuários, órgãos oficiais e se cobre reunião passada com ata para exercitar todos os status. |
| Identificadores amigáveis (`REU-2026-00125`) | Campo adicional, nunca PK (Decisão 8). |
| Blockchain / IA | Não existem. Os textos de UI mencionam, o código não implementa. |

---

## 9. Diagrama conceitual revisado

```mermaid
erDiagram
    USERS ||--o{ MEETING_PARTICIPANTS : "e identificado em"
    USERS ||--o{ ACTION_ITEMS : "e responsavel por"
    USERS ||--o{ AGENDA_TOPICS : "e dono de"
    USERS ||--o{ MEETINGS : "organiza"
    USERS ||--o{ AUDIT_LOGS : "gera"
    USERS ||--o{ AGENDA_TOPIC_PARTICIPANTS : "vinculado a"

    GOVERNANCE_BODIES ||--o{ MEETINGS : "realiza"
    GOVERNANCE_BODIES ||--o{ AGENDA_TOPICS : "classifica"
    GOVERNANCE_BODIES ||--o{ ACTION_ITEMS : "origina"

    AGENDA_TOPIC_TYPES ||--o{ AGENDA_TOPICS : "tipifica"
    AGENDA_TOPIC_NATURES ||--o{ AGENDA_TOPICS : "qualifica"

    MEETINGS ||--o{ MEETING_PARTICIPANTS : "possui"
    MEETINGS ||--o{ MEETING_AGENDA_ITEMS : "possui"
    MEETINGS ||--|| MEETING_MINUTES : "tem ata"
    MEETINGS ||--o{ ACTION_ITEMS : "origina"

    AGENDA_TOPICS ||--o{ MEETING_AGENDA_ITEMS : "e instanciada em"
    AGENDA_TOPICS ||--o{ AGENDA_TOPIC_PARTICIPANTS : "possui"

    MEETING_PARTICIPANTS ||--o{ MEETING_AGENDA_ITEM_PRESENTERS : "apresenta"

    MEETING_AGENDA_ITEMS ||--o{ MEETING_AGENDA_ITEM_PRESENTERS : "possui"
    MEETING_AGENDA_ITEMS ||--o{ ACTION_ITEMS : "origina"

    USERS {
        uuid id PK
        text name
        text email UK
        text user_type
        boolean is_active
    }
    GOVERNANCE_BODIES {
        uuid id PK
        text name UK
        boolean is_active
    }
    AGENDA_TOPIC_TYPES {
        uuid id PK
        text name UK
    }
    AGENDA_TOPIC_NATURES {
        uuid id PK
        text name UK
    }
    MEETINGS {
        uuid id PK
        uuid governance_body_id FK
        uuid organizer_user_id FK
        text title
        timestamptz start_at
        timestamptz end_at
        text timezone
        text status
    }
    MEETING_PARTICIPANTS {
        uuid id PK
        uuid meeting_id FK
        uuid user_id FK "NULL = convidado externo"
        text display_name
        text email
        text participant_type
        text role_in_meeting
        boolean is_confirmed
    }
    MEETING_MINUTES {
        uuid id PK
        uuid meeting_id FK UK
        text content
        text status
    }
    AGENDA_TOPICS {
        uuid id PK
        uuid owner_user_id FK
        uuid governance_body_id FK
        text title
        integer estimated_duration_minutes
        boolean generates_action_item
        boolean is_circular_theme "padrao; copiado ao vincular"
    }
    AGENDA_TOPIC_PARTICIPANTS {
        uuid agenda_topic_id PK
        uuid user_id PK
    }
    MEETING_AGENDA_ITEMS {
        uuid id PK
        uuid meeting_id FK
        uuid agenda_topic_id FK
        text title
        integer position
        integer duration_minutes
        text presenter_label "coletivo, nao pessoa"
        text execution_status
        boolean is_circular_theme "efetivo; copiado da Biblioteca ao vincular"
        uuid agenda_topic_type_id FK "snapshot 019"
        uuid agenda_topic_nature_id FK "snapshot 019"
        text description "snapshot 019"
        boolean generates_action_item "snapshot 019; so classifica"
    }
    MEETING_AGENDA_ITEM_PRESENTERS {
        uuid meeting_agenda_item_id PK
        uuid meeting_participant_id PK
        boolean is_lead
    }
    ACTION_ITEMS {
        uuid id PK
        uuid assigned_user_id FK
        uuid origin_meeting_id FK
        uuid origin_agenda_item_id FK
        uuid governance_body_id FK
        date due_date
        text status
    }
    AUDIT_LOGS {
        uuid id PK
        uuid actor_user_id FK
        text actor_name
        text action
        text entity_type
        text status
    }
```

---

## 10. Questões A–E — todas fechadas

| # | Questão | Decisão | Onde está no modelo |
|---|---|---|---|
| A | Órgão obrigatório na reunião? | **Sim, `NOT NULL`.** Não há reunião avulsa na v1 | 5.4 |
| B | Status da reunião × status da ata | **Separados e independentes.** `approved_by_secretariat` removido | 5.11 |
| C | Apresentador da pauta | **Pessoa só via N:N**; coletivo em `presenter_label` | 5.8, 5.9 |
| D | Seed | **Adiado.** Massa nova e limpa em tarefa própria | §8 |
| E | Externo em pauta da biblioteca | **Não existe.** Externo pertence à reunião | 5.7 |

### Princípio transversal

Três decisões (C, E e a 6) convergem na mesma regra:

> **Nunca criar usuário ou participante fictício para satisfazer uma FK.**

- Coletivo (`"Todos"`, `"Comitê Financeiro"`) → `presenter_label`, texto.
- Convidado externo → `meeting_participants` com `user_id = NULL`.
- Biblioteca de pautas → só `users` reais; o externo entra quando vira item de reunião.

**Nenhuma pendência bloqueia a escrita do SQL.**

---

## 11. Próximo passo

Modelo fechado. A tarefa seguinte seria escrever o SQL/migration das 13 tabelas —
**nada disso foi iniciado**. Aguardando autorização.
