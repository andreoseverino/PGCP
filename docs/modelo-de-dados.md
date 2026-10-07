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
| E | Biblioteca aceita as três naturezas de participante desde a migration 004 | `agenda_topic_participants` admite `users`, identidade Entra ou convidado por e-mail |

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
| `meeting_link` | text | não | link digitado à mão (Webex, Meet, sala virtual de terceiro) |
| `online_meeting_provider` | text | não | 014. Reunião nova nasce sempre `'teamsForBusiness'`, por regra de domínio (não vem do corpo). NULO só em reunião legada; o contrato não aceita `null` de volta |
| `status` | text | sim | ver abaixo |
| `organizer_user_id` | uuid FK → `users` | não | nullable (3.11: às vezes é um setor) |
| `recurrence` | text | não | rótulo (`"Mensal"`) — recurso ainda não implementado |
| `pending_requirements` | text | não | ← `missingRequirementText` |
| `created_at` / `updated_at` | timestamptz | sim | |

**Local físico por catálogo (025).** A coluna livre `location` foi removida na
`021` e **não voltou**. A `025` acrescentou `modality` (`online` | `in_person`,
default `online`) e `physical_location_key` — chave do catálogo da aplicação
(`meetings/locations.ts`), obrigatória só no presencial (CHECK
`(modality = 'in_person') = (physical_location_key IS NOT NULL)`). Endereço
oficial vem de configuração (`MEETING_LOCATIONS_ADDRESSES`), nunca digitado.
**Substituído na 038** (ver 5.23): o local passou a ser cadastro
(`meeting_locations`) com cópia congelada na reunião; `physical_location_key`
ficou depreciada (preservada, não é mais escrita).
Toda reunião continua com Teams (`online_meeting_provider`); no presencial ele é
contingência. A `025` também acrescentou `origin` (`manual` | `annual_agenda`) e
`annual_agenda_id` (FK `ON DELETE SET NULL`) — ver 5.14.

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

Forma normalizada de `StandaloneAgenda.participants[]`. Aceita usuário interno,
identidade Entra ou convidado identificado por e-mail, conforme a evolução da migration 004.

| Campo | Tipo |
|---|---|
| `id` | uuid PK |
| `agenda_topic_id` | uuid FK → `agenda_topics`, `CASCADE` |
| `user_id` | uuid FK → `users`, opcional, `RESTRICT` |
| `entra_tenant_id` / `entra_object_id` | uuid, identidade Entra opcional e pareada |
| `display_name` / `email` | text, snapshots opcionais conforme a identidade |
| `created_at` / `updated_at` | timestamptz |

Índices únicos parciais deduplicam, por pauta, `user_id`, o par Entra e e-mail de
convidado. Não se cria usuário fictício para permitir vínculo na Biblioteca.

**Invariante.** Quando o responsável é uma pessoa identificada pelo par Entra, ele
também pertence a `agenda_topic_participants`. A criação e a edição garantem o vínculo;
o PATCH sem `participants` preserva a coleção, enquanto `participants: []` remove apenas
os opcionais e mantém o responsável. A migration 022 repara vínculos legados ausentes
sem remover participantes existentes e sem correspondência por nome.

### 5.8 `meeting_agenda_items` — pauta **dentro** de uma reunião

> **Terminologia desde a 025:** esta tabela representa o **TEMA** (assunto
> específico). A **PAUTA** passou a ser o agrupador `meeting_agendas` (5.14), e
> o tema aponta para ela por `meeting_agenda_id` (anulável; FK composta com
> `meeting_id`). Nome da tabela e colunas **não** foram renomeados.

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
backend **copia uma vez** (COALESCE no INSERT do item) — **título, responsável, duração,
Tipo, Natureza, Tema circular, Tema de FUP, Descrição** e os **participantes** da pauta
(via `agenda_topic_participants` → `meeting_agenda_item_participants`, ver 5.9.1) — e preserva
`agenda_topic_id` como procedência. **Depois disso são independentes**: editar o mestre
**não** retroage a reuniões existentes; editar a pauta da reunião **não** altera o mestre.
Pauta criada direto na reunião (sem vínculo) grava os valores explícitos; ausentes ficam
`NULL`/`false`. Os FKs de Tipo/Natureza usam `ON DELETE SET NULL` (e não `RESTRICT` como em
`agenda_topics`): o snapshot degrada em vez de emitir erro cru se um cadastro for excluído.
`is_circular_theme` (017) segue exatamente a mesma lógica de snapshot. Itens antigos
permanecem compatíveis com `NULL`/defaults — **sem backfill**. Alterações estruturais destes
campos reabrem a validação (016) quando `sent`/`approved` antes da reunião; RBAC vale como
para os demais.

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

### 5.9.1 `meeting_agenda_item_participants` — participantes POR TEMA (020; regra de remoção revista na 025)

> Desde a 025, `meeting_agenda_items` é o **TEMA** (5.8/5.14); "pauta" abaixo, no
> texto histórico da 020, designa o mesmo item.

Relaciona `meeting_agenda_items` a **`meeting_participants`** — **não** ao diretório/Entra.
Assim a invariante "quem participa de uma pauta participa da reunião" é **estrutural**
(FK), não uma regra que possa furar. **Conceito distinto** de `meeting_agenda_item_presenters`
(5.9, apresentador): aqui é "quem participa da discussão daquela pauta".

