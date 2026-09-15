import React, { useState, useEffect } from "react";
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
  History,
  Calendar,
  Flag,
  UserPlus,
  ArrowRight,
  ShieldAlert
} from "lucide-react";
import { StandaloneAgenda, Meeting } from "../types";
import DirectoryUserPicker from "./DirectoryUserPicker";
import DurationHoursMinutesSelect from "./DurationHoursMinutesSelect";
import { directoryEmail, type DirectoryUser } from "../lib/directory";
import { formatMinutesAsTime, parseDurationMinutes } from "../lib/agenda-time";

interface UnlinkedAgendasViewProps {
  language: "en" | "pt";
  standaloneAgendas: StandaloneAgenda[];
  /** Carga de GET /agenda-topics em andamento. */
  agendaTopicsLoading?: boolean;
  agendaTopicsError?: string | null;
  onReloadAgendaTopics?: () => void;
  onAddStandaloneAgenda: (input: BibliotecaFormInput) => void;
  onDeleteStandaloneAgenda: (id: string) => void;
  onUpdateStandaloneAgenda: (id: string, input: BibliotecaFormInput) => void;
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
  pautaTypes = [],
  pautaNatures = []
}: UnlinkedAgendasViewProps) {
  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
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
  const [isFupForm, setIsFupForm] = useState(false);
  const [meetingId, setMeetingId] = useState("");
  /*
   * IDENTIDADE do tipo/natureza, não o rótulo.
   *
   * Antes o `value` do select era o nome, o que fazia renomear um cadastro
   * quebrar o vínculo de todas as pautas que o usavam.
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
    title: language === "en" ? "Agendas / Pautas" : "Pautas",
    subTitle: language === "en" 
      ? "Create and manage corporate agendas before linking them to specific board meetings." 
      : "Cadastre e configure temas e assuntos independentes para debates e deliberações em reuniões do conselho.",
    
    secNew: language === "en" ? "Register Agenda" : "Cadastrar Nova Pauta",
    secEdit: language === "en" ? "Edit Agenda" : "Editar Pauta",
    lblTitle: language === "en" ? "Topic Title / Proposal" : "Título da Pauta",
    lblDuration: language === "en" ? "Estimated Duration (HH:mm)" : "Tempo Estimado (Duração)",
    // `author` pode ser pessoa, área, órgão, cargo ou coletivo — o rótulo não
    // afirma que quem responde pela pauta é quem vai apresentá-la.
    lblSpeaker: language === "en" ? "Responsible" : "Responsável pela pauta (EntraID)",
    lblCategory: language === "en" ? "Governance Segment" : "Categoria Governança",
    lblDescription: language === "en" ? "Executive Summary & Pre-Reads" : "Descrição / Objetivo de Debate",
    lblParticipants: language === "en" ? "Additional Participants / Observers" : "Participantes Extras / Convidados (EntraID)",
    lblMeetingLink: language === "en" ? "Linked Meeting" : "Vincular a Reunião",
    lblPautaType: language === "en" ? "Pauta Type" : "Tipo de Pauta",
    lblPautaNature: language === "en" ? "Pauta Nature" : "Natureza da Pauta",
    
    placeholderTitle: language === "en" ? "e.g. ESG Sustainability Report" : "Ex: Relatório de Sustentabilidade ESG",
    placeholderSpeaker: language === "en" ? "Select responsible..." : "Selecione o responsável...",
    placeholderDesc: language === "en" ? "Strategic context and decisions expected..." : "Pontos fundamentais e materiais a serem lidos previamente para a tomada de decisões.",
    placeholderParticipant: language === "en" ? "Select participant to add..." : "Selecione para adicionar...",
    
    btnSubmit: language === "en" ? "Save Agenda" : "Salvar Pauta",
    btnUpdate: language === "en" ? "Save Changes" : "Salvar Alterações",
    btnCancelEdit: language === "en" ? "Cancel Edit" : "Cancelar Edição",
    
    secList: language === "en" ? "Registered Agendas" : "Pautas Cadastradas",
    searchPlc: language === "en" ? "Search topics, speakers or summaries..." : "Buscar pautas por título, apresentador ou objetivos...",
    filterAll: language === "en" ? "All Governance Categories" : "Qualquer Categoria",
    
    emptyState: language === "en" 
      ? "No agendas found matching your filters. Register a new one on the left!" 
      : "Nenhuma pauta cadastrada atende aos filtros. Registre ou altere os filtros!",
    
    badgeUnlinked: language === "en" ? "Available" : "Livre para Vínculo",
    lblTips: language === "en" ? "How do pautas work?" : "Como funcionam as pautas?",
    tipsBody: language === "en"
      ? "These are independent board topics stored in your repository. When scheduling corporate meetings, you can immediately pull them to auto-assemble meeting agendas in one click, along with planned durations and speakers."
      : "As pautas cadastradas aqui formam uma biblioteca de assuntos corporativos. Ao agendar uma nova reunião oficial do conselho ou comitê, você pode importar qualquer uma dessas pautas de forma instantânea de maneira simplificada.",
      
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
      generatesActionItem: isFupForm,
      isCircularTheme: isCircular,
      participants: participantesComResponsavel
    };

    if (editingId) {
      onUpdateStandaloneAgenda(editingId, input);
      setEditingId(null);
    } else {
      onAddStandaloneAgenda(input);
    }

    // Reset Form
    setTitle("");
    setAuthor("");
    setAuthorFromDirectory(null);
    setAuthorEntraObjectId("");
    setDescription("");
    setParticipants([]);
    setDuration("00:30");
    setIsFupForm(false);
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

      setEditingId(agenda.id);
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
      setIsFupForm(agenda.isFUP || false);
      setPautaTypeId(agenda.pautaTypeId || pautaTypes[0]?.id || "");
      setPautaNatureId(agenda.pautaNatureId || pautaNatures[0]?.id || "");
      setIsCircular(agenda.isCircularTheme === true);

      setDuration(agenda.duration);
    } catch (error) {
      setEditLoadError(describeTopicError(error, language));
    } finally {
      setLoadingEditId(null);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditLoadError(null);
    setTitle("");
    setAuthor("");
    setAuthorFromDirectory(null);
    setAuthorEntraObjectId("");
    setDescription("");
    setParticipants([]);
    setDuration("00:30");
    setIsFupForm(false);
    setMeetingId("");
    setPautaTypeId(pautaTypes[0]?.id || "");
    setPautaNatureId(pautaNatures[0]?.id || "");
    setIsCircular(false);
    setSelectedParticipantToAdd("");
  };

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
      <header className="pb-4 border-b border-slate-200/60">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 flex items-center gap-2.5 font-sans">
          <ListTodo className="w-8 h-8 text-[#00658d] shrink-0" />
          {t.title}
        </h2>
        <p className="text-slate-500 font-medium text-sm mt-1.5 matches-subheading-style">
          {t.subTitle}
        </p>
      </header>

      {/* MAIN TWO-COLUMN LAYOUT */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mt-6">
        
        {/* LEFT COLUMN: REGISTRATION / EDIT FORM */}
        <section className="lg:col-span-4 bg-white border border-slate-100 rounded-2xl p-5 lg:sticky lg:top-6 self-start shadow-xs">
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-1.5">
              <Pencil className="w-3.5 h-3.5 text-[#00658d]" />
              <span className="text-xs font-bold text-slate-800 uppercase font-sans tracking-wide">
                {editingId ? t.secEdit : t.secNew}
              </span>
            </div>
            {editingId && (
              <span className="text-[9px] bg-sky-50 text-[#00658d] border border-sky-100 font-extrabold px-2 py-0.5 rounded-full select-none">
                {editingId.toUpperCase()}
              </span>
            )}
          </div>

          {editLoadError && (
            <p className="mb-3 rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-[10px] font-bold text-red-700" role="alert">
              {editLoadError}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5 font-semibold text-xs text-slate-750">
            
            {/*
              "Reunião Vinculada" saiu do formulário.
              O vínculo é `meeting_agenda_items.agenda_topic_id`: a pauta entra
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

            {/* Responsável pela pauta — pessoas vêm do diretório corporativo
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

            {/* Tipo de Pauta */}
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

            {/* Natureza da Pauta */}
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

            {/* Tema circular? — PADRÃO da Biblioteca. Copiado para a pauta ao
                vincular a uma reunião; sem automação. Default Não. */}
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

            {/* FUP Classification Checkbox */}
            <div className="bg-slate-50/40 hover:bg-slate-50 border border-slate-100 rounded-xl p-3 select-none flex items-center gap-2.5 transition-colors">
              <input
                id="isFupCheckbox"
                type="checkbox"
                checked={isFupForm}
                onChange={(e) => setIsFupForm(e.target.checked)}
                className="w-4 h-4 text-[#00658d] border-slate-200 rounded focus:ring-[#00658d]/30 cursor-pointer"
              />
              <label htmlFor="isFupCheckbox" className="text-xs font-bold text-slate-700 cursor-pointer flex items-center gap-1.5 flex-1">
                <History className={`w-4 h-4 text-[#00658d] ${isFupForm ? "animate-spin" : ""}`} style={isFupForm ? { animationDuration: '8s' } : undefined} />
                <div className="flex flex-col text-left">
                  <span className="text-slate-800 font-bold text-[11.5px]">{language === "en" ? "Classify under Follow-Up (FUP)" : "Classificar como Tema de FUP"}</span>
                  <span className="text-[9.5px] font-medium text-slate-400 normal-case leading-tight">
                    {language === "en" ? "Keeps the topic flagged for ongoing monitoring and tracking" : "Mantém o tema sob acompanhamento contínuo da secretaria"}
                  </span>
                </div>
              </label>
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

            {/* Adicionar Participantes section */}
            <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
              <label className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>{language === "en" ? "Add Participants" : "Adicionar Participantes"}</span>
                <span className="text-[9px] text-[#00658d] font-extrabold bg-[#00658d]/5 px-2 py-0.5 rounded-full">
                  {participants.length}
                </span>
              </label>
              
              <button
                type="button"
                onClick={() => setIsParticipantModalOpen(true)}
                className="w-full py-2 px-3 bg-slate-50 hover:bg-[#00658d]/5 border border-slate-100 hover:border-[#00658d]/20 text-[#00658d] rounded-xl text-xs transition flex items-center justify-center gap-2 cursor-pointer font-bold select-none text-center"
              >
                <Users className="w-3.5 h-3.5" />
                {language === "en" ? "Manage Participants" : "Vincular Participantes"}
              </button>

              {/* Renders current Participant Chips */}
              <div className="mt-1 space-y-1 max-h-36 overflow-y-auto p-1 bg-slate-50/30 rounded-xl border border-slate-100">
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
            </div>

            {/* CTA action row */}
            <div className="flex flex-col gap-1.5 pt-2">
              <button
                type="submit"
                className="w-full py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white font-bold uppercase text-[10px] tracking-wider rounded-xl shadow-xs transition flex items-center justify-center gap-1.5 active:scale-[0.98] select-none cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {editingId ? t.btnUpdate : t.btnSubmit}
              </button>

              {editingId && (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold uppercase text-[9px] tracking-wider rounded-xl transition flex items-center justify-center gap-1.5 select-none cursor-pointer"
                >
                  {t.btnCancelEdit}
                </button>
              )}
            </div>

          </form>
        </section>

        {/* RIGHT COLUMN: REGISTERED LIST */}
        <section className="lg:col-span-8 space-y-4 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto pr-1.5 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
          
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
                <option value="fup">{language === "en" ? "Only FUP (Follow-Up)" : "Apenas Pautas em FUP"}</option>
                <option value="non-fup">{language === "en" ? "Standard Topics (No FUP)" : "Apenas Pautas Padrão (Sem FUP)"}</option>
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
                 * navegador: duas pautas homônimas apareciam vinculadas às
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
                          // PATCH parcial: só o campo que mudou. Reenviar
                          // a pauta inteira sobrescreveria o que veio do banco.
                          onUpdateStandaloneAgenda(agenda.id, {
                            title: agenda.title,
                            generatesActionItem: !agenda.isFUP
                          });
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
                          : (language === "en" ? "Edit agenda" : "Editar pauta")}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>

                      {/* Delete Button */}
                      <button
                        type="button"
                        onClick={() => onDeleteStandaloneAgenda(agenda.id)}
                        className="text-slate-400 hover:text-rose-600 hover:bg-rose-50 p-1.5 rounded-md border border-slate-100 bg-white transition-colors cursor-pointer"
                        title={language === "en" ? "Delete agenda" : "Excluir pauta"}
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

      </div>

      {/* POPUP MODAL: SELECIONAR PARTICIPANTES DA PAUTA */}
      {isParticipantModalOpen && (
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

                {/* Já vinculados a esta pauta */}
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
        </div>
      )}

    </div>
  );
}
