import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BellRing,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  Eye,
  FileCheck,
  FileText,
  GripVertical,
  Info,
  Landmark,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  PlusCircle,
  RotateCcw,
  Send,
  Trash2,
  User,
  Users,
  Video,
  X,
  CalendarDays,
  MapPin,
  FolderPlus,
  FolderOpen,
  Paperclip
} from "lucide-react";
import { Meeting, ActionItem, StandaloneAgenda, Participant, AgendaItem, SessionUser, GovernanceBody } from "../types";
import { newId } from "../lib/id";
import { ehEmailValido, pautasSobResponsabilidade } from "../lib/participants";
import {
  CalendarPreconditionError,
  calendarVisualState,
  describeCalendarError,
  describeCalendarStatus,
  permiteTentarNovamente,
  syncMeetingCalendar,
  type ParticipanteSemEndereco
} from "../lib/calendar-sync";
import {
  approveAgenda,
  describeValidationError,
  sendAgendaForValidation
} from "../lib/agenda-validation";
import type { FupFormInput } from "../lib/action-items";
import {
  MinutesConflictError,
  buildMinutesTemplate,
  describeMinutesError,
  downloadMeetingMinutesPdf,
  getMeetingMinutes,
  minutesStatusLabel,
  saveMeetingMinutes,
  type MeetingMinutes
} from "../lib/meeting-minutes";
import {
  postponeAgendaItem as apiPostponeAgendaItem,
  resumeAgendaItem as apiResumeAgendaItem
} from "../lib/meetings";
import {
  addAgendaItem as apiAddAgendaItem,
  addAgendaItemParticipant as apiAddAgendaItemParticipant,
  addParticipant as apiAddParticipant,
  callAgendaItemParticipants,
  describeMeetingError,
  localToInstant,
  getMeeting,
  meetingFromApi,
  removeAgendaItem as apiRemoveAgendaItem,
  removeAgendaItemParticipant as apiRemoveAgendaItemParticipant,
  reorderAgendaItems as apiReorderAgendaItems,
  sendAgendaItemTeamsMessage,
  setAgendaItemStatus as apiSetAgendaItemStatus,
  describeTeamsMessageError,
  TEAMS_MESSAGE_MAX_LENGTH,
  updateAgendaItem as apiUpdateAgendaItem,
  updateMeeting as apiUpdateMeeting,
  removeParticipant as apiRemoveParticipant,
  addAgenda as apiAddAgenda,
  renameAgenda as apiRenameAgenda,
  removeAgenda as apiRemoveAgenda,
  type AgendaItemPatchPayload
} from "../lib/meetings";
import { locationLabel, ModalityFields } from "./MeetingInviteFields";
import ParticipantPicker from "./ParticipantPicker";
import ConfirmRemovalDialog from "./ConfirmRemovalDialog";
import { previaDoTitulo, SESSION_TYPE_OPTIONS, type SessionType } from "../lib/meeting-title";
import { cronogramaDosTemas } from "../lib/agenda-schedule";
import {
  confirmacaoRemoverDaReuniao,
  confirmacaoRemoverDoTema,
  temasDoParticipante,
  type ConfirmacaoRemocao
} from "../lib/participant-removal";
import {
  nomeDoSelecionado,
  selecionadoParaPayload,
  type ParticipanteSelecionado
} from "../lib/participant-search";
import { temasPorPauta } from "../lib/pipeline";
import MeetingDocumentsPanel from "./MeetingDocumentsPanel";
import UploadDocumentModal from "./UploadDocumentModal";
import { getInitials } from "../lib/user";
import { hrefSeguro } from "../lib/safe-url";
import DirectoryUserPicker from "./DirectoryUserPicker";
import { directoryEmail, type DirectoryUser } from "../lib/directory";
import type { TaxonomyItem } from "../lib/agenda-topics";
import DurationHoursMinutesSelect from "./DurationHoursMinutesSelect";
import {
  parseDurationMinutes,
  parseTimeToMinutes,
  formatMinutesAsTime,
  addDurationToTime
} from "../lib/agenda-time";
import {
  getAgendaProgress,
  getMeetingStage,
  getPautasMode,
  stageIndex,
  type MeetingStage
} from "../lib/meeting-progress";

/** Aparência de cada estado na timeline da Visão Geral. */
const TIMELINE_BADGES: Record<string, { className: string; labelPt: string; labelEn: string }> = {
  Concluido: { className: "bg-green-100 text-green-700", labelPt: "CONCLUÍDA", labelEn: "Concluded" },
  Apresentando: { className: "bg-blue-100 text-blue-700", labelPt: "EM DISCUSSÃO", labelEn: "In Discussion" },
  Postergado: { className: "bg-amber-100 text-amber-800", labelPt: "ADIADO", labelEn: "Postponed" },
  Pendente: { className: "bg-gray-100 text-gray-600", labelPt: "NÃO INICIADO", labelEn: "Not Started" }
};

interface MeetingDetailViewProps {
  language: "en" | "pt";
  meeting: Meeting;
  onBack: () => void;
  onUpdateStatus: (meetId: string, newStatus: Meeting["status"]) => void;
  actionItems: ActionItem[];
  onCreateActionItem: (input: FupFormInput) => void | Promise<void>;
  onSetActionItemStatus: (id: string, concluir: boolean) => void | Promise<void>;
  setActionItems: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  standaloneAgendas: StandaloneAgenda[];
  /** Recarrega a Biblioteca depois de Postergar/Retomar. */
  onReloadAgendaTopics?: () => void;
  setStandaloneAgendas: React.Dispatch<React.SetStateAction<StandaloneAgenda[]>>;
  meetings: Meeting[];
  setMeetings: React.Dispatch<React.SetStateAction<Meeting[]>>;
  setSelectedMeeting: React.Dispatch<React.SetStateAction<Meeting | null>>;
  triggerToast: (msg: string) => void;
  /** Usuário da sessão. Usado apenas para registrar QUEM executa uma ação. */
  currentUser: SessionUser;
  /** O ator pode alterar este FUP? Cortesia; o servidor revalida. */
  podeGerenciarFup?: (item: ActionItem) => boolean;
  /**
   * A pessoa tem a App Role `PGCP.Assessoria`?
   *
   * Só esconde o que ela não pode fazer. A autoridade continua sendo o
   * servidor: `PATCH /meetings/:id` recusa quem não tem a role, e nenhuma
   * decisão de autorização é tomada aqui.
   */
  canSchedule?: boolean;
  /** Mesmas fontes de Tipo/Natureza da Biblioteca (cadastros relacionais). */
  pautaTypes?: TaxonomyItem[];
  pautaNatures?: TaxonomyItem[];
  /** Órgãos para o "Editar Detalhes" — mesma lista da criação. */
  governanceBodies?: GovernanceBody[];
}