| Campo | Tipo |
|---|---|
| `meeting_agenda_item_id` | uuid FK → `meeting_agenda_items`, PK composta, `ON DELETE CASCADE` |
| `meeting_participant_id` | uuid FK → `meeting_participants`, PK composta, `ON DELETE CASCADE` |
| `created_at` | timestamptz |

**PK composta** impede vínculo duplicado (a mesma pessoa não entra duas vezes na mesma
pauta). **`ON DELETE CASCADE` nos dois lados**: excluir a pauta, ou remover a pessoa da
reunião, elimina o vínculo.

**Regra de negócio (aprovada).** *Todo participante de uma pauta é também participante da
reunião.*

Além disso, quando o responsável é uma pessoa identificada no Entra, ele é
obrigatoriamente participante da própria pauta. A aplicação garante sua existência em
`meeting_participants` e o vínculo nesta tabela na mesma transação. Trocar o responsável
inclui o novo sem remover automaticamente o anterior. A migration 022 completa vínculos
legados já identificáveis, sem remover dados existentes.

- **Adicionar** alguém a uma pauta: se já é participante da reunião, **reutiliza** o
  `meeting_participant` (deduplicação pela lógica da aplicação — por `entra_object_id`/`user_id`,
  **nunca** por `display_name`; para convidado sem identidade — externo do PGCP — pelo e-mail,
  a mesma chave do índice parcial de convidados). Se ainda não é, ele é
  **adicionado à reunião** pelo MESMO fluxo da aba Participantes — passa a constar na lista
  geral e a integração de calendário fica `stale` (5.11 / ver §Calendário).
- **Remover de um Tema (regra vigente).** Remover um participante de um Tema remove somente o
  vínculo daquele participante com o Tema. O participante permanece na reunião e em outros
  Temas aos quais esteja associado. O convite do calendário não muda. O responsável pessoa
  não pode ser desvinculado do próprio Tema (409 — troca-se o responsável antes). Trilha:
  "Participante removido do tema".
- **Remover da reunião.** Para remover a pessoa da reunião inteira, a ação deve ser realizada
  na aba Participantes da reunião. Antes da confirmação, a interface informa que a pessoa será
  removida da reunião e de todos os Temas aos quais esteja vinculada, apresentando os Temas
  afetados quando houver. Apaga o `meeting_participant`; o `ON DELETE CASCADE` remove os
  vínculos com todos os Temas; calendário `stale`. Trilha: "Participante removido da reunião".
- A exclusão de um participante da reunião não exclui seu cadastro administrativo de
  participante externo no PGCP (5.15) — nem a remoção de um Tema.
- Toda remoção (de Tema ou da reunião) exige **confirmação explícita** na interface; a
  confirmação é UX — o backend aplica a regra sobre o estado atual do banco.
- *Regra anterior, SUBSTITUÍDA (Opção A da 020): remover de uma pauta removia a pessoa da
  reunião inteira e, pelo cascade, das demais pautas. Não é mais o comportamento.*

**Snapshot Biblioteca → reunião.** Ao vincular uma pauta da Biblioteca que tem participantes
(`agenda_topic_participants`), cada pessoa é **localizada/criada** em `meeting_participants` e
então vinculada aqui. A partir daí o vínculo da reunião é **independente** da Biblioteca — não
há sincronização retroativa.

**Validação.** Vincular/desvincular participante é **alteração estrutural**: antes da reunião,
`sent`/`approved` → `draft` (016); durante `In Progress`/`Done`/`Closed`, não reabre.

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

### 5.14 Revisão 025 — Pauta → Tema e Agenda Anual

Estrutura conceitual: **Reunião → Pauta → Tema**. Não existe nível
intermediário ("bloco").

| Tabela | Papel | Pontos-chave |
|---|---|---|
| `meeting_agendas` | **Pauta** da reunião (ex.: Finanças) | `meeting_id` `CASCADE`; `title`; `position`; `UNIQUE (id, meeting_id)` como alvo da FK composta |
| `meeting_agenda_items.meeting_agenda_id` | **Tema** → Pauta | Anulável (itens anteriores = "temas sem pauta", sem backfill); FK composta `(meeting_agenda_id, meeting_id)` impede apontar para pauta de outra reunião; excluir pauta com temas é recusado (409) |
| `annual_agendas` | Planejamento anual de um órgão | `governance_body_id`, `year`, `title`; `status` `draft` → `pending_approval` → `approved` com CHECK de coerência (mesmo padrão da 016); **independente da reserva** |
| `annual_agenda_items` | Data planejada | `start_at`/`end_at`/`timezone` planejados; `meeting_id UNIQUE` `ON DELETE SET NULL` = reserva (uma data vira no máximo uma reunião) |
| `meetings.origin` / `annual_agenda_id` | Procedência | Definidas pelo servidor, nunca pelo corpo |

