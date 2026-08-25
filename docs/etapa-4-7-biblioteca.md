# Etapa 4.7 — Biblioteca de pautas no PostgreSQL

> **Status:** desenho aprovado, **nada implementado**.
> **Data da auditoria:** 18/08/2026
> **Divisão:** 4.7a = migration + backend definitivos · 4.7b = frontend + retirada do legado local
>
> A 4.7a decide o schema em caráter **final**. A 4.7b não deve precisar voltar ao
> banco para corrigir modelagem.

---

## 1. Auditoria — conclusões que não precisam ser refeitas

### `StandaloneAgenda` × `agenda_topics`

| Campo do frontend | Destino | Classe |
|---|---|---|
| `title`, `description` | `title`, `description` | direto |
| `author` + `authorEntraObjectId` | `responsible_label` + `responsible_entra_*` | direto (migration 003) |
| `isFUP` | `generates_action_item` | direto |
| `duration` | `estimated_duration_minutes` | parcial — string → int via `parseDurationMinutes` |
| `id` | `id uuid` | parcial — `pauta-*` e `pauta-post-*` não são UUID |
| `createdAt` | `created_at` | parcial — string pt-BR por extenso; o banco gera o seu |
| `authorId` | — | legado (mock de diretório já removido) |
| `category` | — | **sem representação e sem consumidor** — ver abaixo |
| `pautaType` / `pautaNature` | `agenda_topic_type_id` / `_nature_id` | relacional (decisão B) |
| `meetingId` | `meeting_agenda_items.agenda_topic_id` | relacional (decisão D) |
| `participants: string[]` | `agenda_topic_participants` evoluída | relacional (decisão C) |
| `sourceMeetingId` / `sourceAgendaItemId` | procedência composta | decisão A |

### `category` — descartável, sem perda

O formulário da Biblioteca **nunca grava** `category`. As duas ocorrências em
`UnlinkedAgendasView` são rótulos i18n (`lblCategory`, `filterAll`) sem
consumidor: não há filtro nem exibição. O único ponto que preenche o campo é
`handlePostponeAgendaTopic`, copiando `meeting.category`.

Não mapear para `governance_bodies` nem para tipo/natureza. Sai sem prejuízo.

### `meeting_agenda_items.postponed_from_item_id` — não serve à procedência

FK para a **própria tabela**: significa *"este item de reunião nasceu de outro
item de reunião"* — a pauta reaparecendo numa reunião futura. A cópia da
Biblioteca é `agenda_topic` originado de `meeting_agenda_item`: direção e
tabelas diferentes.

**Preservar o campo para o conceito dele.** Segue sem consumidor.

### "Reunião Vinculada" — mesmo conceito de estar na agenda

Decisivo, `UnlinkedAgendasView.tsx:600`:

```js
const linkedMeetings = meetings.filter(m =>
  (m.agenda && m.agenda.some(item => item.title === agenda.title))
  || (agenda.meetingId && m.id === agenda.meetingId)
);
```

O `||` já trata os dois como a mesma coisa. O rótulo do estado vazio confirma:
*"Não Vinculada (Salvar no Banco)"*.

`meetingId` era ponteiro manual porque o caminho relacional dependia de
**casamento de título** — frágil e cego a homônimos.

---

## 2. Migration 005 — desenho aprovado

### A. Procedência composta

```sql
-- Alvo da FK composta. Redundante em conteúdo (id já é único), mas o
-- PostgreSQL só aceita REFERENCES contra unicidade declarada.
ALTER TABLE meeting_agenda_items
  ADD CONSTRAINT meeting_agenda_items_meeting_id_id_uk UNIQUE (meeting_id, id);

ALTER TABLE agenda_topics
  ADD COLUMN source_meeting_id     uuid,
  ADD COLUMN source_agenda_item_id uuid,
  ADD CONSTRAINT agenda_topics_source_fk
    FOREIGN KEY (source_meeting_id, source_agenda_item_id)
    REFERENCES meeting_agenda_items (meeting_id, id)
    MATCH FULL ON DELETE SET NULL;

CREATE UNIQUE INDEX agenda_topics_source_uk
  ON agenda_topics (source_meeting_id, source_agenda_item_id)
  WHERE source_meeting_id IS NOT NULL AND source_agenda_item_id IS NOT NULL;
```

O que o banco passa a garantir:

- `MATCH FULL` — os dois preenchidos ou os dois nulos, nunca meia procedência;
- a FK composta — o item pertence mesmo à reunião indicada;
- `ON DELETE SET NULL` — excluída a origem, ambos ficam nulos **juntos** e a
  pauta da Biblioteca **permanece**;
- o índice parcial — no máximo uma cópia automática por (reunião, pauta).

**`postponedCopyId` não participa do modelo real.** A idempotência passa a ser
estrutural. Remover a cópia (Retomar) libera repostergar depois.

Consequência aceita: quando a origem é excluída, a cópia perde a procedência e
fica indistinguível de uma pauta manual — o Retomar não a encontra mais.

### B. Tipo e natureza — relacionais

`agenda_topic_types` e `agenda_topic_natures` viram os cadastros reais.
`agenda_topics` referencia pelas FKs que já existem. **Sem** `type_label` /
`nature_label` temporários.

**Seed — valores canônicos versionados no código** (`App.tsx:130` e `:135`),
que são os defaults quando não há nada no navegador:

