import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { mockTestPeople } from "./auth/mock-login-people";
import { Meeting, AuditLog, ActionItem, StandaloneAgenda, GovernanceBody, GovernanceBodyChairInput, SessionUser, TestProfile } from "./types";
import { ApiError, apiRequest } from "./lib/api";
import {
  deleteMeeting as apiDeleteMeeting,
  describeMeetingError,
  getMeeting,
  listMeetings,
  meetingFromApi,
  updateMeeting
} from "./lib/meetings";
import {
  actionItemFromApi,
  buildActionItemPayload,
  completeActionItem,
  createActionItem as apiCreateActionItem,
  describeActionItemError,
  listActionItems,
  reopenActionItem,
  updateActionItem as apiUpdateActionItem,
  type ActionItemPayload,
  type FupFormInput
} from "./lib/action-items";
import {
  agendaTopicToStandalone,
  buildTopicPayload,
  createAgendaTopic,
  deleteAgendaTopic as apiDeleteAgendaTopic,
  describeTopicError,
  listAgendaTopicNatures,
  listAgendaTopicTypes,
  listAgendaTopics,
  updateAgendaTopic,
  createTaxonomyItem,
  deleteTaxonomyItem,
  renameTaxonomyItem,
  type BibliotecaFormInput,
  type TaxonomyItem,
  type TaxonomyKind
} from "./lib/agenda-topics";
import {
  describeAuthError,
  isEntraConfigured,
  isMockLoginAllowed,
  signIn,
  signOut
} from "./auth/msal";
import {
  describeMeError,
  fetchMe,
  podeAdministrar,
  podeAssessorar,
  type MeResponse
} from "./auth/me";
import { parseSessionUser } from "./auth/session";
import { getInitials } from "./lib/user";
import { newId } from "./lib/id";
import {
  auditLogFromApi,
  describeAuditLogsError,
  fetchAuditLogs
} from "./lib/audit-logs";
import Sidebar from "./components/Sidebar";
import { searchMeetings } from "./lib/meeting-search";
import DashboardView from "./components/DashboardView";
import MeetingsView from "./components/MeetingsView";
import MeetingDetailView from "./components/MeetingDetailView";
import AuditLogsView from "./components/AuditLogsView";
import SystemSettingsView from "./components/SystemSettingsView";
import AdministrationView from "./components/AdministrationView";
import QuickSearchView from "./components/QuickSearchView";
import ScheduleMeetingModal from "./components/ScheduleMeetingModal";
import UnlinkedAgendasView from "./components/UnlinkedAgendasView";
import FupListView from "./components/FupListView";
import LoginView from "./components/LoginView";
import { FileCheck, LogOut, Search, Sparkles, Trash2, X } from "lucide-react";

/**
 * Chave da sessão local. Fica em sessionStorage, NÃO em localStorage:
 * assim o logout nunca encosta nos dados da aplicação (chaves `cielo_*`).
 * Recarregar mantém a sessão; fechar a aba encerra.
 */
const SESSION_KEY = "pgcp_session_active";

/** Usuário da sessão. Também em sessionStorage — nunca vai para o banco. */
const SESSION_USER_KEY = "pgcp_session_user";

/**
 * Placeholder de sessão AUSENTE — antes da autenticação e depois do logout.
 *
 * Não é uma pessoa: era "Sarah Jenkins", nome de demonstração que ficava como
 * usuário corrente enquanto ninguém tinha entrado. Nenhuma tela de dado é
 * renderizada neste estado; quem preenche a sessão de verdade é `GET /me`
 * (login Entra) ou o perfil escolhido no Modo de teste.
 */
const DEFAULT_SESSION_USER: SessionUser = {
  name: "",
  role: ""
};

/**
 * Lê o usuário da sessão; sessão corrompida cai no padrão em vez de quebrar.
 *
 * Delega a `parseSessionUser` (pura, testável). RESTAURA `appRoles` — a versão
 * anterior os descartava, e por isso um remount (reload / aba descartada após
 * inatividade) rebaixava Assessoria/Admin a usuário sem papel. Não é autoridade:
 * o backend revalida cada rota.
 */
function readSessionUser(): SessionUser {
  return parseSessionUser(sessionStorage.getItem(SESSION_USER_KEY)) ?? DEFAULT_SESSION_USER;
}