**Reserva antes da aprovação.** `POST /annual-agendas/:id/reserve` cria, numa
transação com a agenda travada, as reuniões das datas sem `meeting_id` (mesmo
caminho da criação manual, `inserirReuniao`) e, depois do COMMIT, envia os
convites. Repetir é inofensivo. Depois de reservada, a data é alterada pelo
Pipeline (`PATCH /meetings/:id`), que atualiza o **mesmo** evento; a Agenda
Anual exibe a data vigente da reunião. Alterar datas depois de pedir aprovação
devolve a agenda para `draft`.

**Situação atual (028+).** A interface não oferece mais datas planejadas nem a
reserva: a Agenda Anual consolida as reuniões criadas no Calendário. A tabela
`annual_agenda_items` e as rotas `/annual-agendas/:id/items` e `/:id/reserve`
continuam por compatibilidade com dados existentes — o detalhe, o PDF/snapshot
(`datasSemReuniao`) e a regra que impede desassociar reunião nascida de reserva
ainda as leem.

**Pipeline — sem status novo.** As etapas (Agendada, Em preparação, Pronta para
reunião, Realizada) são derivadas de `meetings.status`,
`agenda_validation_status` e da contagem de temas (`apps/web/src/lib/pipeline.ts`).

Migration aditiva, com SQL de reversão documentado no cabeçalho de
`025_calendar_pipeline_annual_agenda.sql`.

**Revisão 028 — Agenda Anual como consolidação + versão aprovada.** A Agenda
Anual deixa de ser só planejamento de datas: ela reúne as reuniões do órgão/ano
**já criadas no Calendário** pelo vínculo existente `meetings.annual_agenda_id`
(qualquer `origin` — `origin` diz onde a reunião nasceu, não se faz parte do
plano). Associar grava só esse vínculo: mesmo `meeting.id`, mesmo evento Graph,
sem convite novo. Pautas e temas são os da própria reunião (`meeting_agendas` /
`meeting_agenda_items`) — nenhuma cópia em `annual_agendas`.

| Estrutura | Papel | Regras |
| --- | --- | --- |
| `annual_agenda_versions` | Versão enviada para aprovação | `snapshot jsonb` = agenda, órgão, ano, reuniões (título/data/horário/fuso), pautas e temas **como enviados**; `version` sequencial por agenda; desfecho `approved_at` (+ quem registrou) **ou** `withdrawn_at`; no máximo uma em aberto e uma aprovada por agenda; FK `RESTRICT` |
| Imutabilidade | — | trigger recusa alterar conteúdo, mudar desfecho já decidido e `DELETE`; `pcgp_app` só tem `SELECT`/`INSERT` e `UPDATE` das colunas de desfecho |
| Trigger em `meetings` | Integridade | reunião só aponta para Agenda Anual do **mesmo órgão** (associar e trocar órgão) |

Estados (sem enum novo, os de 025): `draft` = em elaboração (conteúdo
editável pela Agenda); `pending_approval` = bloqueada até **retirar da
aprovação** (explícito, auditado; a versão fica como retirada); `approved` =
bloqueada de vez. Registrar a aprovação marca **a versão enviada** — não tira
foto nova. O Pipeline continua operando as reuniões depois da aprovação; o
documento aprovado sai do snapshot e não muda. Reversão no cabeçalho de
`028_annual_agenda_versions.sql`.

**Revisão 029 — uma Agenda Anual por órgão por ano.** Índice único
`annual_agendas_body_year_uk (governance_body_id, year)`; a migration aborta,
sem escolher nada, se já houver duplicata. Com a unicidade, a associação é
automática e só grava `meetings.annual_agenda_id`:

- **Visão anual** (`GET /annual-agendas/overview?year=`): reuniões do Calendário
  do ano agrupadas por órgão, com a agenda formal quando existir. Somente
  leitura — abrir a tela não cria agenda.
- **Formalizar** ("Preparar Agenda Anual" = `POST /annual-agendas`): cria a
  agenda do órgão/ano e associa as reuniões já existentes do mesmo órgão/ano
  (fuso da reunião) que não estejam em outra agenda. 409 legível se já existir.
- **Reunião nova no Calendário**: entra na agenda do mesmo órgão/ano se ela
  estiver **em elaboração** (trava a agenda, como o envio). Enviada/aprovada
  não muda de conteúdo: a reunião fica como "do Calendário, não associada".

Reversão: `DROP INDEX annual_agendas_body_year_uk` (cabeçalho da 029).

**Revisão 030 — tipo e título padronizado.** `meetings.session_type`
(`ordinary` | `extraordinary`, CHECK; `NULL` = legado com título livre). Com
tipo, o **servidor** monta o título — `09:00 | Cielo | Reunião Extraordinária do
Comitê de Riscos (PRESENCIAL)` (hora no fuso da reunião; "do"/"da" pelo órgão;
`PRESENCIAL`/`VIDEOCONFERÊNCIA` pelo formato) — na criação, na reserva da
Agenda Anual e a cada alteração de hora, órgão, formato ou tipo (o convite fica
`stale` para reenvio). O corpo não pode trazer título quando há tipo. A versão
aprovada da Agenda Anual não muda: o título aprovado está no snapshot (028).
Regra em `apps/api/src/meetings/title.ts` (prévia espelhada em
`apps/web/src/lib/meeting-title.ts`).