- tipos: `Pauta Excepcional`, `Pauta Regular`
- naturezas: `Deliberativa`, `Informativa`, `Debate Estratégico`,
  `Remuneração`, `Compliance / CVM`

> Uma migration não lê `localStorage`. Valores customizados que existam só no
> navegador de alguém **não são migrados** e não devem ser declarados como
> migrados. A 4.7b decide explicitamente se importa uma vez ou descarta.

Identidade é o `id` do banco, nunca o nome.

### C. `agenda_topic_participants` — modelo final de identidade

Hoje: `(agenda_topic_id, user_id)` como PK, `user_id NOT NULL`. Isso impede os
três casos que o produto já suporta em `meeting_participants`.

Evolui para o mesmo modelo da migration 003:

```
id                uuid PK
agenda_topic_id   uuid FK -> agenda_topics ON DELETE CASCADE
user_id           uuid FK -> users, NULLABLE
entra_tenant_id   uuid NULLABLE
entra_object_id   uuid NULLABLE
display_name      text          -- snapshot
email             text          -- quando aplicável
created_at/updated_at
```

Constraints:

- CHECK de pareamento do par Entra (`(oid IS NULL) = (tid IS NULL)`);
- CHECK exigindo identidade **ou** snapshot: `user_id IS NOT NULL OR display_name IS NOT NULL`;
- CHECK exigindo nome quando há identidade Entra (mesmo padrão de 003);
- UNIQUE parcial por `(agenda_topic_id, user_id)` — dentro da pauta, não global;
- UNIQUE parcial por `(agenda_topic_id, entra_tenant_id, entra_object_id)`.

Sem `jsonb`, sem `text[]`, sem lista de nomes. Nunca criar usuário fake.
Reconciliação futura **só** por `(tenant, oid)` — nunca por nome, e-mail ou UPN.

### D. Vínculo com reuniões

**Não criar `linked_meeting_id`.** A relação final:

```
agenda_topics.id  ->  meeting_agenda_items.agenda_topic_id  ->  meetings.id
```

Uma pauta pode aparecer em N reuniões. O casamento por título sai: título nunca
é identidade.

---

## 3. Backend da 4.7a

**Biblioteca:** `GET /agenda-topics`, `GET /agenda-topics/:id`,
`POST /agenda-topics`, `PATCH /agenda-topics/:id`.

`DELETE` **só** se a análise das FKs provar regra segura. Não criar exclusão
física para reproduzir o botão atual.

**Cadastros:** leitura de `agenda_topic_types` e `agenda_topic_natures`;
mutações apenas com integridade clara — **nunca** excluir um tipo/natureza em uso
em silêncio.

**Operações de domínio atômicas** — o browser não coordena duas escritas:

```
POST /meetings/:meetingId/agenda-items/:agendaItemId/postpone
  BEGIN
    agenda item -> postponed
    cria/converge agenda_topic automático com procedência
    audit  (uma entrada de domínio, não uma por INSERT)
  COMMIT

POST /meetings/:meetingId/agenda-items/:agendaItemId/resume
  BEGIN
    agenda item -> pending
    remove SOMENTE a cópia localizada pela PROCEDÊNCIA
    audit
  COMMIT
```

Localizar a cópia por título, responsável, nome ou `postponedCopyId` está
**proibido**. Procedência estrutural é a única chave.

Regras já fixadas nas ondas anteriores e que continuam valendo:

- todos os endpoints atrás de `requireEntraAuth` → `requireActivePgcpUser`;
- browser envia no máximo `responsibleEntraObjectId`; o **tenant vem do token**;
- `completed` não cria entrada na Biblioteca — só `postponed`;
- `presenting` continua fora de tudo;
- sem sincronização contínua entre o item da reunião e a cópia: ela é snapshot
  do momento do Postergar.

---

## 4. Testes obrigatórios da 4.7a

Procedência: excluir o source item → ambos NULL e a pauta permanece · item de A
com source meeting B → FK rejeita · meia procedência → rejeitada · duplicata de
origem → convergida/rejeitada.

Fluxo: Postergar → 1 cópia · Postergar de novo → continua 1 · Retomar → cópia
some, item volta a `pending` · Retomar → Postergar → nova cópia válida.

Isolamento: cópia de outra reunião nunca removida · pauta manual homônima nunca
removida · duas `agenda_topics` homônimas continuam distintas · mesma
`agenda_topic` em duas reuniões é permitido · vínculo determinado por
`agenda_topic_id`, nunca por `title`.

Participantes: PGCP válido · Entra sem `users` válido · externo válido · meia
identidade Entra rejeitada.

Rollback: falha ao criar a cópia → estado da pauta desfeito · falha ao mudar
estado → nenhuma cópia · falha na auditoria → tudo desfeito.

---

## 5. Dado real a preservar

Existe uma reunião **"Teste"** (2 pautas) criada pelo teste manual. **Não
alterar.** Fixtures próprias, baseline real — nunca assumir contagem zero.

Baseline no fechamento da 4.6: `users = 1` · `governance_bodies = 6` ·
`meetings = 1` · `meeting_agenda_items = 2` · `audit_logs = 5` ·
`execution_status = 'presenting'` em **0** linhas.

---

## 6. Fora do escopo

FUP, notas, Ata, assinaturas, Outlook, Teams, Mail, OBO, RBAC, Graph sync,
taxonomia nova de pautas. `UnlinkedAgendasView` e `AdministrationView` **não são
tocados na 4.7a** — são a 4.7b.