export default function App() {
  /*
    * Idioma: PREFERÊNCIA DE DISPOSITIVO, não dado corporativo. Fica no
    * navegador de propósito — centralizar em tabela obrigaria uma ida ao
    * servidor para decidir em que língua desenhar a primeira tela.
    *
    * Até a 4.12 `cielo_lang` era escrita e nunca lida: a escolha se perdia a
    * cada refresh. Agora a leitura existe.
    */
  const [language, setLanguage] = useState<"en" | "pt">(
    () => (localStorage.getItem("cielo_lang") === "en" ? "en" : "pt")
  );

  // Acesso temporário de desenvolvimento — o SSO Microsoft ainda não existe.
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(
    () => sessionStorage.getItem(SESSION_KEY) === "true"
  );

  const [currentUser, setCurrentUser] = useState<SessionUser>(readSessionUser);
  /** Busca da barra flutuante do topo — a mesma que alimenta a aba "Busca Rápida". */
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  /** Dropdown de resultados só aparece com a busca em foco — evita ficar pairando depois de navegar. */
  const [isGlobalSearchFocused, setIsGlobalSearchFocused] = useState(false);

  /**
   * Modo de autenticação. Avaliado uma vez: depende só de variáveis de build,
   * que não mudam em tempo de execução.
   *
   * Os dois caminhos são mutuamente exclusivos por construção — ver
   * `isMockLoginAllowed`. Assim que o Entra é configurado, o modo de teste
   * desaparece sem depender de ninguém desligar uma flag.
   */
  const [entraEnabled] = useState(isEntraConfigured);
  const [mockAllowed] = useState(isMockLoginAllowed);

  /*
   * Pode agendar?
   *
   * Só governa o que aparece. Toda mutação de reunião é revalidada no servidor
   * pelo App Role `PGCP.Assessoria` — quem chamar a API sem o papel recebe
   * 403, com ou sem botão na tela.
   *
   * Ver a própria agenda e participar de reunião NÃO dependem disto.
   */
  const usuarioPodeAgendar = podeAssessorar(currentUser);
  /*
   * `PGCP.Admin` — administração da PLATAFORMA. Independente de agendar: quem
   * só administra não conduz reunião, e quem só conduz não administra.
   *
   * Vem das roles que `GET /me` devolveu. O servidor revalida cada rota; isto
   * aqui evita oferecer (e abrir) uma área que responderia 403.
   */
  const usuarioPodeAdministrar = podeAdministrar(currentUser);

  /*
   * ADMINISTRAÇÃO tem DUAS portas: a Assessoria mantém os cadastros funcionais
   * (órgãos, tipos, naturezas) e a administração técnica também. Auditoria e
   * Configurações continuam só do Admin — abrir a mesma aba não significa ver
   * o mesmo conteúdo.
   */
  const usuarioPodeAbrirAdministracao = usuarioPodeAdministrar || usuarioPodeAgendar;
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  /** Reunião com exclusão pendente de confirmação. `null` = modal fechado. */
  const [meetingParaExcluir, setMeetingParaExcluir] = useState<Meeting | null>(null);

  /*
   * REUNIÕES: PostgreSQL, via GET /meetings.
   *
   * Não há leitura de `cielo_meetings`; a massa de demonstração que existia em
   * `initialData.ts` foi removida na 4.12, arquivo inclusive.
   * Banco vazio significa lista vazia — repor as reuniões de demonstração faria
   * a tela mentir sobre o que existe.
   *
   * `setMeetings` continua existindo porque telas que ainda não migraram (a
   * edição dentro do MeetingDetailView) mexem no estado em memória. Essas
   * alterações NÃO são persistidas: `PATCH /meetings` é onda posterior.
   */
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(true);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);

  /** Resultados ao vivo da busca do topo — mesma lógica da aba "Busca Rápida". */
  const globalSearchResults = useMemo(
    () => searchMeetings(meetings, globalSearchQuery).slice(0, 6),
    [meetings, globalSearchQuery]
  );

  /*
   * TRILHA CORPORATIVA: só `audit_logs` no PostgreSQL.
   *
   * Até a 4.12a o navegador mantinha uma segunda trilha em `cielo_audit_logs`,
   * alimentada por `addAuditLogEntry` a cada ação da tela. Ela duplicava o que a
   * API já registra dentro da transação de domínio, inventava eventos que nunca
   * chegaram ao servidor (envio de e-mail, notificação no Teams, abertura de
   * menu) e vivia só naquele navegador. Foi removida inteira.
   *
   * A leitura da trilha real depende de `GET /audit-logs`, que existe como
   * serviço testado em `apps/api/src/audit/read.ts` mas NÃO está exposto: falta
   * a fonte de autorização. Ver a tela de Auditoria.
   */

  // Órgãos de governança: única funcionalidade que já vem do PostgreSQL via API.
  // Não usa localStorage — recarregar a página busca de novo no banco.
  const [governanceBodies, setGovernanceBodies] = useState<GovernanceBody[]>([]);
  const [governanceBodiesLoading, setGovernanceBodiesLoading] = useState(true);
  const [governanceBodiesError, setGovernanceBodiesError] = useState<string | null>(null);

  /*
   * TIPO E NATUREZA: cadastros reais em PostgreSQL.
   *
   * Antes eram listas de strings em `localStorage`, onde o NOME servia de
   * identidade. Agora identidade é o `id` do banco e o nome é rótulo — renomear
   * um tipo deixa de quebrar o vínculo das pautas que o usam.
   *
   * Valores que existiam só no navegador de alguém foram conscientemente
   * descartados: não há importador temporário.
   */
  const [pautaTypes, setPautaTypes] = useState<TaxonomyItem[]>([]);
  const [pautaNatures, setPautaNatures] = useState<TaxonomyItem[]>([]);
  const [taxonomyLoading, setTaxonomyLoading] = useState(true);

  /*
   * FUP: `action_items` no PostgreSQL.
   *
   * Sem leitura de `cielo_action_items` e sem fallback para
   * massa local. O estado continua existindo como cache de UI — os
   * contadores do Dashboard e a aba FUP da reunião leem dele — mas quem o
   * alimenta é a API.
   */
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [actionItemsLoading, setActionItemsLoading] = useState(true);
  /** FUPs do usuário autenticado. Filtrados pelo servidor, por identidade. */
  const [myActionItems, setMyActionItems] = useState<ActionItem[]>([]);
  const [actionItemsError, setActionItemsError] = useState<string | null>(null);

  /*
   * REMOVIDO: `systemSettings` / `cielo_system_settings`.
   *
   * Era write-only. `tenantId`, `clientId` e `status` eram lidos do
   * localStorage, reescritos a cada mudança e nunca chegavam a componente
   * algum — o único setter, `handleSaveSystemSettings`, também não era passado
   * para lugar nenhum. A configuração real do Entra vive em `apps/api/.env` e o
   * status verdadeiro das integrações vem do painel PGCP Conectado, que
   * consulta a API. Também sai daqui o `lastSyncTime` fixo em "01/06/2026",
   * que exibia uma sincronização que nunca aconteceu.
   */

  /*
   * BIBLIOTECA DE PAUTAS: `agenda_topics` no PostgreSQL.
   *
   * Sem leitura de `cielo_standalone_agendas` e sem fallback para
   * massa local. Banco vazio significa Biblioteca vazia — repor dados de
   * demonstração faria a tela mentir sobre o que existe.
   */
  const [standaloneAgendas, setStandaloneAgendas] = useState<StandaloneAgenda[]>([]);
  const [agendaTopicsLoading, setAgendaTopicsLoading] = useState(true);
  const [agendaTopicsError, setAgendaTopicsError] = useState<string | null>(null);

  // Custom visual banner toast notification
  const [toastMessage, setToastMessage] = useState<string | null>(null);


  // Synchronize state with LocalStorage on state modifications
  useEffect(() => {
    localStorage.setItem("cielo_lang", language);
  }, [language]);


  // --- Biblioteca de pautas: leitura real contra a API ------------------------
  const loadAgendaTopics = async () => {
    setAgendaTopicsLoading(true);
    setAgendaTopicsError(null);
    try {
      const lista = await listAgendaTopics();
      setStandaloneAgendas(lista.map(agendaTopicToStandalone));
    } catch (error) {
      setAgendaTopicsError(describeTopicError(error, language));
    } finally {
      setAgendaTopicsLoading(false);
    }
  };

  const loadTaxonomy = async () => {
    setTaxonomyLoading(true);
    try {
      const [tipos, naturezas] = await Promise.all([
        listAgendaTopicTypes(),
        listAgendaTopicNatures()
      ]);
      setPautaTypes(tipos);
      setPautaNatures(naturezas);
    } catch (error) {
      triggerToast(describeTopicError(error, language));
    } finally {
      setTaxonomyLoading(false);
    }
  };

  /**
   * Cadastros de tipo/natureza contra a API.
   *
   * Nada muda na tela antes do banco confirmar: excluir um cadastro em uso
   * devolve 409, e remover localmente fingiria um sucesso que não houve.
   */
  const handleCreateTaxonomy = async (kind: TaxonomyKind, name: string) => {
    try {
      await createTaxonomyItem(kind, name);
      await loadTaxonomy();
      triggerToast(`Cadastro "${name}" criado.`);
    } catch (error) {
      triggerToast(describeTopicError(error, language));
    }
  };

  const handleRenameTaxonomy = async (kind: TaxonomyKind, id: string, name: string) => {
    try {
      await renameTaxonomyItem(kind, id, name);
      await loadTaxonomy();
      triggerToast(`Cadastro renomeado para "${name}".`);
    } catch (error) {
      triggerToast(describeTopicError(error, language));
    }
  };

  const handleDeleteTaxonomy = async (kind: TaxonomyKind, id: string) => {
    try {
      await deleteTaxonomyItem(kind, id);
      await loadTaxonomy();
      // A Biblioteca mostra tipo/natureza: recarrega para não exibir um
      // cadastro que deixou de existir.
      await loadAgendaTopics();
      triggerToast("Cadastro removido.");
    } catch (error) {
      triggerToast(describeTopicError(error, language));
    }
  };

  // --- FUP: leitura real contra a API -----------------------------------------
  /*
   * MINHAS PENDÊNCIAS vêm de uma consulta PRÓPRIA, com `assignedToMe=true`.
   *
   * Não se filtra a lista geral no navegador: quem decide o que é "meu" é o
   * servidor, comparando IDENTIDADE (`assigned_user_id` ou o par tenant+oid do
   * token) — nunca nome, e-mail ou rótulo. `status=open` porque a área existe
   * para o que ainda exige ação.
   */
  const loadActionItems = async () => {
    setActionItemsLoading(true);
    setActionItemsError(null);
    try {
      const [lista, minhas] = await Promise.all([
        listActionItems(),
        // TODOS os meus, não só os abertos: a mesma consulta responde "isto é
        // meu?" para habilitar a ação de concluir e reabrir.
        listActionItems({ assignedToMe: true })
      ]);
      setActionItems(lista.map(actionItemFromApi));
      setMyActionItems(minhas.map(actionItemFromApi));
    } catch (error) {
      setActionItemsError(describeActionItemError(error, language));
    } finally {
      setActionItemsLoading(false);
    }
  };

  const handleCreateActionItem = async (input: FupFormInput) => {
    try {
      const criado = await apiCreateActionItem(buildActionItemPayload(input));
      await loadActionItems();
      triggerToast(`Ação "${criado.title}" registrada.`);
    } catch (error) {
      triggerToast(describeActionItemError(error, language));
    }
  };

  /**
   * Concluir / reabrir. Nada muda na tela antes do banco confirmar: marcar
   * localmente e falhar depois deixaria a ação "concluída" só aqui.
   */
  const handleSetActionItemStatus = async (id: string, concluir: boolean) => {
    try {
      const atualizado = concluir ? await completeActionItem(id) : await reopenActionItem(id);
      await loadActionItems();
      triggerToast(concluir ? "Ação concluída." : "Ação reaberta.");
    } catch (error) {
      triggerToast(describeActionItemError(error, language));
    }
  };

  /**
   * PATCH parcial de um FUP existente — VP responsável, comentários, prazo
   * etc. Mesmo padrão das demais mutações: só reflete na tela depois do banco
   * confirmar.
   */
  const handleUpdateActionItem = async (id: string, payload: ActionItemPayload) => {
    try {
      await apiUpdateActionItem(id, payload);
      await loadActionItems();
      triggerToast("FUP atualizado.");
    } catch (error) {
      triggerToast(describeActionItemError(error, language));
    }
  };

  // --- Reuniões: leitura real contra a API ------------------------------------
  const loadMeetings = async () => {
    setMeetingsLoading(true);
    setMeetingsError(null);
    try {
      const lista = await listMeetings();
      setMeetings(lista.map(meetingFromApi));
    } catch (error) {
      setMeetingsError(describeMeetingError(error, language));
    } finally {
      setMeetingsLoading(false);
    }
  };

  /**
   * Abre a reunião buscando o DETALHE na API — participantes e pautas só vêm
   * por ali. Não procura antes em `cielo_meetings`: a fonte é o banco.
   */
  const openMeeting = async (meet: Meeting) => {
    setSelectedMeeting(meet);
    try {
      setSelectedMeeting(meetingFromApi(await getMeeting(meet.id)));
    } catch (error) {
      triggerToast(describeMeetingError(error, language));
      setSelectedMeeting(null);
    }
  };

  // --- Órgãos de governança: CRUD real contra a API ---------------------------
  const loadGovernanceBodies = async () => {
    setGovernanceBodiesLoading(true);
    setGovernanceBodiesError(null);
    try {
      setGovernanceBodies(await apiRequest<GovernanceBody[]>("/governance-bodies", { auth: true }));
    } catch (error) {
      setGovernanceBodiesError(
        error instanceof Error ? error.message : "Erro ao carregar os órgãos de governança."
      );
    } finally {
      setGovernanceBodiesLoading(false);
    }
  };

  /*
   * Toda carga espera a sessão. `/governance-bodies` passou a exigir token na
   * 4.12b — antes era público e carregava de imediato; buscar agora antes do
   * login devolveria 401 e sujaria a tela de erro.
   */
  useEffect(() => {
    if (!isAuthenticated) return;
    void loadGovernanceBodies();
    void loadMeetings();
    void loadAgendaTopics();
    void loadTaxonomy();
    void loadActionItems();
  }, [isAuthenticated]);

  const handleCreateGovernanceBody = async (
    name: string,
    chair: GovernanceBodyChairInput | null
  ) => {
    const created = await apiRequest<GovernanceBody>("/governance-bodies", {
      auth: true,
      method: "POST",
      body: JSON.stringify({ name, chair })
    });
    setGovernanceBodies((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
    triggerToast(`Órgão "${created.name}" cadastrado com sucesso.`);
  };

  const handleUpdateGovernanceBody = async (
    id: string,
    name: string,
    chair: GovernanceBodyChairInput | null
  ) => {
    const updated = await apiRequest<GovernanceBody>(`/governance-bodies/${id}`, {
      auth: true,
      method: "PUT",
      body: JSON.stringify({ name, chair })
    });
    setGovernanceBodies((prev) =>
      prev.map((b) => (b.id === id ? updated : b)).sort((a, b) => a.name.localeCompare(b.name))
    );
    triggerToast(`Órgão atualizado para "${updated.name}".`);
  };

  // Desativação lógica: o registro permanece no banco e nenhum vínculo
  // histórico (reuniões, pautas, ações) é afetado.
  const handleSetGovernanceBodyActive = async (id: string, isActive: boolean) => {
    const target = governanceBodies.find((b) => b.id === id);
    if (!target) return;

    const updated = await apiRequest<GovernanceBody>(`/governance-bodies/${id}`, {
      auth: true,
      method: "PUT",
      body: JSON.stringify({ name: target.name, isActive })
    });
    setGovernanceBodies((prev) => prev.map((b) => (b.id === id ? updated : b)));

    triggerToast(
      isActive
        ? `Órgão "${updated.name}" reativado e disponível para novos usos.`
        : `Órgão "${updated.name}" desativado. O histórico foi preservado.`
    );
  };

  // Toast trigger helper
  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 4500);
  };

  // Handler: Save Scheduled Meeting Form data
  /**
   * Chamado DEPOIS que o modal recebeu 201 de POST /meetings.
   *
   * Não fabrica reunião local: recarrega a lista do banco. O `id` que chega é
   * o UUID gerado pelo PostgreSQL — nada de `meet-<random>`.
   */
  const handleMeetingCreated = (meetId: string, title: string) => {
    setIsScheduleModalOpen(false);
    void loadMeetings();

    triggerToast(`Sucesso: Sessão corporativa "${title}" registrada e auditada.`);
  };

  // Handler: Complete An Overdue Task Action
  /*
   * O que posso ALTERAR num FUP — cortesia com quem não pode, não controle.
   *
   * A autoridade é o servidor: `PATCH /action-items/:id` recusa quem não é o
   * responsável nem tem `PGCP.Assessoria`. Aqui só se evita oferecer um botão
   * que responderia 403.
   *
   * "É meu" vem da lista que o SERVIDOR filtrou por identidade — nunca de
   * comparar nome ou e-mail no navegador.
   */
  const meusFupIds = useMemo(
    () => new Set(myActionItems.map((item) => item.id)),
    [myActionItems]
  );

  const podeGerenciarFup = (item: ActionItem): boolean =>
    meusFupIds.has(item.id) || usuarioPodeAgendar;

  /*
   * TRILHA CORPORATIVA — leitura real, paginada por cursor.
   *
   * Até a 5.4i a tela mostrava um aviso de indisponibilidade porque
   * `GET /audit-logs` não existia. Agora existe, restrito a `PGCP.Admin`.
   *
   * A lista NÃO é recarregada do zero a cada página: `Carregar mais` acumula,
   * usando o `nextCursor` que o servidor devolveu. Cursor nulo = acabou.
   */
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const loadAuditLogs = async (proximaPagina = false) => {
    if (proximaPagina && !auditCursor) return;

    if (proximaPagina) setAuditLoadingMore(true);
    else setAuditLoading(true);
    setAuditError(null);

    try {
      const pagina = await fetchAuditLogs(
        proximaPagina ? { cursor: auditCursor ?? undefined } : {}
      );
      const convertidos = pagina.items.map(auditLogFromApi);

      setAuditLogs((anteriores) => (proximaPagina ? [...anteriores, ...convertidos] : convertidos));
      setAuditCursor(pagina.nextCursor);
    } catch (error) {
      setAuditError(describeAuditLogsError(error, language));
    } finally {
      setAuditLoading(false);
      setAuditLoadingMore(false);
    }
  };

  /*
   * Carrega ao abrir a aba, e só para quem pode: sem `PGCP.Admin` o servidor
   * responderia 403, e a tela nem é montada.
   */
  useEffect(() => {
    if (activeTab !== "audit-logs" || !usuarioPodeAdministrar) return;
    void loadAuditLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, usuarioPodeAdministrar]);

  const handleCompleteActionTask = (id: string) => {
    void handleSetActionItemStatus(id, true);
  };

  // Handler: Dynamic progress stepper click changes state
  /**
   * Transição formal da reunião, persistida em `meetings.status`.
   *
   * Só as transições que o produto realmente executa: Scheduled -> In Progress
   * -> Done. Os legados (Draft, Needs Approval, Approved, Closed) continuam no
   * tipo e no CHECK por compatibilidade, mas não voltam pelo fluxo novo — o
   * Stepper visual segue derivado e nunca é gravado.
   */
  const STATUS_PERSISTIVEL: Partial<Record<Meeting["status"], "scheduled" | "in_progress" | "done">> = {
    Scheduled: "scheduled",
    "In Progress": "in_progress",
    Done: "done"
  };

  const handleUpdateMeetingStatus = async (meetId: string, newStatus: Meeting["status"]) => {
    const statusApi = STATUS_PERSISTIVEL[newStatus];
    if (!statusApi) {
      triggerToast(`Transição para "${newStatus}" não é suportada neste fluxo.`);
      return;
    }

    try {
      const atualizada = meetingFromApi(await updateMeeting(meetId, { status: statusApi }));
      setMeetings((prev) => prev.map((m) => (m.id === meetId ? atualizada : m)));
      setSelectedMeeting((prev) => (prev && prev.id === meetId ? atualizada : prev));

      triggerToast(`Status da assembleia alterado para "${newStatus}" com auditoria ativa.`);
    } catch (error) {
      // Falha não muda a tela: o status exibido continua sendo o do banco.
      triggerToast(describeMeetingError(error, language));
    }
  };

  /*
   * EXCLUSÃO DE REUNIÃO.
   *
   * `PGCP.Assessoria` é a regra de autorização que faltava — o backend
   * revalida, o botão na tela é só cortesia (mesmo padrão de toda mutação de
   * reunião). O clique abre a confirmação; `confirmarExclusaoReuniao` é o
   * ato de verdade, contra `DELETE /meetings/:id`.
   *
   * NÃO apaga a Biblioteca nem os FUPs: o servidor só deleta o que existe
   * exclusivamente por causa desta reunião (participantes, pautas vinculadas,
   * Anotações, Ata). Temas da Biblioteca e FUPs sobrevivem, só perdendo o
   * vínculo de origem — mesmo princípio do "Postergar".
   */
  const handleDeleteMeeting = (id: string) => {
    const alvo = meetings.find((m) => m.id === id);
    if (alvo) setMeetingParaExcluir(alvo);
  };

  const confirmarExclusaoReuniao = async () => {
    const alvo = meetingParaExcluir;
    if (!alvo) return;

    try {
      await apiDeleteMeeting(alvo.id);
      if (selectedMeeting?.id === alvo.id) setSelectedMeeting(null);
      await loadMeetings();
      triggerToast(language === "en" ? "Meeting deleted." : "Reunião excluída.");
    } catch (error) {
      triggerToast(describeMeetingError(error, language));
    } finally {
      setMeetingParaExcluir(null);
    }
  };


  /*
   * REMOVIDO: cadastro de "categorias" (`initialCategories`, `cielo_categories`,
   * `handleRegisterCategory`, `handleDeleteCategory`, `handleToggleCategoryStatus`).
   *
   * Nenhum dos três handlers era passado para componente algum: a aba de
   * categorias saiu da Administração e o estado sobrevivia só para alimentar a
   * busca rápida com nomes de demonstração. Não representava órgão de
   * governança (`governance_bodies`), nem tipo, nem natureza de pauta — os três
   * conceitos reais, que já vivem no PostgreSQL. Ficou também o ID inventado
   * `cat-NNNNN`, que nunca chegou a banco nenhum.
   *
   * REMOVIDO junto: `handleSaveSystemSettings`, único setter de um estado que
   * ninguém lia.
   */

  // Handler: Register manual standalone unlinked agenda
  /**
   * Cria a pauta no PostgreSQL e recarrega a lista.
   *
   * Nada é inserido localmente: o `id` que passa a valer é o UUID gerado pelo
   * banco, e a resposta canônica vem do refetch.
   */
  const handleRegisterStandaloneAgenda = async (
    input: BibliotecaFormInput,
  ): Promise<StandaloneAgenda | null> => {
    try {
      const criada = await createAgendaTopic(buildTopicPayload(input));
      await loadAgendaTopics();
      triggerToast(`Pauta "${criada.title}" registrada na Biblioteca.`);
      // Devolve o tema criado: o drawer da reunião usa o `id` para VINCULAR o
      // item ao mestre (procedência + snapshot), em vez de criar item solto.
      return agendaTopicToStandalone(criada);
    } catch (error) {
      triggerToast(describeTopicError(error, language));
      return null;
    }
  };

  const handleUpdateStandaloneAgenda = async (id: string, input: BibliotecaFormInput) => {
    try {
      const atualizada = await updateAgendaTopic(id, buildTopicPayload(input));
      await loadAgendaTopics();
      triggerToast(`Pauta "${atualizada.title}" atualizada.`);
    } catch (error) {
      triggerToast(describeTopicError(error, language));
    }
  };

  /**
   * Exclusão REAL. Pauta vinculada a reunião devolve 409 e a tela não remove
   * nada — mostrar sucesso otimista aqui esconderia que o vínculo impediu.
   */
  const handleDeleteStandaloneAgenda = async (id: string) => {
    const alvo = standaloneAgendas.find((a) => a.id === id);
    try {
      await apiDeleteAgendaTopic(id);
      await loadAgendaTopics();
      triggerToast("Pauta removida da Biblioteca.");
    } catch (error) {
      triggerToast(describeTopicError(error, language));
    }
  };

  const startSession = (user: SessionUser) => {
    sessionStorage.setItem(SESSION_KEY, "true");
    sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    setCurrentUser(user);
    setIsAuthenticated(true);
  };

  /**
   * Entrada pelo botão Microsoft.
   *
   * Com o Entra configurado: login real, aquisição do access token da API do
   * PGCP e confirmação da identidade em `GET /me`. Só abre a sessão depois que a
   * API aceitou o token E resolveu o usuário em `users` — autenticar no Entra
   * sem estar cadastrado no PGCP não é acesso.
   *
   * Divisão de papéis:
   *   Entra ID   → autentica a pessoa
   *   PostgreSQL → define o usuário do PGCP (nome, e-mail, cargo)
   *
   * `role` recebe `jobTitle` apenas como RÓTULO de exibição. Não é perfil
   * funcional: identidade corporativa e autorização no PGCP são conceitos
   * distintos, e o RBAC virá depois, do banco.
   */
  const handleSignIn = async () => {
    if (!entraEnabled) {
      setAuthError("Autenticação Microsoft não está configurada nesta instalação.");
      return;
    }

    setIsSigningIn(true);
    setAuthError(null);

    try {
      await signIn();
      openSessionFromMe(await fetchMe());
    } catch (error) {
      // Falha da API distingue 401/403/422/503; do MSAL, o cancelamento.
      setAuthError(
        error instanceof ApiError ? describeMeError(error) : describeAuthError(error).message
      );
    } finally {
      setIsSigningIn(false);
    }
  };

  /**
   * Abre a sessão a partir do usuário resolvido em `users`.
   *
   * Atributos funcionais vêm do PostgreSQL, não dos claims: o Entra provou QUEM
   * é a pessoa; o PGCP é quem define o usuário dela aqui dentro.
   */
  const openSessionFromMe = (me: MeResponse) => {
    startSession({
      name: me.name,
      role: me.jobTitle ?? "Conta corporativa",
      // Papéis vêm do token, resolvidos pelo servidor. A tela só os lê.
      appRoles: me.appRoles ?? []
    });
  };

  /** Entrada pelo Modo de teste: assume o perfil escolhido nesta sessão. */
  const handleTestSignIn = (profile: TestProfile) =>
    startSession({ name: profile.name, role: profile.role });

  // Encerra apenas a sessão. NÃO usa localStorage.clear(): os dados da
  // aplicação (chaves `cielo_*`) precisam sobreviver ao logout.
  const handleSignout = async () => {
    const confirmation = window.confirm(
      "Deseja realmente sair do PGCP?"
    );
    if (!confirmation) return;

    // Sessão local primeiro: se o encerramento no Entra falhar, o usuário não
    // fica preso numa sessão do PGCP que ele pediu para fechar.
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_USER_KEY);
    setCurrentUser(DEFAULT_SESSION_USER);
    setIsAuthenticated(false);
    setSelectedMeeting(null);
    setActiveTab("dashboard");
    setAuthError(null);

    if (entraEnabled) {
      try {
        // O MSAL limpa o próprio cache de token. Nada nosso guarda token.
        await signOut();
      } catch (error) {
        console.warn("[auth] falha ao encerrar a sessão no Entra:", error);
      }
    }
  };

  // Helper mapping to render selected views
  const renderTabContent = () => {
    if (selectedMeeting) {
      return (
        <MeetingDetailView
          language={language}
          meeting={selectedMeeting}
          onBack={() => {
            setSelectedMeeting(null);
          }}
          onUpdateStatus={(meetId, newStatus) => {
            // Sem atualização otimista: `handleUpdateMeetingStatus` já troca
            // `selectedMeeting` pela resposta do banco. Trocar aqui antes mostraria
            // a reunião iniciada mesmo quando a API recusa (ex.: pautas não aprovadas).
            void handleUpdateMeetingStatus(meetId, newStatus);
          }}
          actionItems={actionItems}
          setActionItems={setActionItems}
          onCreateActionItem={handleCreateActionItem}
          onSetActionItemStatus={handleSetActionItemStatus}
          standaloneAgendas={standaloneAgendas}
          setStandaloneAgendas={setStandaloneAgendas}
          onReloadAgendaTopics={() => void loadAgendaTopics()}
          meetings={meetings}
          setMeetings={setMeetings}
          setSelectedMeeting={setSelectedMeeting}
          triggerToast={triggerToast}
          currentUser={currentUser}
          canSchedule={usuarioPodeAgendar}
          podeGerenciarFup={podeGerenciarFup}
          pautaTypes={pautaTypes}
          pautaNatures={pautaNatures}
          governanceBodies={governanceBodies}
        />
      );
    }

    /*
     * ÁREAS ADMINISTRATIVAS — não basta esconder no menu.
     *
     * O `activeTab` pode chegar aqui por estado antigo, atalho ou role revogada
     * entre um login e outro. A view administrativa simplesmente não é montada
     * sem `PGCP.Admin`; e, mesmo que fosse, cada rota do servidor recusaria.
     */
    const areaRestrita =
      (activeTab === "administration" && !usuarioPodeAbrirAdministracao) ||
      ((activeTab === "audit-logs" || activeTab === "settings") && !usuarioPodeAdministrar);

    if (areaRestrita) {
      return (
        <div className="p-10 text-center space-y-2">
          <p className="text-sm font-extrabold text-slate-700">
            {language === "en" ? "Restricted area" : "Área restrita"}
          </p>
          <p className="text-xs text-slate-400 font-semibold leading-relaxed max-w-md mx-auto">
            {language === "en"
              ? "Platform administration is available to PGCP administrators. Talk to the Governance Secretariat if you need access."
              : "A administração da plataforma é restrita aos administradores do PGCP. Fale com a Secretaria de Governança se precisar de acesso."}
          </p>
        </div>
      );
    }

    switch (activeTab) {
      case "dashboard":
        return (
          <DashboardView
            language={language}
            meetings={meetings}
            actionItems={actionItems}
            setActionItems={setActionItems}
            myActionItems={myActionItems}
            podeGerenciarFup={podeGerenciarFup}
            governanceBodies={governanceBodies}
            onScheduleClick={() => setIsScheduleModalOpen(true)}
            canSchedule={usuarioPodeAgendar}
            onMeetingClick={(meet) => void openMeeting(meet)}
            onViewAllMeetings={() => setActiveTab("meetings")}
            onViewAllActionItems={() => setActiveTab("fup")}
            onCompleteAction={handleCompleteActionTask}
            triggerToast={triggerToast}
          />
        );
      case "meetings":
        return (
          <MeetingsView
            language={language}
            meetings={meetings}
            meetingsLoading={meetingsLoading}
            meetingsError={meetingsError}
            onReloadMeetings={() => void loadMeetings()}
            onMeetingClick={(meet) => void openMeeting(meet)}
            onScheduleClick={() => setIsScheduleModalOpen(true)}
            canSchedule={usuarioPodeAgendar}
            onDeleteMeeting={handleDeleteMeeting}
          />
        );
      case "search":
        return (
          <QuickSearchView
            language={language}
            meetings={meetings}
            onNavigateToMeeting={(meet) => {
              setSelectedMeeting(meet);
              setActiveTab("meetings");
            }}
            onNavigateToTab={(tab) => setActiveTab(tab)}
            query={globalSearchQuery}
            onQueryChange={setGlobalSearchQuery}
          />
        );
      case "audit-logs":
        return (
          <AuditLogsView
            language={language}
            logs={auditLogs}
            loading={auditLoading}
            error={auditError}
            hasMore={auditCursor !== null}
            loadingMore={auditLoadingMore}
            onLoadMore={() => void loadAuditLogs(true)}
          />
        );
      case "administration":
        return (
          <AdministrationView
            language={language}
            governanceBodies={governanceBodies}
            governanceBodiesLoading={governanceBodiesLoading}
            governanceBodiesError={governanceBodiesError}
            onReloadGovernanceBodies={loadGovernanceBodies}
            onCreateGovernanceBody={handleCreateGovernanceBody}
            onUpdateGovernanceBody={handleUpdateGovernanceBody}
            onSetGovernanceBodyActive={handleSetGovernanceBodyActive}
            pautaTypes={pautaTypes}
            pautaNatures={pautaNatures}
            onCreateTaxonomy={handleCreateTaxonomy}
            onRenameTaxonomy={handleRenameTaxonomy}
            onDeleteTaxonomy={handleDeleteTaxonomy}
          />
        );
      case "unlinked-agendas":
        return (
          <UnlinkedAgendasView
            language={language}
            standaloneAgendas={standaloneAgendas}
            agendaTopicsLoading={agendaTopicsLoading}
            agendaTopicsError={agendaTopicsError}
            onReloadAgendaTopics={() => void loadAgendaTopics()}
            onAddStandaloneAgenda={handleRegisterStandaloneAgenda}
            onDeleteStandaloneAgenda={handleDeleteStandaloneAgenda}
            onUpdateStandaloneAgenda={handleUpdateStandaloneAgenda}
            pautaTypes={pautaTypes}
            pautaNatures={pautaNatures}
          />
        );
      case "fup":
        return (
          <FupListView
            language={language}
            actionItems={actionItems}
            setActionItems={setActionItems}
            onCreateActionItem={handleCreateActionItem}
            onSetActionItemStatus={handleSetActionItemStatus}
            onUpdateActionItem={handleUpdateActionItem}
            podeGerenciarFup={podeGerenciarFup}
            actionItemsLoading={actionItemsLoading}
            actionItemsError={actionItemsError}
            organs={governanceBodies.filter((b) => b.isActive).map((b) => b.name)}
            triggerToast={triggerToast}
          />
        );
      case "settings":
        return (
          <SystemSettingsView language={language} />
        );
      default:
        return (
          <div className="p-8 text-center text-slate-400">
            View placeholder.
          </div>
        );
    }
  };

  /**
   * Resolve o cargo exibido no Modo de teste: primeiro o papel registrado como
   * participante de reunião, depois o cargo do próprio cadastro.
   *
   * Nenhum cargo novo é inventado — só reaproveita o que já está nos dados.
   */
  const resolveRole = (user: { name: string; jobTitle?: string }): string => {
    const fromParticipants = meetings
      .flatMap((m) => m.participants || [])
      .find((p) => p.name === user.name)?.role;
    if (fromParticipants) return fromParticipants;

    return user.jobTitle || "Sem cargo definido";
  };

  const testProfiles: TestProfile[] = mockTestPeople.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: resolveRole(user)
  }));

  // Portão de acesso. Fica depois de todos os hooks para não violar as regras
  // de hooks do React — a ordem de chamada permanece constante entre renders.
  if (!isAuthenticated) {
    return (
      <LoginView
        language={language}
        onSignIn={() => void handleSignIn()}
        testProfiles={mockAllowed ? testProfiles : []}
        onTestSignIn={handleTestSignIn}
        entraEnabled={entraEnabled}
        mockAllowed={mockAllowed}
        isSigningIn={isSigningIn}
        authError={authError}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#eaedf1] text-[#191c1e] flex font-sans antialiased selection:bg-[#c6e7ff]/60 selection:text-slate-900">
      
      {/* Toast banner notifier */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed top-5 left-1/2 -translate-x-1/2 z-50 p-4 bg-slate-900/95 backdrop-blur-md text-white rounded-xl shadow-2xl flex items-center gap-3.5 border border-white/10 max-w-md w-[90vw] select-none text-xs"
          >
            <div className="w-7 h-7 rounded-full bg-[#00aeef]/20 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[15px] text-[#00aeef]">verified</span>
            </div>
            <p className="font-semibold flex-1 leading-snug">{toastMessage}</p>
            <button
              onClick={() => setToastMessage(null)}
              className="text-slate-400 hover:text-white transition p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Sidebar Drawer component */}
      <Sidebar
        // No detalhe de uma reunião, "Reuniões" segue destacado. Derivado em
        // vez de gravado no estado: assim o botão Voltar continua devolvendo
        // à tela de origem (Dashboard, Reuniões ou Busca).
        activeTab={selectedMeeting ? "meetings" : activeTab}
        setActiveTab={(tab) => {
          setSelectedMeeting(null);
          setActiveTab(tab);
        }}
        language={language}
        setLanguage={setLanguage}
        canAdminister={usuarioPodeAdministrar}
        canOpenAdministration={usuarioPodeAbrirAdministracao}
      />

      {/* Main Content Layout Pane wrapper.
          `min-w-0`: sem isto o <main> é um flex item com min-width:auto e NÃO
          encolhe abaixo da largura de conteúdo — uma tabela larga (min-w-[800px])
          empurrava a página inteira em telas estreitas. Com min-w-0 o main respeita
          a largura disponível e os contêineres overflow-x-auto passam a rolar
          internamente em vez de estourar o viewport. */}
      <main className="flex-1 md:pl-[280px] min-w-0 min-h-screen flex flex-col pt-16 md:pt-0">
        {/* Barra superior desktop: logo + busca global à esquerda, perfil e
            sair à direita — nenhum dos dois com faixa/fundo atrás, cada um
            seu próprio elemento flutuante. Só desktop: no mobile o topo já
            é ocupado pela barra com o menu de gaveta. */}
        <div className="hidden md:flex items-center justify-between gap-4 px-8 pt-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1 max-w-md">
            <form
              className="relative flex-1 min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                if (globalSearchQuery.trim()) setActiveTab("search");
                setIsGlobalSearchFocused(false);
              }}
            >
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-3.5 h-3.5 pointer-events-none" />
              <input
                type="text"
                value={globalSearchQuery}
                onChange={(e) => setGlobalSearchQuery(e.target.value)}
                onFocus={() => setIsGlobalSearchFocused(true)}
                onBlur={() => setIsGlobalSearchFocused(false)}
                placeholder={language === "en" ? "Search meetings..." : "Buscar reuniões..."}
                className="w-full pl-9 pr-3 py-2 rounded-full border border-slate-200 bg-white shadow-xs text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] transition"
              />

              {/* Resultados ao vivo, digitando — sem precisar dar Enter. Some
                  ao perder o foco; `onMouseDown` com preventDefault em cada
                  item evita que o blur do input feche a lista ANTES do
                  clique registrar. */}
              {isGlobalSearchFocused && globalSearchQuery.trim() !== "" && (
                <div className="absolute left-0 right-0 top-full mt-2 bg-white border border-slate-200 rounded-2xl shadow-md overflow-hidden z-50">
                  {globalSearchResults.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-slate-400 font-semibold">
                      {language === "en" ? "No meetings found." : "Nenhuma reunião encontrada."}
                    </p>
                  ) : (
                    <>
                      {globalSearchResults.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setSelectedMeeting(m);
                            setActiveTab("meetings");
                            setGlobalSearchQuery("");
                            setIsGlobalSearchFocused(false);
                          }}
                          className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition cursor-pointer border-b border-slate-100 last:border-b-0"
                        >
                          <p className="text-xs font-bold text-slate-800 truncate">{m.title}</p>
                          <p className="text-[10px] text-slate-400 font-semibold truncate">
                            {m.date} • {m.startTime}
                          </p>
                        </button>
                      ))}
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setActiveTab("search");
                          setIsGlobalSearchFocused(false);
                        }}
                        className="w-full text-left px-4 py-2 text-[10.5px] font-bold text-[#00658d] hover:bg-slate-50 transition cursor-pointer"
                      >
                        {language === "en" ? "See all results" : "Ver todos os resultados"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </form>
          </div>

          <div className="flex items-center gap-2 pl-2 pr-1.5 py-1.5 rounded-full border border-slate-200 bg-white shadow-xs shrink-0">
            <div className="w-7 h-7 rounded-full bg-[#94a4bd] text-[#0b1c30] flex items-center justify-center font-semibold text-[10px] shrink-0 select-none">
              {getInitials(currentUser.name)}
            </div>
            <span className="text-xs font-semibold text-slate-700 max-w-[160px] truncate">
              {currentUser.name}
            </span>
            <button
              onClick={handleSignout}
              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-full transition cursor-pointer"
              title={language === "en" ? "Sign Out" : "Sair do Sistema"}
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="p-6 md:p-10 w-full min-w-0 flex-1 pb-16">
          {renderTabContent()}
        </div>
      </main>

      {/* Slide Modal popup scheduler for compiling new meetings dynamically */}
      {isScheduleModalOpen && (
        <ScheduleMeetingModal
          language={language}
          standaloneAgendas={standaloneAgendas}
          onClose={() => setIsScheduleModalOpen(false)}
          governanceBodies={governanceBodies.filter((b) => b.isActive)}
          onCreated={handleMeetingCreated}
          onAddStandaloneAgenda={handleRegisterStandaloneAgenda}
          pautaTypes={pautaTypes}
          pautaNatures={pautaNatures}
        />
      )}

      {/* MODAL: confirmação de exclusão de reunião — identifica pelo título e
          deixa claro que a Biblioteca não é afetada (mesmo padrão visual do
          modal de excluir pauta em MeetingDetailView). */}
      {meetingParaExcluir && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setMeetingParaExcluir(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-sm w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                  <Trash2 className="w-5 h-5 text-red-600" />
                </div>
                <h3 className="text-sm font-extrabold text-slate-900">
                  {language === "pt" ? "Excluir reunião" : "Delete meeting"}
                </h3>
              </div>
              <p className="text-xs text-slate-600 font-medium leading-relaxed">
                {language === "pt" ? "Excluir a reunião " : "Delete the meeting "}
                <span className="font-extrabold text-slate-900">&ldquo;{meetingParaExcluir.title}&rdquo;</span>
                {language === "pt"
                  ? "? Isso apaga participantes, anotações, Ata e o vínculo com as pautas. Esta ação não pode ser desfeita."
                  : "? This deletes participants, Notes, Minutes and the link to its agenda items. This action cannot be undone."}
              </p>
              <p className="text-xs text-slate-400 font-medium leading-relaxed mt-2">
                {language === "pt"
                  ? "As pautas continuam disponíveis na Biblioteca."
                  : "Agenda topics remain available in the Library."}
              </p>
            </div>
            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setMeetingParaExcluir(null)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer"
              >
                {language === "pt" ? "Cancelar" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => void confirmarExclusaoReuniao()}
                className="px-4 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer inline-flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {language === "pt" ? "Excluir" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