**Cronograma dos temas (sem migration).** A ordem é `meeting_agenda_items.position`
(global na reunião, a mesma do Pipeline); cada tema começa quando o anterior
termina, a partir do início da reunião, pela `duration_minutes`
(`apps/api/src/meetings/schedule.ts`, espelhada em `web/src/lib/agenda-schedule.ts`,
usada também pelo Pipeline). Tema sem duração não vira 0: fica sem término e
é contado à parte. Pela Agenda Anual: arrastar reordena dentro da pauta
(`PUT /annual-agendas/:id/meetings/:mid/agenda-items/order`) e o servidor regrava
`scheduled_start_time`; o envio para aprovação é recusado (409) se alguma
reunião tiver temas somando mais que a reunião ou tema sem duração. O snapshot
(028) passa a guardar duração, início/fim, participantes e a ficha de cada tema
(responsável, tipo, natureza, circular, descrição) — campos opcionais no JSON;
snapshots antigos continuam legíveis. Anos da visão anual: só os que têm reunião
ou Agenda Anual.

**Temas pela Agenda Anual (sem migration).** A tela trabalha com Temas; a Pauta
fica como estrutura interna. `POST /annual-agendas/:id/meetings/:mid/temas`
aceita dois contratos fechados: **novo tema** (cadastro completo; desde 5.17
também cadastra o tema-mestre na Biblioteca e vincula a instância) ou **da
Biblioteca** (`agendaTopicId` +
duração/pauta; título, ficha e participantes vêm do tema-mestre no servidor).
Reunião sem pauta recebe a pauta padrão "Pauta da reunião" na mesma transação
(agenda travada → em elaboração → cria → participantes → horários). Editar pela
Agenda altera só a instância da reunião, nunca o tema-mestre.

### 5.15 Revisão 026 — Participantes externos

**Usuário ≠ participante.** `users` é pessoa AUTENTICADA (Entra + App Roles,
provisionada no login). `external_participants` é o cadastro local de quem só
PARTICIPA de reuniões e não existe no Entra: sem login, sem App Role, sem par
`(tenant, oid)`. Pessoas do Entra não são copiadas para cá — continuam vindo do
diretório sob demanda.

| Tela | Origem |
|---|---|
| Administração → Participantes | **somente** externos cadastrados no PGCP (sem busca no Entra) |
| Seleção de participantes (reunião, tema, reserva anual) | **Entra ID + externos do PGCP**, separados por origem; e-mail repetido é omitido do lado PGCP |

Cadastro exige comprovar que o e-mail **não** é corporativo: consulta ao Entra
por e-mail na gravação, **fail closed** (sem verificação, não grava).

| Campo | Tipo | Obrig. | Observação |
|---|---|---|---|
| `id` | uuid | PK | |
| `full_name` | text | sim | 2–200 |
| `email` | text | sim | **único case-insensitive** (`UNIQUE (lower(email))`) |
| `phone` | text | não (038) | TEXTO (preserva DDI/DDD); dígitos, espaço, `+ ( ) -`; validado quando informado |
| `company` | text | não (038) | empresa/organização, 1–200 |
| `governance_body_id` | uuid FK → `governance_bodies` | não | **DEPRECIADA na 027** — substituída pela classificação N:N (5.16). Valor da 026 preservado e migrado; a aplicação não lê nem escreve |
| `created_by_user_id` / `updated_by_user_id` | uuid FK → `users` | | autoria |
| `created_at` / `updated_at` | timestamptz | sim | |

Uso em reunião: a pessoa vira uma linha comum de `meeting_participants`
(`user_id` NULL, sem par Entra, `participant_type='external'`, nome e e-mail
como snapshot) — o convidado externo que o modelo já suportava. Sem FK de
`meeting_participants` para cá: remover o cadastro não altera reuniões. O
convite do Outlook usa só o e-mail. Migration aditiva; reversão no cabeçalho.

### 5.16 Revisão 027 — Classificação de pessoas (órgãos e temas)

Pessoas podem ser classificadas por **0..N Órgãos colegiados** e **0..N Temas**,
nas duas origens. A classificação serve **só para sugerir** participantes nos
seletores de reunião/tema — **não** é autorização, **não** é App Role e **não**
inclui ninguém em reunião ou tema automaticamente.

> **Revisado na 031 (5.17):** o vínculo pessoa ↔ **órgão** passou a ser o
> *grupo do órgão* e **inclui** a pessoa nas reuniões novas do órgão (comentário
> da tabela na 032). **Out/2026:** sem vínculo vivo — entrar no grupo não muda mais
> reuniões já existentes (ver 5.23-b). O vínculo
> pessoa ↔ tema (`participant_topics`) continua só sugestão.

| Conceito | Onde vive | Observação |
|---|---|---|
| Identidade Entra | Microsoft Entra ID | fonte de verdade; nunca copiada em massa |
| Usuário do PGCP | `users` | só quem fez login (JIT); App Roles vêm do token |
| Pessoa do Entra classificada | `directory_people` (nova) | só `(entra_tenant_id, entra_object_id)` + snapshot de nome/e-mail **lido do Graph** no vínculo; existe apenas para quem a Administração vinculou; `UNIQUE (tenant, oid)` |
| Externo do PGCP | `external_participants` (026) | sem login, sem App Role |
| Pessoa ↔ órgão | `participant_governance_bodies` (nova) | sujeito XOR (externo, pessoa do diretório); FK `RESTRICT` em `governance_bodies` |
| Pessoa ↔ tema | `participant_topics` (nova) | tema = **Biblioteca de Temas** (`agenda_topics`), o catálogo reutilizável; FK `CASCADE` (excluir o tema remove só a classificação) |