export default function MeetingDetailView({
  language,
  meeting,
  onBack,
  onUpdateStatus,
  actionItems = [],
  setActionItems,
  onCreateActionItem,
  onSetActionItemStatus,
  standaloneAgendas = [],
  onReloadAgendaTopics,
  setStandaloneAgendas,
  meetings = [],
  setMeetings,
  setSelectedMeeting,
  triggerToast,
  currentUser,
  canSchedule = false,
  podeGerenciarFup = () => true,
  pautaTypes = [],
  pautaNatures = [],
  governanceBodies = []
}: MeetingDetailViewProps) {
  const [activeSubTab, setActiveSubTab] = useState<string>("Overview");

  /*
   * Documentos (Pipeline). Um só diálogo de envio: `undefined` = fechado,
   * `null` = reunião inteira, id = tema DESTA reunião (botão do tema). Enviar
   * exige PGCP.Assessoria e reunião liberada — o servidor revalida as duas.
   */
  const [envioDeDocumento, setEnvioDeDocumento] = useState<string | null | undefined>(undefined);
  const [versaoDosDocumentos, setVersaoDosDocumentos] = useState(0);
  const podeAdicionarDocumento = canSchedule && meeting.releasedToPipeline !== false;

  // Edição de pauta (PATCH /meetings/:id/agenda-items/:itemId). Campos suportados
  // pelo contrato: título, duração, responsável. UUID e agendaTopicId preservados
  // pelo backend (UPDATE parcial, nunca delete+insert).
  const [editandoPautaId, setEditandoPautaId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDuration, setEditDuration] = useState("15 mins");
  const [editRespLabel, setEditRespLabel] = useState("");
  const [editRespOid, setEditRespOid] = useState<string | undefined>(undefined);
  const [editRespUser, setEditRespUser] = useState<DirectoryUser | null>(null);
  // Tema circular NESTA reunião. Editável Não↔Sim; nunca toca a Biblioteca.
  const [editCircular, setEditCircular] = useState(false);
  // Ficha (019): edição da PRÓPRIA pauta da reunião; nunca toca a Biblioteca.
  const [editTypeId, setEditTypeId] = useState("");
  const [editNatureId, setEditNatureId] = useState("");
  const [editFup, setEditFup] = useState(false);
  const [editDescription, setEditDescription] = useState("");
  const [salvandoEdicao, setSalvandoEdicao] = useState(false);
  const [erroEdicao, setErroEdicao] = useState<string | null>(null);

  // Confirmação de exclusão de pauta (evita perda acidental).
  const [pautaParaExcluir, setPautaParaExcluir] = useState<AgendaItem | null>(null);

  // Edit Meeting
  const [isEditingMeeting, setIsEditingMeeting] = useState(false);
  const [editedTitle, setEditedTitle] = useState(meeting.title);
  /** Tipo (030). Com tipo, o título é montado pelo servidor; "" = legado (título livre). */
  const [editedSessionType, setEditedSessionType] = useState<SessionType | "">(meeting.sessionType ?? "");
  const [editedDescription, setEditedDescription] = useState(meeting.description);
  const [editedDate, setEditedDate] = useState(meeting.date);
  const [editedStartTime, setEditedStartTime] = useState(meeting.startTime);
  const [editedEndTime, setEditedEndTime] = useState(meeting.endTime);
  const [editedGovernanceBodyId, setEditedGovernanceBodyId] = useState(meeting.governanceBodyId || "");
  const [editedRecurrence, setEditedRecurrence] = useState(meeting.recurrence || "Single");
  const [editedModality, setEditedModality] = useState<"online" | "in_person">(meeting.modality ?? "online");
  const [editedLocationKey, setEditedLocationKey] = useState(meeting.physicalLocation?.id ?? "");

  // ---------------------------------------------------------------------------
  // STATE MANAGEMENT - ITEM 1 (GERACAO E CICLO DE VIDA DA ATA)
  // ---------------------------------------------------------------------------
  // Minutes (Ata) States
  // ---------------------------------------------------------------------------

  /**
   * Mensagem personalizada e chamada Teams por pauta — ações da aba Pautas
   * durante a reunião ao vivo (Próximas Pautas). Independentes de Anotações
   * (removida): nunca leram nem escreveram o texto do editor.
   */
  const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);
  const [messageTargetAgendaItemId, setMessageTargetAgendaItemId] = useState<string>("");
  const [messageTargetTopic, setMessageTargetTopic] = useState<string>("");
  const [customMessage, setCustomMessage] = useState("");
  const [isSendingCustomMessage, setIsSendingCustomMessage] = useState(false);
  const [customMessageError, setCustomMessageError] = useState<string | null>(null);
  /** ID da pauta em chamada; impede clique repetido enquanto a API trabalha. */
  const [callingAgendaItemId, setCallingAgendaItemId] = useState<string | null>(null);

  /*
   * ATA — fonte de verdade no PostgreSQL (`meeting_minutes`).
   *
   * Antes vivia em cinco chaves de `localStorage` (texto, status, saneamento,
   * nome de quem saneou e assinaturas). Nenhuma delas é lida ou escrita aqui:
   * o documento é da reunião, não do navegador de quem abriu a tela.
   *
   * SALVAMENTO EXPLÍCITO, sem autosave. A Ata é escrita em bloco e revisada,
   * não digitada ao vivo como as anotações — um PUT por tecla num documento
   * formal só criaria revisões intermediárias sem significado.
   */
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [minutesText, setMinutesText] = useState<string>("");
  const [minutesLoadState, setMinutesLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [minutesBusy, setMinutesBusy] = useState<"idle" | "saving" | "clearing">("idle");
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const [minutesConflict, setMinutesConflict] = useState<MeetingMinutes | null>(null);

  /** Último texto confirmado pelo servidor. Distingue "salvo" de "editado". */
  const minutesSalvaRef = useRef<string>("");

  useEffect(() => {
    let cancelado = false;
    const controlador = new AbortController();

    setMinutesLoadState("loading");
    setMinutesError(null);
    setMinutesConflict(null);

    getMeetingMinutes(meeting.id, controlador.signal)
      .then((doc) => {
        if (cancelado) return;
        setMinutes(doc);
        setMinutesText(doc.content);
        minutesSalvaRef.current = doc.content;
        setMinutesLoadState("ready");
      })
      .catch((erro) => {
        if (cancelado || (erro as Error)?.name === "AbortError") return;
        setMinutesLoadState("error");
        setMinutesError(describeMinutesError(erro, language));
      });

    return () => {
      cancelado = true;
      controlador.abort();
    };
  }, [meeting.id]);

  const minutesRevision = minutes?.revision ?? 0;
  const minutesDirty = minutesText !== minutesSalvaRef.current;
  /*
   * Saneada é a REVISÃO, não a Ata em abstrato: editar depois do visto derruba
   * o estado no servidor, e a tela reflete isso em vez de manter um selo que
   * não corresponde mais ao texto exibido.
   */
  const minutesCleared = minutes?.clearedForCurrentRevision === true;

  const aplicarMinutes = (doc: MeetingMinutes) => {
    setMinutes(doc);
    setMinutesText(doc.content);
    minutesSalvaRef.current = doc.content;
  };

  const handleSaveMinutes = () => {
    if (minutesBusy !== "idle" || minutesLoadState !== "ready") return;

    setMinutesBusy("saving");
    setMinutesError(null);

    saveMeetingMinutes(meeting.id, minutesText, minutesRevision)
      .then((doc) => {
        aplicarMinutes(doc);
        triggerToast(language === "en" ? "Minutes saved." : "Ata salva.");
      })
      .catch((erro) => {
        if (erro instanceof MinutesConflictError) {
          // O texto local FICA. Descartá-lo em silêncio perderia o que a
          // pessoa acabou de escrever.
          setMinutesConflict(erro.current);
          return;
        }
        setMinutesError(describeMinutesError(erro, language));
      })
      .finally(() => setMinutesBusy("idle"));
  };

  /**
   * (Re)monta o esqueleto da Ata só com fatos já registrados — chamada tanto
   * na criação (estado vazio) quanto no botão "Resetar Esqueleto", que existe
   * porque atualizar o formato do esqueleto não republica sozinho as Atas já
   * geradas: sem um jeito de regenerar, cada ajuste de modelo exigia apagar o
   * texto na mão.
   *
   * Não gera conteúdo: deliberação, decisão, votação, responsável e prazo
   * ficam em branco para quem participou da sessão escrever. O texto não é
   * gravado aqui — vira rascunho na tela até alguém salvar, e SUBSTITUI
   * qualquer coisa já digitada (o botão de reset confirma antes de chamar).
   */
  const handleCreateMinutes = () => {
    setMinutesText(buildMinutesTemplate(meeting, language));
  };

  /** Descarta o texto local e adota a versão do servidor. Ação explícita. */
  const recarregarMinutes = () => {
    if (!minutesConflict) return;
    aplicarMinutes(minutesConflict);
    setMinutesConflict(null);
  };

  // --- ADDED STATES FOR DYNAMIC TABS (PARTICIPANTS & FUP) ---
  const [isAddingParticipantOnTab, setIsAddingParticipantOnTab] = useState(false);
  const [newTabPartName, setNewTabPartName] = useState("");
  const [newTabPartRole, setNewTabPartRole] = useState(language === "en" ? "Technical Guest" : "Convidado Técnico");
  /**
   * E-mail do convidado externo.
   *
   * Opcional: a reunião existe sem ele. Sem endereço, porém, a pessoa não pode
   * receber o convite de calendário, e a sincronização com o Outlook fica
   * bloqueada até que ele seja informado.
   */
  const [newTabPartEmail, setNewTabPartEmail] = useState("");

  /*
   * SINCRONIZAÇÃO COM O CALENDÁRIO.
   *
   * Ação explícita, nunca automática: PostgreSQL e Microsoft Graph não
   * compartilham transação, e a reunião existe independentemente de o convite
   * ter saído. A tela mostra o estado que o servidor devolve — não deduz
   * sucesso, e `failed` continua `failed` até alguém corrigir e reenviar.
   */
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [semEndereco, setSemEndereco] = useState<ParticipanteSemEndereco[]>([]);

  /*
   * O que a tela mostra sobre a projeção. Derivado do que o servidor guarda —
   * a tela não reinterpreta `sync_status`, só distingue `stale` com erro de
   * `stale` sem erro, que para quem lê são coisas diferentes.
   */
  const estadoDoCalendario = calendarVisualState(meeting.calendar);

  /*
   * VALIDAÇÃO DE PAUTAS — preparação da reunião já agendada (025).
   *
   * O convite Outlook/Teams sai no AGENDAMENTO (Calendário ou reserva da
   * Agenda Anual), sem esperar pauta. A validação continua exigida para
   * INICIAR a reunião — barreira no backend (`exigirProntaParaIniciar`).
   */
  const validacao = meeting.agendaValidation;
  const statusValidacao = validacao?.status ?? "draft";
  const pautasAprovadas = statusValidacao === "approved";

  /*
   * Pré-requisitos de "Iniciar Reunião": pautas aprovadas e convite enviado
   * (evento existe no calendário: synced, ou stale após edição). A barreira de
   * verdade é o backend (`exigirProntaParaIniciar`); aqui só explicamos o porquê.
   */
  const conviteEnviado =
    meeting.calendar?.syncStatus === "synced" || meeting.calendar?.syncStatus === "stale";
  const pendenciasParaIniciar = [
    ...(pautasAprovadas ? [] : [language === "en" ? "agenda not approved yet" : "pautas ainda não aprovadas"]),
    ...(conviteEnviado ? [] : [language === "en" ? "invitation not sent yet" : "convite ainda não enviado"]),
  ];
  const podeIniciar = pendenciasParaIniciar.length === 0;

  /**
   * Modo da aba Pautas, derivado só de `meetings.status` (sem status novo):
   *   planning   antes da reunião — montar/editar/ordenar, Biblioteca
   *   execution  In Progress — conduzir ao vivo
   *   result     Done/Closed — leitura do desfecho
   * Só apresentação: o backend segue exigindo PGCP.Assessoria em toda mutação.
   */
  const pautasMode = getPautasMode(meeting);
  const modoPlanejamento = pautasMode === "planning";
  const modoExecucao = pautasMode === "execution";
  const modoResultado = pautasMode === "result";

  const [modalValidacaoAberto, setModalValidacaoAberto] = useState(false);
  const [emailAprovador, setEmailAprovador] = useState("");
  const [enviandoValidacao, setEnviandoValidacao] = useState(false);
  const [erroValidacao, setErroValidacao] = useState<string | null>(null);
  const [aprovando, setAprovando] = useState(false);

  /** Substitui o estado pela reunião relida que a própria resposta devolve. */
  const absorverReuniao = (api: import("../lib/meetings").ApiMeetingDetail): Meeting => {
    const convertida = meetingFromApi(api);
    setSelectedMeeting(convertida);
    setMeetings((prev) => prev.map((m) => (m.id === convertida.id ? convertida : m)));
    return convertida;
  };

  /**
   * Avisa, sem silêncio, quando uma alteração ESTRUTURAL pré-reunião reabriu a
   * validação (backend voltou `sent`/`approved` para `draft`). `statusValidacao`
   * é o estado ANTES da mutação (derivado no render corrente); só `draft` é o
   * destino da reabertura, então a transição não-draft→draft é inequívoca.
   */
  const avisarSeValidacaoReaberta = (depois: Meeting) => {
    const depoisStatus = depois.agendaValidation?.status ?? "draft";
    if ((statusValidacao === "sent" || statusValidacao === "approved") && depoisStatus === "draft") {
      triggerToast(
        language === "en"
          ? "The agenda changed. The previous validation was reopened and must be sent for approval again."
          : "As pautas foram alteradas. A validação anterior foi reaberta e será necessário enviar novamente para aprovação."
      );
    }
  };

  const handleEnviarParaValidacao = async () => {
    if (enviandoValidacao) return;
    setErroValidacao(null);
    setEnviandoValidacao(true);
    try {
      const resposta = await sendAgendaForValidation(meeting.id, emailAprovador);
      absorverReuniao(resposta.meeting);
      setModalValidacaoAberto(false);
      setEmailAprovador("");
      triggerToast(
        language === "en"
          ? `Agenda sent to ${resposta.sentTo} for validation.`
          : `Pautas enviadas para ${resposta.sentTo}.`
      );
    } catch (erro) {
      // Fica NO MODAL: a pessoa corrige o endereço sem perder o que digitou.
      setErroValidacao(describeValidationError(erro, language === "en" ? "en" : "pt"));
    } finally {
      setEnviandoValidacao(false);
    }
  };

  const handleAprovarPautas = async () => {
    if (aprovando) return;
    setErroValidacao(null);
    setAprovando(true);
    try {
      const resposta = await approveAgenda(meeting.id);
      absorverReuniao(resposta.meeting);
      triggerToast(
        language === "en" ? "Agenda marked as approved." : "Pautas marcadas como aprovadas."
      );
    } catch (erro) {
      setErroValidacao(describeValidationError(erro, language === "en" ? "en" : "pt"));
    } finally {
      setAprovando(false);
    }
  };

  const handleSyncCalendar = () => {
    if (syncing) return;

    setSyncing(true);
    setSyncError(null);
    setSemEndereco([]);

    syncMeetingCalendar(meeting.id)
      .then(() => {
        triggerToast(
          language === "en" ? "Calendar invitation sent." : "Convite de calendário enviado."
        );
        // Recarrega a reunião: o estado da projeção vem do servidor, não de
        // uma suposição local sobre o que acabou de acontecer.
        void getMeeting(meeting.id)
          .then((atualizada) => {
            const convertida = meetingFromApi(atualizada);
            setSelectedMeeting(convertida);
            setMeetings((prev) => prev.map((m) => (m.id === convertida.id ? convertida : m)));
          })
          .catch(() => {
            /* A sincronização deu certo; falhar ao reler é problema da próxima
               abertura da tela, não motivo para desmentir o convite. */
          });
      })
      .catch((erro) => {
        if (erro instanceof CalendarPreconditionError) {
          // Quem ficou sem endereço vai nominalmente para a tela: saber QUEM
          // corrigir é a diferença entre um aviso útil e um erro genérico.
          setSemEndereco(erro.participants);
        }
        setSyncError(describeCalendarError(erro, language));
      })
      .finally(() => setSyncing(false));
  };

  const [isAddingFupOnTab, setIsAddingFupOnTab] = useState(false);
  const [newFupTitle, setNewFupTitle] = useState("");
  const [newFupTopic, setNewFupTopic] = useState("");
  const [newFupVp, setNewFupVp] = useState("");
  const [newFupDueDate, setNewFupDueDate] = useState("");
  const [newFupComments, setNewFupComments] = useState("");
  const [newFupStatus, setNewFupStatus] = useState<"open" | "completed">("open");
  /** Responsável do FUP, escolhido no diretório corporativo. */
  const [newFupAssignee, setNewFupAssignee] = useState<DirectoryUser | null>(null);

  /**
   * Executa uma mutação no PostgreSQL e substitui o estado pela resposta.
   *
   * Não há optimistic update: se a API falhar, a tela NÃO finge que gravou —
   * mostra o erro e mantém o que veio do banco. O corpo devolvido é o mesmo de
   * GET /meetings/:id, então uma gravação que mexeu em mais de uma linha
   * (reordenar, por exemplo) chega inteira.
   */
  const [isPersisting, setIsPersisting] = useState(false);

  const persistir = async (
    operacao: () => Promise<import("../lib/meetings").ApiMeetingDetail>,
    sucesso: string
  ): Promise<boolean> => {
    if (isPersisting) return false;
    setIsPersisting(true);
    try {
      const atualizada = meetingFromApi(await operacao());
      setSelectedMeeting(atualizada);
      setMeetings((prev) => prev.map((m) => (m.id === atualizada.id ? atualizada : m)));
      triggerToast(sucesso);
      // Mensagem de reabertura sobrepõe o toast genérico: é o aviso importante.
      avisarSeValidacaoReaberta(atualizada);
      return true;
    } catch (error) {
      triggerToast(describeMeetingError(error, language));
      return false;
    } finally {
      setIsPersisting(false);
    }
  };

  /**
   * Grava a nova ordem das pautas.
   *
   * Envia apenas os IDs na sequência desejada e os horários recalculados — os
   * UUIDs são preservados. Reenviar as pautas inteiras faria o banco recriá-las,
   * e os ids que o FUP vai referenciar mudariam a cada arrasto.
   */
  const persistirOrdem = (agendaOrdenada: AgendaItem[]) =>
    persistir(
      () =>
        apiReorderAgendaItems(
          meeting.id,
          agendaOrdenada.map((item) => item.id),
          Object.fromEntries(
            agendaOrdenada.filter((item) => /^\d{2}:\d{2}$/.test(item.time)).map((item) => [item.id, item.time])
          )
        ),
      language === "en" ? "Agenda reordered." : "Ordem das pautas atualizada."
    );

  /**
   * Inclui uma pauta no PostgreSQL.
   *
   * Recebe o `AgendaItem` que a tela montou apenas como fonte dos VALORES; o
   * `id` local é descartado, porque a identidade da linha é gerada pelo banco.
   */
  const persistirNovaPauta = (item: AgendaItem) =>
    persistir(
      () =>
        apiAddAgendaItem(meeting.id, {
          title: item.title,
          // Pauta (agrupador, 025) de destino. Validada no servidor: precisa
          // ser DESTA reunião.
          agendaId: item.agendaId ?? (pautaDestinoId || undefined),
          // Preserva a identidade da pauta da Biblioteca.
          agendaTopicId: item.agendaTopicId,
          durationMinutes: item.duration?.trim() ? parseDurationMinutes(item.duration) : undefined,
          scheduledStartTime: /^\d{2}:\d{2}$/.test(item.time) ? item.time : undefined,
          responsibleLabel: item.author?.trim() || undefined,
          // Identidade só acompanha rótulo — a API recusa o contrário.
          responsibleEntraObjectId: item.author?.trim() ? item.authorEntraObjectId : undefined,
          // [EXTRA] carrega o valor escolhido; item da Biblioteca vem undefined e
          // o backend herda o padrão do tema mestre (cópia por agendaTopicId).
          isCircularTheme: item.isCircularTheme,
          // Ficha (019): explícito manda; ausente + agendaTopicId => herda do tema.
          agendaTopicTypeId: item.agendaTopicTypeId,
          agendaTopicNatureId: item.agendaTopicNatureId,
          description: item.description?.trim() ? item.description.trim() : undefined,
          generatesActionItem: item.generatesActionItem
        }),
      language === "en" ? "Topic added." : "Tema incluído na reunião."
    );

  /*
   * PAUTAS (025) — agrupadores de temas. Reunião -> Pauta -> Tema.
   * Criar/renomear/excluir pauta é estrutural: o servidor reabre a validação
   * se ela já tinha saído, e o aviso abaixo diz isso.
   */
  const [novaPautaTitulo, setNovaPautaTitulo] = useState("");
  /** Pauta que recebe o próximo tema criado ou vinculado da Biblioteca. */
  const [pautaDestinoId, setPautaDestinoId] = useState("");
  const [novoTemaTitulo, setNovoTemaTitulo] = useState("");
  const [novoTemaDuracao, setNovoTemaDuracao] = useState("00:15");

  const criarPauta = async () => {
    const titulo = novaPautaTitulo.trim();
    if (!titulo) return;
    const ok = await persistir(
      () => apiAddAgenda(meeting.id, titulo),
      language === "en" ? "Agenda created." : `Pauta "${titulo}" criada.`
    );
    if (ok) setNovaPautaTitulo("");
  };

  const renomearPauta = (agendaId: string, atual: string) => {
    const titulo = window.prompt(language === "en" ? "Agenda title" : "Título da pauta", atual)?.trim();
    if (!titulo || titulo === atual) return;
    void persistir(
      () => apiRenameAgenda(meeting.id, agendaId, titulo),
      language === "en" ? "Agenda renamed." : "Pauta renomeada."
    );
  };

  const excluirPauta = (agendaId: string) => {
    if (!window.confirm(language === "en" ? "Delete this empty agenda?" : "Excluir esta pauta (sem temas)?")) return;
    if (pautaDestinoId === agendaId) setPautaDestinoId("");
    void persistir(
      () => apiRemoveAgenda(meeting.id, agendaId),
      language === "en" ? "Agenda deleted." : "Pauta excluída."
    );
  };

  const moverTemaDePauta = (tema: AgendaItem, agendaId: string) =>
    void persistir(
      () => apiUpdateAgendaItem(meeting.id, tema.id, { agendaId: agendaId || null }),
      language === "en" ? "Topic moved." : "Tema movido de pauta."
    );

  const criarTema = async () => {
    const titulo = novoTemaTitulo.trim();
    if (!titulo) return;
    const ok = await persistirNovaPauta({
      id: newId(),
      title: titulo,
      time: "",
      duration: novoTemaDuracao,
      author: "",
      agendaId: pautaDestinoId || undefined
    });
    if (ok) setNovoTemaTitulo("");
  };

  const handleTabAddParticipant = async () => {
    const nome = newTabPartName.trim();
    if (!nome) return;

    const email = newTabPartEmail.trim();
    // Formato conferido antes de enviar: um endereço malformado só falharia lá
    // na hora do convite, quando corrigir custa mais.
    if (email && !ehEmailValido(email)) {
      triggerToast(
        language === "en" ? "Invalid e-mail address." : "Endereço de e-mail inválido."
      );
      return;
    }

    // Participante avulso: texto digitado, sem identidade no diretório. O
    // servidor deriva `participant_type` como external — é o único caso em que
    // isso é certo sem consultar ninguém.
    const ok = await persistir(
      () =>
        apiAddParticipant(meeting.id, {
          displayName: nome,
          participantType: "external",
          roleInMeeting: newTabPartRole.trim() || undefined,
          email: email || undefined,
          isConfirmed: true
        }),
      language === "en" ? "Participant added!" : "Participante adicionado com sucesso!"
    );

    if (!ok) return;
    setNewTabPartName("");
    setNewTabPartEmail("");
    setIsAddingParticipantOnTab(false);
  };

  /**
   * Pautas concluídas na aba Anotações, identificadas por `AgendaItem.id`.
   *
   * Antes usávamos o título normalizado, o que quebrava ao renomear a pauta e
   * confundia pautas homônimas. A chave antiga (`cielo_meeting_agenda_done_`)
   * guardava títulos e é descartada: converter exigiria casar título->ID,
   * justamente a ambiguidade que este campo elimina. Só esse estado de
   * marcação é perdido; nenhum outro dado é afetado.
   */
  /**
   * PAUTAS CONCLUÍDAS — apenas em memória.
   *
   * O estado persistente é `AgendaItem.executionStatus`, vindo do PostgreSQL, e
   * é ele que `estadoDaPauta` responde. Esta lista sobrevive como fallback de
   * sessão para a reunião que ainda não trouxe estado do banco; desde a 4.12 ela
   * NÃO é gravada em `localStorage`, então nunca vira uma segunda verdade que
   * dispute com o servidor depois de um refresh.
   */
  const [doneTopicIds, setDoneTopicIds] = useState<string[]>([]);

  const toggleTopicDone = (item: AgendaItem) => {
    const jaConcluida = estadoDaPauta(item) === "Concluido";

    if (ehReuniaoReal) {
      // Reabrir volta sempre para `pending` — o estado base. Não há histórico
      // de "estado anterior", e inventar um seria adivinhar.
      void persistirEstadoDaPauta(
        item,
        jaConcluida ? "pending" : "completed",
        jaConcluida
          ? (language === "en" ? `Topic reopened: "${item.title}".` : `Pauta reaberta: "${item.title}".`)
          : (language === "en" ? `Topic concluded: "${item.title}".` : `Pauta concluída: "${item.title}".`)
      );
    } else {
      setDoneTopicIds((prev) => (jaConcluida ? prev.filter((id) => id !== item.id) : [...prev, item.id]));
    }

    // Ponto ÚNICO de encerramento do estado ao vivo. Concluir e reabrir passam
    // por aqui vindo tanto da lista principal quanto do atalho em Próximas
    // Pautas, então a limpeza não precisa ser repetida nos handlers. Sem isso,
    // concluir pelo atalho deixava o cronômetro rodando e o "Apresentando"
    // persistido, e a pauta ressuscitava em apresentação ao ser reaberta.
    // A remoção é condicionada a "Apresentando": "Postergado" nunca é tocado.
    if (topicStates[item.id] === "Apresentando") setTopicState(item.id, null);
    if (activeAgendaId === item.id) setActiveAgendaId(null);

    if (!ehReuniaoReal) {
      triggerToast(
        jaConcluida
          ? (language === "en" ? `Topic reopened: "${item.title}".` : `Pauta reaberta: "${item.title}".`)
          : (language === "en" ? `Topic concluded: "${item.title}".` : `Pauta concluída: "${item.title}".`)
      );
    }
  };

  // --- Ações das pautas em execução (Pautas · Próximas Pautas) -------------
  const teamsDeliverySummary = (
    result: Awaited<ReturnType<typeof callAgendaItemParticipants>>,
    purpose: "message" | "call"
  ): string => {
    const failedNames = result.results
      .filter((delivery) => delivery.status === "failed")
      .map((delivery) => delivery.participantName)
      .join(", ");
    const failure = failedNames
      ? language === "en"
        ? ` Could not send to: ${failedNames}.`
        : ` Não foi possível enviar para: ${failedNames}.`
      : "";
    if (result.sent === 0) {
      return language === "en"
        ? `The ${purpose === "call" ? "call" : "message"} could not be sent to any of the ${result.total} participants.${failure}`
        : `Não foi possível enviar ${purpose === "call" ? "a chamada" : "a mensagem"} para nenhum dos ${result.total} participantes.${failure}`;
    }
    const label = language === "en"
      ? purpose === "call" ? "Call sent" : "Message sent"
      : purpose === "call" ? "Chamada enviada" : "Mensagem enviada";
    return `${label} ${language === "en" ? "to" : "para"} ${result.sent} ${language === "en" ? "of" : "de"} ${result.total} ${language === "en" ? "participants" : "participantes"}.${failure}`;
  };

  const handleCallParticipants = async (item: AgendaItem) => {
    if (callingAgendaItemId !== null) return;

    setCallingAgendaItemId(item.id);
    try {
      const result = await callAgendaItemParticipants(meeting.id, item.id);
      if (result.total === 0) {
        triggerToast(
          language === "en"
            ? "This agenda item has no participants to call."
            : "Esta pauta não possui participantes para receber a chamada."
        );
        return;
      }
      triggerToast(teamsDeliverySummary(result, "call"));
    } catch (error) {
      triggerToast(describeTeamsMessageError(error, language));
    } finally {
      setCallingAgendaItemId(null);
    }
  };

  const handleOpenMessageModal = (item: AgendaItem) => {
    setMessageTargetAgendaItemId(item.id);
    setMessageTargetTopic(item.title);
    setCustomMessage("");
    setCustomMessageError(null);
    setIsMessageModalOpen(true);
  };

  const closeMessageModal = () => {
    if (isSendingCustomMessage) return;
    setIsMessageModalOpen(false);
    setCustomMessageError(null);
  };

  const handleSendCustomMessage = async () => {
    if (!customMessage.trim() || !messageTargetAgendaItemId || isSendingCustomMessage) return;

    setIsSendingCustomMessage(true);
    setCustomMessageError(null);
    try {
      const result = await sendAgendaItemTeamsMessage(
        meeting.id,
        messageTargetAgendaItemId,
        customMessage
      );

      if (result.total === 0) {
        triggerToast(
          language === "en"
            ? "This agenda item has no participants to message."
            : "Esta pauta não possui participantes para receber a mensagem."
        );
        setIsMessageModalOpen(false);
        return;
      }

      const summary = teamsDeliverySummary(result, "message");

      if (result.sent === 0) {
        // Mantem o texto no modal para permitir nova tentativa sem redigitar.
        setCustomMessageError(summary);
        return;
      }

      triggerToast(summary);
      setIsMessageModalOpen(false);
      setCustomMessage("");
    } catch (error) {
      setCustomMessageError(describeTeamsMessageError(error, language));
    } finally {
      setIsSendingCustomMessage(false);
    }
  };

/*
 * REMOVIDOS NESTA ETAPA — nada substituiu por outra simulação:
 *
 *   handleAIMinutesGeneration  fingia IA com setTimeout(2000) e escrevia
 *                              deliberações fixas ("APROVADO, por unanimidade",
 *                              "VOTO DE LOUVOR") que ninguém tomou. Trocado por
 *                              `handleCreateMinutes`, que monta um esqueleto só
 *                              com fatos já registrados.
 *
 *   handleApproveSecretariat   marcava um boolean no navegador. O saneamento
 *                              real (`POST .../minutes/clear-by-secretariat`)
 *                              segue no backend; a tela deixou de oferecê-lo
 *                              quando o Fluxo em Camadas saiu da aba Ata.
 *
 *   handleNotifyTeams          só mostrava toast ("enviado via Adaptive Card")
 *                              sem enviar nada. O envio real é Chamar/Mensagem
 *                              em Próximas Pautas.
 *
 *   handleSignMinutes          assinava por duas pessoas inexistentes
 *                              ("M. Davis", "L. Chen") e promovia a Ata a
 *                              aprovada depois de duas strings. Não há
 *                              substituto: assinatura real é etapa futura, e
 *                              nenhuma assinatura falsa produz `approved`.
 *
 *   handleLaunchMinutesFUPs    criava dois FUPs inventados, com nomes e avatares
 *                              fixos, só no estado React. FUP real já tem fluxo
 *                              próprio contra `/action-items`.
 */

  const [isDownloadingMinutesPdf, setIsDownloadingMinutesPdf] = useState(false);

  /**
   * Exporta a Ata como PDF de verdade — nunca .txt. O documento é gerado no
   * servidor a partir do conteúdo já persistido (mesma identidade visual do
   * PDF de validação de pautas), não do texto solto no editor.
   */
  const handleDownloadMinutesFile = async () => {
    if (isDownloadingMinutesPdf) return;
    setIsDownloadingMinutesPdf(true);
    try {
      const { blob, filename } = await downloadMeetingMinutesPdf(meeting.id);
      const element = document.createElement("a");
      element.href = URL.createObjectURL(blob);
      element.download = filename ?? `Ata-${meeting.title.replace(/\s+/g, "-")}.pdf`;
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
      URL.revokeObjectURL(element.href);
    } catch (error) {
      triggerToast(describeMinutesError(error, language));
    } finally {
      setIsDownloadingMinutesPdf(false);
    }
  };


  // ---------------------------------------------------------------------------
  // STATE MANAGEMENT - ITEM 3 (BIDIRECTIONAL AGENDA & CRONOGRAMA & TIMERS)
  // ---------------------------------------------------------------------------
  // Individual agenda index timer statuses
  /**
   * Estados temporários da pauta, por `AgendaItem.id`.
   *
   * "Concluido" NÃO vive aqui: vem de `doneTopicIds`, a mesma fonte usada por
   * Anotações e Visão Geral. Isso evita duas verdades concorrentes.
   */
  type TopicLiveState = "Apresentando" | "Postergado";

  const [topicStates, setTopicStates] = useState<Record<string, TopicLiveState>>({});

  /** Pauta em apresentação. Por ID: reordenar não faz o cronômetro migrar. */
  const [activeAgendaId, setActiveAgendaId] = useState<string | null>(null);

  const setTopicState = (id: string, state: TopicLiveState | null) =>
    setTopicStates((prev) => {
      const next = { ...prev };
      if (state === null) delete next[id];
      else next[id] = state;
      return next;
    });

  /**
   * Estado PERSISTENTE da pauta.
   *
   * O PostgreSQL vence: quando a pauta traz `executionStatus`, ele é a
   * resposta. Duas fontes concorrentes para o mesmo fato foi exatamente o
   * defeito que esta onda veio corrigir — e na 4.12 as chaves de localStorage
   * que sustentavam a segunda fonte foram removidas.
   *
   * O fallback em memória só atende reunião que ainda não trouxe estado do
   * banco, e morre com a aba.
   */
  const estadoDaPauta = (item: AgendaItem): "Pendente" | "Concluido" | "Postergado" => {
    if (item.executionStatus === "completed") return "Concluido";
    if (item.executionStatus === "postponed") return "Postergado";
    if (item.executionStatus === "pending") return "Pendente";

    if (doneTopicIds.includes(item.id)) return "Concluido";
    return topicStates[item.id] === "Postergado" ? "Postergado" : "Pendente";
  };

  /**
   * Status efetivo exibido. "Apresentando" é sobreposto ao estado persistente
   * porque é da SESSÃO: some no refresh, e por isso nunca vem do banco.
   */
  const getTopicStatus = (item: AgendaItem): "Pendente" | "Apresentando" | "Concluido" | "Postergado" => {
    const persistido = estadoDaPauta(item);
    if (persistido === "Pendente" && topicStates[item.id] === "Apresentando") return "Apresentando";
    return persistido;
  };

  /** A reunião veio do PostgreSQL? Pautas reais trazem estado próprio. */
  const ehReuniaoReal = (meeting.agenda || []).some((item) => item.executionStatus !== undefined);

  /**
   * Grava a transição no banco e substitui o estado pela resposta canônica.
   * Falha NÃO marca nada como persistido — o erro aparece e a tela continua
   * mostrando o que o banco tem.
   */
  const persistirEstadoDaPauta = (
    item: AgendaItem,
    executionStatus: "pending" | "completed" | "postponed",
    mensagem: string
  ) => persistir(() => apiSetAgendaItemStatus(meeting.id, item.id, executionStatus), mensagem);

  /**
   * Marca/desmarca uma pauta como "Tema de FUP" direto da aba Ata — mesmo
   * campo (`generatesActionItem`) que a edição de pauta já grava. Só a
   * classificação; não cria o FUP. Quem preenche responsável e prazo é a
   * aba FUP, a partir da lista de pendentes.
   */
  const alternarFupDaPauta = (item: AgendaItem, marcado: boolean) =>
    persistir(
      () => apiUpdateAgendaItem(meeting.id, item.id, { generatesActionItem: marcado }),
      marcado
        ? (language === "en" ? "Topic flagged as a follow-up candidate." : "Pauta marcada como possível FUP.")
        : (language === "en" ? "Follow-up flag removed." : "Marcação de FUP removida.")
    );

  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [annualSearch, setAnnualSearch] = useState("");

  // Cronômetro da pauta em apresentação. Localiza por ID: reordenar a lista
  // não faz o cronômetro pular para outra pauta.
  useEffect(() => {
    const active = (meeting.agenda || []).find((item) => item.id === activeAgendaId);
    if (!active) {
      setTimeLeft(null);
      return;
    }

    setTimeLeft(parseDurationMinutes(active.duration) * 60);
    const timer = setInterval(() => {
      setTimeLeft((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [activeAgendaId, meeting.agenda]);

  // Helper to format remaining time
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [hoveredOverIndex, setHoveredOverIndex] = useState<number | null>(null);
  const [isExtraFormOpen, setIsExtraFormOpen] = useState(false);
  const [extraTitle, setExtraTitle] = useState("");
  /**
   * Responsável da pauta extraordinária.
   *
   * `extraSpeaker` guarda o texto que vai para `AgendaItem.author` — pode ser
   * uma pessoa do diretório ou o coletivo "Todos". `extraSpeakerUser` só existe
   * no segundo caso, e é dele que sai o vínculo com a identidade Microsoft.
   */
  const [extraSpeaker, setExtraSpeaker] = useState("Todos");
  const [extraSpeakerUser, setExtraSpeakerUser] = useState<DirectoryUser | null>(null);
  const [extraDuration, setExtraDuration] = useState("15 mins");
  // Tema circular da nova pauta. Default visual "Não"; "Sim" só AFIRMA o fato.
  const [extraCircular, setExtraCircular] = useState(false);
  // Ficha (019) da extraordinária — mesma dos demais fluxos. Complementar,
  // recolhível, para não pesar a operação ao vivo.
  const [extraTypeId, setExtraTypeId] = useState("");
  const [extraNatureId, setExtraNatureId] = useState("");
  const [extraFup, setExtraFup] = useState(false);
  const [extraDescription, setExtraDescription] = useState("");
  const [extraFichaAberta, setExtraFichaAberta] = useState(false);
  // Participantes da extraordinária: coletados aqui e VINCULADOS após criar o
  // item (o item precisa existir para receber o vínculo).
  const [extraParticipants, setExtraParticipants] = useState<ParticipanteSelecionado[]>([]);

  /** Recalcula os horários em cascata a partir do início da reunião. */
  const recalculateAgendaTimes = (agendaArray: AgendaItem[]): AgendaItem[] => {
    if (agendaArray.length === 0) return [];
    // Mesma regra de cronograma da Agenda Anual (lib/agenda-schedule). O
    // Pipeline mantém o seu padrão de duração (parseDurationMinutes).
    const horarios = cronogramaDosTemas(
      meeting.startTime,
      agendaArray.map((item) => ({ id: item.id, durationMinutes: parseDurationMinutes(item.duration) }))
    );
    return agendaArray.map((item, i) => ({ ...item, time: horarios[i]!.inicio }));
  };

  const handleMoveAgendaItem = (index: number, direction: "up" | "down") => {
    const agendaList = [...(meeting.agenda || [])];
    if (direction === "up" && index > 0) {
      const temp = agendaList[index];
      agendaList[index] = agendaList[index - 1];
      agendaList[index - 1] = temp;
    } else if (direction === "down" && index < agendaList.length - 1) {
      const temp = agendaList[index];
      agendaList[index] = agendaList[index + 1];
      agendaList[index + 1] = temp;
    } else {
      return;
    }

    const updatedAgenda = recalculateAgendaTimes(agendaList);
    void persistirOrdem(updatedAgenda);

  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setHoveredOverIndex(index);
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    setDraggedIndex(null);
    setHoveredOverIndex(null);
    if (draggedIndex === null || draggedIndex === targetIndex) return;

    const agendaList = [...(meeting.agenda || [])];
    const draggedItem = agendaList[draggedIndex];
    
    agendaList.splice(draggedIndex, 1);
    agendaList.splice(targetIndex, 0, draggedItem);

    const updatedAgenda = recalculateAgendaTimes(agendaList);
    void persistirOrdem(updatedAgenda);

      // Nada a remapear: o estado é indexado por AgendaItem.id, então
      // acompanha a pauta. Sem reset silencioso de pauta concluída.

    setDraggedIndex(null);
    triggerToast(language === "en" ? "Agenda reordered and schedule recalculated!" : "Pauta reordenada e cronograma recalculado!");
  };

  /**
   * Inicia a apresentação. No máximo UMA pauta fica "Apresentando": qualquer
   * outra que estivesse nesse estado volta a "Pendente" por ausência no mapa.
   * Estados que não são de sessão (hoje "Postergado") são preservados.
   */
  const handleStartAgendaTopic = (item: AgendaItem) => {
    setActiveAgendaId(item.id);
    setTopicStates((prev) => {
      const next: Record<string, TopicLiveState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (state !== "Apresentando") next[id] = state;
      }
      next[item.id] = "Apresentando";
      return next;
    });
    triggerToast(language === "en" ? `Presentation of topic started.` : `Apresentação do tema iniciada.`);
  };

  /**
   * Concluir usa a MESMA fonte persistida das Anotações (`doneTopicIds`).
   * `toggleTopicDone` trata conclusão, encerramento do estado ao vivo, toast e
   * auditoria — por isso este handler apenas delega.
   */
  const handleCompleteAgendaTopic = (item: AgendaItem) => {
    toggleTopicDone(item);
  };

  /**
   * Exclusão CONFIRMADA (o botão de lixeira abre a confirmação em
   * `pautaParaExcluir`; aqui é o efeito depois do "Excluir"). Evita perda
   * acidental — a remoção some com a pauta e a procedência de FUPs.
   */
  const confirmarExclusaoPauta = async () => {
    const removido = pautaParaExcluir;
    if (!removido) return;

    // DELETE direcionado pelo UUID da linha. O servidor recompacta `position`
    // na mesma transação — a tela não precisa reenviar a lista inteira.
    const ok = await persistir(
      () => apiRemoveAgendaItem(meeting.id, removido.id),
      language === "en" ? "Agenda item deleted!" : "Item removido da pauta!"
    );
    setPautaParaExcluir(null);
    if (!ok) return;

    // Estado de execução ainda vive no navegador (onda posterior): limpa o
    // resíduo da pauta que deixou de existir.
    if (activeAgendaId === removido.id) setActiveAgendaId(null);
    setTopicState(removido.id, null);
    setDoneTopicIds(prev => prev.filter(id => id !== removido.id));
  };

  /**
   * Abre o modal de EDIÇÃO carregando os valores atuais. Só campos suportados
   * pelo PATCH: título, duração e responsável. UUID e `agendaTopicId` NÃO são
   * tocados — o backend faz UPDATE parcial em `meeting_agenda_items`, nunca
   * delete+insert, e não altera o registro mestre da Biblioteca.
   */
  const abrirEdicaoPauta = (item: AgendaItem) => {
    setEditandoPautaId(item.id);
    setEditTitle(item.title);
    setEditDuration(item.duration?.trim() || "15 mins");
    setEditRespLabel(item.author || "");
    setEditRespOid(item.authorEntraObjectId);
    setEditRespUser(null);
    setEditCircular(item.isCircularTheme === true);
    // Ficha: pré-seleciona o snapshot atual; sem valor, cai no primeiro cadastro.
    setEditTypeId(item.agendaTopicTypeId || pautaTypes[0]?.id || "");
    setEditNatureId(item.agendaTopicNatureId || pautaNatures[0]?.id || "");
    setEditFup(item.generatesActionItem === true);
    setEditDescription(item.description || "");
    setErroEdicao(null);
  };

  const salvarEdicaoPauta = async () => {
    if (!editandoPautaId) return;
    const titulo = editTitle.trim();
    if (!titulo) {
      setErroEdicao(language === "en" ? "Title is required." : "O título é obrigatório.");
      return;
    }
    setSalvandoEdicao(true);
    setErroEdicao(null);
    try {
      const label = editRespLabel.trim();
      // Rótulo e identidade andam juntos: oid só acompanha rótulo (o backend
      // recusa oid solto). Sem rótulo, o responsável não é alterado nesta rodada.
      const patch: AgendaItemPatchPayload = {
        title: titulo,
        durationMinutes: parseDurationMinutes(editDuration),
        // Booleano estrito. Grava o estado do seletor sempre — permite Sim→Não.
        isCircularTheme: editCircular,
        // Ficha (019): grava na PRÓPRIA pauta. `null` limpa; nunca toca a Biblioteca.
        agendaTopicTypeId: editTypeId || null,
        agendaTopicNatureId: editNatureId || null,
        description: editDescription.trim() || null,
        generatesActionItem: editFup,
      };
      if (label) {
        patch.responsibleLabel = label;
        patch.responsibleEntraObjectId = editRespOid ?? undefined;
      }
      const atualizada = absorverReuniao(await apiUpdateAgendaItem(meeting.id, editandoPautaId, patch));
      setEditandoPautaId(null);
      triggerToast(language === "en" ? "Agenda item updated." : "Pauta atualizada.");
      avisarSeValidacaoReaberta(atualizada);
    } catch (erro) {
      setErroEdicao(describeMeetingError(erro, language === "en" ? "en" : "pt"));
    } finally {
      setSalvandoEdicao(false);
    }
  };

  /**
   * Participantes POR PAUTA (Opção A). Add/remove são IMEDIATOS (persistem o
   * vínculo já). `persistir` absorve a reunião relida e dispara o aviso de
   * reabertura da validação quando for o caso. Vincular alguém novo o adiciona à
   * reunião no backend (mesmo caminho da aba Participantes).
   */
  // Entra ID ou externo do PGCP (só nome + e-mail, sem identidade Microsoft).
  const vincularParticipantePauta = (itemId: string, sel: ParticipanteSelecionado) =>
    persistir(
      () => apiAddAgendaItemParticipant(meeting.id, itemId, selecionadoParaPayload(sel)),
      language === "en" ? "Participant linked to the topic." : "Participante vinculado à pauta.",
    );

  /*
   * REMOÇÃO DE PARTICIPANTE — sempre com confirmação explícita.
   *
   *   do tema     só o vínculo com aquele tema (segue na reunião e nos demais)
   *   da reunião  aba Participantes; o cascade tira de todos os temas
   *
   * A chamada à API só acontece em `confirmarRemocao`. Cancelar apenas limpa o
   * estado. O backend aplica a regra sobre o estado atual do banco.
   */
  type RemocaoPendente =
    | { tipo: "tema"; itemId: string; participantId: string; confirmacao: ConfirmacaoRemocao }
    | { tipo: "reuniao"; participantId: string; confirmacao: ConfirmacaoRemocao };
  const [remocaoPendente, setRemocaoPendente] = useState<RemocaoPendente | null>(null);

  const pedirRemocaoDoTema = (itemId: string, tema: string, participantId: string, nome: string) =>
    setRemocaoPendente({
      tipo: "tema",
      itemId,
      participantId,
      confirmacao: confirmacaoRemoverDoTema(nome, tema, language === "en" ? "en" : "pt"),
    });

  const pedirRemocaoDaReuniao = (participantId: string, nome: string) =>
    setRemocaoPendente({
      tipo: "reuniao",
      participantId,
      // Temas a partir do detalhe já carregado (mesma relação do servidor).
      confirmacao: confirmacaoRemoverDaReuniao(
        nome,
        temasDoParticipante(meeting.agenda || [], participantId),
        language === "en" ? "en" : "pt",
        (meeting.participants || []).find((x) => x.participantId === participantId)?.inGovernanceBodyGroup
          ? meeting.category
          : null,
      ),
    });

  const confirmarRemocao = async () => {
    const pendente = remocaoPendente;
    if (!pendente) return;
    const ok =
      pendente.tipo === "tema"
        ? await persistir(
            () => apiRemoveAgendaItemParticipant(meeting.id, pendente.itemId, pendente.participantId),
            language === "en" ? "Participant removed from the topic." : "Participante removido do tema.",
          )
        : await persistir(
            () => apiRemoveParticipant(meeting.id, pendente.participantId),
            language === "en" ? "Participant removed from the meeting." : "Participante removido da reunião.",
          );
    if (ok) setRemocaoPendente(null);
  };

  /**
   * Postergar retira a pauta do fluxo desta reunião sem tê-la concluído.
   *
   * A pauta PERMANECE na posição original. Antes ela era removida do índice e
   * empurrada para o fim, com recálculo de todos os horários — uma reordenação
   * que ninguém pediu. O status "Postergado" já basta para tirá-la do fluxo
   * operacional em Anotações, e o registro histórico na reunião é preservado.
   */
  /**
   * Postergar — UMA chamada de domínio.
   *
   * O backend faz tudo numa transação: estado `postponed`, cópia na Biblioteca
   * com procedência estrutural, e auditoria. A coordenação antiga (PATCH aqui,
   * cópia local ali) nunca foi atômica — dava pauta postergada sem cópia.
   */
  const handlePostponeAgendaTopic = async (idx: number, title: string) => {
    const item = (meeting.agenda || [])[idx];
    if (!item) return;

    if (activeAgendaId === item.id) setActiveAgendaId(null);

    const ok = await persistir(
      () => apiPostponeAgendaItem(meeting.id, item.id),
      language === "en"
        ? "Topic postponed for future handling."
        : "Pauta postergada para tratamento futuro."
    );
    if (!ok) return;

    // A Biblioteca ganhou a cópia: recarrega para mostrá-la.
    onReloadAgendaTopics?.();
  };

  // Import standalones or pending FUPs into this meeting's agenda
  const handleImportAgendaItem = (ag: StandaloneAgenda | ActionItem, type: "standalone" | "fup") => {
    const defaultDuration = "00:30";
    const newAgendaItem: AgendaItem = {
      id: newId(),
      time: meeting.agenda && meeting.agenda.length > 0
        ? calculateNextTimeSlot(meeting.agenda[meeting.agenda.length - 1].time, meeting.agenda[meeting.agenda.length - 1].duration)
        : meeting.startTime,
      title: type === "standalone" 
        ? (ag as StandaloneAgenda).title 
        : `[REPORTE COBRANÇA FUP] ${(ag as ActionItem).title}`,
      duration: type === "standalone" ? (ag as StandaloneAgenda).duration || defaultDuration : "00:15",
      author: type === "standalone" ? (ag as StandaloneAgenda).author : (ag as ActionItem).assignedUser.name,
      /*
       * IDENTIDADE da pauta da Biblioteca. É o que vincula o item de reunião a
       * `agenda_topics` — o vínculo nunca é adivinhado pelo título, e duas
       * pautas homônimas continuam distintas.
       */
      agendaTopicId: type === "standalone" ? (ag as StandaloneAgenda).id : undefined
    };

    /*
     * POST direcionado: o banco gera o UUID e devolve a reunião inteira.
     * Nenhum id local é inventado para uma linha que vai existir no PostgreSQL.
     *
     * `persistirNovaPauta` já dispara o toast de sucesso OU de erro, a partir
     * do resultado real (ex.: 409 quando o tema já está vinculado). Um toast
     * de sucesso fixo aqui, disparado sem esperar a resposta, mentia quando a
     * chamada falhava — inclusive brigando na tela com o toast de erro real.
     */
    void persistirNovaPauta(newAgendaItem);
  };

  const handleAddLiveExtraTopic = (
    titleText: string,
    durationText: string,
    speakerText: string,
    /** Só existe quando o responsável foi escolhido no diretório corporativo. */
    speakerEntraObjectId?: string,
    /** Tema circular desta pauta. Só um fato; não altera o fluxo [EXTRA]. */
    circular = false,
    /** Ficha complementar (019/020). Sem tema mestre: gravada direto na pauta. */
    ficha?: { typeId?: string; natureId?: string; fup?: boolean; description?: string; participants?: ParticipanteSelecionado[] }
  ) => {
    if (!titleText.trim()) return;

    const tituloExtra = `[EXTRA] ${titleText.trim()}`;
    void (async () => {
      try {
        // 1) Cria o item [EXTRA].
        let atualizada = meetingFromApi(
          await apiAddAgendaItem(meeting.id, {
            title: tituloExtra,
            durationMinutes: durationText.trim() ? parseDurationMinutes(durationText) : undefined,
            responsibleLabel: speakerText.trim() || "Todos",
            responsibleEntraObjectId: speakerText.trim() ? speakerEntraObjectId : undefined,
            isCircularTheme: circular,
            agendaTopicTypeId: ficha?.typeId || undefined,
            agendaTopicNatureId: ficha?.natureId || undefined,
            description: ficha?.description?.trim() || undefined,
            generatesActionItem: ficha?.fup ?? false,
          }),
        );

        // 2) Vincula os participantes ao item recém-criado (o mais recente com
        //    este título). Cada um entra também na reunião (Opção A).
        const novo = [...(atualizada.agenda || [])].reverse().find((a) => a.title === tituloExtra);
        if (novo && (ficha?.participants?.length ?? 0) > 0) {
          for (const sel of ficha!.participants!) {
            atualizada = meetingFromApi(
              await apiAddAgendaItemParticipant(meeting.id, novo.id, selecionadoParaPayload(sel)),
            );
          }
        }

        setSelectedMeeting(atualizada);
        setMeetings((prev) => prev.map((m) => (m.id === atualizada.id ? atualizada : m)));
        triggerToast(language === "en" ? "Extra topic successfully added live!" : "Pauta Extraordinária cadastrada e horários recalculados!");
        avisarSeValidacaoReaberta(atualizada);
      } catch (error) {
        triggerToast(describeMeetingError(error, language));
      }
    })();
  };

  const calculateNextTimeSlot = (startTime: string, duration: string): string =>
    addDurationToTime(startTime, duration);


  const t = {
    back: language === "en" ? "Back to Meetings" : "Voltar para Reuniões",
    btnEdit: language === "en" ? "Edit Details" : "Editar Detalhes",
    btnJoin: language === "en" ? "Join Meeting" : "Entrar na Reunião",
    organizerLabel: language === "en" ? "Organizer" : "Organizador",
    objectiveTitle: language === "en" ? "Objective" : "Objetivo",
    agendaTitle: language === "en" ? "Agenda Summary" : "Resumo da Pauta",
    viewFullLink: language === "en" ? "View Full" : "Ver Completo",
    confirmedQuorum: language === "en" ? "Confirmed" : "Confirmados",
    secDetails: language === "en" ? "Meeting Details" : "Detalhes da Reunião",
    bodyLabel: language === "en" ? "Governance Body" : "Órgão de Governança",
    notInformed: language === "en" ? "Not informed" : "Não informado",
    noParticipants: language === "en" ? "No participants registered." : "Nenhum participante cadastrado.",
    noAgenda: language === "en" ? "No agenda topics registered." : "Nenhuma pauta cadastrada."
  };

  /**
   * Etapas do ANDAMENTO — não são valores de `Meeting.status`.
   * Clicar navega para a aba correspondente; não altera status.
   */
  const stages: Array<{ id: MeetingStage; label: string; tab: string }> = [
    { id: "preparation", label: language === "en" ? "Preparation" : "Preparação", tab: "Agendas" },
    // Nome FIXO "Validação". O estado (Pendente de envio / Aguardando aprovação /
    // Aprovado) é derivado de `agendaValidation` e mostrado no centro do donut.
    { id: "validation", label: language === "en" ? "Validation" : "Validação", tab: "Agendas" },
    { id: "in_meeting", label: language === "en" ? "In Meeting" : "Em Reunião", tab: "Agendas" },
    { id: "recording", label: language === "en" ? "Recording" : "Registro", tab: "Fup" },
    { id: "minutes", label: language === "en" ? "Minutes" : "Ata", tab: "Minutes" },
    { id: "finished", label: language === "en" ? "Finished" : "Finalizado", tab: "Minutes" }
  ];

  /*
   * Alimenta o Stepper. `approved` e `closed` continuam sendo a condicao de
   * "Finalizado" — nao ha atalho novo. Como nenhuma operacao desta onda produz
   * esses estados, a reuniao para na etapa Ata, que e a verdade: falta a
   * assinatura formal.
   */
  const minutesApproved = minutes?.status === "approved" || minutes?.status === "closed";

  /** IDs adiados. Para reunião real vêm do banco; senão, do estado local. */
  const postponedTopicIds = ehReuniaoReal
    ? (meeting.agenda || []).filter((ag) => ag.executionStatus === "postponed").map((ag) => ag.id)
    : Object.entries(topicStates)
    .filter(([, state]) => state === "Postergado")
    .map(([id]) => id);

  // `doneTopicIds` só entra para reunião de demonstração; a real deriva do
  // `executionStatus` que veio do banco.
  const concluidasIds = ehReuniaoReal
    ? (meeting.agenda || []).filter((ag) => ag.executionStatus === "completed").map((ag) => ag.id)
    : doneTopicIds;

  const agendaProgress = getAgendaProgress(meeting, concluidasIds, postponedTopicIds);
  const currentStage = getMeetingStage(meeting, agendaProgress, minutesApproved);
  const activeIndex = stageIndex(currentStage);

  /**
   * Estado da etapa "Validação" (nome fixo), derivado de `agendaValidation.status`
   * — não é status de reunião. Exibido no centro do donut SÓ quando a etapa ativa
   * é a Validação; nas demais etapas o donut segue exatamente como antes.
   */
  const validationStepState =
    statusValidacao === "approved"
      ? language === "pt" ? "Aprovado" : "Approved"
      : statusValidacao === "sent"
        ? language === "pt" ? "Aguardando aprovação" : "Awaiting approval"
        : language === "pt" ? "Pendente de envio" : "Pending send";

  // Percentual de CONCLUSÃO sobre as pautas que permaneceram no fluxo.
  // Adiadas ficam fora do denominador; ver `getAgendaProgress`.
  const completionPercentage = agendaProgress.percentage;

  // Anel de progresso: raio no meio do antigo donut (interno 30, externo 40).
  const ANEL_RAIO = 35;
  const ANEL_CIRCUNFERENCIA = 2 * Math.PI * ANEL_RAIO;

  // --- Derivados de Próximas Pautas (aba Pautas, execução) -----------------
  const notesTopics = (meeting.agenda || []).map((ag, index) => ({
    ag,
    index,
    status: getTopicStatus(ag)
  }));
  /**
   * Três desfechos distintos. Antes "Postergado" era somado a "Concluido" numa
   * única lista, e a pauta adiada aparecia contada como concluída.
   *
   * Próximas   = ainda serão tratadas nesta reunião
   * Concluídas = foram efetivamente tratadas
   * Postergadas = saíram do fluxo desta reunião sem terem sido tratadas
   */
  const isTopicDone = (item: AgendaItem, status: string) =>
    doneTopicIds.includes(item.id) || status === "Concluido";
  const isTopicPostponed = (item: AgendaItem, status: string) =>
    !isTopicDone(item, status) && status === "Postergado";

  const upcomingTopics = notesTopics.filter(
    ({ ag, status }) => !isTopicDone(ag, status) && !isTopicPostponed(ag, status)
  );
  const finishedTopics = notesTopics.filter(({ ag, status }) => isTopicDone(ag, status));
  const postponedTopics = notesTopics.filter(({ ag, status }) => isTopicPostponed(ag, status));

  /**
   * Biblioteca oferecida no painel Cronograma Anual da aba Pautas.
   *
   * Exclui o que se originou desta mesma reunião: uma pauta postergada gera
   * cópia na Biblioteca, e sem esse filtro ela reapareceria aqui com botão
   * "Vincular", permitindo reimportá-la para a reunião de onde acabou de sair.
   * O filtro é LOCAL: a cópia continua visível na Biblioteca e disponível para
   * qualquer outra reunião.
   *
   * Exclui também o que JÁ está vinculado a esta reunião — sem isso, o mesmo
   * tema continuava oferecido com botão "Vincular" depois de importado, e
   * cada clique criava outra cópia idêntica na pauta (bug real, sem barreira
   * nem aqui nem no servidor até esta correção).
   */
  const agendaTopicIdsJaVinculados = new Set(
    (meeting.agenda || [])
      .map((ag) => ag.agendaTopicId)
      .filter((id): id is string => Boolean(id))
  );
  const bibliotecaDisponivel = standaloneAgendas.filter(
    (ca) =>
      ca.sourceMeetingId !== meeting.id &&
      !agendaTopicIdsJaVinculados.has(ca.id) &&
      ca.title.toLowerCase().includes(annualSearch.toLowerCase())
  );

  // --- Faixa-resumo de planejamento da aba Pautas ---------------------------
  // Só dado que já chega ao front; nenhuma regra de negócio nova. Reusa os
  // helpers de tempo (`parseDurationMinutes`/`parseTimeToMinutes`). "Informar,
  // não impedir": estouro é avisado, nunca bloqueia salvar.
  const pautasArray = meeting.agenda || [];
  const totalPautas = pautasArray.length;
  const tempoPlanejadoMin = pautasArray.reduce((soma, ag) => soma + parseDurationMinutes(ag.duration), 0);
  const duracaoReuniaoMin = Math.max(
    0,
    parseTimeToMinutes(meeting.endTime) - parseTimeToMinutes(meeting.startTime),
  );
  /** Positivo = folga; negativo = estouro. `null` quando a reunião não tem janela. */
  const saldoTempoMin = duracaoReuniaoMin > 0 ? duracaoReuniaoMin - tempoPlanejadoMin : null;
  const pautasSemResponsavel = pautasArray.filter((ag) => !ag.author || ag.author.trim().length === 0).length;
  const pautasDaBiblioteca = pautasArray.filter((ag) => !!ag.agendaTopicId).length;
  // Contagens de desfecho (persistidas) — usadas na faixa de Execução/Resultado.
  const qtdeConcluidas = pautasArray.filter((ag) => ag.executionStatus === "completed").length;
  const qtdeAdiadas = pautasArray.filter((ag) => ag.executionStatus === "postponed").length;

  /** "1h20" / "45min" / "0min" — rótulo curto de duração para a faixa. */
  const formatarDuracao = (min: number): string => {
    const m = Math.max(0, Math.round(min));
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h > 0 ? (r > 0 ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`) : `${r}min`;
  };

  // --- Derivados da aba Visão Geral -----------------------------------------
  /** Quantos avatares cabem antes de agrupar o excedente. */
  const MAX_VISIBLE_PARTICIPANTS = 12;
  const allParticipants = meeting.participants || [];
  const totalParticipants = allParticipants.length;
  const confirmedCount = allParticipants.filter((p) => p.confirmed).length;
  const visibleParticipants = allParticipants.slice(0, MAX_VISIBLE_PARTICIPANTS);
  const hiddenParticipants = Math.max(0, totalParticipants - MAX_VISIBLE_PARTICIPANTS);

  /**
   * Status exibido na timeline da Visão Geral.
   * Mesma fonte da aba Pautas e das Anotações: `getTopicStatus`.
   */
  const getTimelineStatus = (item: AgendaItem) => getTopicStatus(item);

  // --- Faixa executiva da Visão Geral ---------------------------------------
  // Tudo derivado de dado que já chega ao front. Nenhuma regra de negócio nova.

  /** Nº de pautas da reunião. */
  const pautasCount = meeting.agenda?.length ?? meeting.agendaItemsCount ?? 0;

  /**
   * FUPs desta reunião pela origem ESTRUTURAL (`origin_meeting_id`) — a mesma
   * base da aba FUP, não o casamento por texto. "Em aberto" e "vencido" reusam
   * as definições já existentes (`status`): nenhuma definição nova é inventada.
   */
  const fupsDaReuniao = (actionItems || []).filter((a) => a.originMeetingId === meeting.id);
  const fupEmAberto = fupsDaReuniao.filter((a) => a.status !== "Completed");
  const fupVencidos = fupsDaReuniao.filter((a) => a.status === "Overdue");

  /**
   * Pautas classificadas como "Tema de FUP" (`generatesActionItem`) que ainda
   * não têm um FUP real vinculado — casamento por `originAgendaItemId`, o
   * mesmo id estrutural que `fupsDaReuniao` usa, nunca por título.
   */
  const pautasPendentesDeFup = (meeting.agenda || []).filter(
    (item) => item.generatesActionItem === true &&
      !fupsDaReuniao.some((fup) => fup.originAgendaItemId === item.id)
  );

  /** Rótulo amigável do status formal — mesmos textos da lista de Reuniões. */
  const statusFormalLabel =
    language === "en"
      ? meeting.status
      : (
          {
            "In Progress": "Iniciação",
            Scheduled: "Agendada",
            Done: "Concluído",
            Closed: "Fechado",
            "Needs Approval": "Requer Aprovação",
            Draft: "Rascunho",
          } as Record<string, string>
        )[meeting.status] ?? meeting.status;

  /** Duração derivada de start/end, quando ambos são horários válidos. */
  const duracaoLabel = (() => {
    const minutos = (t: string): number | null => {
      const m = (t || "").match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (!m) return null;
      let h = parseInt(m[1]!, 10);
      const mm = parseInt(m[2]!, 10);
      const mod = m[3]?.toUpperCase();
      if (mod === "PM" && h < 12) h += 12;
      if (mod === "AM" && h === 12) h = 0;
      return h * 60 + mm;
    };
    const ini = minutos(meeting.startTime);
    const fim = minutos(meeting.endTime);
    if (ini === null || fim === null || fim <= ini) return null;
    const d = fim - ini;
    const h = Math.floor(d / 60);
    const r = d % 60;
    return h > 0 ? (r > 0 ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`) : `${r}min`;
  })();

  /** Rótulo curto do convite para a faixa (o painel abaixo traz o detalhe). */
  const conviteCurto =
    estadoDoCalendario === "synced"
      ? language === "pt" ? "Enviado" : "Sent"
      : estadoDoCalendario === "failed"
        ? language === "pt" ? "Falha" : "Failed"
        : estadoDoCalendario === "stale"
          ? language === "pt" ? "Desatualizado" : "Outdated"
          : language === "pt" ? "Pendente" : "Pending";

  /**
   * Abre o modal de validação (mesma ação do botão original). Definido uma vez
   * e reusado pela faixa e pelo botão secundário "Reenviar pautas".
   */
  const abrirValidacao = () => {
    setErroValidacao(null);
    setEmailAprovador(validacao?.sentTo ?? "");
    setModalValidacaoAberto(true);
  };

  /**
   * PRÓXIMA AÇÃO da preparação, derivada dos MESMOS estados dos botões atuais e
   * apontando para os MESMOS handlers. Sem regra nova, sem autorização própria:
   * quem exibe decide entre botão (canSchedule) e texto informativo.
   *
   *   pautas em preparação      -> Enviar pautas para validação (abre modal)
   *   pautas enviadas           -> Marcar pautas como aprovadas
   *   aprovadas + convite aberto -> Enviar/Reenviar convite
   *   convite sincronizado       -> nada pendente (null)
   */
  const proximaAcao: { label: string; onClick: () => void; busy: boolean } | null = (() => {
    // Convite primeiro (025): a reunião já deveria estar reservada desde o
    // agendamento; pendente/falha é o que mais urge corrigir.
    if (permiteTentarNovamente(meeting.calendar)) {
      return {
        label:
          estadoDoCalendario === "pending"
            ? language === "pt" ? "Enviar convite da reunião" : "Send meeting invitation"
            : language === "pt" ? "Reenviar convite da reunião" : "Resend meeting invitation",
        onClick: handleSyncCalendar,
        busy: syncing,
      };
    }
    if (!pautasAprovadas) {
      if (statusValidacao === "sent") {
        return {
          label: language === "pt" ? "Marcar pautas como aprovadas" : "Mark agenda as approved",
          onClick: () => void handleAprovarPautas(),
          busy: aprovando,
        };
      }
      return {
        label: language === "pt" ? "Enviar pautas para validação" : "Send agenda for validation",
        onClick: abrirValidacao,
        busy: false,
      };
    }
    return null;
  })();

  return (
    <div className="space-y-6">
      {/* Upper header section with navigation & primary controls */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 md:p-8 card-shadow">
        <div className="mb-4">
          <button
            onClick={onBack}
            className="text-xs font-bold text-[#00658d] hover:text-[#00aeef] flex items-center gap-1 cursor-pointer transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t.back}
          </button>
        </div>

        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-5">
            <div className="space-y-4 flex-grow">
                <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-slate-900 leading-tight">
                    {meeting.title}
                </h1>
                
                <p className="text-slate-600 font-medium text-sm flex items-center gap-3">
                    <Calendar className="w-4 h-4 text-slate-400" />
                    {new Date(meeting.date + "T12:00:00").toLocaleDateString(language === "en" ? "en-US" : "pt-BR", {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric"
                    })}
                    • {(() => {
                    const to24h = (time: string) => {
                        const match = time.match(/(\d+):(\d+)\s*(AM|PM)?/i);
                        if (!match) return time;
                        let [_, h, m, mod] = match;
                        let hours = parseInt(h, 10);
                        if (mod) {
                        if (mod.toUpperCase() === 'PM' && hours < 12) hours += 12;
                        if (mod.toUpperCase() === 'AM' && hours === 12) hours = 0;
                        }
                        return `${String(hours).padStart(2, '0')}:${m}`;
                    };
                    return `${to24h(meeting.startTime)} - ${to24h(meeting.endTime)}`;
                    })()}
                    {duracaoLabel && <span className="text-slate-400">{` · ${duracaoLabel}`}</span>}
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto justify-start md:justify-end shrink-0 select-none">
              {/* Ações formais: únicos pontos que alteram Meeting.status.
                  Contextuais — só aparece a transição possível agora. */}
              {meeting.status === "In Progress" ? (
                <button
                  onClick={() => onUpdateStatus(meeting.id, "Done")}
                  className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 active:scale-95 text-white text-xs font-extrabold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  {language === "en" ? "End Meeting" : "Encerrar Reunião"}
                </button>
              ) : meeting.status !== "Done" && meeting.status !== "Closed" ? (
                <button
                  onClick={() => onUpdateStatus(meeting.id, "In Progress")}
                  disabled={!podeIniciar}
                  title={podeIniciar
                    ? undefined
                    : (language === "en" ? "Cannot start: " : "Não é possível iniciar: ") + pendenciasParaIniciar.join(language === "en" ? " and " : " e ")}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-extrabold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed disabled:active:scale-100"
                >
                  <Play className="w-3.5 h-3.5" />
                  {language === "en" ? "Start Meeting" : "Iniciar Reunião"}
                </button>
              ) : null}

                <button 
                  onClick={() => {
                    setEditedTitle(meeting.title || "");
                    setEditedSessionType(meeting.sessionType ?? "");
                    setEditedDescription(meeting.description || "");
                    setEditedDate(meeting.date || "");
                    setEditedStartTime(meeting.startTime || "");
                    setEditedEndTime(meeting.endTime || "");
                    setEditedGovernanceBodyId(meeting.governanceBodyId || "");
                    setEditedRecurrence(meeting.recurrence || "Single");
                    setEditedModality(meeting.modality ?? "online");
                    setEditedLocationKey(meeting.physicalLocation?.id ?? "");
                    setIsEditingMeeting(true);
                  }}
                  className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 text-xs font-extrabold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer border border-[#00658d]/10"
                >
                    <Pencil className="w-3.5 h-3.5 text-[#00658d]" />
                    {t.btnEdit}
                </button>
                {/*
                  ÚNICO "Entrar na reunião" da tela. Prioriza o join real do
                  Teams (`calendar.joinUrl`) e cai para `meetingLink` (campo
                  livre/legado) quando não houver — mantido como fallback de
                  compatibilidade. Sempre passa pelo `hrefSeguro`: link ausente
                  ou de esquema perigoso (javascript:, data:) não vira href.
                */}
                {hrefSeguro(meeting.calendar?.joinUrl ?? meeting.meetingLink) ? (
                  <a
                    href={hrefSeguro(meeting.calendar?.joinUrl ?? meeting.meetingLink)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-5 py-2.5 text-xs font-extrabold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white rounded-xl shadow-sm flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t.btnJoin}
                  </a>
                ) : (
                  <span
                    className="px-5 py-2.5 text-xs font-extrabold bg-slate-100 text-slate-400 rounded-xl flex items-center justify-center gap-2 cursor-not-allowed"
                    title={language === "en" ? "No valid meeting link" : "Sem link de reunião válido"}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t.btnJoin}
                  </span>
                )}
            </div>
        </div>

        {/* Subtab categories navigation list */}
        <nav className="flex gap-2 overflow-x-auto border-b border-slate-200 mt-8 pb-0 select-none">
          {[
            { id: "Overview", label: language === "en" ? "Overview" : "Visão Geral", icon: FileText },
            { id: "Agendas", label: language === "en" ? "Agenda" : "Pautas", icon: CheckSquare },
            { id: "Participants", label: language === "en" ? "Participants" : "Participantes", icon: Users },
            { id: "Documents", label: language === "en" ? "Documents" : "Documentos", icon: FolderOpen },
            { id: "Minutes", label: language === "en" ? "Minutes" : "Ata", icon: FileCheck },
            { id: "Fup", label: "FUP", icon: AlertCircle }
          ].map((tab) => {
            const isTabActive = activeSubTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveSubTab(tab.id)}
                className={`px-4 py-3 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all border-b-2 cursor-pointer flex items-center gap-2 ${
                  isTabActive
                    ? "border-[#00658d] text-[#00658d] bg-[#00658d]/5 rounded-t-lg"
                    : "border-transparent text-slate-500 hover:text-[#00658d] hover:bg-slate-50 rounded-t-lg"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
          );
        })}
      </nav>

      {activeSubTab === "Overview" && (
        <div className="mt-8 space-y-6">
          {/*
            FAIXA EXECUTIVA — resumo escaneável. Só estado curto; o detalhe
            (timestamps, aprovador, erros) fica no painel "Preparação" abaixo.
            A "Próxima ação" reusa os handlers existentes e só vira botão para
            quem tem canSchedule; sem a role, aparece como próxima ETAPA (texto).
            Estado nunca depende só de cor: há rótulo/ícone em cada item.
          */}
          <div className="rounded-2xl border border-slate-200/80 bg-white card-shadow px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 flex-1 min-w-0">
              {/* Status formal */}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                <span
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full ${
                    meeting.status === "Done" || meeting.status === "Closed"
                      ? "bg-emerald-500"
                      : meeting.status === "In Progress"
                        ? "bg-amber-500"
                        : "bg-sky-500"
                  }`}
                />
                <span className="text-slate-400 uppercase tracking-wide text-[9.5px]">Status</span>
                {statusFormalLabel}
              </span>
              {/* Validação das pautas */}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold">
                <FileText className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                <span className="text-slate-400 uppercase tracking-wide text-[9.5px]">
                  {language === "pt" ? "Validação" : "Validation"}
                </span>
                <span
                  className={
                    pautasAprovadas
                      ? "text-emerald-600"
                      : statusValidacao === "sent"
                        ? "text-amber-600"
                        : "text-slate-600"
                  }
                >
                  {pautasAprovadas
                    ? language === "pt" ? "Aprovadas" : "Approved"
                    : statusValidacao === "sent"
                      ? language === "pt" ? "Enviadas" : "Sent"
                      : language === "pt" ? "Em preparação" : "In preparation"}
                </span>
              </span>
              {/* Convite Outlook/Teams */}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold">
                <CalendarDays className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                <span className="text-slate-400 uppercase tracking-wide text-[9.5px]">
                  {language === "pt" ? "Convite" : "Invite"}
                </span>
                <span
                  className={
                    estadoDoCalendario === "synced"
                      ? "text-emerald-600"
                      : estadoDoCalendario === "failed"
                        ? "text-red-600"
                        : estadoDoCalendario === "stale"
                          ? "text-amber-600"
                          : "text-slate-600"
                  }
                >
                  {conviteCurto}
                </span>
              </span>
              {/* Nº de pautas */}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                <CheckSquare className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                {pautasCount} {language === "pt" ? "pautas" : "topics"}
              </span>
              {/* Participantes confirmados / total */}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                <Users className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                {confirmedCount}/{totalParticipants} {language === "pt" ? "confirmados" : "confirmed"}
              </span>
              {/* FUP em aberto (origem estrutural); destaca vencidos quando houver */}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                <AlertCircle
                  className={`w-3.5 h-3.5 ${fupVencidos.length > 0 ? "text-red-500" : "text-slate-400"}`}
                  aria-hidden="true"
                />
                {fupEmAberto.length} {language === "pt" ? "FUP em aberto" : "open FUP"}
                {fupVencidos.length > 0 && (
                  <span className="text-red-600">{` (${fupVencidos.length} ${language === "pt" ? "vencidos" : "overdue"})`}</span>
                )}
              </span>
            </div>

            {/* Próxima ação: botão só com canSchedule; senão, próxima etapa em texto. */}
            <div className="shrink-0 lg:border-l lg:border-slate-100 lg:pl-4 flex items-center">
              {proximaAcao ? (
                canSchedule ? (
                  <button
                    type="button"
                    onClick={proximaAcao.onClick}
                    disabled={proximaAcao.busy}
                    className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white text-xs font-extrabold rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                  >
                    {proximaAcao.busy
                      ? language === "pt" ? "Processando..." : "Working..."
                      : proximaAcao.label}
                  </button>
                ) : (
                  <span className="text-[11px] font-semibold text-slate-500">
                    <span className="text-slate-400 uppercase tracking-wide text-[9.5px]">
                      {language === "pt" ? "Próxima etapa" : "Next step"}
                    </span>{" "}
                    <span className="text-slate-700 font-bold">{proximaAcao.label}</span>
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  {language === "pt" ? "Preparação concluída" : "Preparation complete"}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Main Details block column */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              {/* Progress Status Stepper Indicator timeline */}
              <div className="flex flex-col md:flex-row gap-6 bg-white rounded-2xl p-6 border border-slate-200/95 card-shadow items-center">
                {/* Progress side */}
                <div className="flex-shrink-0 flex items-center justify-center border-b md:border-b-0 md:border-r border-slate-100 pb-4 md:pb-0 md:pr-6">
                    <div className="w-24 h-24 relative">
                        {/* Começa no topo e cresce no sentido horário. */}
                        <svg viewBox="0 0 96 96" className="w-full h-full -rotate-90" aria-hidden="true">
                            <circle cx="48" cy="48" r={ANEL_RAIO} fill="none" stroke="#f1f5f9" strokeWidth="10" />
                            <circle
                                cx="48"
                                cy="48"
                                r={ANEL_RAIO}
                                fill="none"
                                stroke="#10b981"
                                strokeWidth="10"
                                strokeDasharray={`${((completionPercentage ?? 0) / 100) * ANEL_CIRCUNFERENCIA} ${ANEL_CIRCUNFERENCIA}`}
                            />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none w-full h-full">
                            {currentStage === "validation" ? (
                              /* Etapa Validação: mostra o ESTADO (derivado) no
                                 lugar do 0% de execução, que não diz nada antes
                                 de a reunião começar. */
                              <>
                                <span className="text-[9px] font-extrabold text-[#00658d] uppercase tracking-wider text-center leading-tight px-1">
                                  {stages[activeIndex]?.label}
                                </span>
                                <span className="text-[8px] font-bold text-slate-500 text-center leading-tight px-1 mt-0.5">
                                  {validationStepState}
                                </span>
                              </>
                            ) : completionPercentage === null ? (
                              <span className="text-[9px] font-extrabold text-slate-400 uppercase tracking-wider text-center leading-tight px-1">
                                {stages[activeIndex]?.label}
                              </span>
                            ) : (
                              <>
                                <span className="text-xl font-extrabold text-slate-900">{completionPercentage}%</span>
                                <span className="text-[8.5px] font-bold text-slate-400 uppercase tracking-wider">
                                  {agendaProgress.done}/{agendaProgress.total} {language === "en" ? "topics" : "pautas"}
                                </span>
                              </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Stepper side */}
                {/* items-start: os círculos alinham pelo topo, então um rótulo
                    que quebra em duas linhas não desloca os demais passos. */}
                {/* Sem gap-1: com 6 etapas, o gap somado ao mx dos conectores
                    consumia a largura e deixava os conectores `flex-1` em 0px.
                    O espaçamento entre círculos vem dos próprios conectores. */}
                <div className="flex-grow flex items-start justify-between w-full">
                  {stages.map((stage, idx) => {
                    const completed = idx <= activeIndex;
                    const isCurrent = idx === activeIndex;

                    return (
                      <React.Fragment key={stage.id}>
                        <button
                          onClick={() => setActiveSubTab(stage.tab)}
                          title={language === "en" ? `Go to ${stage.label}` : `Ir para ${stage.label}`}
                          className={`relative flex flex-col items-center gap-2 group focus:outline-none shrink-0 cursor-pointer`}
                        >
                          <div
                            className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 ${
                              isCurrent || completed
                                ? "bg-emerald-600 text-white shadow-md"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {idx + 1}
                          </div>
                          {/* min-h reserva espaço de duas linhas: rótulos de
                              uma linha ficam com a mesma altura dos demais.
                              w-16 (não w-20): com 6 etapas os rótulos w-20
                              ocupavam a linha inteira e os conectores `flex-1`
                              ficavam sem espaço (0px) e sumiam. */}
                          <span className={`text-[10px] font-bold transition-colors text-center w-16 leading-tight min-h-[1.75rem] flex items-start justify-center ${
                            isCurrent || completed ? "text-slate-900" : "text-slate-400"
                          }`}>
                            {stage.label}
                          </span>
                        </button>
                        {idx < stages.length - 1 && (
                          <div className={`h-0.5 flex-1 mt-5 ${
                            idx < activeIndex ? "bg-emerald-600" : "bg-slate-200"
                          }`} />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Objective Content */}
              <div className="bg-white rounded-2xl p-6 md:p-8 border border-slate-200/95 card-shadow flex flex-col justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 mb-6 pb-2 border-b border-slate-100 uppercase tracking-wide">
                    {t.secDetails}
                  </h3>

                  {/* Cada informação com rótulo próprio. Data e horário não são
                      repetidos aqui: já aparecem no cabeçalho da reunião. */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 mb-8">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-[#00658d] shrink-0 border border-slate-200/40">
                        <Landmark className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          {t.bodyLabel}
                        </p>
                        <p className="text-sm font-bold text-slate-800 mt-0.5">
                          {meeting.category || t.notInformed}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-[#00658d] shrink-0 border border-slate-200/40">
                        <User className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          {t.organizerLabel}
                        </p>
                        <p className="text-sm font-bold text-slate-800 mt-0.5">
                          {meeting.organizer || t.notInformed}
                        </p>
                      </div>
                    </div>

                    {/* Modalidade (025). Presencial continua com Teams. */}
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-[#00658d] shrink-0 border border-slate-200/40">
                        {meeting.modality === "in_person" ? <MapPin className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          {language === "pt" ? "Modalidade" : "Format"}
                        </p>
                        <p className="text-sm font-bold text-slate-800 mt-0.5">
                          {meeting.modality === "in_person"
                            ? `${language === "pt" ? "Presencial" : "In person"} — ${meeting.physicalLocation ? locationLabel(meeting.physicalLocation) : t.notInformed}`
                            : "Online"}
                        </p>
                        {meeting.modality === "in_person" && (
                          <p className="text-[10px] text-slate-500 font-semibold">
                            {language === "pt" ? "Microsoft Teams como contingência" : "Microsoft Teams as fallback"}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-100">
                    <h4 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider mb-2.5">
                      {t.objectiveTitle}
                    </h4>
                    <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-line font-medium">
                      {meeting.description || t.notInformed}
                    </p>
                  </div>
                </div>
              </div>
            {/*
              PREPARAÇÃO DA REUNIÃO — validação das pautas + convite Outlook/Teams
              num painel só. O DETALHE operacional (status completo, aprovador,
              timestamps, falha do Graph, sem-e-mail, Teams) é preservado. As
              AÇÕES PRIMÁRIAS de cada etapa vivem na faixa executiva (Próxima
              ação); aqui ficam só ações SECUNDÁRIAS com finalidade distinta
              ("Reenviar pautas") e o ingresso no Teams — sem CTA duplicado.
            */}
            <div className="bg-white border border-slate-200 rounded-2xl card-shadow p-5 space-y-4">
              <h3 className="text-xs font-extrabold text-slate-900 uppercase tracking-widest">
                {language === "pt" ? "Preparação da reunião" : "Meeting preparation"}
              </h3>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Validação das pautas */}
                <div className="space-y-2 lg:border-r lg:border-slate-100 lg:pr-5">
                  <h4 className="text-[11px] font-extrabold text-slate-700 uppercase tracking-wide flex items-center gap-2">
                    <FileText className="w-4 h-4 text-[#00658d]" />
                    {language === "pt" ? "Validação das pautas" : "Agenda validation"}
                  </h4>
                  <p className="text-[11px] font-semibold">
                    <span
                      className={
                        pautasAprovadas
                          ? "text-emerald-600"
                          : statusValidacao === "sent"
                            ? "text-amber-600"
                            : "text-slate-500"
                      }
                    >
                      {pautasAprovadas
                        ? language === "pt" ? "Pautas aprovadas" : "Agenda approved"
                        : statusValidacao === "sent"
                          ? language === "pt" ? "Enviada para validação" : "Sent for validation"
                          : language === "pt" ? "Em preparação" : "In preparation"}
                    </span>
                    {statusValidacao === "sent" && validacao?.sentTo && (
                      <span className="text-slate-400">{` · ${validacao.sentTo}`}</span>
                    )}
                    {pautasAprovadas && validacao?.approvedAt && (
                      <span className="text-slate-400">
                        {` · ${new Date(validacao.approvedAt).toLocaleString(
                          language === "en" ? "en-US" : "pt-BR"
                        )}`}
                      </span>
                    )}
                  </p>
                  {!pautasAprovadas && (
                    <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                      {language === "pt"
                        ? "A aprovação das pautas é exigida para iniciar a reunião. O convite já sai no agendamento."
                        : "Agenda approval is required to start the meeting. The invitation is sent at scheduling."}
                    </p>
                  )}
                  {/*
                    Ação SECUNDÁRIA com finalidade própria: reenviar as pautas
                    (ex.: corrigir o aprovador) enquanto aguardam validação. A
                    ação PRIMÁRIA ("Marcar como aprovadas") fica na faixa acima —
                    não se repete aqui. Só `PGCP.Assessoria`: o servidor recusa
                    o resto.
                  */}
                  {canSchedule && statusValidacao === "sent" && (
                    <button
                      type="button"
                      onClick={abrirValidacao}
                      className="px-3 py-1.5 border border-[#00658d] text-[#00658d] hover:bg-[#00658d]/5 text-[11px] font-extrabold rounded-lg transition cursor-pointer"
                    >
                      {language === "pt" ? "Reenviar pautas" : "Resend agenda"}
                    </button>
                  )}
                  {erroValidacao && !modalValidacaoAberto && (
                    <p className="text-[11px] font-bold text-red-600">{erroValidacao}</p>
                  )}
                </div>

                {/* Outlook e Microsoft Teams */}
                <div className="space-y-2">
                  <h4 className="text-[11px] font-extrabold text-slate-700 uppercase tracking-wide flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-[#00658d]" />
                    {language === "pt" ? "Outlook e Microsoft Teams" : "Outlook and Microsoft Teams"}
                  </h4>
                  <p className="text-[11px] font-semibold">
                    <span
                      className={
                        estadoDoCalendario === "synced"
                          ? "text-emerald-600"
                          : estadoDoCalendario === "failed"
                            ? "text-red-600"
                            : estadoDoCalendario === "stale"
                              ? "text-amber-600"
                              : "text-slate-500"
                      }
                    >
                      {describeCalendarStatus(estadoDoCalendario, language === "en" ? "en" : "pt")}
                    </span>
                    {meeting.calendar?.lastSyncedAt && (
                      <span className="text-slate-400">
                        {" · "}
                        {new Date(meeting.calendar.lastSyncedAt).toLocaleString(
                          language === "en" ? "en-US" : "pt-BR"
                        )}
                      </span>
                    )}
                  </p>
                  {/*
                    Mensagem FUNCIONAL primeiro, depois o motivo que o servidor
                    gravou — `last_error` já é texto sanitizado (sem token,
                    payload, cabeçalho ou stack) e costuma ser acionável. A ação
                    de (re)enviar o convite fica na faixa (Próxima ação).
                  */}
                  {estadoDoCalendario === "failed" && (
                    <p className="text-[10px] text-red-600 font-bold leading-relaxed">
                      {language === "pt"
                        ? "Não foi possível atualizar o convite no Outlook e Microsoft Teams. A reunião continua salva no PGCP."
                        : "Could not update the Outlook and Microsoft Teams invitation. The meeting is still saved in PGCP."}
                    </p>
                  )}
                  {estadoDoCalendario === "failed" && meeting.calendar?.lastError && (
                    <p className="text-[10px] text-red-500 font-medium">
                      {meeting.calendar.lastError}
                    </p>
                  )}
                  {syncError && (
                    <p className="text-[11px] font-bold text-red-600">{syncError}</p>
                  )}

                  {/*
                    REUNIÃO DO TEAMS — estado, nunca ação de preparação. Ingressar
                    é distinto de (re)enviar o convite, então o link permanece.
                  */}
                  <div className="pt-2 border-t border-slate-100">
                    {meeting.onlineMeetingProvider ? (
                      /*
                        STATUS, não ação. O "Entrar na reunião" é único, no
                        cabeçalho, e já usa `calendar.joinUrl` como primário —
                        por isso o link de ingressar não se repete aqui.
                      */
                      <p className="text-[11px] font-extrabold text-slate-800 flex items-center gap-1.5 min-w-0">
                        <Video className="w-3.5 h-3.5 text-[#00658d]" />
                        Microsoft Teams
                      </p>
                    ) : (
                      <p className="text-[10px] text-slate-500 font-semibold leading-relaxed">
                        {language === "en"
                          ? "Legacy meeting: created before Teams became part of every PGCP meeting."
                          : "Reunião legada: criada antes de o Teams passar a fazer parte de toda reunião do PGCP."}
                      </p>
                    )}
                  </div>

                  {/* Quem impede o convite, nominalmente. */}
                  {semEndereco.length > 0 && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                      <p className="text-[11px] font-bold text-amber-800">
                        {language === "pt"
                          ? "Não foi possível obter o endereço corporativo — o convite não foi enviado a ninguém:"
                          : "The corporate address could not be resolved — the invitation was sent to nobody:"}
                      </p>
                      <ul className="mt-1.5 space-y-0.5">
                        {semEndereco.map((p) => (
                          <li key={p.participantId} className="text-[11px] text-amber-900 font-semibold">
                            • {p.displayName}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
              {/* Participantes: visão resumida — avatar e nome apenas.
                  Cargo e ações ficam na aba Participantes. */}
              <div className="bg-white rounded-2xl p-6 md:p-8 border border-slate-200/95 card-shadow">
                <div className="flex justify-between items-center mb-6 pb-2 border-b border-slate-100">
                  <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider">
                    {language === "en" ? "Participants" : "Participantes"}
                  </h3>
                  <span className="px-2.5 py-0.5 bg-slate-100 text-slate-600 font-bold text-xs rounded-full border border-slate-200">
                    {confirmedCount} / {totalParticipants} {t.confirmedQuorum}
                  </span>
                </div>

                <div className="flex flex-wrap gap-6 font-sans">
                  {totalParticipants === 0 ? (
                    <p className="text-slate-400 text-sm py-4 italic">{t.noParticipants}</p>
                  ) : (
                    <>
                      {visibleParticipants.map((p, idx) => (
                        <div key={idx} className="flex flex-col items-center text-center gap-1.5 w-18 select-none">
                          {p.avatarUrl ? (
                            <img
                              src={p.avatarUrl}
                              alt={p.name}
                              referrerPolicy="no-referrer"
                              className="w-14 h-14 rounded-full border-2 border-white shadow-sm ring-2 ring-slate-100 object-cover"
                            />
                          ) : (
                            <div className="w-14 h-14 rounded-full border-2 border-slate-200/50 bg-[#c6e7ff]/30 text-[#00658d] flex items-center justify-center font-bold text-sm shadow-xs select-none">
                              {getInitials(p.name)}
                            </div>
                          )}
                          <span className="text-xs font-bold text-slate-800 leading-snug truncate w-full">
                            {p.name}
                          </span>
                        </div>
                      ))}

                      {/* Excedente REAL, quando há mais participantes do que cabem. */}
                      {hiddenParticipants > 0 && (
                        <button
                          type="button"
                          onClick={() => setActiveSubTab("Participants")}
                          title={language === "en" ? "See all participants" : "Ver todos os participantes"}
                          className="flex flex-col items-center justify-center gap-1.5 w-18 cursor-pointer select-none"
                        >
                          <div className="w-14 h-14 rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center bg-slate-50 text-slate-500 font-bold hover:bg-slate-100 hover:border-[#00658d] hover:text-[#00658d] transition-colors">
                            +{hiddenParticipants}
                          </div>
                          <span className="text-xs font-bold text-slate-500">
                            {language === "en" ? "Others" : "Outros"}
                          </span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Right column sidebar summary */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-2xl p-6 border border-slate-200/95 card-shadow flex flex-col justify-between h-full">
                <div>
                  <div className="flex justify-between items-center mb-6 pb-2 border-b border-slate-100">
                    <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider block truncate">
                      {t.agendaTitle}
                    </h3>
                    <button
                      onClick={() => setActiveSubTab("Agendas")}
                      className="text-xs font-bold text-[#00658d] hover:underline flex items-center"
                    >
                      {t.viewFullLink}
                    </button>
                  </div>

                  {/* Agenda timeline list */}
                  <div className="relative space-y-5">
                    {meeting.agenda && meeting.agenda.length > 0 ? (
                      meeting.agenda.map((ag, index) => {
                        const timelineStatus = getTimelineStatus(ag);
                        const badge = TIMELINE_BADGES[timelineStatus];
                        return (
                          <div key={ag.id} className="relative pl-7 group">
                            {/* Conector: vai do centro deste marcador até o
                                centro do próximo (20px de space-y-5 + 11px).
                                O último item não recebe conector. */}
                            {index < meeting.agenda!.length - 1 && (
                              <div className="absolute left-[10px] top-[11px] -bottom-[31px] w-0.5 bg-slate-100" />
                            )}
                            {/* Marcador: 10px de largura em left-6px -> centro em 11px,
                                exatamente o centro do conector. */}
                            <div className="absolute left-[6px] top-1.5 w-2.5 h-2.5 rounded-full bg-white ring-2 ring-[#00aeef] group-hover:bg-[#00aeef] transition-colors" />
                            <p className="text-[10px] font-bold text-[#00658d] mb-0.5 font-sans whitespace-nowrap">
                              {ag.time}
                            </p>
                            <p className="text-xs font-bold text-slate-900 leading-snug">
                              {ag.title}
                            </p>
                            <p className="text-[10px] text-slate-400 font-medium mt-1">
                              {ag.duration} {ag.author ? `• ${ag.author}` : ""}
                              <span className={`ml-2 font-semibold text-[9px] px-1.5 py-0.5 rounded ${badge.className}`}>
                                {language === "en" ? badge.labelEn : badge.labelPt}
                              </span>
                            </p>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-slate-400 text-xs py-4 pl-6 italic">{t.noAgenda}</p>
                    )}
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === "Agendas" && (
        // ---------------------------------------------------------------------
        // SUBTAB AGENDAS - ITEM 3 (BIDIRECTIONAL ALIGNMENT / ANNUAL OR FUP VINCULATION)
        // ---------------------------------------------------------------------
        <div className="mt-8 space-y-6">
          {/*
            FAIXA-RESUMO por MODO — só dado já derivado, sem cálculo novo.
            Planejamento: tempo e pendências. Execução: pauta atual/próxima e
            desfechos. Resultado: contagem por status. Informa, nunca bloqueia.
          */}
          {modoPlanejamento ? (
          <div className="rounded-2xl border border-slate-200/80 bg-white card-shadow px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
              <CheckSquare className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              {totalPautas} {language === "pt" ? "pautas" : "topics"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
              <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span className="text-slate-400 uppercase tracking-wide text-[9.5px]">
                {language === "pt" ? "Planejado" : "Planned"}
              </span>
              {formatarDuracao(tempoPlanejadoMin)}
              {duracaoReuniaoMin > 0 && <span className="text-slate-400">{` / ${formatarDuracao(duracaoReuniaoMin)}`}</span>}
            </span>
            {saldoTempoMin !== null && (
              saldoTempoMin >= 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
                  {formatarDuracao(saldoTempoMin)} {language === "pt" ? "disponíveis" : "available"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-red-600">
                  <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  {language === "pt"
                    ? `Excede a duração da reunião em ${formatarDuracao(-saldoTempoMin)}`
                    : `Exceeds the meeting length by ${formatarDuracao(-saldoTempoMin)}`}
                </span>
              )
            )}
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold ${pautasSemResponsavel > 0 ? "text-amber-600" : "text-slate-700"}`}>
              <User className={`w-3.5 h-3.5 ${pautasSemResponsavel > 0 ? "text-amber-500" : "text-slate-400"}`} aria-hidden="true" />
              {pautasSemResponsavel} {language === "pt" ? "sem responsável" : "without owner"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
              <Calendar className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              {pautasDaBiblioteca} {language === "pt" ? "da Biblioteca" : "from Library"}
            </span>
          </div>
          ) : modoExecucao ? (
          <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/40 card-shadow px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            {(() => {
              const atual = pautasArray.find((a) => a.id === activeAgendaId) ?? null;
              const proxima = pautasArray.find((a) => a.id !== activeAgendaId && getTopicStatus(a) === "Pendente") ?? null;
              return (
                <>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-800">
                    <Play className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                    {language === "pt" ? "Pauta atual:" : "Current:"}{" "}
                    <strong className="text-slate-900">
                      {atual ? atual.title : (language === "pt" ? "nenhuma em discussão" : "none in discussion")}
                    </strong>
                  </span>
                  {atual && timeLeft !== null && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
                      <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                      {formatTime(timeLeft)}
                    </span>
                  )}
                  {proxima && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
                      {language === "pt" ? "Próxima:" : "Next:"} {proxima.title}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                    {qtdeConcluidas} {language === "pt" ? "concluídas" : "done"} · {qtdeAdiadas} {language === "pt" ? "adiadas" : "postponed"}
                  </span>
                </>
              );
            })()}
          </div>
          ) : (
          <div className="rounded-2xl border border-slate-200/80 bg-white card-shadow px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
              <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
              {qtdeConcluidas} {language === "pt" ? "concluídas" : "done"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-600">
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
              {qtdeAdiadas} {language === "pt" ? "adiadas" : "postponed"}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
              {totalPautas} {language === "pt" ? "no total" : "total"}
            </span>
          </div>
          )}

          {/* Planejamento: agenda (2/3) + Biblioteca (1/3). Execução/Resultado:
              a agenda ocupa a largura toda e a Biblioteca não aparece. */}
          <div className={`grid grid-cols-1 gap-8 ${modoPlanejamento ? "lg:grid-cols-3" : ""}`}>
          <div className={modoPlanejamento ? "lg:col-span-2 space-y-6" : "space-y-6"}>
            <div className="bg-white border border-slate-200 p-6 md:p-8 rounded-2xl card-shadow">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-4 border-b border-slate-100">
                <div>
                  <h3 className="text-base font-extrabold text-slate-900 uppercase tracking-wide">
                    {modoExecucao
                      ? (language === "en" ? "Pautas · Live Meeting" : "Pautas · Reunião ao Vivo")
                      : modoResultado
                      ? (language === "en" ? "Pautas · Result" : "Pautas · Resultado")
                      : (language === "en" ? "Agendas & Topics · Preparation" : "Pautas e Temas · Preparação")}
                  </h3>
                  <p className="text-xs text-slate-400 font-semibold mt-0.5">
                    {modoExecucao
                      ? (language === "en"
                          ? "Conduct the meeting: start, approve, postpone and time each topic."
                          : "Conduza a reunião: inicie, aprove, adie e cronometre cada pauta.")
                      : modoResultado
                      ? (language === "en"
                          ? "Read-only outcome of the executed agenda."
                          : "Leitura do desfecho da agenda executada.")
                      : (language === "en"
                          ? "Create agendas and add topics to them: order, owners, duration and recurring theme."
                          : "Crie as pautas e inclua os temas de cada uma: ordem, responsáveis, duração e Tema circular.")}
                  </p>
                </div>
                {meeting.status === "In Progress" && (
                  <div className="px-3 py-1.5 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-lg border border-emerald-200 animate-pulse flex items-center gap-1.5 self-start sm:self-auto">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 block"></span>
                    {language === "en" ? "TRANSMITTING LIVE" : "SESSÃO ONLINE AO VIVO"}
                  </div>
                )}
              </div>

              {/*
                PREPARAÇÃO (025): crie as PAUTAS (ex.: Finanças, Auditoria) e
                inclua TEMAS nelas — direto aqui ou vinculando da Biblioteca.
              */}
              {canSchedule && modoPlanejamento && (
                <div className="mb-6 p-4 bg-slate-50/70 border border-slate-200 rounded-2xl space-y-3">
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                    <div className="flex-1 flex flex-col gap-1">
                      <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                        {language === "pt" ? "Nova pauta" : "New agenda"}
                      </label>
                      <input
                        value={novaPautaTitulo}
                        onChange={(e) => setNovaPautaTitulo(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void criarPauta(); } }}
                        placeholder={language === "pt" ? "Ex.: Finanças" : "e.g. Finance"}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs"
                      />
                    </div>
                    <button type="button" onClick={() => void criarPauta()} disabled={isPersisting || !novaPautaTitulo.trim()}
                      className="px-3 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                      <FolderPlus className="w-3.5 h-3.5" />{language === "pt" ? "Criar pauta" : "Create agenda"}
                    </button>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                    <div className="flex-1 flex flex-col gap-1">
                      <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                        {language === "pt" ? "Novo tema" : "New topic"}
                      </label>
                      <input
                        value={novoTemaTitulo}
                        onChange={(e) => setNovoTemaTitulo(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void criarTema(); } }}
                        placeholder={language === "pt" ? "Ex.: Resultado do trimestre" : "e.g. Quarterly results"}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1 sm:w-44">
                      <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                        {language === "pt" ? "Na pauta" : "In agenda"}
                      </label>
                      <select value={pautaDestinoId} onChange={(e) => setPautaDestinoId(e.target.value)}
                        className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs cursor-pointer">
                        <option value="">{language === "pt" ? "Sem pauta" : "No agenda"}</option>
                        {(meeting.agendas ?? []).map((a) => (
                          <option key={a.id} value={a.id}>{a.title}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1 sm:w-36">
                      <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                        {language === "pt" ? "Duração" : "Duration"}
                      </label>
                      <DurationHoursMinutesSelect
                        language={language}
                        value={novoTemaDuracao}
                        onChangeMinutes={(m) => setNovoTemaDuracao(formatMinutesAsTime(m))}
                        selectClassName="w-full bg-white border border-slate-200 rounded-xl px-2 py-2 text-xs cursor-pointer"
                      />
                    </div>
                    <button type="button" onClick={() => void criarTema()} disabled={isPersisting || !novoTemaTitulo.trim()}
                      className="px-3 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                      <Plus className="w-3.5 h-3.5" />{language === "pt" ? "Incluir tema" : "Add topic"}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 font-semibold">
                    {language === "pt"
                      ? "Temas vinculados da Biblioteca (ao lado) também entram na pauta selecionada em \"Na pauta\". Responsável, participantes e ficha completa: use Editar no tema."
                      : "Topics pulled from the Library (right) also go into the agenda selected above. Owner, participants and details: use Edit on the topic."}
                  </p>
                </div>
              )}

              {/* Dynamic timelines of topics */}
              <div className="relative space-y-4">
                <div className="absolute left-4.5 top-3.5 bottom-3.5 w-0.5 bg-slate-100" />

                {temasPorPauta(meeting.agendas ?? [], meeting.agenda || []).map((grupo) => (
                  <React.Fragment key={grupo.agenda?.id ?? "sem-pauta"}>
                  {/* Cabeçalho da PAUTA — só quando a reunião usa pautas (025). */}
                  {(meeting.agendas?.length ?? 0) > 0 && (
                    <div className="relative z-10 flex items-center justify-between gap-2 pt-2">
                      <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-[#00658d] bg-white pr-2 flex items-center gap-1.5">
                        {grupo.agenda
                          ? `${language === "pt" ? "Pauta" : "Agenda"}: ${grupo.agenda.title}`
                          : language === "pt" ? "Temas sem pauta" : "Topics without agenda"}
                        <span className="text-slate-400 font-bold normal-case tracking-normal">
                          ({grupo.temas.length} {language === "pt" ? "tema(s)" : "topic(s)"})
                        </span>
                      </h4>
                      {grupo.agenda && canSchedule && modoPlanejamento && (
                        <span className="flex items-center gap-1 bg-white">
                          <button type="button" onClick={() => renomearPauta(grupo.agenda!.id, grupo.agenda!.title)}
                            className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer" title={language === "pt" ? "Renomear pauta" : "Rename agenda"}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {grupo.temas.length === 0 && (
                            <button type="button" onClick={() => excluirPauta(grupo.agenda!.id)}
                              className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer" title={language === "pt" ? "Excluir pauta" : "Delete agenda"}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                  {grupo.agenda && grupo.temas.length === 0 && (
                    <p className="relative z-10 pl-12 text-[10px] text-slate-400 font-semibold">
                      {language === "pt" ? "Nenhum tema nesta pauta ainda." : "No topics in this agenda yet."}
                    </p>
                  )}
                  {grupo.temas.map((ag) => {
                  // Índice na ordem GLOBAL (`position`): mover/arrastar/adiar
                  // continuam operando sobre a lista completa.
                  const index = (meeting.agenda || []).indexOf(ag);
                  const currentStatus = getTopicStatus(ag);
                  const isCurrent = activeAgendaId === ag.id;

                  return (
                    <div 
                      key={ag.id} 
                      draggable={canSchedule && modoPlanejamento}
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragLeave={() => setHoveredOverIndex(null)}
                      onDrop={(e) => handleDrop(e, index)}
                      className={`relative pl-12 pr-4 py-3 rounded-xl border transition-all cursor-grab active:cursor-grabbing group select-none ${
                        isCurrent 
                          ? "border-[#00658d] bg-white shadow-md z-20"
                          : currentStatus === "Concluido"
                          ? "border-emerald-200 bg-emerald-50"
                          : currentStatus === "Postergado"
                          ? "border-amber-200 bg-amber-50"
                          : "border-slate-100 bg-white"
                      } ${draggedIndex === index ? "opacity-40 scale-[0.98]" : ""} ${hoveredOverIndex === index ? "border-dashed border-[#00658d] !bg-cyan-50" : ""}`}
                    >
                      {/* Left vertical drag handle */}
                      <div className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-300 group-hover:text-slate-400 transition-colors">
                        <GripVertical className="w-3.5 h-3.5" />
                      </div>

                      {/* Left timeline badge button */}
                      <div className={`absolute left-5.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ring-2 ring-white select-none ${
                        currentStatus === "Concluido"
                          ? "bg-emerald-500 text-white"
                          : currentStatus === "Postergado"
                          ? "bg-amber-500 text-white"
                          : isCurrent
                          ? "bg-[#00658d] text-white animate-pulse"
                          : "bg-slate-200 text-slate-600"
                      }`}>
                        {currentStatus === "Concluido" ? "✓" : currentStatus === "Postergado" ? "⇥" : index + 1}
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[10.5px] font-extrabold text-[#00658d] bg-[#00658d]/5 px-1.5 py-0.5 rounded">
                              {ag.time} ({ag.duration})
                            </span>
                            
                            {/* Theme status indicator pill */}
                            <span className={`px-2 py-0.5 text-[8.5px] font-extrabold rounded uppercase tracking-wider ${
                              currentStatus === "Concluido"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                : currentStatus === "Postergado"
                                ? "bg-amber-50 text-amber-700 border border-amber-100"
                                : isCurrent
                                ? "bg-blue-50 text-blue-700 border border-blue-100 animate-pulse"
                                : "bg-slate-100 text-slate-500"
                            }`}>
                              {currentStatus === "Apresentando" ? (
                                <span className="flex items-center gap-1.5">
                                  {language === "pt" ? "Em Discussão" : "IN DISCUSSION"}
                                  {activeAgendaId === ag.id && timeLeft !== null && (
                                    <span className="bg-blue-200 text-blue-900 rounded px-1.5 py-0.5 text-[9px] font-mono">
                                      {formatTime(timeLeft)}
                                    </span>
                                  )}
                                </span>
                              ) : currentStatus === "Concluido" && language === "pt" ? "Aprovado" : currentStatus === "Postergado" && language === "pt" ? "Adiado" : language === "pt" && currentStatus === "Pendente" ? "Não Iniciado" : currentStatus}
                            </span>
                          </div>
 
                          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-xs font-extrabold text-slate-900">{ag.title}</h4>
                            {/* Selo só quando circular. "Não circular" nunca aparece. */}
                            {ag.isCircularTheme && (
                              <span className="text-[9px] font-extrabold uppercase tracking-wider text-[#00658d] bg-[#c6e7ff]/50 px-1.5 py-0.5 rounded">
                                {language === "pt" ? "Circular" : "Recurring"}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-400 font-semibold flex items-center gap-1">
                            <User className="w-3 h-3 text-slate-400" />
                            Responsável: {ag.author || "Definido no ato"}
                          </p>
                          {canSchedule && modoPlanejamento && (meeting.agendas?.length ?? 0) > 0 && (
                            <select
                              value={ag.agendaId ?? ""}
                              onChange={(e) => moverTemaDePauta(ag, e.target.value)}
                              onMouseDown={(e) => e.stopPropagation()}
                              disabled={isPersisting}
                              aria-label={language === "pt" ? "Pauta do tema" : "Topic agenda"}
                              className="mt-1 bg-white border border-slate-200 rounded-lg px-2 py-0.5 text-[10px] font-semibold text-slate-600 cursor-pointer"
                            >
                              <option value="">{language === "pt" ? "Sem pauta" : "No agenda"}</option>
                              {(meeting.agendas ?? []).map((a) => (
                                <option key={a.id} value={a.id}>{a.title}</option>
                              ))}
                            </select>
                          )}
                        </div>
 
                        {/* Control buttons & reordering controls during execution */}
                        <div className="flex items-center gap-3 shrink-0 select-none">
                          {/* Reordenar — planejamento e com canSchedule (o servidor exige PGCP.Assessoria). */}
                          {canSchedule && modoPlanejamento && (
                          <div className="flex flex-col gap-0.5">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMoveAgendaItem(index, "up");
                              }}
                              disabled={index === 0}
                              className={`p-0.5 rounded hover:bg-slate-100 transition-colors ${
                                index === 0 ? "text-slate-200 cursor-not-allowed" : "text-slate-500 hover:text-slate-800 cursor-pointer"
                              }`}
                              title={language === "en" ? "Move Up" : "Mover para Cima"}
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMoveAgendaItem(index, "down");
                              }}
                              disabled={index === (meeting.agenda || []).length - 1}
                              className={`p-0.5 rounded hover:bg-slate-100 transition-colors ${
                                index === (meeting.agenda || []).length - 1 ? "text-slate-200 cursor-not-allowed" : "text-slate-500 hover:text-slate-800 cursor-pointer"
                              }`}
                              title={language === "en" ? "Move Down" : "Mover para Baixo"}
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          )}

                          {/* Quick action buttons */}
                          <div className="flex gap-1 items-center">
                            {/* Documento do TEMA: mesmo diálogo da aba Documentos, com o tema já escolhido. */}
                            {podeAdicionarDocumento && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEnvioDeDocumento(ag.id);
                                }}
                                className="p-1.5 text-slate-400 hover:text-[#00658d] hover:bg-slate-100 rounded transition-all cursor-pointer"
                                title={language === "en" ? "Add document to this topic" : "Adicionar documento ao tema"}
                                aria-label={language === "en" ? `Add document to ${ag.title}` : `Adicionar documento ao tema ${ag.title}`}
                              >
                                <Paperclip className="w-4 h-4" />
                              </button>
                            )}
                            {/* Editar pauta — modal com título, duração e
                                responsável (PATCH). Preserva UUID e agendaTopicId.
                                Só no planejamento e com canSchedule; o servidor revalida. */}
                            {canSchedule && modoPlanejamento && (
                              <button
                                type="button"
                                onClick={() => abrirEdicaoPauta(ag)}
                                className="p-1.5 text-slate-400 hover:text-[#00658d] hover:bg-slate-100 rounded transition-all cursor-pointer"
                                title={language === "en" ? "Edit topic" : "Editar pauta"}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}

                              {/*
                                CONDUZIR A PAUTA — iniciar, aprovar, postergar,
                                redefinir. Só no modo EXECUÇÃO (reunião In Progress):
                                conduzir não é planejar. Todas exigem `PGCP.Assessoria`
                                no servidor; sem a role o botão não aparece, porque
                                oferecer o que responde 403 não é informação.
                              */}
                              {canSchedule && modoExecucao && (<>
                              {currentStatus === "Pendente" && (
                                <button
                                  onClick={() => handleStartAgendaTopic(ag)}
                                  className="p-1.5 text-slate-400 hover:text-[#00658d] hover:bg-cyan-50 rounded transition-all cursor-pointer"
                                  title={language === "en" ? "Start" : "Iniciar"}
                                >
                                  <Play className="w-4 h-4 fill-current" />
                                </button>
                              )}
                              {isCurrent && (
                                <button
                                  onClick={() => handleCompleteAgendaTopic(ag)}
                                  className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-all cursor-pointer"
                                  title={language === "en" ? "Approve" : "Aprovar"}
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                              )}
                              {currentStatus !== "Postergado" && currentStatus !== "Concluido" && (
                                <button
                                  onClick={() => handlePostponeAgendaTopic(index, ag.title)}
                                  className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-all cursor-pointer"
                                  title={language === "en" ? "Postpone topic to next session" : "Adiar tema para próxima pauta"}
                                >
                                  <Clock className="w-4 h-4" />
                                </button>
                              )}
                            {currentStatus !== "Pendente" && (
                              <button
                                onClick={() => {
                                  if (activeAgendaId === ag.id) setActiveAgendaId(null);
                                  if (ehReuniaoReal) {
                                    void persistirEstadoDaPauta(
                                      ag,
                                      "pending",
                                      language === "en" ? "Status reset." : "Estado da pauta redefinido."
                                    );
                                    return;
                                  }
                                  setTopicState(ag.id, null);
                                  setDoneTopicIds(prev => prev.filter(id => id !== ag.id));
                                }}
                                className="p-1 text-slate-350 hover:text-red-500 rounded hover:bg-slate-100 transition cursor-pointer"
                                title={language === "en" ? "Reset Status" : "Resetar estado"}
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            )}
                              </>)}

                            {canSchedule && modoPlanejamento && (
                              <button
                                onClick={() => setPautaParaExcluir(ag)}
                                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-all cursor-pointer"
                                title={language === "en" ? "Delete Item" : "Excluir Item"}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    );
                  })}
                  </React.Fragment>
                ))}
              </div>

              {/* Pauta extraordinária — só no modo Execução (reunião In Progress). */}
              {modoExecucao && (
              <div className="mt-6 pt-5 border-t border-slate-100 select-none">
                {isExtraFormOpen ? (
                  <div className="bg-slate-50/60 border border-slate-200 rounded-2xl p-4 space-y-3 animate-fade-in text-xs">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="font-extrabold text-slate-800 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                        <PlusCircle className="w-4 h-4 text-[#00aeef]" />
                        Nova Pauta de Assunto Extraordinário
                      </span>
                      <button
                        type="button"
                        onClick={() => { setExtraCircular(false); setIsExtraFormOpen(false); }}
                        className="text-slate-400 hover:text-slate-600 transition"
                      >
                        Cancelar
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-6 flex flex-col gap-1">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase">Assunto / Tema da Pauta</label>
                        <input
                          type="text"
                          value={extraTitle}
                          onChange={(e) => setExtraTitle(e.target.value)}
                          placeholder="Ex: Alocação emergencial de investimentos no projeto X"
                          className="w-full bg-white border border-slate-205 rounded-xl p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none"
                        />
                      </div>

                      <div className="md:col-span-3 flex flex-col gap-1">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase">Responsável</label>
                        {/* Pessoas vêm do diretório corporativo. O coletivo
                            "Todos (Conselho)" continua disponível: responsável
                            nem sempre é uma pessoa. */}
                        <DirectoryUserPicker
                          language={language}
                          selected={extraSpeakerUser}
                          selectedLabel={extraSpeaker || null}
                          placeholder="Buscar no diretório..."
                          onSelect={(user) => {
                            setExtraSpeaker(user.displayName ?? directoryEmail(user) ?? "");
                            setExtraSpeakerUser(user);
                          }}
                          onClear={() => {
                            setExtraSpeaker("");
                            setExtraSpeakerUser(null);
                          }}
                        />
                        {!extraSpeaker && (
                          <button
                            type="button"
                            onClick={() => {
                              setExtraSpeaker("Todos");
                              setExtraSpeakerUser(null);
                            }}
                            className="self-start text-[10px] font-extrabold uppercase tracking-wider text-[#00658d] hover:underline cursor-pointer"
                          >
                            Todos (Conselho)
                          </button>
                        )}
                      </div>

                      <div className="md:col-span-3 flex flex-col gap-1">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase font-sans">Duração Estimada</label>
                        <DurationHoursMinutesSelect
                          language={language}
                          value={extraDuration}
                          onChangeMinutes={(m) => setExtraDuration(formatMinutesAsTime(m))}
                          selectClassName="w-full bg-white border border-slate-205 rounded-xl p-2.5 text-xs text-slate-705 cursor-pointer focus:outline-none"
                        />
                      </div>

                      {/* Tema circular: só REGISTRA um fato da pauta. Sem automação,
                          nem no "Sim". Default visual "Não". */}
                      <div className="md:col-span-3 flex flex-col gap-1">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase font-sans">Tema circular?</label>
                        <select
                          value={extraCircular ? "sim" : "nao"}
                          onChange={(e) => setExtraCircular(e.target.value === "sim")}
                          className="w-full bg-white border border-slate-205 rounded-xl p-2.5 text-xs text-slate-705 cursor-pointer focus:outline-none"
                        >
                          <option value="nao">Não</option>
                          <option value="sim">Sim</option>
                        </select>
                      </div>
                    </div>

                    {/* Complementar (019) — recolhível, para não pesar a operação
                        ao vivo. Mesma ficha; pode ser completada depois via Editar. */}
                    <button
                      type="button"
                      onClick={() => setExtraFichaAberta((v) => !v)}
                      className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-[#00658d] hover:underline cursor-pointer"
                    >
                      {extraFichaAberta ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {language === "en" ? "More details (type, nature, FUP, description)" : "Mais detalhes (tipo, natureza, FUP, descrição)"}
                    </button>

                    {extraFichaAberta && (
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-1">
                        <div className="md:col-span-4 flex flex-col gap-1">
                          <label className="text-[10px] font-extrabold text-slate-500 uppercase">Tipo</label>
                          <select
                            value={extraTypeId}
                            onChange={(e) => setExtraTypeId(e.target.value)}
                            className="w-full bg-white border border-slate-205 rounded-xl p-2.5 text-xs text-slate-705 cursor-pointer focus:outline-none"
                          >
                            <option value="">— Sem tipo —</option>
                            {pautaTypes.map((pt) => (
                              <option key={pt.id} value={pt.id}>{pt.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="md:col-span-4 flex flex-col gap-1">
                          <label className="text-[10px] font-extrabold text-slate-500 uppercase">Natureza</label>
                          <select
                            value={extraNatureId}
                            onChange={(e) => setExtraNatureId(e.target.value)}
                            className="w-full bg-white border border-slate-205 rounded-xl p-2.5 text-xs text-slate-705 cursor-pointer focus:outline-none"
                          >
                            <option value="">— Sem natureza —</option>
                            {pautaNatures.map((pn) => (
                              <option key={pn.id} value={pn.id}>{pn.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="md:col-span-4 flex items-end">
                          <label className="flex items-center gap-2 cursor-pointer select-none pb-2">
                            <input
                              type="checkbox"
                              checked={extraFup}
                              onChange={(e) => setExtraFup(e.target.checked)}
                              className="w-4 h-4 accent-[#00658d] cursor-pointer"
                            />
                            <span className="text-[10px] font-extrabold text-slate-500 uppercase">Tema de FUP</span>
                          </label>
                        </div>
                        <div className="md:col-span-12 flex flex-col gap-1">
                          <label className="text-[10px] font-extrabold text-slate-500 uppercase">Descrição / Objetivo de Debate</label>
                          <textarea
                            rows={2}
                            value={extraDescription}
                            onChange={(e) => setExtraDescription(e.target.value)}
                            className="w-full bg-white border border-slate-205 rounded-xl p-2.5 text-xs text-slate-800 focus:outline-none resize-none font-sans"
                          />
                        </div>
                        <div className="md:col-span-12 flex flex-col gap-1">
                          <label className="text-[10px] font-extrabold text-slate-500 uppercase">Participantes da pauta</label>
                          <ParticipantPicker
                            language={language}
                            sugestao={{ governanceBodyId: meeting.governanceBodyId, rotuloOrgao: meeting.category }}
                            placeholder="Adicionar participante..."
                            jaEscolhidos={{
                              entraIds: extraParticipants.flatMap((x) => (x.origem === "entra" ? [x.user.id] : [])),
                              emails: extraParticipants.flatMap((x) => (x.origem === "pgcp" ? [x.participante.email] : []))
                            }}
                            onSelect={(sel) => setExtraParticipants((prev) => [...prev, sel])}
                          />
                          {extraParticipants.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {extraParticipants.map((u) => (
                                <span key={u.origem === "entra" ? u.user.id : u.participante.id} className="inline-flex items-center gap-1 bg-[#00658d]/5 text-[#00658d] text-[10px] font-bold px-2 py-0.5 rounded-full">
                                  {nomeDoSelecionado(u)}
                                  <button type="button" onClick={() => setExtraParticipants((prev) => prev.filter((x) => x !== u))} className="hover:text-red-600" aria-label="Remover">
                                    <X className="w-3 h-3" />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          <p className="text-[10px] text-slate-400 font-semibold">
                            Estas pessoas também serão adicionadas aos participantes da reunião e receberão o convite quando a reunião for enviada.
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!extraTitle.trim()) {
                            triggerToast(language === "en" ? "Please fill the topic title." : "Por favor preencha o assunto.");
                            return;
                          }
                          handleAddLiveExtraTopic(extraTitle, extraDuration, extraSpeaker, extraSpeakerUser?.id, extraCircular, {
                            typeId: extraTypeId || undefined,
                            natureId: extraNatureId || undefined,
                            fup: extraFup,
                            description: extraDescription,
                            participants: extraParticipants
                          });
                          setExtraTitle("");
                          setExtraSpeaker("Todos");
                          setExtraSpeakerUser(null);
                          setExtraCircular(false);
                          setExtraTypeId("");
                          setExtraNatureId("");
                          setExtraFup(false);
                          setExtraDescription("");
                          setExtraParticipants([]);
                          setExtraFichaAberta(false);
                          setIsExtraFormOpen(false);
                        }}
                        className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white font-bold text-xs rounded-xl shadow-xs transition"
                      >
                        Registrar e Recalcular Horários
                      </button>
                    </div>
                  </div>
                ) : (canSchedule && modoExecucao) ? (
                  // Pauta extraordinária SÓ durante a reunião (In Progress): é ato
                  // de condução ao vivo, não de planejamento.
                  <button
                    type="button"
                    onClick={() => setIsExtraFormOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-[#00658d] font-bold text-xs rounded-xl transition-all cursor-pointer shadow-xs active:scale-95"
                  >
                    <Plus className="w-4 h-4 text-[#00658d]" />
                    {language === "en" ? "Add Extra Topic (Live)" : "Adicionar Pauta Extraordinária ao Vivo"}
                  </button>
                ) : null}
              </div>
              )}

              {(!meeting.agenda || meeting.agenda.length === 0) && (
                <div className="text-center py-10 border-2 border-dashed border-slate-200 rounded-xl">
                  <AlertCircle className="w-8 h-8 text-slate-350 mx-auto mb-3" />
                  <p className="text-sm font-bold text-slate-500">
                    {language === "en" ? "No topics yet." : "Nenhum tema cadastrado para esta reunião."}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    {language === "en" ? "Create agendas and topics above, or pull topics from the Library." : "Crie pautas e temas acima, ou vincule temas da Biblioteca ao lado."}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Coluna direita: Biblioteca — SÓ no Planejamento. Durante a reunião
              e depois dela ela não deve competir com a condução/leitura. */}
          {modoPlanejamento && (
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 p-5 rounded-2xl card-shadow">
              <h3 className="text-xs font-extrabold text-slate-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-[#00658d]" />
                {language === "en" ? "Topic Library" : "Biblioteca de Temas"}
              </h3>
              <p className="text-[10px] text-slate-400 font-bold block mb-4 uppercase">
                {language === "en" ? "Capture scheduled themes for this specific month" : "Temas previstos mapeados no cronograma da Cielo"}
              </p>

              <input
                type="text"
                placeholder={language === "en" ? "Search..." : "Buscar temas..."}
                value={annualSearch}
                onChange={(e) => setAnnualSearch(e.target.value)}
                className="w-full text-xs p-2 mb-3 border border-slate-200 rounded-lg"
              />

              <div className="space-y-3">
                {bibliotecaDisponivel.length === 0 ? (
                  <p className="text-slate-400 text-xs font-semibold py-2">
                    {language === "en" ? "All annual topics already imported or none match." : "Todos os temas do cronograma anual já integrados ou nenhum encontrado."}
                  </p>
                ) : (
                  bibliotecaDisponivel
                    .map((ca) => (
                      <div key={ca.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between hover:bg-slate-100/50 transition">
                        <div className="space-y-0.5 truncate max-w-[70%]">
                          <h4 className="text-xs font-extrabold text-[#001e2d] truncate">{ca.title}</h4>
                          <p className="text-[10px] text-slate-400 font-bold">
                            {ca.duration} • {ca.author}
                          </p>
                        </div>
                        {canSchedule && (
                        <button
                          onClick={() => handleImportAgendaItem(ca, "standalone")}
                          className="px-2.5 py-1 bg-white hover:bg-[#00658d] hover:text-white text-[#00658d] border border-slate-205 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer shadow-xs"
                        >
                          <Plus className="w-3 h-3" />
                          {language === "en" ? "Pull" : "Vincular"}
                        </button>
                        )}
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
          )}
          </div>
        </div>
      )}

      {activeSubTab === "Documents" && (
        <MeetingDocumentsPanel
          language={language}
          meetingId={meeting.id}
          podeAdicionar={podeAdicionarDocumento}
          versao={versaoDosDocumentos}
          onAdd={() => setEnvioDeDocumento(null)}
          triggerToast={triggerToast}
        />
      )}

      {/* Diálogo compartilhado: aberto pela aba Documentos ou pelo botão de um tema. */}
      {envioDeDocumento !== undefined && (
        <UploadDocumentModal
          language={language}
          meetingId={meeting.id}
          temas={(meeting.agenda ?? []).map((t) => ({ id: t.id, title: t.title }))}
          temaInicial={envioDeDocumento}
          onClose={() => setEnvioDeDocumento(undefined)}
          onUploaded={(nome) => {
            setEnvioDeDocumento(undefined);
            setVersaoDosDocumentos((v) => v + 1);
            setMeetings((ms) => ms.map((m) => (m.id === meeting.id ? { ...m, documentsCount: (m.documentsCount ?? 0) + 1 } : m)));
            triggerToast(language === "pt" ? `Documento "${nome}" adicionado.` : `Document "${nome}" added.`);
          }}
        />
      )}

      {activeSubTab === "Minutes" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">

          {/* DOCUMENTO DA ATA */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 md:p-8 font-sans">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-4 border-b border-indigo-100">
                <div>
                  <h3 className="text-base font-extrabold text-slate-905 uppercase tracking-wide flex items-center gap-1.5">
                    <FileText className="w-5 h-5 text-indigo-650" />
                    {language === "en" ? "Meeting Minutes" : "Ata da Reunião"}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
                    {language === "en"
                      ? "Written by the participants. Saved on the server."
                      : "Redigida pelos participantes. Gravada no servidor."}
                  </p>
                </div>

                {/* Status próprio da Ata — independente de Meeting.status */}
                <div className="self-start sm:self-auto select-none">
                  <span className={`px-3 py-1.5 font-bold text-xs rounded-xl flex items-center gap-1.5 border ${
                    minutesCleared
                      ? "bg-amber-50 text-amber-700 border-amber-250"
                      : "bg-slate-50 text-slate-600 border-slate-200"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full block ${
                      minutesCleared ? "bg-amber-500" : "bg-slate-400"
                    }`} />
                    {minutesStatusLabel(minutes?.status ?? "draft", language === "en" ? "en" : "pt")}
                  </span>
                </div>
              </div>

              {minutesLoadState === "loading" && (
                <p className="text-xs text-slate-400 font-semibold py-10 text-center">
                  {language === "en" ? "Loading minutes..." : "Carregando a Ata..."}
                </p>
              )}

              {minutesLoadState === "error" && (
                <p className="text-xs text-red-600 font-semibold py-10 text-center">
                  {minutesError}
                </p>
              )}

              {minutesLoadState === "ready" && (
                minutesText ? (
                  <div className="space-y-4">
                    {/*
                      Marcação de "possível FUP" por pauta, ao lado da
                      DELIBERAÇÕES — não dentro do texto: a Ata é texto puro e
                      isto é controle de tela, não sai no PDF. Mesmo campo
                      (`generatesActionItem`) da edição de pauta; só um lugar
                      mais conveniente para marcar enquanto se redige a Ata.
                    */}
                    {(meeting.agenda || []).length > 0 && (
                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                        <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">
                          {language === "en"
                            ? "Flag topics as follow-up (FUP) candidates"
                            : "Marcar pautas como possível FUP"}
                        </p>
                        <div className="space-y-1.5">
                          {(meeting.agenda || []).map((item, indice) => (
                            <label
                              key={item.id}
                              className={`flex items-start gap-2 select-none ${canSchedule ? "cursor-pointer" : "cursor-default"}`}
                            >
                              <input
                                type="checkbox"
                                checked={item.generatesActionItem === true}
                                disabled={!canSchedule || isPersisting}
                                onChange={(e) => void alternarFupDaPauta(item, e.target.checked)}
                                className="w-4 h-4 mt-0.5 accent-[#00658d] cursor-pointer disabled:cursor-not-allowed"
                              />
                              <span className="text-xs text-slate-700">
                                <span className="font-bold text-slate-500">
                                  ({String(indice + 1).padStart(2, "0")})
                                </span>{" "}
                                {item.title}
                              </span>
                            </label>
                          ))}
                        </div>
                        <p className="text-[10px] text-slate-400 font-semibold">
                          {language === "en"
                            ? "Marked topics show up in the FUP tab to have owner and due date filled in."
                            : "Pautas marcadas aparecem na aba FUP para preencher responsável e prazo."}
                        </p>
                      </div>
                    )}

                    <textarea
                      rows={22}
                      value={minutesText}
                      readOnly={!canSchedule}
                      onChange={(e) => setMinutesText(e.target.value)}
                      // "Courier New" explícito, não o genérico `font-mono` do
                      // Tailwind: esse resolve para fontes diferentes por
                      // sistema operacional (Consolas no Windows, Menlo no
                      // Mac), e o PDF exportado usa Courier — precisam bater.
                      style={{ fontFamily: '"Courier New", Courier, monospace' }}
                      className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl p-5 leading-relaxed focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#003e58]/20 focus:border-[#00658d]"
                    />

                    {/* CONFLITO — o texto local NÃO é descartado sozinho. */}
                    {minutesConflict && (
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                        <p className="text-[11px] font-bold text-amber-800">
                          {language === "en"
                            ? "The minutes were changed in another session. Your text was kept here and not sent."
                            : "A Ata foi alterada em outra sessão. Seu texto foi mantido aqui e não foi enviado."}
                        </p>
                        <button
                          type="button"
                          onClick={recarregarMinutes}
                          className="px-3 py-1.5 bg-white hover:bg-amber-100 border border-amber-300 text-amber-800 text-[10px] font-extrabold rounded-lg transition cursor-pointer"
                        >
                          {language === "en"
                            ? "Discard mine and load the server version"
                            : "Descartar o meu e carregar a versão do servidor"}
                        </button>
                      </div>
                    )}

                    {minutesError && !minutesConflict && (
                      <p className="text-[11px] font-bold text-red-600">{minutesError}</p>
                    )}

                    <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between select-none">
                      <p className="text-[10px] text-slate-400 font-semibold">
                        {minutesRevision === 0
                          ? (language === "en" ? "Not saved yet" : "Ainda não gravada")
                          : (language === "en"
                              ? `Revision ${minutesRevision}${minutes?.updatedByName ? ` · last saved by ${minutes.updatedByName}` : ""}`
                              : `Revisão ${minutesRevision}${minutes?.updatedByName ? ` · gravada por ${minutes.updatedByName}` : ""}`)}
                        {minutesDirty && (language === "en" ? " · unsaved changes" : " · alterações não salvas")}
                      </p>

                      <div className="flex gap-2 justify-end">
                        {canSchedule && (
                        <button
                          type="button"
                          onClick={() => {
                            const msg = language === "pt"
                              ? "Isso apaga o texto atual (inclusive o que ainda não foi salvo) e recomeça do esqueleto com os dados de hoje da reunião. Continuar?"
                              : "This erases the current text (including anything not saved yet) and starts over from the skeleton with today's meeting data. Continue?";
                            if (window.confirm(msg)) handleCreateMinutes();
                          }}
                          title={language === "en"
                            ? "Discard current text and regenerate the skeleton"
                            : "Descarta o texto atual e gera o esqueleto de novo"}
                          className="px-4 py-2 bg-white hover:bg-slate-50 border border-slate-250 text-slate-700 text-xs font-extrabold rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                        >
                          <RotateCcw className="w-4 h-4 text-slate-500" />
                          {language === "en" ? "Reset skeleton" : "Resetar Esqueleto"}
                        </button>
                        )}

                        <button
                          onClick={() => void handleDownloadMinutesFile()}
                          disabled={isDownloadingMinutesPdf}
                          className="px-4 py-2 bg-white hover:bg-slate-50 border border-slate-250 text-slate-700 text-xs font-extrabold rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Download className="w-4 h-4 text-slate-500" />
                          {isDownloadingMinutesPdf
                            ? (language === "en" ? "Generating..." : "Gerando...")
                            : (language === "en" ? "Export" : "Exportar Ata")}
                        </button>

                        {canSchedule && (
                        <button
                          onClick={handleSaveMinutes}
                          disabled={minutesBusy !== "idle" || !minutesDirty}
                          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white text-xs font-extrabold rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Check className="w-4 h-4" />
                          {minutesBusy === "saving"
                            ? (language === "en" ? "Saving..." : "Salvando...")
                            : (language === "en" ? "Save minutes" : "Salvar Ata")}
                        </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-16 bg-slate-50 border border-dashed rounded-2xl">
                    <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                    <h4 className="text-sm font-bold text-slate-800">
                      {language === "en"
                        ? "No minutes written yet."
                        : "Ata ainda não redigida."}
                    </h4>
                    <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                      {language === "en"
                        ? "Start from a skeleton with the data already registered — participants and agenda. Discussion and resolutions are written by whoever attended."
                        : "Comece por um esqueleto com os dados já registrados da reunião — participantes e pautas. Discussão e deliberações são escritas por quem participou."}
                    </p>
                    <button
                      onClick={handleCreateMinutes}
                      className="mt-4 px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white font-extrabold text-xs rounded-xl shadow-xs transition cursor-pointer inline-flex items-center gap-2"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      {language === "en" ? "Create minutes" : "Criar Ata"}
                    </button>
                  </div>
                )
              )}
            </div>
          </div>

          {/* Próximas Pautas — Chamar, Mensagem e Concluir durante a reunião ao
              vivo. Fica ao lado da Ata porque é onde a condução acontece.
              Só em Execução: antes da reunião não existe "próxima pauta" no
              sentido operacional, e depois dela conduzir deixa de fazer sentido.
              Substituiu o Fluxo de Aprovação em Camadas, que não era usado; o
              saneamento continua existindo no backend. */}
          {modoExecucao ? (
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-2xl p-5 card-shadow">
              <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider mb-1 flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-[#00658d]" />
                {language === "en" ? "Upcoming topics" : "Próximas Pautas"}
              </h3>
              <p className="text-[11px] text-slate-400 font-semibold mb-4 leading-relaxed">
                {language === "en"
                  ? "In order of execution. Concluded and postponed topics are grouped separately below."
                  : "Na ordem de execução. Pautas concluídas e postergadas são organizadas separadamente abaixo."}
              </p>

              {upcomingTopics.length === 0 && finishedTopics.length === 0 && postponedTopics.length === 0 ? (
                <p className="text-xs text-slate-400 italic py-6 text-center">
                  {language === "en" ? "No agenda topics registered." : "Nenhuma pauta registrada nesta reunião."}
                </p>
              ) : (
                <div className="space-y-2.5">
                  {upcomingTopics.map(({ ag }, ordem) => {
                    const isNext = ordem === 0;
                    return (
                      <div
                        key={ag.id}
                        className={`rounded-xl border p-3 transition ${
                          isNext ? "border-[#00658d]/30 bg-[#c6e7ff]/15" : "border-slate-100 bg-slate-50/40"
                        }`}
                      >
                        {isNext && (
                          <span className="text-[8.5px] font-extrabold text-[#00658d] uppercase tracking-widest">
                            {language === "en" ? "Next" : "Próxima"}
                          </span>
                        )}
                        <p className="text-[10px] font-bold text-[#00658d] mt-0.5">{ag.time}</p>
                        <p className="text-xs font-extrabold text-slate-800 leading-snug mt-0.5">{ag.title}</p>
                        <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                          {ag.duration}{ag.author ? ` • ${ag.author}` : ""}
                        </p>

                        <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2.5 border-t border-slate-100">
                          <button
                            type="button"
                            onClick={() => toggleTopicDone(ag)}
                            className="px-2 py-1 text-[9.5px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-600 hover:text-white hover:border-emerald-600 transition cursor-pointer inline-flex items-center gap-1"
                          >
                            <Check className="w-3 h-3" />
                            {language === "en" ? "Done" : "Concluir"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCallParticipants(ag)}
                            disabled={callingAgendaItemId !== null}
                            aria-busy={callingAgendaItemId === ag.id}
                            className="px-2 py-1 text-[9.5px] font-extrabold uppercase tracking-wider text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-[#00658d] hover:text-[#00658d] transition cursor-pointer inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <BellRing className={`w-3 h-3 ${callingAgendaItemId === ag.id ? "animate-pulse" : ""}`} />
                            {callingAgendaItemId === ag.id
                              ? (language === "en" ? "Calling..." : "Chamando...")
                              : (language === "en" ? "Call" : "Chamar")}
                          </button>
                          {canSchedule && <button
                            type="button"
                            onClick={() => handleOpenMessageModal(ag)}
                            className="px-2 py-1 text-[9.5px] font-extrabold uppercase tracking-wider text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-[#00658d] hover:text-[#00658d] transition cursor-pointer inline-flex items-center gap-1"
                          >
                            <MessageSquare className="w-3 h-3" />
                            {language === "en" ? "Message" : "Mensagem"}
                          </button>}
                        </div>
                      </div>
                    );
                  })}

                  {finishedTopics.length > 0 && (
                    <div className="pt-3 mt-2 border-t border-slate-100">
                      <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-2">
                        {language === "en" ? "Concluded" : "Concluídas"} ({finishedTopics.length})
                      </p>
                      <div className="space-y-1">
                        {finishedTopics.map(({ ag }) => (
                          <div key={ag.id} className="flex items-center gap-2 px-1 py-0.5 group/done">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" />
                            <span className="text-[10.5px] font-bold text-slate-400 truncate line-through flex-1 min-w-0">
                              {ag.title}
                            </span>
                            {doneTopicIds.includes(ag.id) && (
                              <button
                                type="button"
                                onClick={() => toggleTopicDone(ag)}
                                title={language === "en" ? "Reopen topic" : "Reabrir pauta"}
                                className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400 hover:text-[#00658d] transition cursor-pointer shrink-0 inline-flex items-center gap-0.5 opacity-0 group-hover/done:opacity-100 focus:opacity-100"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                                {language === "en" ? "Reopen" : "Reabrir"}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* POSTERGADAS — fora do fluxo desta reunião, sem ações
                      operacionais. Só o caminho de volta: Retomar. */}
                  {postponedTopics.length > 0 && (
                    <div className="pt-3 mt-2 border-t border-slate-100">
                      <p className="text-[9px] font-extrabold text-amber-600/80 uppercase tracking-widest mb-2">
                        {language === "en" ? "Postponed" : "Postergadas"} ({postponedTopics.length})
                      </p>
                      <div className="space-y-1">
                        {postponedTopics.map(({ ag }) => (
                          <div key={ag.id} className="flex items-center gap-2 px-1 py-0.5">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" />
                            <span className="text-[10.5px] font-bold text-slate-500 truncate flex-1 min-w-0">
                              {ag.time && <span className="text-amber-700/70">{ag.time} · </span>}
                              {ag.title}
                            </span>
                            {canSchedule && (
                            <button
                              type="button"
                              onClick={() => {
                                /*
                                 * Retomar — UMA chamada de domínio.
                                 *
                                 * O backend devolve a pauta a `pending` E remove
                                 * a cópia certa na mesma transação, localizando-a
                                 * pela procedência estrutural. O frontend não
                                 * procura mais cópia por id construído, por
                                 * título nem por responsável.
                                 */
                                if (!ehReuniaoReal) {
                                  setTopicState(ag.id, null);
                                  return;
                                }

                                void persistir(
                                  () => apiResumeAgendaItem(meeting.id, ag.id),
                                  language === "en" ? "Topic resumed." : "Pauta retomada."
                                ).then((ok) => {
                                  if (ok) onReloadAgendaTopics?.();
                                });
                              }}
                              title={language === "en"
                                ? "Return topic to this meeting's flow"
                                : "Devolver a pauta ao fluxo desta reunião"}
                              className="text-[9px] font-extrabold uppercase tracking-wider text-amber-600 hover:text-amber-700 transition cursor-pointer shrink-0 inline-flex items-center gap-0.5"
                            >
                              <RotateCcw className="w-2.5 h-2.5" />
                              {language === "en" ? "Resume" : "Retomar"}
                            </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          ) : (
          <div className="space-y-6">
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
              <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider mb-1 flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-[#00658d]" />
                {language === "en" ? "Upcoming topics" : "Próximas Pautas"}
              </h3>
              <p className="text-[11px] text-slate-400 font-semibold leading-relaxed">
                {language === "en"
                  ? "Call, Message and Done are available while the meeting is in progress."
                  : "Chamar, Mensagem e Concluir ficam disponíveis com a reunião em andamento."}
              </p>
            </div>
          </div>
          )}
        </div>
      )}

          {activeSubTab === "Fup" && (
            <div className="bg-white border border-slate-200 p-8 rounded-2xl card-shadow space-y-5 mt-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-3 border-b border-slate-100 gap-2">
                <div>
                  <h3 className="text-base font-extrabold text-[#001e2d] uppercase tracking-wider flex items-center gap-2">
                    <CheckSquare className="w-5 h-5 text-[#00658d]" />
                    {language === "en" ? "Action Items / Follow-Up (FUP)" : "Plano de Ação e Follow-Up (FUP)"}
                  </h3>
                  <p className="text-[11px] text-slate-400 font-semibold mt-0.5">
                    {language === "en"
                      ? "Review follow-up statuses linked directly to this session's agendas."
                      : "Gerencie os itens de FUP integrados obrigatoriamente às pautas e responsáveis."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingFupOnTab(!isAddingFupOnTab);
                    if (meeting.agenda && meeting.agenda.length > 0) setNewFupTopic(meeting.agenda[0].id);
                    // Sem pré-seleção de responsável: escolher pessoa é ato
                    // deliberado, e não existe mais uma lista local de onde
                    // tirar "o primeiro".
                  }}
                  className="px-3 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white text-xs font-bold rounded-xl transition-all flex items-center gap-1 cursor-pointer select-none"
                >
                  <Plus className="w-4 h-4" />
                  {language === "en" ? "New Action FUP" : "Nova Ação FUP"}
                </button>
              </div>

              {/*
                Pautas classificadas como "Tema de FUP" (na aba Ata ou na
                edição da pauta) que ainda não viraram um FUP de verdade —
                falta responsável e prazo, que só quem preenche este
                formulário decide. Casamento por ID estrutural
                (`originAgendaItemId`), nunca por título.
              */}
              {pautasPendentesDeFup.length > 0 && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl space-y-2">
                  <p className="text-[10.5px] font-extrabold text-amber-800 uppercase tracking-wide flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {language === "en"
                      ? "Topics flagged for follow-up, awaiting details"
                      : "Pautas marcadas para FUP, aguardando cadastro"}
                  </p>
                  <div className="space-y-1.5">
                    {pautasPendentesDeFup.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-3 bg-white border border-amber-100 rounded-xl px-3 py-2"
                      >
                        <span className="text-xs font-bold text-slate-700 min-w-0 truncate">{item.title}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setIsAddingFupOnTab(true);
                            setNewFupTitle(item.title);
                            setNewFupTopic(item.id);
                          }}
                          className="shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-extrabold rounded-lg transition cursor-pointer"
                        >
                          {language === "en" ? "Fill in FUP" : "Preencher FUP"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {isAddingFupOnTab && (
                <div className="p-5 bg-slate-50 border border-slate-200 rounded-2xl space-y-4 animate-fade-in">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      {language === "en" ? "Subject" : "Assunto"} *
                    </label>
                    <input
                      type="text"
                      placeholder={language === "en"
                        ? "Specify the exact actionable outcome..."
                        : "Ex: Apresentar novo Business Plan na próxima sessão de conselho"}
                      value={newFupTitle}
                      onChange={(e) => setNewFupTitle(e.target.value)}
                      className="w-full bg-white border border-slate-205 p-2.5 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Obrigatorily Linked Agenda" : "Pauta Vinculada Obrigatoriamente"} *
                      </label>
                      <select
                        value={newFupTopic}
                        onChange={(e) => setNewFupTopic(e.target.value)}
                        className="w-full bg-white border border-slate-205 p-2.5 rounded-xl text-xs text-slate-705 cursor-pointer focus:outline-none"
                      >
                        {(meeting.agenda || []).map((ag) => (
                          <option key={ag.id} value={ag.id}>{ag.title}</option>
                        ))}
                        {(meeting.agenda || []).length === 0 && (
                          <option value="">
                            {language === "en" ? "-- No agendas listed --" : "-- Sem pautas disponíveis --"}
                          </option>
                        )}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Responsible" : "Responsáveis"} *
                      </label>
                      {/* Mesma fonte e mesma semântica da aba FUP: pessoa vem
                          do diretório, e o vínculo vai em
                          `assignedUser.entraObjectId`. */}
                      <DirectoryUserPicker
                        language={language}
                        selected={newFupAssignee}
                        placeholder={language === "en" ? "Search directory..." : "Buscar no diretório..."}
                        onSelect={setNewFupAssignee}
                        onClear={() => setNewFupAssignee(null)}
                      />
                    </div>

                    {/* VP responsável — texto livre, por decisão explícita: não vem do diretório nem de um cadastro. */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Responsible VP" : "VP Responsável"}
                      </label>
                      <input
                        type="text"
                        placeholder={language === "en" ? "Ex: Jane Doe" : "Ex: Fulano de Tal"}
                        value={newFupVp}
                        onChange={(e) => setNewFupVp(e.target.value)}
                        className="w-full bg-white border border-slate-205 p-2.5 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Due Date" : "Data para Conclusão"}
                      </label>
                      <input
                        type="date"
                        value={newFupDueDate}
                        onChange={(e) => setNewFupDueDate(e.target.value)}
                        className="w-full bg-white border border-slate-205 p-2.5 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                      />
                    </div>

                    {/* Status — só duas opções, por decisão do produto. */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Status" : "Status"}
                      </label>
                      <select
                        value={newFupStatus}
                        onChange={(e) => setNewFupStatus(e.target.value as "open" | "completed")}
                        className="w-full bg-white border border-slate-205 p-2.5 rounded-xl text-xs text-slate-705 cursor-pointer focus:outline-none"
                      >
                        <option value="open">{language === "en" ? "In Progress" : "Em Andamento"}</option>
                        <option value="completed">{language === "en" ? "Completed" : "Concluído"}</option>
                      </select>
                    </div>
                  </div>

                  {/* Comentários — campo único, sobrescrito a cada edição (sem histórico). */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Comments" : "Comentários"}
                    </label>
                    <textarea
                      rows={2}
                      placeholder={language === "en" ? "Notes about this FUP..." : "Observações sobre este FUP..."}
                      value={newFupComments}
                      onChange={(e) => setNewFupComments(e.target.value)}
                      className="w-full bg-white border border-slate-205 p-2.5 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d] resize-none"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2 select-none">
                    <button
                      type="button"
                      onClick={() => setIsAddingFupOnTab(false)}
                      className="px-4 py-2 bg-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-300 transition"
                    >
                      {language === "en" ? "Cancel" : "Cancelar"}
                    </button>
                    <button
                      type="button"
                      disabled={!newFupTitle.trim() || !newFupTopic || !newFupAssignee}
                      onClick={() => {
                        if (!newFupAssignee) return;
                        const nomeResponsavel =
                          newFupAssignee.displayName ?? directoryEmail(newFupAssignee) ?? "";

                        /*
                         * Origem real: UUID da reunião e da pauta —
                         * `newFupTopic` guarda o id. O toast de sucesso ou
                         * erro é o de `onCreateActionItem` (App.tsx); nada é
                         * anunciado aqui antes do servidor confirmar.
                         */
                        void onCreateActionItem({
                          title: newFupTitle,
                          assigneeName: nomeResponsavel,
                          assigneeEntraObjectId: newFupAssignee?.id,
                          originMeetingId: meeting.id,
                          originAgendaItemId: newFupTopic || undefined,
                          vpResponsavel: newFupVp.trim() || undefined,
                          dueDate: newFupDueDate || undefined,
                          description: newFupComments.trim() || undefined,
                          status: newFupStatus
                        });

                        setNewFupTitle("");
                        setNewFupVp("");
                        setNewFupDueDate("");
                        setNewFupComments("");
                        setNewFupStatus("open");
                        setNewFupAssignee(null);
                        setIsAddingFupOnTab(false);
                      }}
                      className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-lg text-xs font-bold transition disabled:opacity-50 cursor-pointer"
                    >
                      {language === "en" ? "Create Action" : "Gravar e Vincular"}
                    </button>
                  </div>
                </div>
              )}

              {/* FUP List matching this meeting's context */}
              <div className="space-y-2 mt-4">
                {(() => {
                  /*
                   * Origem ESTRUTURAL: `origin_meeting_id`. O filtro antigo
                   * procurava o título da reunião dentro de um texto livre —
                   * casava reuniões homônimas e se perdia numa renomeação.
                   */
                  const filteredFups = actionItems.filter(
                    (item) => item.originMeetingId === meeting.id
                  );

                  if (filteredFups.length === 0) {
                    return (
                      <div className="p-8 text-center bg-slate-50 border border-dashed border-slate-200 rounded-2xl">
                        <p className="text-xs text-slate-400 font-semibold">{language === "en" ? "No follow-up (FUP) logs for this session yet." : "Nenhum item de follow-up (FUP) gerado para os temas nesta pauta."}</p>
                      </div>
                    );
                  }

                  return filteredFups.map((fup) => {
                    const cleanPauta = fup.origin.split(" (Reunião")[0];
                    return (
                      <div key={fup.id} className="p-4 rounded-2xl border border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 decoration-indigo-200">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-xs font-extrabold text-slate-800 leading-snug">{fup.title}</h4>
                          <div className="flex flex-wrap gap-2 items-center mt-2">
                            <span className="bg-sky-50 text-sky-800 text-[8.5px] font-extrabold px-2 py-0.5 rounded border border-sky-100 uppercase tracking-tight">
                              {language === "en" ? "Pauta" : "Pauta Vinculada"}: {cleanPauta}
                            </span>
                            <span className="bg-slate-105 text-slate-500 text-[8.5px] font-bold px-2 py-0.5 rounded uppercase">
                              {fup.assignedUser.name}
                            </span>
                            {fup.vpResponsavel && (
                              <span className="bg-slate-105 text-slate-500 text-[8.5px] font-bold px-2 py-0.5 rounded uppercase">
                                VP: {fup.vpResponsavel}
                              </span>
                            )}
                            {fup.dueDate && (
                              <span className="bg-slate-105 text-slate-500 text-[8.5px] font-bold px-2 py-0.5 rounded uppercase">
                                {language === "en" ? "Due" : "Conclusão"}: {fup.dueDate.split("-").reverse().join("/")}
                              </span>
                            )}
                          </div>
                          {fup.description && (
                            <p className="text-[10px] text-slate-400 font-semibold mt-1.5">{fup.description}</p>
                          )}
                        </div>

                        <div className="shrink-0 flex items-center gap-3 select-none">
                          <span className={`px-2 py-0.5 rounded text-[8.5px] font-extrabold uppercase ${
                            fup.status === "Completed" 
                              ? "bg-emerald-50 text-emerald-600 border border-emerald-100" 
                              : "bg-amber-50 text-amber-600 border border-amber-100"
                          }`}>
                            {fup.status === "Completed" ? (language === "en" ? "Completed" : "Concluído") : (language === "en" ? "Active" : "Em aberto")}
                          </span>

                          {fup.status !== "Completed" && podeGerenciarFup(fup) && (
                            <button
                              type="button"
                              onClick={() => {
                                void onSetActionItemStatus(fup.id, true);
                              }}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[9.5px] font-bold rounded-lg transition cursor-pointer"
                            >
                              {language === "en" ? "Complete" : "Concluir"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {/* 2) EMBELLISHED PARTICIPANTS VIEW WITH INTERACTIVE STANDALONE ADDITION & NOISELESS BADGES - ITEM 4 */}
          {activeSubTab === "Participants" && (
            <>

            <div className="bg-white border border-slate-200 p-8 rounded-2xl card-shadow space-y-5 mt-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-3 border-b border-slate-100 gap-2">
                <div>
                  <h3 className="text-base font-extrabold text-slate-900 uppercase tracking-wide flex items-center gap-2">
                    <Users className="w-5 h-5 text-[#00658d]" />
                    {language === "pt" ? "Participantes da Sessão" : "Meeting Participants"}
                  </h3>
                  <p className="text-[11px] text-slate-400 font-semibold mt-0.5">
                    {language === "pt" ? "Visualização de membros convidados e suas respectivas vinculações de pautas." : "Review scheduled corporate participants and their active agenda links."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingParticipantOnTab(!isAddingParticipantOnTab);
                  }}
                  className="px-3 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white text-xs font-bold rounded-xl transition-all flex items-center gap-1 cursor-pointer select-none shadow-xs"
                >
                  <Plus className="w-4 h-4" />
                  {language === "pt" ? "Adicionar Participante" : "Add Standalone"}
                </button>
              </div>

              {isAddingParticipantOnTab && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3.5 animate-fade-in max-w-xl">
                  {/* Entra ID + externos do PGCP: inclui direto na reunião. */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      {language === "pt" ? "Buscar participante" : "Find participant"}
                    </label>
                    <ParticipantPicker
                      language={language}
                      showHint
                      sugestao={{ governanceBodyId: meeting.governanceBodyId, rotuloOrgao: meeting.category }}
                      disabled={isPersisting}
                      jaEscolhidos={{
                        entraIds: (meeting.participants || []).map((p) => p.entraObjectId ?? "").filter(Boolean),
                        emails: (meeting.participants || []).map((p) => p.email ?? "")
                      }}
                      onSelect={(sel) =>
                        void persistir(
                          () => apiAddParticipant(meeting.id, selecionadoParaPayload(sel)),
                          language === "en" ? "Participant added!" : `${nomeDoSelecionado(sel)} adicionado(a) à reunião.`
                        )
                      }
                    />
                  </div>
                  <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider pt-1">
                    {language === "pt" ? "Ou inclua um convidado avulso" : "Or add a one-off guest"}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{language === "pt" ? "Nome Completo" : "Full Name"} *</label>
                      <input 
                        type="text"
                        placeholder="Ex: Dr. Roberto Alencar"
                        value={newTabPartName}
                        onChange={(e) => setNewTabPartName(e.target.value)}
                        className="w-full bg-white border border-slate-205 p-2 rounded-lg text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">{language === "pt" ? "Cargo ou Função" : "Cargo / Role"}</label>
                      <input 
                        type="text"
                        placeholder="Ex: Auditor Externo"
                        value={newTabPartRole}
                        onChange={(e) => setNewTabPartRole(e.target.value)}
                        className="w-full bg-white border border-slate-205 p-2 rounded-lg text-xs"
                      />
                    </div>
                    {/*
                      E-mail do convidado externo. Sem ele a pessoa entra na
                      reunião, mas não recebe convite de calendário — e a
                      sincronização com o Outlook fica bloqueada até corrigir.
                    */}
                    <div className="flex flex-col gap-1 sm:col-span-2">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "pt" ? "E-mail (para o convite)" : "E-mail (for the invitation)"}
                      </label>
                      <input
                        type="email"
                        placeholder="roberto.alencar@empresa.com.br"
                        value={newTabPartEmail}
                        onChange={(e) => setNewTabPartEmail(e.target.value)}
                        className="w-full bg-white border border-slate-205 p-2 rounded-lg text-xs"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        {language === "pt"
                          ? "Sem e-mail a pessoa fica registrada, mas não recebe o convite do calendário."
                          : "Without an e-mail the person is registered but receives no calendar invitation."}
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-1 select-none">
                    <button
                      type="button"
                      onClick={() => setIsAddingParticipantOnTab(false)}
                      className="px-3 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-bold"
                    >
                      {language === "pt" ? "Cancelar" : "Cancel"}
                    </button>
                    <button
                      type="button"
                      disabled={!newTabPartName.trim()}
                      onClick={handleTabAddParticipant}
                      className="px-4 py-1.5 bg-[#003e58] text-white rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {language === "pt" ? "Incluir" : "Add"}
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {(meeting.participants || []).map((p, idx) => {
                  /*
                   * Pautas sob responsabilidade desta pessoa.
                   *
                   * IDENTIDADE (`entra_object_id`) decide; nome só desempata
                   * quando nenhum dos dois lados tem identidade — dado legado.
                   * O casamento por substring que existia aqui pendurava a
                   * mesma pauta em "Ana" e em "Ana Paula Souza", e separava
                   * homônimos que o diretório sabe distinguir.
                   *
                   * Mesma função da tela de agendamento: a regra de quem
                   * responde pelo quê é uma só no produto.
                   */
                  const linkedPautas = pautasSobResponsabilidade(meeting.agenda || [], {
                    name: p.name,
                    entraObjectId: p.entraObjectId
                  });

                  return (
                    <div key={idx} className="flex flex-col p-3.5 rounded-2xl border border-slate-100 bg-slate-50/50 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-full bg-sky-100 text-[#00658d] flex items-center justify-center font-bold text-xs select-none uppercase">
                            {p.initials || p.name.substring(0, 2)}
                          </span>
                          <div className="leading-tight">
                            <h4 className="text-xs font-extrabold text-[#001e2d]">{p.name}</h4>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{p.role}</p>
                            {/* Origem discreta: integra o grupo do órgão (inclusão automática). */}
                            {p.inGovernanceBodyGroup && (
                              <p className="text-[10px] text-slate-400 font-semibold mt-0.5" title={language === "pt" ? "Faz parte do grupo de participação deste órgão colegiado" : "Member of this governance body's participation group"}>
                                {language === "pt" ? `Grupo: ${meeting.category}` : `Group: ${meeting.category}`}
                              </p>
                            )}
                          </div>
                        </div>
                        <span className="flex items-center gap-1.5">
                        <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider border ${
                          p.confirmed 
                            ? "bg-emerald-50 text-emerald-700 border-emerald-100" 
                            : "bg-slate-100 text-slate-400 border-slate-200"
                        }`}>
                          {p.confirmed ? (language === "pt" ? "Presidente / Presença" : "Present") : (language === "pt" ? "Pendente" : "Pending")}
                        </span>
                        {/* Único caminho para a pessoa DEIXAR a reunião. */}
                        {canSchedule && p.participantId && (
                          <button
                            type="button"
                            disabled={isPersisting}
                            onClick={() => pedirRemocaoDaReuniao(p.participantId!, p.name)}
                            className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition cursor-pointer disabled:opacity-40"
                            title={language === "pt" ? "Remover da reunião" : "Remove from meeting"}
                            aria-label={language === "pt" ? `Remover ${p.name} da reunião` : `Remove ${p.name} from meeting`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        </span>
                      </div>

                      {/* Linked agendas list tags */}
                      {linkedPautas.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-2 border-t border-slate-200/50">
                          {linkedPautas.map((ag, aIdx) => (
                            <span 
                              key={aIdx} 
                              className="text-[8px] font-extrabold bg-sky-50 text-[#00658d] px-1.5 py-0.5 rounded uppercase tracking-tight border border-sky-100/60"
                            >
                              {ag.title}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            </>
          )}

          {/* Confidential encrypted metadata logs */}

      {/* Modal for Editing Meeting Details */}
      {isEditingMeeting && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-[9999] p-4 transition-all duration-300 animate-fadeIn">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 max-w-2xl w-full max-h-[90vh] overflow-y-auto transform scale-100 transition-all font-sans">
            {/* Modal Header */}
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 sticky top-0 backdrop-blur-md z-10">
              <div>
                <h3 className="text-lg font-extrabold text-slate-900">
                  {language === "en" ? "Edit Meeting Details" : "Editar Detalhes da Reunião"}
                </h3>
                <p className="text-xs text-slate-500 font-semibold mt-0.5">
                  {language === "en" ? "Update information for this governance session." : "Atualize os metadados desta sessão de governança."}
                </p>
              </div>
              <button 
                onClick={() => setIsEditingMeeting(false)}
                className="w-10 h-10 rounded-full bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-500 hover:text-slate-700 flex items-center justify-center transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body / Form */}
            <form onSubmit={(e) => e.preventDefault()} className="p-6 space-y-5">
              {/*
                Tipo + TÍTULO PADRONIZADO (030). Com tipo, o título é montado pelo
                servidor a partir de hora, órgão, formato e tipo — e recomposto a
                cada alteração aqui. A versão aprovada da Agenda Anual não muda
                (snapshot). Reunião antiga sem tipo mantém o título livre até
                alguém escolher o tipo.
              */}
              <div className="space-y-1.5">
                <label htmlFor="editSessionType" className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                  {language === "en" ? "Type" : "Tipo"}
                </label>
                <select
                  id="editSessionType"
                  value={editedSessionType}
                  onChange={(e) => setEditedSessionType(e.target.value as SessionType | "")}
                  className="w-full text-sm font-semibold text-slate-800 bg-slate-50/50 border border-slate-200 focus:border-[#00658d] rounded-xl px-4 py-3 outline-none cursor-pointer"
                >
                  {!meeting.sessionType && (
                    <option value="">{language === "en" ? "No type (keep free title)" : "Sem tipo (manter título atual)"}</option>
                  )}
                  {SESSION_TYPE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{language === "en" ? o.en : o.pt}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                  {editedSessionType
                    ? language === "en" ? "Meeting Title (generated)" : "Título da Reunião (gerado automaticamente)"
                    : language === "en" ? "Meeting Title" : "Título da Reunião"}
                </label>
                {editedSessionType ? (
                  <p className="w-full text-sm font-bold text-slate-700 bg-slate-50 border border-dashed border-slate-200 rounded-xl px-4 py-3 break-words">
                    {previaDoTitulo({
                      startTime: editedStartTime,
                      orgao: governanceBodies.find((b) => b.id === (editedGovernanceBodyId || meeting.governanceBodyId))?.name ?? meeting.category,
                      tipo: editedSessionType,
                      modalidade: editedModality
                    }) ?? meeting.title}
                  </p>
                ) : (
                  <input
                    type="text"
                    value={editedTitle}
                    onChange={(e) => setEditedTitle(e.target.value)}
                    className="w-full text-sm font-bold text-slate-800 placeholder-slate-400 bg-slate-50/50 hover:bg-slate-50/80 focus:bg-white border border-slate-200 focus:border-[#00658d] rounded-xl px-4 py-3 outline-none transition-all focus:ring-2 focus:ring-[#00658d]/10"
                    placeholder={language === "en" ? "Enter meeting title..." : "Digite o título da reunião..."}
                  />
                )}
              </div>

              {/* Date, Start Time, End Time Row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.55">
                  <label className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                    {language === "en" ? "Date" : "Data"}
                  </label>
                  <input 
                    type="date"
                    value={editedDate}
                    onChange={(e) => setEditedDate(e.target.value)}
                    className="w-full text-sm font-bold text-slate-800 bg-slate-50/50 border border-slate-200 focus:border-[#00658d] rounded-xl px-4 py-2.5 outline-none focus:bg-white transition-all focus:ring-2 focus:ring-[#00658d]/10"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                    {language === "en" ? "Start Time" : "Hora Início"}
                  </label>
                  <input
                    type="time"
                    value={editedStartTime}
                    onChange={(e) => setEditedStartTime(e.target.value)}
                    className="w-full text-sm font-bold text-slate-800 bg-slate-50/50 border border-slate-200 focus:border-[#00658d] rounded-xl px-4 py-2.5 outline-none focus:bg-white transition-all focus:ring-2 focus:ring-[#00658d]/10"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                    {language === "en" ? "End Time" : "Hora Fim"}
                  </label>
                  <input
                    type="time"
                    value={editedEndTime}
                    onChange={(e) => setEditedEndTime(e.target.value)}
                    className="w-full text-sm font-bold text-slate-800 bg-slate-50/50 border border-slate-200 focus:border-[#00658d] rounded-xl px-4 py-2.5 outline-none focus:bg-white transition-all focus:ring-2 focus:ring-[#00658d]/10"
                  />
                </div>
              </div>

              {/* Órgão / Recorrência / Organizador. O link do Teams não é
                  digitado: vem do próprio evento do calendário. */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="editGovernanceBody" className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                    {language === "en" ? "Governance body" : "Órgão de Governança"}
                  </label>
                  <select
                    id="editGovernanceBody"
                    value={editedGovernanceBodyId}
                    onChange={(e) => setEditedGovernanceBodyId(e.target.value)}
                    className="w-full text-sm font-bold text-slate-800 bg-slate-50/50 border border-slate-200 focus:border-[#00658d] rounded-xl px-3 py-2.5 outline-none focus:bg-white transition-all focus:ring-2 focus:ring-[#00658d]/10 cursor-pointer"
                  >
                    {/* Inativos só aparecem se forem o órgão atual: trocar para
                        um deles não é permitido na criação, nem aqui. */}
                    {governanceBodies
                      .filter((body) => body.isActive || body.id === meeting.governanceBodyId)
                      .map((body) => (
                        <option key={body.id} value={body.id}>{body.name}</option>
                      ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="editRecurrence" className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                    {language === "en" ? "Recurrence" : "Recorrência"}
                  </label>
                  <select
                    id="editRecurrence"
                    value={editedRecurrence}
                    onChange={(e) => setEditedRecurrence(e.target.value)}
                    className="w-full text-sm font-bold text-slate-800 bg-slate-50/50 border border-slate-200 focus:border-[#00658d] rounded-xl px-3 py-2.5 outline-none focus:bg-white transition-all focus:ring-2 focus:ring-[#00658d]/10 cursor-pointer"
                  >
                    <option value="Single">{language === "en" ? "Does not repeat" : "Não se repete (Única)"}</option>
                    <option value="Semanal">{language === "en" ? "Weekly" : "Semanal"}</option>
                    <option value="Quinzenal">{language === "en" ? "Biweekly" : "Quinzenal"}</option>
                    <option value="Mensal">{language === "en" ? "Monthly" : "Mensal"}</option>
                    <option value="Trimestral">{language === "en" ? "Quarterly" : "Trimestral"}</option>
                    {/* Valor legado fora da lista: mantido para não trocar em silêncio. */}
                    {!["Single", "Semanal", "Quinzenal", "Mensal", "Trimestral"].includes(editedRecurrence) && (
                      <option value={editedRecurrence}>{editedRecurrence}</option>
                    )}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                    {language === "en" ? "Organizer" : "Organizador"}
                  </label>
                  {/*
                    Somente leitura: o convite mora no calendário do organizador.
                    Trocá-lo exigiria mover o evento de caixa, e o PATCH recusa o
                    campo (`organizerUserId` fica fora por decisão).
                  */}
                  <input
                    type="text"
                    value={meeting.organizer || (language === "en" ? "Not informed" : "Não informado")}
                    readOnly
                    aria-describedby="organizerHint"
                    className="w-full text-sm font-bold text-slate-500 bg-slate-100 border border-slate-200 rounded-xl px-3 py-2.5 outline-none cursor-not-allowed"
                  />
                  <p id="organizerHint" className="text-[10px] text-slate-400 font-semibold">
                    {language === "en"
                      ? "Defined when the meeting is scheduled."
                      : "Definido no agendamento da reunião."}
                  </p>
                </div>
              </div>

              {/*
                Modalidade/local (025). Alterar reaproveita o MESMO evento do
                Outlook (PATCH no id gravado) — nunca cria convite duplicado.
              */}
              <ModalityFields
                language={language}
                modality={editedModality}
                physicalLocationKey={editedLocationKey}
                onChange={(m, local) => {
                  setEditedModality(m);
                  setEditedLocationKey(local);
                }}
              />

              {/* Description / Objective */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-slate-700 tracking-wider block uppercase">
                  {language === "en" ? "Objective / Summary" : "Objetivo / Resumo"}
                </label>
                <textarea
                  value={editedDescription}
                  onChange={(e) => setEditedDescription(e.target.value)}
                  rows={4}
                  className="w-full text-sm font-medium text-slate-800 placeholder-slate-400 bg-slate-50/50 hover:bg-slate-50/80 focus:bg-white border border-slate-200 focus:border-[#00658d] rounded-xl px-4 py-3 outline-none transition-all focus:ring-2 focus:ring-[#00658d]/10 resize-none"
                  placeholder={language === "en" ? "Enter meeting description..." : "Cole ou digite o objetivo desta sessão..."}
                />
              </div>
            </form>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50/30">
              <button 
                type="button"
                onClick={() => setIsEditingMeeting(false)}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 font-bold text-xs rounded-xl transition cursor-pointer"
              >
                {language === "en" ? "Cancel" : "Cancelar"}
              </button>
              <button 
                type="button"
                onClick={() => {
                  /*
                   * PATCH do cabeçalho. `organizer` NÃO vai junto (somente
                   * leitura). `meetingLink` também não: o campo saiu do
                   * formulário e omiti-lo preserva o valor legado gravado.
                   */
                  void persistir(
                    () =>
                      apiUpdateMeeting(meeting.id, {
                        // Com tipo, o servidor monta o título; sem tipo (legado), título livre.
                        ...(editedSessionType ? { sessionType: editedSessionType } : { title: editedTitle }),
                        description: editedDescription,
                        startAt: localToInstant(editedDate, editedStartTime, meeting.timeZone),
                        endAt: localToInstant(editedDate, editedEndTime, meeting.timeZone),
                        recurrence: editedRecurrence,
                        ...(editedGovernanceBodyId ? { governanceBodyId: editedGovernanceBodyId } : {}),
                        // Só envia se mudou: modalidade/local desatualizam o convite.
                        ...(editedModality !== (meeting.modality ?? "online") ||
                        editedLocationKey !== (meeting.physicalLocation?.id ?? "")
                          ? {
                              modality: editedModality,
                              physicalLocationKey: editedModality === "in_person" ? editedLocationKey || null : null
                            }
                          : {})
                      }),
                    language === "en" ? "Meeting updated successfully" : "Dados da reunião atualizados com sucesso"
                  ).then((ok) => {
                    if (ok) setIsEditingMeeting(false);
                  });
                }}
                className="px-5 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white font-bold text-xs rounded-xl shadow-md active:scale-95 transition cursor-pointer"
              >
                {language === "en" ? "Save Changes" : "Salvar Alterações"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Target Item Detail Modal - Item 1.4 */}
      {/*
        MODAL: editar pauta (PATCH). Só título, duração e responsável — os
        campos que o contrato aceita. UUID e agendaTopicId são preservados pelo
        backend; item da Biblioteca continua uma CÓPIA (o mestre não é tocado).
      */}
      {editandoPautaId !== null && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => { if (!salvandoEdicao) setEditandoPautaId(null); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#c6e7ff]/40 flex items-center justify-center shrink-0">
                  <Pencil className="w-5 h-5 text-[#00658d]" />
                </div>
                <h3 className="text-sm font-extrabold text-slate-900">
                  {language === "pt" ? "Editar pauta" : "Edit topic"}
                </h3>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                  {language === "pt" ? "Título" : "Title"}
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  autoFocus
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                  {language === "pt" ? "Responsável" : "Owner"}
                </label>
                <DirectoryUserPicker
                  language={language}
                  selected={editRespUser}
                  selectedLabel={editRespLabel || null}
                  placeholder={language === "pt" ? "Buscar no diretório..." : "Search directory..."}
                  onSelect={(user) => {
                    setEditRespUser(user);
                    setEditRespLabel(user.displayName ?? directoryEmail(user) ?? "");
                    setEditRespOid(user.id);
                  }}
                  onClear={() => {
                    setEditRespUser(null);
                    setEditRespLabel("");
                    setEditRespOid(undefined);
                  }}
                />
                {!editRespLabel && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditRespLabel("Todos");
                      setEditRespUser(null);
                      setEditRespOid(undefined);
                    }}
                    className="self-start text-[10px] font-extrabold uppercase tracking-wider text-[#00658d] hover:underline cursor-pointer"
                  >
                    {language === "pt" ? "Todos (Conselho)" : "Everyone (Board)"}
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                  {language === "pt" ? "Duração" : "Duration"}
                </label>
                <DurationHoursMinutesSelect
                  language={language}
                  value={editDuration}
                  onChangeMinutes={(m) => setEditDuration(formatMinutesAsTime(m))}
                  selectClassName="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 cursor-pointer focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                />
              </div>

              {/* Tema circular NESTA reunião. Permite Não↔Sim; grava via PATCH.
                  Não toca a Biblioteca — é fato da pauta desta reunião. */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                  {language === "pt" ? "Tema circular?" : "Recurring theme?"}
                </label>
                <select
                  value={editCircular ? "sim" : "nao"}
                  onChange={(e) => setEditCircular(e.target.value === "sim")}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 cursor-pointer focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                >
                  <option value="nao">{language === "pt" ? "Não" : "No"}</option>
                  <option value="sim">{language === "pt" ? "Sim" : "Yes"}</option>
                </select>
              </div>

              {/* Ficha (019): Tipo e Natureza — MESMOS cadastros da Biblioteca. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                    {language === "pt" ? "Tipo" : "Type"}
                  </label>
                  <select
                    value={editTypeId}
                    onChange={(e) => setEditTypeId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 cursor-pointer focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                  >
                    <option value="">{language === "pt" ? "— Sem tipo —" : "— None —"}</option>
                    {pautaTypes.map((pt) => (
                      <option key={pt.id} value={pt.id}>{pt.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                    {language === "pt" ? "Natureza" : "Nature"}
                  </label>
                  <select
                    value={editNatureId}
                    onChange={(e) => setEditNatureId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 cursor-pointer focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                  >
                    <option value="">{language === "pt" ? "— Sem natureza —" : "— None —"}</option>
                    {pautaNatures.map((pn) => (
                      <option key={pn.id} value={pn.id}>{pn.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Classificar como Tema de FUP — só classificação (não cria FUP). */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={editFup}
                  onChange={(e) => setEditFup(e.target.checked)}
                  className="w-4 h-4 accent-[#00658d] cursor-pointer"
                />
                <span className="text-[10px] font-extrabold text-slate-500 uppercase">
                  {language === "pt" ? "Classificar como Tema de FUP" : "Classify as follow-up (FUP) theme"}
                </span>
              </label>

              {/* Descrição / Objetivo de Debate. */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                  {language === "pt" ? "Descrição / Objetivo de Debate" : "Description / Debate objective"}
                </label>
                <textarea
                  rows={4}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d] resize-none font-sans"
                />
              </div>

              {/* Participantes da pauta (Opção A) — add/remove IMEDIATOS (persistem
                  já). Vincular alguém novo o adiciona também à reunião. */}
              {(() => {
                const itemAtual = (meeting.agenda || []).find((a) => a.id === editandoPautaId);
                const vinculados = itemAtual?.participants ?? [];
                return (
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-extrabold text-slate-500 uppercase">
                      {language === "pt" ? "Participantes do tema" : "Topic participants"}
                    </label>
                    {vinculados.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1">
                        {vinculados.map((p) => {
                          const participanteDaReuniao = (meeting.participants ?? []).find(
                            (participant) => participant.participantId === p.participantId
                          );
                          const isResponsible = Boolean(
                            itemAtual?.authorEntraObjectId &&
                            participanteDaReuniao?.entraObjectId &&
                            itemAtual.authorEntraObjectId.toLowerCase() === participanteDaReuniao.entraObjectId.toLowerCase()
                          );
                          return (
                            <span key={p.participantId} className="inline-flex items-center gap-1 bg-[#00658d]/5 text-[#00658d] text-[10px] font-bold px-2 py-0.5 rounded-full">
                              {p.name}
                              {isResponsible && (
                                <span className="text-[8px] uppercase opacity-75">
                                  {language === "pt" ? "Responsável" : "Responsible"}
                                </span>
                              )}
                              {canSchedule && !isResponsible && (
                                <button
                                  type="button"
                                  disabled={isPersisting}
                                  onClick={() => pedirRemocaoDoTema(itemAtual!.id, itemAtual!.title, p.participantId, p.name)}
                                  className="hover:text-red-600 disabled:opacity-40"
                                  title={language === "pt" ? "Remover do tema" : "Remove from topic"}
                                  aria-label={language === "pt" ? `Remover ${p.name} do tema` : `Remove ${p.name} from topic`}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {canSchedule && itemAtual && (
                      <>
                        <ParticipantPicker
                          language={language}
                          sugestao={{
                            governanceBodyId: meeting.governanceBodyId,
                            rotuloOrgao: meeting.category,
                            // Tema da Biblioteca ligado a este tema (quando houver).
                            agendaTopicId: itemAtual.agendaTopicId,
                            rotuloTema: itemAtual.title
                          }}
                          placeholder={language === "pt" ? "Adicionar participante..." : "Add participant..."}
                          jaEscolhidos={{
                            emails: (meeting.participants || [])
                              .filter((p) => (itemAtual.participants || []).some((x) => x.participantId === p.participantId))
                              .map((p) => p.email ?? "")
                          }}
                          onSelect={(sel) => void vincularParticipantePauta(itemAtual.id, sel)}
                        />
                        <p className="text-[10px] text-slate-400 font-semibold">
                          {language === "pt"
                            ? "Esta pessoa também será adicionada aos participantes da reunião e receberá o convite quando a reunião for enviada."
                            : "This person will also be added to the meeting participants and invited when the meeting is sent."}
                        </p>
                      </>
                    )}
                  </div>
                );
              })()}

              {erroEdicao && (
                <p className="text-[11px] font-bold text-red-600">{erroEdicao}</p>
              )}
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setEditandoPautaId(null)}
                disabled={salvandoEdicao}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer disabled:opacity-50"
              >
                {language === "pt" ? "Cancelar" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={salvarEdicaoPauta}
                disabled={salvandoEdicao || !editTitle.trim()}
                className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {salvandoEdicao
                  ? language === "pt" ? "Salvando..." : "Saving..."
                  : language === "pt" ? "Salvar" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: confirmação de exclusão de pauta — identifica a pauta pelo título. */}
      {remocaoPendente && (
        <ConfirmRemovalDialog
          language={language === "en" ? "en" : "pt"}
          confirmacao={remocaoPendente.confirmacao}
          busy={isPersisting}
          onCancel={() => setRemocaoPendente(null)}
          onConfirm={() => void confirmarRemocao()}
        />
      )}

      {pautaParaExcluir && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setPautaParaExcluir(null)}
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
                  {language === "pt" ? "Excluir pauta" : "Delete topic"}
                </h3>
              </div>
              <p className="text-xs text-slate-600 font-medium leading-relaxed">
                {language === "pt" ? "Excluir a pauta " : "Delete the topic "}
                <span className="font-extrabold text-slate-900">&ldquo;{pautaParaExcluir.title}&rdquo;</span>
                {language === "pt"
                  ? "? Esta ação não pode ser desfeita."
                  : "? This action cannot be undone."}
              </p>
            </div>
            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setPautaParaExcluir(null)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer"
              >
                {language === "pt" ? "Cancelar" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={confirmarExclusaoPauta}
                className="px-4 py-2 text-xs font-bold bg-red-600 hover:bg-red-700 active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer inline-flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {language === "pt" ? "Excluir" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* MODAL: mensagem personalizada para uma pauta (aba Anotações) */}
      {isMessageModalOpen && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={closeMessageModal}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-center gap-3.5 mb-4">
                <div className="w-10 h-10 rounded-full bg-[#c6e7ff]/40 flex items-center justify-center shrink-0">
                  <MessageSquare className="w-5 h-5 text-[#00658d]" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-slate-900">
                    {language === "en" ? "Custom message" : "Mensagem Personalizada"}
                  </h3>
                  <p className="text-[11px] text-slate-400 font-semibold truncate">
                    {messageTargetTopic}
                  </p>
                </div>
              </div>

              <textarea
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                autoFocus
                rows={5}
                maxLength={TEAMS_MESSAGE_MAX_LENGTH}
                disabled={isSendingCustomMessage}
                placeholder={language === "en"
                  ? "Write the message for the participants of this topic..."
                  : "Escreva a mensagem para os participantes desta pauta..."}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 leading-relaxed placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d] transition-all font-medium resize-none"
              />

              <p className="text-[10px] text-slate-400 font-semibold mt-2 leading-relaxed">
                {language === "en"
                  ? "Sent individually in Microsoft Teams as your signed-in account. The message content is not copied to the PGCP audit trail."
                  : "Enviada individualmente no Microsoft Teams em nome da sua conta autenticada. O conteúdo não é copiado para a auditoria do PGCP."}
              </p>
              <div className="mt-2 flex items-start justify-between gap-3">
                {customMessageError ? (
                  <p className="text-[10px] text-red-600 font-semibold leading-relaxed" role="alert">
                    {customMessageError}
                  </p>
                ) : <span />}
                <span className="text-[9px] text-slate-400 font-semibold whitespace-nowrap">
                  {customMessage.length}/{TEAMS_MESSAGE_MAX_LENGTH}
                </span>
              </div>
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100">
              <button
                type="button"
                onClick={closeMessageModal}
                disabled={isSendingCustomMessage}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer"
              >
                {language === "en" ? "Cancel" : "Cancelar"}
              </button>
              <button
                type="button"
                onClick={handleSendCustomMessage}
                disabled={!customMessage.trim() || isSendingCustomMessage}
                className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                <Send className="w-3.5 h-3.5" />
                {isSendingCustomMessage
                  ? (language === "en" ? "Sending..." : "Enviando...")
                  : (language === "en" ? "Send" : "Enviar")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        ENVIAR PAUTAS PARA VALIDAÇÃO.

        Um único campo: o e-mail de quem valida. O PDF é montado no servidor a
        partir do que já está cadastrado — não há nada para o usuário anexar,
        escolher ou preencher aqui.

        O aprovador NÃO precisa de conta no PGCP: ele recebe, lê e responde por
        e-mail. Quem registra a aprovação depois é a Secretaria.
      */}
      {modalValidacaoAberto && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg card-shadow overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200">
              <h3 className="text-sm font-extrabold text-slate-900">
                {language === "en" ? "Send agenda for validation" : "Enviar pautas para validação"}
              </h3>
              <p className="text-[11px] text-slate-500 font-medium mt-1 leading-relaxed">
                {language === "en"
                  ? "A PDF file with the meeting and its agenda is generated and attached automatically. The e-mail is sent from your own mailbox."
                  : "Um arquivo PDF com a reunião e as pautas é gerado e anexado automaticamente. O e-mail sai da sua própria caixa."}
              </p>
            </div>

            <form
              onSubmit={(evento) => {
                evento.preventDefault();
                void handleEnviarParaValidacao();
              }}
            >
              <div className="px-6 py-5 space-y-2">
                <label
                  htmlFor="email-aprovador"
                  className="block text-[11px] font-extrabold text-slate-700 uppercase tracking-wider"
                >
                  {language === "en" ? "Approver e-mail" : "E-mail de quem valida"}
                </label>
                <input
                  id="email-aprovador"
                  type="email"
                  required
                  autoFocus
                  value={emailAprovador}
                  onChange={(evento) => {
                    setEmailAprovador(evento.target.value);
                    setErroValidacao(null);
                  }}
                  placeholder="nome.sobrenome@empresa.com.br"
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#00658d]/30 focus:border-[#00658d]"
                />
                <p className="text-[10px] text-slate-500 font-medium">
                  {language === "en"
                    ? `${meeting.agenda?.length ?? 0} agenda item(s) will be included.`
                    : `${meeting.agenda?.length ?? 0} pauta(s) serão incluídas.`}
                </p>
                {/* O servidor revalida o endereço; isto é só o aviso imediato. */}
                {erroValidacao && (
                  <p className="text-[11px] font-bold text-red-600 leading-relaxed">{erroValidacao}</p>
                )}
              </div>

              <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalValidacaoAberto(false);
                    setErroValidacao(null);
                  }}
                  className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer"
                >
                  {language === "en" ? "Cancel" : "Cancelar"}
                </button>
                <button
                  type="submit"
                  disabled={enviandoValidacao || !ehEmailValido(emailAprovador.trim())}
                  className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                >
                  <Send className="w-3.5 h-3.5" />
                  {enviandoValidacao
                    ? language === "en" ? "Sending..." : "Enviando..."
                    : language === "en" ? "Send" : "Enviar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      </div>
      </div>
  );
}
