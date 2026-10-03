/**
 * Usuário da sessão atual — fonte única de verdade de quem está logado.
 *
 * Não guarda iniciais: elas são derivadas do nome por `getInitials()`.
 * A origem da sessão (Modo de teste hoje, Entra ID no futuro) é irrelevante
 * para quem consome este tipo.
 */
export interface SessionUser {
  name: string;
  /** Rótulo de exibição (cargo). NÃO é perfil funcional nem autorização. */
  role: string;
  /**
   * App Roles do PGCP desta pessoa.
   *
   * Decide o que a tela MOSTRA. A autorização de verdade é do servidor, que
   * revalida em cada rota — esconder um botão é cortesia, não barreira.
   */
  appRoles?: string[];
}

/** Opção do seletor de Modo de teste, montada a partir dos mocks existentes. */
export interface TestProfile extends SessionUser {
  id: string;
  email: string;
}

/** Órgão de governança. Vem da API (`governance_bodies`), não do localStorage. */
export interface GovernanceBody {
  id: string;
  name: string;
  icon: string | null;
  isActive: boolean;
  /** Presidente da Mesa cadastrado no órgão. `null` = ninguém cadastrado ainda. */
  chairEntraObjectId: string | null;
  chairName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Presidente da Mesa escolhido no diretório, ao criar/editar um órgão. */
export interface GovernanceBodyChairInput {
  entraObjectId: string;
  displayName: string;
}

export interface Participant {
  /**
   * `meeting_participants.id` — PK da linha no PostgreSQL.
   *
   * É o que identifica a participação para remover ou editar. Ausente enquanto
   * a reunião não foi gravada (participante ainda sendo montado no formulário).
   *
   * NÃO confundir com `entraObjectId`: uma é a linha, a outra é a pessoa. E não
   * substituir por nome nem por índice do array — nome não é chave, e o índice
   * muda ao reordenar.
   */
  participantId?: string;
  name: string;
  role: string;
  avatarUrl?: string;
  initials: string;
  confirmed: boolean;
  /**
   * `id` da pessoa no Microsoft Graph — o mesmo valor de `entra_object_id`.
   *
   * Identidade MICROSOFT, distinta de `users.id`: participante de reunião não
   * precisa ter conta no PGCP. Ausente em participantes legados, e é por isso
   * que a deduplicação cai para o nome quando o par não está disponível.
   */
  entraObjectId?: string;
  /**
   * Pertence HOJE ao grupo do órgão colegiado da reunião (Administração →
   * Participantes → Grupos). Informativo: origem discreta e texto da remoção.
   */
  inGovernanceBodyGroup?: boolean;
  /**
   * Endereço para o convite de calendário.
   *
   * NÃO é identidade — quem identifica é `entraObjectId` (Microsoft) ou o
   * `users.id` do lado do servidor. Serve para o Outlook saber para onde mandar
   * o convite, e nunca é derivado do nome.
   *
   * Origem por caso:
   *   usuário PGCP    → `users.email`, resolvido no servidor
   *   pessoa do Entra → `mail` do diretório, ou o UPN quando `mail` vem nulo
   *   externo         → digitado explicitamente no formulário
   *
   * Ausente é legítimo: a reunião existe sem endereço. O que não acontece sem
   * ele é a sincronização com o calendário.
   */
  email?: string;
}

import type { CalendarIntegration } from "./lib/calendar-sync";
import type { AgendaValidation } from "./lib/agenda-validation";

/**
 * PAUTA da reunião (025) — agrupa temas. Reunião -> Pauta -> Tema.
 */
export interface MeetingAgenda {
  id: string;
  title: string;
  position: number;
}

/**
 * TEMA da reunião (`meeting_agenda_items`). O nome do tipo é anterior a 025,
 * quando "pauta" designava o assunto específico.
 */
export interface AgendaItem {
  /**
   * Identidade estável da pauta dentro da reunião (UUID).
   * Não derivar de posição, título ou horário: renomear e reordenar não
   * podem trocar o estado entre pautas. Alinhado com `meeting_agenda_items.id`.
   */
  id: string;
  time: string;
  title: string;
  duration: string;
  author: string;
  /**
   * `id` do responsável no Microsoft Graph — o mesmo valor de
   * `entra_object_id`. Identidade MICROSOFT, não a interna do PGCP.
   *
   * Ausente em pautas legadas e sempre que `author` for uma área, um órgão ou
   * um coletivo ("Todos", "Finance Committee") — casos em que não há pessoa
   * para vincular.
   */
  authorEntraObjectId?: string;
  /**
   * `agenda_topics.id` da pauta da Biblioteca que originou este item.
   *
   * É o que preserva a IDENTIDADE ao importar: duas pautas homônimas continuam
   * distintas, e o vínculo nunca é adivinhado pelo título.
   *
   * Ausente em item criado direto na reunião.
   */
  agendaTopicId?: string;
  /**
   * Estado de execução PERSISTIDO (`meeting_agenda_items.execution_status`).
   *
   * "Apresentando" NÃO aparece aqui de propósito: é estado de sessão, vive só
   * no React e some no refresh. Persistir transformaria um fato da tela em
   * fato compartilhado entre navegadores.
   *
   * Ausente em pautas que ainda não vieram do banco.
   */
  executionStatus?: "pending" | "completed" | "postponed";
  /**
   * Tema circular NESTA reunião (`meeting_agenda_items.is_circular_theme`).
   * Propriedade da pauta da reunião, não do tema mestre da Biblioteca. Só
   * informa; não dispara comportamento. Ausente em item local ainda não gravado.
   */
  isCircularTheme?: boolean;
  /**
   * Ficha cadastral NESTA reunião (snapshot, migration 019). Snapshot de
   * `agenda_topics.*` no vínculo; depois independente. Os `*Id` guardam a
   * IDENTIDADE (para o form pré-selecionar); `pautaType`/`pautaNature` são só o
   * rótulo de exibição. Ausentes em item antigo/sem classificação.
   */
  agendaTopicTypeId?: string;
  pautaType?: string;
  agendaTopicNatureId?: string;
  pautaNature?: string;
  /** Descrição / Objetivo de debate desta pauta. */
  description?: string;
  /** "Tema de FUP" — apenas classificação; não cria FUP. */
  generatesActionItem?: boolean;
  /**
   * Participantes POR PAUTA (020, Opção A). Cada um existe também na reunião.
   * `participantId` é a participação na reunião (para desvincular); `name` exibe.
   */
  participants?: { participantId: string; name: string }[];
  /** PAUTA (agrupador) a que este tema pertence. Ausente = tema sem pauta. */
  agendaId?: string;
}

/** Local físico do catálogo. Endereço `null` enquanto não configurado. */
export interface PhysicalLocation {
  id: string;
  name: string;
  address: string | null;
  complement: string | null;
  city: string | null;
  state: string | null;
}

/**
 * Pauta da Biblioteca — view model de `agenda_topics`.
 *
 * Todos os dados vêm da API. Campos que o modelo antigo tinha e o PostgreSQL
 * não guarda saíram: `category` (sem consumidor, provado em auditoria),
 * `meetingId` (vínculo é `meeting_agenda_items.agenda_topic_id`) e `authorId`
 * (id de um mock de diretório que não existe mais).
 */
export interface StandaloneAgenda {
  /** UUID de `agenda_topics`. Nunca `pauta-*` nem `pauta-post-*`. */
  id: string;
  title: string;
  /** "HH:mm". Derivado de `estimated_duration_minutes`. */
  duration: string;
  /** RESPONSÁVEL: pessoa, área ou coletivo. */
  author: string;
  /**
   * `id` do responsável no Microsoft Graph — o mesmo valor de
   * `entra_object_id`. Identidade MICROSOFT, não a interna do PGCP.
   *
   * Ausente quando `author` é uma área, um órgão ou um coletivo.
   */
  authorEntraObjectId?: string;
  description: string;
  createdAt: string;
  /** Participantes com identidade explícita vivem no detalhe, não aqui. */
  participantsCount?: number;
  isFUP?: boolean;