- Índices únicos parciais impedem vínculo duplicado por sujeito; `CHECK
  (num_nonnulls(...) = 1)` impede vínculo sem sujeito ou com dois.
- **Por que não `agenda_topic_participants`:** aquela relação é copiada para a
  reunião quando o tema é vinculado (snapshot 020) — usá-la adicionaria pessoas
  automaticamente. A classificação aponta para o mesmo catálogo por outra relação.
- **Temas da reunião** (`meeting_agenda_items`) não são classificação; a
  sugestão por tema usa o `agenda_topic_id` do tema quando ele veio da Biblioteca.
- **Compatibilidade 026:** backfill de `external_participants.governance_body_id`
  para `participant_governance_bodies`; a coluna fica, depreciada.
- Migration aditiva; reversão no cabeçalho de `027_participant_classifications.sql`.

**Órgão colegiado como contexto global (frontend).** O seletor do cabeçalho
filtra Visão Geral, Calendário, Pipeline e Agenda Anual e pré-seleciona o órgão
ao criar reunião/agenda (só órgão ativo). É preferência do navegador
(`localStorage`), **não** autorização — nada vai para a API. Telas
administrativas não são filtradas por ele.

### 5.17 Revisão 031 — Grupos de participação e exceção por reunião

Mudança de regra: os grupos passam a **incluir** pessoas automaticamente, em
dois momentos claros (sem sincronização contínua nem retroativa).

| Grupo | Onde vive | Quando inclui |
|---|---|---|
| Grupo do **Órgão colegiado** | `participant_governance_bodies` (027), pessoa do diretório ou externo | na **criação** da reunião do órgão (mesma transação, depois dos manuais) e, ao **entrar no grupo**, nas reuniões **abertas** já existentes do órgão |
| **Participantes padrão** do Tema | `agenda_topic_participants` (lista do tema da Biblioteca — a mesma do modal da Biblioteca) | quando o tema da Biblioteca **entra** na reunião (cópia já existente, 020): pessoa na reunião + no tema |

| Estrutura nova | Papel | Regras |
|---|---|---|
| `meeting_participant_exclusions` | Pessoa **removida explicitamente** de uma reunião | `meeting_id` FK `CASCADE`; identidade = a de `meeting_participants` (par Entra **ou** e-mail do convidado); únicos parciais por reunião+par e por reunião+`lower(email)`; `pcgp_app`: `SELECT/INSERT/DELETE` |

- **Deduplicação:** a pessoa aparece uma vez (identidade Entra, usuário ou
  e-mail); nenhum segundo convite para o mesmo endereço.
- **Remover da reunião** apaga a participação (e os vínculos com temas) e grava
  a exceção: nenhuma inclusão automática a traz de volta **àquela** reunião.
  Grupos não mudam; a próxima reunião inclui de novo.
- **Incluir manualmente** (ou vincular a um tema) apaga a exceção.
- **Remover do tema** só desvincula do tema (sem exceção).
- **Entrar ou sair do grupo do órgão** não muda reunião já criada (decisão
  out/2026; antes, entrar no grupo incluía a pessoa nas reuniões abertas).
  O grupo é só o ponto de partida das reuniões NOVAS.
- Externo entra como convidado (nome + e-mail, `external`): sem `users`, sem
  identidade Microsoft, sem App Role.
- Convite: a inclusão do órgão acontece antes do primeiro envio (a integração
  nasce `pending`); a do tema usa o caminho atual (convite fica `stale` para
  reenvio, como em qualquer inclusão). Nenhuma lógica nova de Outlook/Teams.
- **"+ Novo tema" da Agenda Anual** cadastra o tema também na Biblioteca
  (`agenda_topics`, mesma função da Biblioteca): os participantes do formulário
  viram os **participantes padrão** e a instância na reunião nasce vinculada
  (`agenda_topic_id`), tudo na mesma transação. Editar a instância depois não
  altera o tema-mestre. Título não é único no catálogo (cada "Novo tema" é um
  tema-mestre novo). A massa local de QA teve 2 temas anteriores vinculados por
  correção pontual (IDs explícitos), sem backfill genérico.
- Migration aditiva; reversão no cabeçalho de `031_meeting_participant_exclusions.sql`.

### 5.18 Agenda Anual → Pipeline e Documentos (sem migration)

**Liberação para o Pipeline — REMOVIDA em 10/2026 (ver §5.20).** Até então a
reunião com `annual_agenda_id` só operava no Pipeline depois da Agenda Anual
`approved`. Hoje toda reunião opera no Pipeline desde o agendamento: a guarda
`exigirLiberadaParaPipeline` saiu do router `/meetings`, e `releasedToPipeline`
continua no contrato, sempre `true`. A Agenda continua editando pelas próprias
rotas (`/annual-agendas/:id/meetings/...`), na transação travada dela.

