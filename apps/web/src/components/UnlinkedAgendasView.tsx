import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  describeTopicError,
  ensureResponsibleTopicParticipant,
  getAgendaTopic,
  isResponsibleTopicParticipant,
  topicParticipantsToPayload,
  type BibliotecaFormInput,
  type TaxonomyItem,
  type TopicParticipantPayload,
} from "../lib/agenda-topics";
import {
  ListTodo,
  Plus,
  Trash2,
  Clock,
  User,
  Tag,
  Search,
  CheckCircle,
  Sparkles,
  Info,
  Pencil,
  Users,
  X,
  PlusCircle,
  Calendar,
  Flag,
  UserPlus,
  ArrowRight,
  ShieldAlert
} from "lucide-react";
import { StandaloneAgenda, Meeting } from "../types";
import ConfirmRemovalDialog from "./ConfirmRemovalDialog";
import DirectoryUserPicker from "./DirectoryUserPicker";
import DurationHoursMinutesSelect from "./DurationHoursMinutesSelect";
import { directoryEmail, type DirectoryUser } from "../lib/directory";
import { formatMinutesAsTime, parseDurationMinutes } from "../lib/agenda-time";
import {
  abrirEdicaoTema,
  abrirNovoTema,
  confirmacaoExclusaoTema,
  idEmEdicao,
  MODAL_FECHADO,
  modalAberto,
  tituloDoModalTema,
  type EstadoModalTema
} from "../lib/topic-library-modal";

interface UnlinkedAgendasViewProps {
  language: "en" | "pt";
  standaloneAgendas: StandaloneAgenda[];
  /** Carga de GET /agenda-topics em andamento. */
  agendaTopicsLoading?: boolean;
  agendaTopicsError?: string | null;
  onReloadAgendaTopics?: () => void;
  onAddStandaloneAgenda: (input: BibliotecaFormInput) => void;
  /** Executa a exclusão (App trata 409 de tema vinculado com toast). */
  onDeleteStandaloneAgenda: (id: string) => void | Promise<void>;
  onUpdateStandaloneAgenda: (id: string, input: BibliotecaFormInput) => void;
  /** Bandeira FUP da lista — PATCH parcial só com `generatesActionItem`. */
  onToggleTopicFup: (id: string, marcado: boolean) => void;
  /** Cadastros reais. Identidade é o `id`; o nome é rótulo. */
  pautaTypes: TaxonomyItem[];
  pautaNatures: TaxonomyItem[];
}