  /** IDENTIDADE do tipo/natureza. O label é só exibição. */
  pautaTypeId?: string;
  pautaType?: string;
  pautaNatureId?: string;
  pautaNature?: string;

  /**
   * PADRÃO de tema circular do tema mestre (`agenda_topics.is_circular_theme`).
   * Ao vincular a uma reunião, é copiado para a pauta da reunião (snapshot);
   * depois os valores são independentes. Ausente em registro ainda não gravado.
   */
  isCircularTheme?: boolean;

  /** Em quantas reuniões a pauta está. Vem da FK, nunca de casar título. */
  linkedMeetingsCount?: number;

  /**
   * PROCEDÊNCIA da cópia automática, para EXIBIÇÃO apenas.
   *
   * O frontend não gera, não decide e não usa esses campos para localizar a
   * cópia: quem remove a cópia certa é o PostgreSQL, pela chave estrutural,
   * dentro de `POST .../resume`.
   */
  sourceMeetingId?: string;
  sourceAgendaItemId?: string;
  isAutomaticCopy?: boolean;
}

export interface Meeting {
  id: string;
  title: string;
  date: string; // e.g. "2023-10-15" (YYYY-MM-DD)
  startTime: string; // e.g. "10:05"
  endTime: string; // e.g. "14:00"
  timeZone: string; // e.g. "EST"
  category: string;
  /** Identidade do órgão (`category` é só o nome exibido). */
  governanceBodyId?: string;
  /**
   * Presidente da Mesa cadastrado no ÓRGÃO de governança (não na reunião).
   * Alimenta a seção MESA do esqueleto da Ata. `null`/`undefined` = ninguém
   * cadastrado ainda para este órgão.
   */
  governanceBodyChairName?: string | null;
  governanceBodyChairEntraObjectId?: string | null;
  /**
   * Situação formal da reunião. NÃO representa a aba aberta nem a etapa do
   * processo — o andamento visual é derivado, não armazenado.
   *
   * Ciclo oficial gerado pela aplicação:
   *   Scheduled -> In Progress -> Done
   *
   * Demais valores são legados preservados por compatibilidade:
   *   Draft, Needs Approval  — existem nos dados e têm filtro/selo em Reuniões
   *   Approved, Closed       — não são mais gravados por nenhum fluxo
   */
  status: "Scheduled" | "Draft" | "Needs Approval" | "In Progress" | "Done" | "Approved" | "Closed";
  expectedParticipantsCount: number;
  agendaItemsCount: number;
  /** Temas sem duração (resumo do servidor). */
  agendaItemsWithoutDuration?: number;
  /** Anexos da reunião e dos temas (resumo do servidor). */
  documentsCount?: number;
  description: string;
  organizer: string;
  meetingLink?: string;
  /**
   * Reuniao online do proprio evento de calendario, quando a reunião a tem.
   *
   * Presente = decisão tomada. O link só existe depois que o Graph provisiona,
   * e vem em `calendar.joinUrl` — nunca aqui.
   */
  onlineMeetingProvider?: "teamsForBusiness";
  /** TEMAS da reunião. */
  agenda?: AgendaItem[];
  /** PAUTAS (agrupadores). Só no detalhe. */
  agendas?: MeetingAgenda[];
  participants?: Participant[];
  /** Modalidade (025). Presencial continua com Teams, como contingência. */
  modality?: "online" | "in_person";
  physicalLocation?: PhysicalLocation | null;
  /** Origem: Calendário (manual) ou reserva da Agenda Anual. */
  origin?: "manual" | "annual_agenda";
  annualAgendaId?: string | null;
  /** Status da Agenda Anual da reunião (`null` = avulsa). */
  annualAgendaStatus?: "draft" | "pending_approval" | "approved" | null;
  /**
   * Operacional no Pipeline (decidido no servidor): avulsa sempre; com Agenda
   * Anual, só depois de aprovada. Antes disso a reunião é preparada na Agenda.
   */
  releasedToPipeline?: boolean;
  /** Estado do convite também no resumo (Pipeline). */
  calendarSyncStatus?: "pending" | "synced" | "failed" | "stale" | null;
  /** Situação da Ata (`meeting_minutes.status`); `null` = não iniciada. */
  minutesStatus?: "draft" | "under_review" | "approved" | "closed" | null;
  /** Tipo (030). Preenchido = título padronizado; `null` = legado. */
  sessionType?: "ordinary" | "extraordinary" | null;
  missingRequirementText?: string;
  recurrence?: string;
  /**
   * Projeção da reunião no calendário externo, quando existe.
   *
   * Ausente significa que a reunião não tem integração preparada — não que o
   * convite foi enviado. A tela nunca deduz sucesso: o estado vem do servidor.
   */
  calendar?: CalendarIntegration;
  /**
   * Ciclo da PAUTA — em preparação, enviada para validação, aprovada.
   *
   * Eixo separado de `status` (ciclo da reunião) e de `calendar` (convite).
   * A tela usa para decidir o que HABILITAR; a barreira real está no backend,
   * que recusa o convite enquanto a pauta não estiver aprovada.
   */
  agendaValidation?: AgendaValidation;
}

export interface AuditLog {
  id: string;
  timestamp: string; // YYYY-MM-DD HH:mm:ss
  user: string;
  role: string;
  initials: string;
  action: string;
  icon: string;
  entity: string;
  entityId: string;
  status: "Sucesso" | "Falha";
}

/**
 * Preferências locais de desenvolvimento.
 *
 * NÃO guarda segredo. `clientSecret` existia aqui e era persistido em
 * localStorage; a configuração do Entra ID passou a viver em apps/api/.env, e o
 * navegador só recebe `configured: true/false` via GET /integrations.
 */
/*
 * REMOVIDOS na 4.12: `SystemSettings` e `CategoryItem`.
 *
 * `SystemSettings` (tenantId/clientId/status) descrevia a configuração do Entra
 * no navegador — write-only, sem leitor. A configuração real vive em
 * `apps/api/.env` e o status verdadeiro vem do painel PGCP Conectado.
 *
 * `CategoryItem` era o cadastro de "modelos de categoria" do protótipo. Não é
 * órgão de governança (`governance_bodies`), nem tipo, nem natureza de pauta —
 * os três conceitos reais, que já vivem no PostgreSQL.
 */

export interface ActionItem {
  id: string;
  title: string;
  origin: string;
  daysLate: number; // if <= 0 means Due Today
  /**
   * Responsável pelo acompanhamento.
   *
   * Historicamente guardava apenas texto: não havia campo de identidade, e o id
   * do mock local era descartado no cadastro. `entraObjectId` é campo NOVO —
   * não há legado para conflitar.
   */
  assignedUser: {
    name: string;
    avatarUrl?: string;
    initials: string;
    isCurrentUser?: boolean;
    /**
     * `id` do usuário no Microsoft Graph — o mesmo valor de `entra_object_id`.
     *
     * Identidade MICROSOFT, não a interna do PGCP. Ausente em FUPs legados e em
     * responsáveis que nunca foram escolhidos pelo diretório.
     */
    entraObjectId?: string;
  };
  /**
   * DERIVADO. `Overdue` e `Due Today` saem de `daysLate`, que o servidor
   * calcula contra a data DELE; só `Completed` é situação persistida.
   * O status real do banco vem em `apiStatus`.
   */
  status: "Overdue" | "Due Today" | "Completed";

  /** `action_items.id` — UUID do PostgreSQL. Ausente em item ainda não gravado. */
  actionItemId?: string;
  /** Data civil de vencimento, `YYYY-MM-DD`. Única data de prazo persistida. */
  dueDate?: string;
  /** Situação persistida, sem a mistura com prazo. */
  apiStatus?: "open" | "completed" | "cancelled";
  /** Origem ESTRUTURAL. O texto de `origin` é só exibição. */
  originMeetingId?: string;
  originAgendaItemId?: string;
  /** "Comentários" da tela de FUP — campo único, sobrescrito a cada edição. */
  description?: string;
  /** VP responsável pelo tema perante a governança. Texto livre. */
  vpResponsavel?: string;
  /** "Data da Solicitação" — data de criação do FUP no sistema. ISO-8601. */
  createdAt?: string;
}