**Documentos.** Ver §5.19 (anexos com AWS S3, migration 033). Atas com
conteúdo e a versão vigente da Agenda Anual continuam entrando na biblioteca
sem cópia (download pelas rotas de origem); a prévia da Agenda não entra.

### 5.19 Documentos com AWS S3 (migration 033)

**Implementado (código, testes e banco descartável).**

- Tabela `documents` — **metadado** do anexo; os bytes ficam no S3 privado.
  Colunas: `source` (`user` | `pgcp`), `meeting_id`, `meeting_agenda_item_id`
  (tema **desta** reunião, não o tema da Biblioteca), `annual_agenda_version_id`,
  `original_filename`, `description`, `mime_type` (decidido pelo servidor),
  `size_bytes`, `sha256`, `object_key` (único), `uploaded_by_user_id`,
  `created_at`.
- Integridade no banco: exatamente um contexto (reunião **ou** versão da Agenda
  Anual — `num_nonnulls = 1`); tema exige reunião; FK **composta**
  `(meeting_id, meeting_agenda_item_id) → meeting_agenda_items (meeting_id, id)`
  impede anexar a um tema de outra reunião; `source = 'user'` exige autor.
- Sem exclusão no MVP: FKs `ON DELETE RESTRICT`; o runtime (`pcgp_app`) tem só
  `SELECT, INSERT` (UPDATE/DELETE revogados). Excluir tema ou reunião com
  documento → 409 antes de qualquer efeito (inclusive antes de cancelar o
  evento do Outlook). Nada de cascade apagando objeto no S3.
- Chave do objeto só com ids estáveis:
  `meetings/{meetingId}/documents/{documentId}/arquivo.{ext}` e
  `meetings/{meetingId}/topics/{meetingAgendaItemId}/{documentId}/arquivo.{ext}`.
  Nome original e pessoas ficam fora da chave. A chave nunca sai da API.
- Biblioteca e árvore vêm **dos metadados** (UNION de anexos, Atas e Agenda
  vigente), numa consulta; o bucket nunca é listado. Pastas visuais Órgão →
  Ano → (Agenda Anual | Mês → "DD/MM — Reunião"), sem nível Dia; ano/mês são
  os da reunião no fuso dela (filtros `year`/`month` usam o mesmo critério).
- Resumo da reunião expõe `documentsCount` (anexos) e
  `agendaItemsWithoutDuration` para a Lista do Pipeline.
- Reversão no cabeçalho de `033_documents.sql` (DROP TABLE + linha de
  `schema_migrations`); **os objetos no S3 permanecem** e precisam de limpeza
  manual se houver.

**Pendente.** Guardar no S3 os PDFs gerados (versão enviada/aprovada da
Agenda Anual, Ata final) — a coluna `annual_agenda_version_id` e `source =
'pgcp'` já existem; hoje esses documentos entram pela rota de origem.
Exclusão/versionamento de anexo e antivírus: fora do MVP.

### 5.20 Revisão 10/2026 — sem aprovações, descrição rica, versões da reunião (034) e Mesa externa (035)

Decisões do produto (usuárias do PGCP, 06/10/2026):

**Agenda Anual sem aprovação.** Sempre editável; reunião da Agenda opera no
Pipeline desde o agendamento; Calendário e Agenda mostram a reunião **ao
vivo** (o congelamento pela versão aprovada saiu, inclusive
`GET /annual-agendas/frozen-calendar`). As rotas `approval-request`,
`approval` e `withdraw` respondem **410**. **Nada foi apagado**:
`annual_agendas.status`, `approval_*`/`approved_*` e `annual_agenda_versions`
(snapshot imutável) seguem gravados e legíveis como **histórico** — o
documento da versão antiga continua em `GET /:id/document`. Nenhuma operação
produz mais `pending_approval`/`approved`. A prévia (PDF compilado) continua.

**Validação de pautas da reunião opcional.** Iniciar a reunião exige só o
convite (`exigirProntaParaIniciar`). Envio ao aprovador e registro da
aprovação continuam disponíveis, sem bloquear nada;
`meetings.agenda_validation_*` segue gravado.

**Preservado ("geração do tema").** Criação/edição de temas pela Agenda Anual,
o PDF compilado (prévia da Agenda e PDF da validação), a cópia do tema da
Biblioteca para a reunião (019/020) e a classificação "Tema de FUP" — nenhum
dependia da aprovação depois desta revisão.

**Descrição da reunião (`meetings.description`, sem migration).** Passa a
guardar **HTML saneado pelo servidor** (`meetings/rich-text.ts`): só `p`, `br`,
`strong`, `em`, `ul`, `ol`, `li`, **sem atributos**; texto reescapado; teto de
20 000 caracteres formatados. Descrições antigas em texto puro continuam
válidas e são convertidas em parágrafos na leitura/envio. A coluna continua
`text`; nenhuma linha foi reescrita.

**`meeting_versions` (034).** Fotografia auditável a cada alteração relevante:
`meeting_id` (FK `ON DELETE CASCADE`), `version` (único por reunião),
`snapshot` jsonb `{ formato, conteudo, contexto }`, `content_hash` (SHA-256 de
`conteudo` canônico), `change_summary`, `created_by_user_id`, `created_at`.