export default function UnlinkedAgendasView({
  language,
  standaloneAgendas,
  agendaTopicsLoading = false,
  agendaTopicsError = null,
  onReloadAgendaTopics,
  onAddStandaloneAgenda,
  onDeleteStandaloneAgenda,
  onUpdateStandaloneAgenda,
  onToggleTopicFup,
  pautaTypes = [],
  pautaNatures = []
}: UnlinkedAgendasViewProps) {
  // Modal de cadastro (Novo tema / Editar tema). Fechado = formulário fora da tela.
  const [modal, setModal] = useState<EstadoModalTema>(MODAL_FECHADO);
  const editingId = idEmEdicao(modal);
  /** Tema aguardando confirmação de exclusão. `null` = nada a confirmar. */
  const [temaParaExcluir, setTemaParaExcluir] = useState<StandaloneAgenda | null>(null);
  const [excluindo, setExcluindo] = useState(false);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);

  // Form states matching standard inputs
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState("00:30");
  const [author, setAuthor] = useState("");
  /**
   * Pessoa escolhida no diretório corporativo. `null` quando nada foi
   * selecionado nesta edição — inclusive ao editar um registro legado, cujo
   * `author` é texto livre sem vínculo com o diretório.
   */
  const [authorFromDirectory, setAuthorFromDirectory] = useState<DirectoryUser | null>(null);
  /** `entra_object_id` já gravado no registro. Preservado ao editar. */
  const [authorEntraObjectId, setAuthorEntraObjectId] = useState("");
  const [description, setDescription] = useState("");
  /**
   * Participantes com IDENTIDADE explícita.
   *
   * O modelo antigo era `string[]` — só nomes, sem como saber de quem se
   * tratava. `agenda_topic_participants` aceita as três naturezas de pessoa, e
   * o payload carrega o `entraObjectId` quando existe.
   */
  const [participants, setParticipants] = useState<TopicParticipantPayload[]>([]);
  const [selectedParticipantToAdd, setSelectedParticipantToAdd] = useState("");
  const [meetingId, setMeetingId] = useState("");
  /*
   * IDENTIDADE do tipo/natureza, não o rótulo.
   *
   * Antes o `value` do select era o nome, o que fazia renomear um cadastro
   * quebrar o vínculo de todos os temas que o usavam.
   */
  const [pautaTypeId, setPautaTypeId] = useState("");
  const [pautaNatureId, setPautaNatureId] = useState("");
  /**
   * PADRÃO de tema circular do tema mestre. Default Não. Ao vincular a uma
   * reunião, o backend copia este valor para a pauta da reunião (snapshot).
   */
  const [isCircular, setIsCircular] = useState(false);

  // Search query
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFupFilter, setSelectedFupFilter] = useState<"all" | "fup" | "non-fup">("all");

  // Participant adding/caching states
  const [isParticipantModalOpen, setIsParticipantModalOpen] = useState(false);

  // New user registration fields

  useEffect(() => {
    if (pautaTypes.length > 0 && !pautaTypeId) {
      setPautaTypeId(pautaTypes[0].id);
    }
  }, [pautaTypes, pautaTypeId]);

  useEffect(() => {
    if (pautaNatures.length > 0 && !pautaNatureId) {
      setPautaNatureId(pautaNatures[0].id);
    }
  }, [pautaNatures, pautaNatureId]);

  const t = {
    title: language === "en" ? "Topic library" : "Biblioteca de Temas",
    subTitle: language === "en"
      ? "Create and manage corporate agendas before linking them to specific board meetings."
      : "Cadastre e configure temas reutilizáveis para debates e deliberações em reuniões do conselho.",

    secNew: language === "en" ? "New topic" : "Novo tema",
    secEdit: language === "en" ? "Edit topic" : "Editar tema",
    lblTitle: language === "en" ? "Topic title" : "Nome do tema",
    lblDuration: language === "en" ? "Estimated Duration (HH:mm)" : "Tempo Estimado (Duração)",
    // `author` pode ser pessoa, área, órgão, cargo ou coletivo — o rótulo não
    // afirma que quem responde pelo tema é quem vai apresentá-lo.
    lblSpeaker: language === "en" ? "Responsible" : "Responsável pelo tema (EntraID)",
    lblCategory: language === "en" ? "Governance Segment" : "Categoria Governança",
    lblDescription: language === "en" ? "Executive Summary & Pre-Reads" : "Descrição / Objetivo de Debate",
    lblParticipants: language === "en" ? "Additional Participants / Observers" : "Participantes Extras / Convidados (EntraID)",
    lblMeetingLink: language === "en" ? "Linked Meeting" : "Vincular a Reunião",
    lblPautaType: language === "en" ? "Topic type" : "Tipo do tema",
    lblPautaNature: language === "en" ? "Topic nature" : "Natureza do tema",

    placeholderTitle: language === "en" ? "e.g. ESG Sustainability Report" : "Ex: Relatório de Sustentabilidade ESG",
    placeholderSpeaker: language === "en" ? "Select responsible..." : "Selecione o responsável...",
    placeholderDesc: language === "en" ? "Strategic context and decisions expected..." : "Pontos fundamentais e materiais a serem lidos previamente para a tomada de decisões.",
    placeholderParticipant: language === "en" ? "Select participant to add..." : "Selecione para adicionar...",

    btnSubmit: language === "en" ? "Save topic" : "Salvar tema",
    btnUpdate: language === "en" ? "Save Changes" : "Salvar Alterações",
    btnCancel: language === "en" ? "Cancel" : "Cancelar",
    btnNew: language === "en" ? "New topic" : "Novo tema",

    secList: language === "en" ? "Registered topics" : "Temas cadastrados",
    searchPlc: language === "en" ? "Search topics, speakers or summaries..." : "Buscar temas por nome, responsável ou objetivos...",
    filterAll: language === "en" ? "All Governance Categories" : "Qualquer Categoria",

    emptyState: language === "en"
      ? "No topics found matching your filters. Register a new one!"
      : "Nenhum tema cadastrado atende aos filtros. Cadastre um novo tema ou altere os filtros.",

    badgeUnlinked: language === "en" ? "Available" : "Livre para Vínculo",
    lblTips: language === "en" ? "How do topics work?" : "Como funcionam os temas?",
    tipsBody: language === "en"
      ? "These are independent board topics stored in your repository. When scheduling corporate meetings, you can immediately pull them to auto-assemble meeting agendas in one click, along with planned durations and speakers."
      : "Os temas cadastrados aqui formam uma biblioteca de assuntos corporativos. Ao montar a pauta de uma reunião do conselho ou comitê, você pode importar qualquer um desses temas.",

    phHours: language === "en" ? "Duration" : "Duração",
    minutesText: language === "en" ? "Minutes" : "Minutos",
    hoursText: language === "en" ? "Hours" : "Horas",
    lblAddedPart: language === "en" ? "Added:" : "Lista de Participantes:",
    noPart: language === "en" ? "No extra participants." : "Nenhum participante extra adicionado.",
  };

  const handleRemoveParticipant = (indexToRemove: number) => {
    setParticipants(participants.filter((_, idx) => idx !== indexToRemove));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !author.trim()) return;

    /*
     * Duração vai em MINUTOS: a API guarda `estimated_duration_minutes` como
     * inteiro, e a string "HH:mm" era formato de exibição.
     */
    const totalMinutos = parseDurationMinutes(duration, 30);

    const participantesComResponsavel = ensureResponsibleTopicParticipant(
      participants,
      author,
      authorEntraObjectId,
    );
    const input = {
      title: title.trim(),
      description: description.trim(),
      durationMinutes: Number.isFinite(totalMinutos) ? totalMinutos : null,
      responsibleLabel: author.trim(),
      responsibleEntraObjectId: authorEntraObjectId || undefined,
      typeId: pautaTypeId || undefined,
      natureId: pautaNatureId || undefined,
      isCircularTheme: isCircular,
      participants: participantesComResponsavel
    };

    if (editingId) {
      onUpdateStandaloneAgenda(editingId, input);
    } else {
      onAddStandaloneAgenda(input);
    }
    fecharModal();
  };

  /** Limpa o formulário: nada de um tema anterior vaza para o próximo. */
  const limparFormulario = () => {
    setTitle("");
    setAuthor("");
    setAuthorFromDirectory(null);
    setAuthorEntraObjectId("");
    setDescription("");
    setParticipants([]);
    setDuration("00:30");
    setMeetingId("");
    setPautaTypeId(pautaTypes[0]?.id || "");
    setPautaNatureId(pautaNatures[0]?.id || "");
    setIsCircular(false);
    setSelectedParticipantToAdd("");
  };

  const handleStartEdit = async (agenda: StandaloneAgenda) => {
    if (loadingEditId) return;
    setLoadingEditId(agenda.id);
    setEditLoadError(null);
    try {
      // GET de detalhe: a listagem tem apenas o contador, nunca a coleção.
      const detail = await getAgendaTopic(agenda.id);
      const hydrated = ensureResponsibleTopicParticipant(
        topicParticipantsToPayload(detail.participants),
        detail.responsible?.label,
        detail.responsible?.entraObjectId,
      );

      setTitle(agenda.title);
      setAuthor(agenda.author);
      /*
       * Registro legado (`author` textual, sem vínculo) continua renderizando:
       * o picker só substitui a identidade após escolha explícita.
       */
      setAuthorFromDirectory(null);
      setAuthorEntraObjectId(agenda.authorEntraObjectId || "");
      setDescription(agenda.description || "");
      setParticipants(hydrated);
      setPautaTypeId(agenda.pautaTypeId || pautaTypes[0]?.id || "");
      setPautaNatureId(agenda.pautaNatureId || pautaNatures[0]?.id || "");
      setIsCircular(agenda.isCircularTheme === true);

      setDuration(agenda.duration);
      setModal(abrirEdicaoTema(agenda.id));
    } catch (error) {
      setEditLoadError(describeTopicError(error, language));
    } finally {
      setLoadingEditId(null);
    }
  };

  /** Cancelar, X, Esc ou após salvar: descarta o não salvo e fecha. */
  const fecharModal = () => {
    setModal(MODAL_FECHADO);
    setIsParticipantModalOpen(false);
    limparFormulario();
  };

  /**
   * Só após confirmar. A regra de tema vinculado é do backend: um 409 chega ao
   * handler do App, que mostra a mensagem atual no toast.
   */
  const confirmarExclusao = async () => {
    if (!temaParaExcluir || excluindo) return;
    setExcluindo(true);
    try {
      await onDeleteStandaloneAgenda(temaParaExcluir.id);
    } finally {
      setExcluindo(false);
      setTemaParaExcluir(null);
    }
  };

  const handleStartNew = () => {
    setEditLoadError(null);
    limparFormulario();
    setModal(abrirNovoTema());
  };

  useEffect(() => {
    if (!modalAberto(modal) || isParticipantModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fecharModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, isParticipantModalOpen]);

  // Filter lists
  const filteredAgendas = standaloneAgendas.filter((agenda) => {
    const matchesSearch =
      agenda.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      agenda.author.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (agenda.description || "").toLowerCase().includes(searchQuery.toLowerCase());

    const matchesFup =
      selectedFupFilter === "all" ||
      (selectedFupFilter === "fup" && agenda.isFUP === true) ||
      (selectedFupFilter === "non-fup" && !agenda.isFUP);

    return matchesSearch && matchesFup;
  });

  return (
    <div className="space-y-8 animate-fade-in text-slate-755 text-xs text-slate-700 font-semibold leading-relaxed">

      {/* HEADER SECTION */}
      <header className="pb-4 border-b border-slate-200/60 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="min-w-0">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 flex items-center gap-2.5 font-sans">
          <ListTodo className="w-8 h-8 text-[#00658d] shrink-0" />
          {t.title}
        </h2>
        <p className="text-slate-500 font-medium text-sm mt-1.5 matches-subheading-style">
          {t.subTitle}
        </p>
        </div>
        <button
          type="button"
          onClick={handleStartNew}
          className="self-start sm:self-auto shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white font-bold uppercase text-[10px] tracking-wider rounded-xl shadow-xs transition active:scale-[0.98] select-none cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          {t.btnNew}
        </button>
      </header>

      {editLoadError && (
        <p className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-[10px] font-bold text-red-700" role="alert">
          {editLoadError}
        </p>
      )}

      {/* LISTA DE TEMAS — o cadastro/edição abre em modal. */}
      <section className="space-y-4 mt-6" aria-label={t.secList}>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-3.5 border border-slate-100 rounded-2xl">

            {/* Search Input bar */}
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl pl-9 pr-3.5 py-2 text-xs font-semibold focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200"
                placeholder={t.searchPlc}
              />
            </div>

            {/* FUP Filter dropdown */}
            <div className="w-full sm:w-56">
              <select
                value={selectedFupFilter}
                onChange={(e) => setSelectedFupFilter(e.target.value as "all" | "fup" | "non-fup")}
                className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs font-semibold cursor-pointer focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200"
              >
                <option value="all">{language === "en" ? "FUP + Standard Status" : "Qualquer Acompanhamento"}</option>
                <option value="fup">{language === "en" ? "Only FUP (Follow-Up)" : "Apenas temas em FUP"}</option>
                <option value="non-fup">{language === "en" ? "Standard Topics (No FUP)" : "Apenas temas padrão (sem FUP)"}</option>
              </select>
            </div>

          </div>

          {/* Results List Grid */}
          <div className="space-y-2.5">
            {filteredAgendas.length > 0 ? (
              filteredAgendas.map((agenda) => {
                /*
                 * Vínculo vem da API, contado sobre
                 * `meeting_agenda_items.agenda_topic_id`.
                 *
                 * O cálculo antigo casava TÍTULOS e varria as reuniões no
                 * navegador: dois temas homônimos apareciam vinculadas às
                 * mesmas reuniões, e renomear uma desfazia o vínculo.
                 */
                const linkedCount = agenda.linkedMeetingsCount ?? 0;
                const partsCount = agenda.participantsCount ?? 0;
                const hasParts = partsCount > 0;

                return (
                  <div
                    key={agenda.id}
                    className={`bg-white border text-slate-700 text-xs font-semibold rounded-xl p-4.5 hover:border-slate-350 hover:shadow-xs transition duration-200 relative group flex flex-col gap-3 ${
                      editingId === agenda.id ? "ring-2 ring-[#00658d]/20 border-[#00658d]" : "border-slate-100"
                    } ${
                      agenda.isFUP ? "border-l-4 border-l-amber-500/80" : ""
                    }`}
                  >

                    {/* Minimalist Action Buttons on Hover */}
                    <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none">
                      {/* Flag button */}
                      <button
                        type="button"
                        onClick={() => {
                          // PATCH parcial: só o campo que mudou. Campos `null`
                          // no PATCH apagariam o que está gravado no tema.
                          onToggleTopicFup(agenda.id, !agenda.isFUP);
                        }}
                        className={`p-1.5 rounded-md border text-slate-400 transition-colors cursor-pointer ${
                          agenda.isFUP
                            ? "bg-amber-50 text-amber-500 border-amber-200/50"
                            : "text-slate-450 hover:text-amber-500 border-slate-100 bg-white"
                        }`}
                        title={
                          agenda.isFUP
                            ? (language === "en" ? "Remove FUP" : "Remover FUP")
                            : (language === "en" ? "Set under FUP" : "Marcar como FUP")
                        }
                      >
                        <Flag className={`w-3 h-3 ${agenda.isFUP ? "fill-amber-500 text-amber-500" : ""}`} />
                      </button>

                      {/* Edit Button */}
                      <button
                        type="button"
                        disabled={loadingEditId !== null}
                        onClick={() => void handleStartEdit(agenda)}
                        className="text-slate-400 hover:text-[#00658d] hover:bg-slate-50 p-1.5 rounded-md border border-slate-100 bg-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        title={loadingEditId === agenda.id
                          ? (language === "en" ? "Loading participants..." : "Carregando participantes...")
                          : (language === "en" ? "Edit topic" : "Editar tema")}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>

                      {/* Delete Button */}
                      <button
                        type="button"
                        onClick={() => setTemaParaExcluir(agenda)}
                        className="text-slate-400 hover:text-rose-600 hover:bg-rose-50 p-1.5 rounded-md border border-slate-100 bg-white transition-colors cursor-pointer"
                        title={language === "en" ? "Delete topic" : "Excluir tema"}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Meta badges - Minimal & Pastel-based */}
                    <div className="flex flex-wrap items-center gap-1.5 mb-0.5 pr-20 select-none">

                      <span className="px-2 py-0.5 rounded text-[9px] font-mono font-medium text-slate-400 bg-slate-50 border border-slate-105 border-slate-100 uppercase tracking-wider">
                        {agenda.id.toUpperCase()}
                      </span>

                      {agenda.pautaType && (
                        <span className="px-2 py-0.5 rounded text-[9px] font-medium text-amber-600 bg-amber-50/40 border border-amber-100/50 uppercase tracking-wider">
                          {agenda.pautaType}
                        </span>
                      )}

                      {agenda.pautaNature && (
                        <span className="px-2 py-0.5 rounded text-[9px] font-medium text-[#00658d] bg-[#00658d]/5 border border-[#00658d]/10 uppercase tracking-wider">
                          {agenda.pautaNature}
                        </span>
                      )}

                      <span className={`px-2 py-0.5 rounded text-[9px] font-medium flex items-center gap-1 border uppercase tracking-wider ${
                        linkedCount > 0
                          ? "bg-indigo-50/60 text-indigo-600 border-indigo-100/60"
                          : "bg-slate-50/50 text-slate-400 border-slate-100"
                      }`}>
                        <Calendar className="w-2.5 h-2.5 shrink-0" />
                        <span>{linkedCount} {linkedCount === 1
                          ? (language === "en" ? "meeting" : "reunião")
                          : (language === "en" ? "meetings" : "reuniões")
                        }</span>
                      </span>

                      <span className={`px-2 py-0.5 rounded text-[9px] font-medium flex items-center gap-1 border uppercase tracking-wider ${
                        hasParts
                          ? "bg-sky-50/60 text-sky-600 border-sky-100/60"
                          : "bg-slate-50/50 text-slate-400 border-slate-100"
                      }`}>
                        <Users className="w-2.5 h-2.5 shrink-0" />
                        <span>{hasParts ? `${partsCount} ${language === "en" ? "participants" : "participantes"}` : (language === "en" ? "0 participants" : "0 participante")}</span>
                      </span>

                    </div>

                    {/* Main Content Info */}
                    <div className="space-y-1 text-left">
                      <h3 className="text-xs font-bold text-slate-900 leading-snug tracking-tight group-hover:text-[#00658d] transition-colors duration-200">
                        {agenda.title}
                      </h3>

                      {agenda.description && (
                        <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                          {agenda.description}
                        </p>
                      )}

                      {/* Display of individual participants nested sentence */}
                      {hasParts && (
                        <div className="flex items-center gap-1.5 bg-slate-50/40 border border-slate-100/50 rounded-lg px-2.5 py-1.5 mt-2 text-[10px]">
                          <Users className="w-3.5 h-3.5 text-[#00658d]" />
                          <span className="text-[#00658d]/90 font-bold select-none shrink-0">{t.lblAddedPart}</span>
                          <span className="text-slate-500 font-semibold truncate">
                            {(agenda.participantsCount ?? 0) + (language === "en" ? " linked" : " vinculado(s)")}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Compact Card Footer */}
                    <div className="pt-2 border-t border-slate-100/60 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400 font-semibold select-none">

                      <span className="flex items-center gap-1.5 text-slate-500">
                        <User className="w-3.5 h-3.5 text-[#00658d]" />
                        <span>{t.lblSpeaker}: <strong className="font-bold text-slate-700">{agenda.author}</strong></span>
                      </span>

                      <span className="flex items-center gap-1 text-slate-400">
                        <Clock className="w-3.5 h-3.5 text-[#00aeef]" />
                        <span>{t.lblDuration}: <strong className="font-bold text-slate-600">{agenda.duration}</strong></span>
                      </span>

                    </div>

                  </div>
                );
              })
            ) : (
              <div className="text-center py-12 bg-white border border-slate-100 rounded-2xl text-slate-400 font-medium italic text-[11px] space-y-2">
                <ListTodo className="w-8 h-8 text-slate-300 mx-auto" />
                <p>{t.emptyState}</p>
              </div>
            )}
          </div>

      </section>

      {/* MODAL: NOVO TEMA / EDITAR TEMA. Portal no <body>: `fixed` fica
          relativo à viewport (a tela tem `animate-fade-in`, cujo transform
          prenderia o modal ao container). Fundo só desfocado, sem escurecer. */}
      {modalAberto(modal) && createPortal(
        <div className="fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="tema-modal-titulo"
            className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in"
          >
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 shrink-0">
              <h3 id="tema-modal-titulo" className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
                <Pencil className="w-4 h-4 text-[#00658d]" />
                {tituloDoModalTema(modal, language)}
              </h3>
              <button
                type="button"
                onClick={fecharModal}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors cursor-pointer"
                aria-label={language === "en" ? "Close" : "Fechar"}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col font-semibold text-xs text-slate-750">
              {/* Corpo: formulário à esquerda, participantes do tema à direita
                  (md+). Em telas menores empilha, com uma única rolagem. */}
              <div className="flex-1 min-h-0 overflow-y-auto md:overflow-hidden md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,320px)] md:grid-rows-[minmax(0,1fr)]">
              <div className="px-6 py-5 space-y-3.5 md:overflow-y-auto md:min-h-0">
              {/*
                "Reunião Vinculada" saiu do formulário.
                O vínculo é `meeting_agenda_items.agenda_topic_id`: o tema entra
                numa reunião ao ser importada lá, e pode estar em N reuniões. Um
                ponteiro manual aqui seria um segundo caminho para o mesmo fato.
              */}
              {/* Title */}
              <div className="flex flex-col gap-1">
                <label htmlFor="agendaTitleInput" className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {t.lblTitle} *
                </label>
                <input
                  id="agendaTitleInput"
                  type="text"
                  required
                  placeholder={t.placeholderTitle}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200"
                />
              </div>

              {/* Responsável pelo tema — pessoas vêm do diretório corporativo
                  (Microsoft Graph), não mais de uma lista local. */}
              <div className="flex flex-col gap-1">
                <label className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {t.lblSpeaker} *
                </label>
                <DirectoryUserPicker
                  language={language}
                  selected={authorFromDirectory}
                  selectedLabel={author || null}
                  placeholder={t.placeholderSpeaker}
                  onSelect={(user) => {
                    // `author` continua sendo o nome de exibição: é o que as
                    // telas já leem hoje. O id do diretório vai num campo
                    // próprio, sem sobrescrever o `authorId` legado.
                    const displayName = user.displayName ?? directoryEmail(user) ?? "";
                    setAuthor(displayName);
                    setAuthorFromDirectory(user);
                    setAuthorEntraObjectId(user.id);
                    setParticipants((current) =>
                      ensureResponsibleTopicParticipant(current, displayName, user.id)
                    );
                  }}
                  onClear={() => {
                    setAuthor("");
                    setAuthorFromDirectory(null);
                    setAuthorEntraObjectId("");
                  }}
                />
              </div>

              {/* Tipo do tema */}
              <div className="flex flex-col gap-1">
                <label htmlFor="agendaPautaTypeInput" className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {t.lblPautaType} *
                </label>
                <select
                  id="agendaPautaTypeInput"
                  required
                  value={pautaTypeId}
                  onChange={(e) => setPautaTypeId(e.target.value)}
                  className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200"
                >
                  {/* `value` é o UUID: renomear o cadastro não quebra vínculo. */}
                  {pautaTypes.map((pt) => (
                    <option key={pt.id} value={pt.id}>{pt.name}</option>
                  ))}
                </select>
              </div>

              {/* Natureza do tema */}
              <div className="flex flex-col gap-1">
                <label htmlFor="agendaPautaNatureInput" className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {t.lblPautaNature} *
                </label>
                <select
                  id="agendaPautaNatureInput"
                  required
                  value={pautaNatureId}
                  onChange={(e) => setPautaNatureId(e.target.value)}
                  className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200"
                >
                  {pautaNatures.map((pn) => (
                    <option key={pn.id} value={pn.id}>{pn.name}</option>
                  ))}
                </select>
              </div>

              {/* Tema circular? — PADRÃO da Biblioteca. Copiado para o item da
                  reunião ao vincular a uma reunião; sem automação. Default Não. */}
              <div className="flex flex-col gap-1">
                <label htmlFor="agendaCircularInput" className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {language === "en" ? "Recurring theme?" : "Tema circular?"} *
                </label>
                <select
                  id="agendaCircularInput"
                  value={isCircular ? "sim" : "nao"}
                  onChange={(e) => setIsCircular(e.target.value === "sim")}
                  className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200"
                >
                  <option value="nao">{language === "en" ? "No" : "Não"}</option>
                  <option value="sim">{language === "en" ? "Yes" : "Sim"}</option>
                </select>
              </div>

              {/* Estimated time in Standard Duration (HH:mm selects) */}
              <div className="flex flex-col gap-1">
                <label className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {t.lblDuration} *
                </label>
                <DurationHoursMinutesSelect
                  language={language}
                  value={duration}
                  onChangeMinutes={(m) => setDuration(formatMinutesAsTime(m))}
                  selectClassName="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] focus:bg-white outline-none cursor-pointer transition-all duration-200"
                />
              </div>

              {/* Rich Objective and Pre-read details */}
              <div className="flex flex-col gap-1">
                <label htmlFor="agendaDescInput" className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider">
                  {t.lblDescription}
                </label>
                <textarea
                  id="agendaDescInput"
                  rows={3}
                  placeholder={t.placeholderDesc}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] font-sans resize-none leading-relaxed transition-all duration-200"
                />
              </div>

              </div>

              {/* PARTICIPANTES DO TEMA — coluna direita (md+). */}
              <aside
                aria-labelledby="tema-participantes-titulo"
                className="px-6 py-5 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/60 flex flex-col gap-3 md:overflow-y-auto md:min-h-0"
              >
                <div>
                  <h4 id="tema-participantes-titulo" className="text-xs font-extrabold text-slate-800 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-[#00658d]" />
                      {language === "en" ? "Topic participants" : "Participantes do tema"}
                    </span>
                    <span className="text-[9px] text-[#00658d] font-extrabold bg-[#00658d]/5 px-2 py-0.5 rounded-full">
                      {participants.length}
                    </span>
                  </h4>
                  <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                    {language === "en"
                      ? "Select or review the people related to this topic."
                      : "Selecione ou visualize os participantes relacionados a este tema."}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setIsParticipantModalOpen(true)}
                  className="w-full py-2 px-3 bg-white hover:bg-[#00658d]/5 border border-slate-200 hover:border-[#00658d]/20 text-[#00658d] rounded-xl text-xs transition flex items-center justify-center gap-2 cursor-pointer font-bold select-none text-center"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  {language === "en" ? "Link participants" : "Vincular participantes"}
                </button>

                {/* Participantes já vinculados ao tema */}
                <div className="space-y-1 max-h-60 md:max-h-none md:flex-1 md:min-h-0 overflow-y-auto p-1 bg-white rounded-xl border border-slate-100">
                  {participants.length > 0 ? (
                    participants.map((p, index) => {
                      const isResponsible = isResponsibleTopicParticipant(p, authorEntraObjectId);
                      return (
                        <div
                          key={p.entraObjectId ?? p.email ?? `${p.displayName}-${index}`}
                          className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-100 text-slate-705 flex items-center justify-between transition-colors hover:bg-slate-50/40"
                        >
                          <div className="flex flex-col truncate min-w-0 pr-2 text-left">
                            <span className="font-bold text-slate-800 text-[10.5px] truncate">{p.displayName ?? p.email ?? ""}</span>
                            {isResponsible && (
                              <span className="text-[8.5px] font-extrabold text-[#00658d] uppercase">
                                {language === "en" ? "Responsible" : "Responsável"}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            disabled={isResponsible}
                            onClick={() => handleRemoveParticipant(index)}
                            className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 p-0.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-slate-400 disabled:hover:bg-transparent"
                            title={isResponsible
                              ? (language === "en" ? "Change the responsible person before removing." : "Troque o responsável antes de remover.")
                              : (language === "en" ? "Delete participant" : "Remover participante")}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })
                  ) : (
                    <span className="text-[10px] italic text-slate-400 p-2 block text-center font-medium">
                      {language === "en" ? "No participants." : "Nenhum participante adicionado."}
                    </span>
                  )}
                </div>
              </aside>
              </div>

              <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0">
                <button
                  type="button"
                  onClick={fecharModal}
                  className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer"
                >
                  {t.btnCancel}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer inline-flex items-center gap-1.5"
                >
                  {editingId ? t.btnUpdate : t.btnSubmit}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* CONFIRMAÇÃO: EXCLUIR TEMA DA BIBLIOTECA */}
      {temaParaExcluir && (
        <ConfirmRemovalDialog
          language={language}
          confirmacao={confirmacaoExclusaoTema(temaParaExcluir.title, language)}
          busy={excluindo}
          onCancel={() => setTemaParaExcluir(null)}
          onConfirm={() => void confirmarExclusao()}
        />
      )}

      {/* POPUP MODAL: SELECIONAR PARTICIPANTES DO TEMA */}
      {isParticipantModalOpen && createPortal(
        <div className="fixed inset-0 bg-slate-900/65 backdrop-blur-sm z-[999] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl border border-slate-200/90 shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col md:flex-row animate-fade-in text-slate-700">

            {/* LEFT AREA: Users list and search */}
            <div className={`flex-1 p-6 md:p-8 flex flex-col justify-between overflow-y-auto`}>
              <div>
                <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                  <div>
                    <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                      <Users className="w-5 h-5 text-[#00658d]" />
                      {language === "en" ? "Link Participants" : "Vincular Participantes"}
                    </h3>
                    <p className="text-slate-400 font-semibold text-[11px] mt-0.5">
                      {language === "en" ? "Select corporate accounts and observers for this topic." : "Selecione membros do diretório, conselho ou convidados."}
                    </p>
                  </div>
                  <button
                    onClick={() => setIsParticipantModalOpen(false)}
                    className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Participantes vêm do diretório corporativo (Microsoft
                    Graph). A lista local editável e o cadastro manual foram
                    removidos: pessoa não se cria digitando. */}
                <div className="my-4">
                  <DirectoryUserPicker
                    language={language}
                    keepOpenOnSelect
                    alreadyChosenIds={participants
                      .map((participant) => participant.entraObjectId)
                      .filter((id): id is string => Boolean(id))}
                    placeholder={language === "en" ? "Search directory by name or e-mail..." : "Buscar no diretório por nome ou e-mail..."}
                    onSelect={(user) => {
                      /*
                       * Guarda IDENTIDADE, não só o nome: `entraObjectId` é o
                       * que permite ao backend reconhecer a pessoa e, se ela já
                       * tiver conta, vincular ao `users.id` existente.
                       *
                       * Deduplicação pelo oid — nome não é chave, e dois
                       * homônimos do diretório são duas pessoas.
                       */
                      const displayName = user.displayName ?? directoryEmail(user) ?? "";
                      if (!displayName) return;
                      if (participants.some((p) => p.entraObjectId === user.id)) return;

                      setParticipants([
                        ...participants,
                        { entraObjectId: user.id, displayName, email: directoryEmail(user) ?? undefined }
                      ]);
                    }}
                  />
                </div>

                {/* Já vinculados a este tema */}
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {participants.length === 0 ? (
                    <p className="text-[10.5px] text-slate-400 font-semibold italic py-4 text-center">
                      {language === "en" ? "No one linked yet." : "Ninguém vinculado ainda."}
                    </p>
                  ) : (
                    participants.map((p, idx) => {
                      const isResponsible = isResponsibleTopicParticipant(p, authorEntraObjectId);
                      return (
                        <div
                          key={p.entraObjectId ?? p.email ?? `${p.displayName}-${idx}`}
                          className="p-3 rounded-2xl border bg-[#00658d]/5 border-[#00658d]/35 flex items-center justify-between gap-3"
                        >
                          <span className="font-extrabold text-slate-950 text-xs truncate min-w-0">
                            {p.displayName ?? p.email ?? ""}
                            {isResponsible && (
                              <span className="ml-1.5 text-[8.5px] text-[#00658d] uppercase">
                                {language === "en" ? "Responsible" : "Responsável"}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            disabled={isResponsible}
                            onClick={() => handleRemoveParticipant(idx)}
                            className="px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider bg-rose-500 text-white hover:bg-rose-600 transition cursor-pointer shrink-0 disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-rose-500"
                            title={isResponsible
                              ? (language === "en" ? "Change the responsible person before removing." : "Troque o responsável antes de remover.")
                              : undefined}
                          >
                            {language === "en" ? "Remove" : "Remover"}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Action feet area row */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-end mt-6">
                <button
                  type="button"
                  onClick={() => setIsParticipantModalOpen(false)}
                  className="px-5 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white font-bold text-xs uppercase rounded-xl transition cursor-pointer"
                >
                  {language === "en" ? "Confirm & Back" : "Confirmar e Voltar"}
                </button>
              </div>
            </div>

          </div>
        </div>,
        document.body
      )}

    </div>
  );
}