- Nasce no **fim da mesma transação** da mutação (criação, cabeçalho,
  participantes, pautas, temas, ordem, postergação, inclusão pelo grupo do
  órgão, edição pela Agenda Anual) e, para o convite criado no Outlook, numa
  transação própria logo após o COMMIT do convite. Hash igual ao da última
  versão = nenhuma versão; falha = ROLLBACK leva a versão junto.
- `conteudo` (entra no hash): título, tipo, situação, descrição, data/horário,
  fuso, modalidade/local, órgão (id), organizador, recorrência, participantes
  (nome, e-mail, externo, papel), pautas/temas (ficha, horário, duração,
  responsável, postergado, participantes) e convite (enviado, Teams).
  `contexto` (não gera versão sozinho): nome do órgão, Presidente da Mesa,
  membros do grupo do órgão presentes, validação de pautas, última
  sincronização.
- Imutável: runtime só `SELECT, INSERT`; trigger recusa `UPDATE` e `DELETE`
  (a cascata da exclusão da reunião é a única remoção possível — a exclusão
  fica em `audit_logs`). Cada versão grava "Versão da reunião registrada" na
  trilha, na mesma transação.
- PDF gerado **do snapshot**, sob demanda (`GET /meetings/:id/versions/:versionId/pdf`),
  como na Agenda Anual — sem bytes no S3. Reuniões anteriores à 034 ganham a
  versão 1 na primeira alteração ("reunião anterior ao versionamento").

**Presidente da Mesa externo (035).** `governance_bodies.chair_external_participant_id`
→ `external_participants` (`ON DELETE RESTRICT`; a aplicação responde 409 ao
tentar remover o cadastro de quem preside). CHECK: Entra **ou** externo, nunca
os dois; externo exige `chair_name` (snapshot; a leitura prefere o nome atual
do cadastro). Presidir não dá login, App Role nem acesso. Externos no **grupo
do órgão** (027/031) já entravam nas reuniões como `meeting_participants`
`external` (nome + e-mail) e recebem o convite pelo e-mail.

Reversão das duas migrations: ver o cabeçalho de cada arquivo.

### 5.21 Revisão 036 — excluir reunião = cancelamento lógico

`DELETE /meetings/:id` **não apaga mais** a reunião. Antes, a cascata levava
participantes, pautas, temas, Anotações, Ata, integração de calendário e as
versões (034); reunião com documento nem podia ser excluída.

- `meetings.cancelled_at` + `cancelled_by_user_id` (par coerente) e
  `calendar_event_cancelled_at` (evento do Outlook/Teams cancelado; `NULL` com
  evento existente = cancelamento externo **pendente**).
- Fluxo: transação local (trava, marca, trilha "Reunião cancelada (exclusão
  lógica)", versão final com `conteudo.cancelada = true`) → depois do COMMIT,
  `DELETE` do evento no calendário do organizador (o Exchange envia o
  cancelamento aos convidados; 404 = já não existia). Falha no Graph: reunião
  continua cancelada, trilha de falha, `calendarCancellation: "pending"` na
  resposta; repetir a exclusão retenta só o evento (idempotente).
- Fora dos fluxos ativos: listagem de reuniões (Pipeline, Calendário, Visão
  Geral, busca), exportação, Agenda Anual (contagens, visão, conteúdo,
  candidatas, edição, associação, reserva), grupos do órgão e sincronização com
  o Outlook (409). Continua legível: detalhe, versões e PDFs, documentos, Ata,
  trilha. Toda mutação em `/meetings/:id/...` responde 409
  `meeting_cancelled`.
- Banco: trigger torna a reunião cancelada somente leitura e impede
  reativar; `meeting_versions` passa a `ON DELETE RESTRICT` (sem cascata) e o
  trigger dela recusa qualquer DELETE; `pcgp_app` perde `DELETE` em `meetings`.
- Documentos: a FK já era `RESTRICT` (033); cancelar com documento é
  permitido e eles ficam no histórico.
- Resposta do `DELETE` passou de 204 sem corpo para 200
  `{ meetingId, cancelledAt, calendarCancellation, warning? }`.

### 5.22 Revisão 037 — Biblioteca no estilo Drive e Favoritos

- **Pastas continuam derivadas** (Órgão → Ano → Agenda Anual | Mês → Reunião,
  montadas dos metadados). Não existe pasta no banco: "Nova pasta" e
  **Lixeira** ficaram fora por decisão de produto (exigiriam modelo novo e
  regra de retenção). Nenhum documento pode ser excluído (033 mantida).
- **`document_favorites` (037)**: `user_id` (CASCADE), `document_key` (id opaco
  `doc:`/`ata:`/`agenda:` + uuid, CHECK), UNIQUE por usuário. Preferência
  pessoal: não altera documento, não concede acesso; favoritar confere a
  visibilidade (mesma CTE da Biblioteca, 404 fora do alcance); a lista de
  Favoritos é sempre recortada pela visibilidade atual. Sem `audit_logs`
  (preferência de leitura). Runtime: `SELECT, INSERT, DELETE`.
- **Formato** (`format` na lista e filtro `format`): derivado da extensão — a
  mesma fonte do MIME decidido no upload; gerados são PDF.
- **Armazenamento** (`GET /documents/storage`): contagens e soma de
  `size_bytes` dos ANEXOS visíveis; Ata/Agenda Anual são geradas e não ocupam
  espaço. Sem quota (não existe no PGCP).
- Ordenação nova `nome_desc`; "Enviar arquivo" na Biblioteca reaproveita
  `POST /meetings/:id/documents` (só na pasta de reunião ativa).

### 5.23 Revisão 038 — Locais cadastrados e Participantes (telefone/empresa)

- **`meeting_locations`**: `name` (2–120, único sem caixa/espaços), `street`,
  `number`, `complement`, `neighborhood`, `city`, `state` (UF `^[A-Z]{2}$`),
  `postal_code` (8 dígitos), `notes` (interna, ≤ 500), `is_active`,
  `legacy_key` (só os importados), autoria e datas. CHECK: local **ativo** tem
  rua, número, cidade, UF e CEP. Sem geocodificação, sem API de CEP, sem tabela
  de país/estado/cidade, sem reserva de sala/capacidade.
- **Sem exclusão**: runtime com `SELECT, INSERT, UPDATE` (sem `DELETE`);
  inativar tira o local da escolha de reuniões novas.
- **Importação**: as duas sedes do catálogo da 025 (`sede-matriz`,
  `sede-leopoldo`) viraram locais **inativos** sem endereço ("a completar");
  reuniões que usavam as chaves receberam `physical_location_id` e a cópia
  `{id, name}` (triggers da 036/updated_at desligados só no backfill).
- **Reunião**: `physical_location_id` (FK RESTRICT) + `physical_location_snapshot`
  (jsonb: id, nome e endereço **no momento da escolha**). CHECKs:
  `(modality = 'in_person') = (physical_location_id IS NOT NULL)` e id/cópia
  sempre juntos. Local **novo** precisa existir e estar ativo; manter o mesmo
  id preserva a cópia (mesmo que o cadastro tenha sido editado/inativado).
  Convite, versões (`conteudo.local`), PDF e exportação leem a cópia; versões
  antigas não mudam.
- **API**: `GET/POST /meeting-locations`, `PATCH /meeting-locations/:id`,
  `PUT /meeting-locations/:id/status` (Assessoria ou Admin; trilha "Local
  criado/atualizado/inativado/reativado", `entity_type = meeting_location`).
  `GET /meetings/locations` devolve só os **ativos** (sem observação). Corpo da
  reunião: `physicalLocationId` (substitui `physicalLocationKey`).
- **`external_participants`**: `phone` passou a opcional (o CHECK de formato
  continua quando há valor); nova `company` opcional (1–200). Buscável pela
  lista da Administração.

### 5.23-b Participantes do grupo do órgão na Nova reunião e na edição (sem migration)

- **Nova reunião:** ao escolher o órgão, a tela carrega o grupo
  (`GET /participation-groups/governance-bodies/:id/members`, agora com
  `entraObjectId`) como ponto de partida, marcado "Do órgão". A usuária
  remove/adiciona só para aquela reunião. O corpo da criação leva
  `participantsIncludeGroup: true`: o servidor não recoloca o grupo e registra a
  exceção (031) de quem do grupo ficou de fora. Sem a flag (outros clientes,
  reserva da Agenda Anual), o servidor inclui o grupo como antes.
- **Troca de órgão (Nova reunião):** lista intocada → troca direto; ajustada à
  mão → confirmação, e "Substituir lista" troca a lista inteira (o 1º órgão
  soma ao que já havia, ex.: organizador).
- **Editar reunião:** abrir mostra a lista da reunião, sem recalcular pelo
  órgão. Trocar o órgão pergunta: "Sim" **acrescenta** o grupo do novo órgão
  (sem duplicar, ninguém sai); "Não" mantém a lista. Salvar segue o PATCH
  consolidado (uma transação, uma versão, uma sincronização).
- **Sem vínculo vivo:** entrar/sair do grupo na Administração não altera
  reunião existente.

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
| `meeting_agenda_item_participants` (020) | `meeting_agenda_items` / `meeting_participants` | **N:N** | — | `CASCADE` |
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
| `documents` / `attachments` | **Implementado na 033** (ver §5.19): aba Documentos na reunião (Pipeline) e biblioteca central. |
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
    MEETING_PARTICIPANTS ||--o{ MEETING_AGENDA_ITEM_PARTICIPANTS : "participa"

    MEETING_AGENDA_ITEMS ||--o{ MEETING_AGENDA_ITEM_PRESENTERS : "possui"
    MEETING_AGENDA_ITEMS ||--o{ MEETING_AGENDA_ITEM_PARTICIPANTS : "possui"
    MEETING_AGENDA_ITEMS ||--o{ ACTION_ITEMS : "origina"

    USERS {
        uuid id PK
        text name
        text email
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
    MEETING_AGENDA_ITEM_PARTICIPANTS {
        uuid meeting_agenda_item_id PK
        uuid meeting_participant_id PK
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
