import React, { useState, useEffect } from "react";
import { X, Calendar, Clock, MapPin, CheckCircle, Sparkles, User, Users, Plus, Trash2, ListTodo, FileText, Info, GripVertical, Edit2 } from "lucide-react";
import { AgendaItem, GovernanceBody, Participant, StandaloneAgenda } from "../types";
import { newId } from "../lib/id";
import DirectoryUserPicker from "./DirectoryUserPicker";
import type { DirectoryUser } from "../lib/directory";
import type { BibliotecaFormInput, TaxonomyItem, TopicParticipantPayload } from "../lib/agenda-topics";
import {
  addParticipantOnce,
  canOfferAsParticipant,
  enderecoDoDiretorio,
  isAlreadyParticipant
} from "../lib/participants";
import {
  DEFAULT_TIMEZONE,
  buildCreatePayload,
  createMeeting,
  describeMeetingError,
  instantToLocal
} from "../lib/meetings";

/**
 * Minutos a partir do texto livre de duração ("30 mins", "45", "1h").
 * Sem número reconhecível devolve `null`: a API aceita pauta sem duração, e
 * chutar um valor inventaria informação.
 */
function parseDuracaoEmMinutos(texto: string): number | null {
  const horas = /^\s*(\d+)\s*h/i.exec(texto);
  if (horas) return Number(horas[1]) * 60;
  const minutos = /(\d+)/.exec(texto);
  return minutos ? Number(minutos[1]) : null;
}

interface ScheduleMeetingModalProps {
  language: "en" | "pt";
  /** Órgãos ativos vindos do PostgreSQL. A identidade é o `id`, não o nome. */
  governanceBodies: GovernanceBody[];
  standaloneAgendas: StandaloneAgenda[];
  onClose: () => void;
  /** Avisa que POST /meetings devolveu 201. O `id` é o UUID do banco. */
  onCreated: (meetingId: string, title: string) => void;
  /** Cria o tema na Biblioteca e DEVOLVE o tema criado (para o drawer vincular). */
  onAddStandaloneAgenda: (input: BibliotecaFormInput) => Promise<StandaloneAgenda | null>;
  /** Mesmas fontes de Tipo/Natureza da Biblioteca (cadastros relacionais). */
  pautaTypes: TaxonomyItem[];
  pautaNatures: TaxonomyItem[];
}

export default function ScheduleMeetingModal({
  language,
  governanceBodies = [],
  standaloneAgendas = [],
  onClose,
  onCreated,
  onAddStandaloneAgenda,
  pautaTypes = [],
  pautaNatures = []
}: ScheduleMeetingModalProps) {
  const [title, setTitle] = useState("");
  /** Identidade do órgão: UUID real de `governance_bodies`, nunca o nome. */
  const [governanceBodyId, setGovernanceBodyId] = useState("");

  /*
   * ORGANIZADOR — pessoa em cujo calendário o evento nascerá.
   *
   * NÃO é quem está cadastrando. A assessora cadastra; o Presidente organiza.
   * Por isso o campo é explícito e vem do diretório corporativo: escolher pessoa
   * é ato deliberado, e a identidade que vale é o `id` do Graph (o `oid`), nunca
   * o nome digitado.
   *
   * Vazio significa "eu mesmo" — o caso comum, e o servidor resolve.
   */
  const [organizerUser, setOrganizerUser] = useState<DirectoryUser | null>(null);
  /*
   * Data inicial: HOJE, no fuso da reunião.
   *
   * Era uma data fixa no código, que envelhecia sozinha e obrigava a corrigir o
   * campo a cada cadastro. `instantToLocal` com `DEFAULT_TIMEZONE` — e não
   * `toISOString()` — porque o dia civil precisa ser o do calendário da
   * reunião: às 22h de Brasília o UTC já virou, e a data sairia um dia à
   * frente.
   *
   * Inicializador preguiçoso: roda uma vez por abertura do modal, e o modal é
   * montado a cada abertura — então a data acompanha o dia sem recalcular a
   * cada tecla digitada no formulário.
   */
  const [date, setDate] = useState(
    () => instantToLocal(new Date().toISOString(), DEFAULT_TIMEZONE).date
  );
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("12:00");
  /*
   * Fuso IANA. O valor anterior era "EST" — uma abreviação, que a API recusa e
   * que sequer identifica um fuso sem ambiguidade.
   */
  const [timeZone] = useState(DEFAULT_TIMEZONE);
  const [organizer, setOrganizer] = useState("Secretaria Geral de Governança");
  const [recurrence, setRecurrence] = useState("Mensal");
  const [description, setDescription] = useState("");

  // Live Participant adding states
  /*
   * Começa VAZIO. Antes vinha pré-preenchido com duas pessoas de demonstração
   * ("Mariana Silveira", "Secretária Geral de Governança") que não existem no
   * diretório — e que iam para `meeting_participants` no PostgreSQL assim que
   * alguém criasse a reunião. Participante entra pelo diretório corporativo.
   */
  const [participants, setParticipants] = useState<Omit<Participant, "initials">[]>([]);
  const [newPartName, setNewPartName] = useState("");
  const [newPartRole, setNewPartRole] = useState("");
  const [newPartConfirmed, setNewPartConfirmed] = useState(true);

  // Live Agenda adding states
  /*
   * Começa VAZIA, pelo mesmo motivo dos participantes: as duas pautas de
   * exemplo viravam linhas reais em `meeting_agenda_items`. Pauta vem da
   * Biblioteca ou é escrita aqui por quem está agendando.
   */
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);

  // Seção Pautas - Item 7.2 selection & creation states
  const [isSelectAgendasOpen, setIsSelectAgendasOpen] = useState(false);
  const [selectedAgendaIds, setSelectedAgendaIds] = useState<string[]>([]);
  const [isCreateAgendaDrawerOpen, setIsCreateAgendaDrawerOpen] = useState(false);

  // Drag and Reorder/Edit States
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [editingAgendaIndex, setEditingAgendaIndex] = useState<number | null>(null);

  const [editingTopicTitle, setEditingTopicTitle] = useState("");
  const [editingTopicDuration, setEditingTopicDuration] = useState("");
  /** Texto exibido do responsável: pode ser pessoa, área ou coletivo. */
  const [editingTopicAuthor, setEditingTopicAuthor] = useState("");
  /** `id` no Graph do responsável, quando é uma pessoa do diretório. */
  const [editingTopicAuthorUser, setEditingTopicAuthorUser] = useState<DirectoryUser | null>(null);
  const [editingTopicAuthorOid, setEditingTopicAuthorOid] = useState<string | undefined>(undefined);
  /** Endereço do responsável escolhido no diretório, para o convite. */
  const [editingTopicAuthorEmail, setEditingTopicAuthorEmail] = useState<string | undefined>(undefined);
  /** Opção explícita de incluir o responsável entre os participantes. */
  const [editingTopicAuthorAsParticipant, setEditingTopicAuthorAsParticipant] = useState(false);


  const recalculateAgendaTimesInModal = (agendaArray: AgendaItem[], customStart?: string): AgendaItem[] => {
    if (agendaArray.length === 0) return [];
    
    let startStr = customStart || startTime || "10:00";
    let hour = 10;
    let minute = 0;
    let ampm = "";

    const cleanStr = startStr.trim().toUpperCase();
    const ampmMatch = cleanStr.match(/(AM|PM)/);
    if (ampmMatch) ampm = ampmMatch[0];

    const digits = cleanStr.replace(/[^0-9:]/g, "").split(":");
    if (digits.length >= 1) hour = parseInt(digits[0], 10) || 10;
    if (digits.length >= 2) minute = parseInt(digits[1], 10) || 0;

    if (ampm === "PM" && hour < 12) hour += 12;
    else if (ampm === "AM" && hour === 12) hour = 0;

    let currentMinutes = hour * 60 + minute;

    return agendaArray.map((item) => {
      const h24 = Math.floor(currentMinutes / 60) % 24;
      const m = currentMinutes % 60;

      const formattedTime = `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

      let durationMinutes = 15;
      const durationMatch = item.duration.match(/\d+/);
      if (durationMatch) {
         durationMinutes = parseInt(durationMatch[0], 10);
      } else if (item.duration.includes(":")) {
         const [dh, dm] = item.duration.split(":").map(Number);
         durationMinutes = (dh * 60 || 0) + (dm || 0);
      }

      currentMinutes += durationMinutes;

      return {
        ...item,
        time: formattedTime
      };
    });
  };

  /*
   * Trava a rolagem da página enquanto o modal está aberto.
   *
   * Sem isso, rolar dentro do formulário "vaza" para a tela de trás quando o
   * conteúdo do modal chega ao fim, e a página some por baixo do overlay.
   *
   * A largura da barra de rolagem é devolvida como padding: ocultá-la sem
   * compensar encolhe a página em ~15px e o conteúdo pula lateralmente ao abrir
   * e ao fechar.
   *
   * Guarda os valores ANTERIORES em vez de limpar para "": se algum dia outro
   * componente também travar a rolagem, restaurar às cegas devolveria a rolagem
   * a quem ainda a queria travada.
   */
  useEffect(() => {
    const { body } = document;
    const overflowAnterior = body.style.overflow;
    const paddingAnterior = body.style.paddingRight;
    const larguraDaBarra = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = "hidden";
    if (larguraDaBarra > 0) {
      const atual = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${atual + larguraDaBarra}px`;
    }

    return () => {
      body.style.overflow = overflowAnterior;
      body.style.paddingRight = paddingAnterior;
    };
  }, []);

  useEffect(() => {
    setAgenda(prev => {
      const recalculated = recalculateAgendaTimesInModal(prev, startTime);
      const changed = recalculated.some((item, idx) => item.time !== prev[idx]?.time);
      return changed ? recalculated : prev;
    });
  }, [startTime]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;

    const agendaList = [...agenda];
    const draggedItem = agendaList[draggedIndex];
    agendaList.splice(draggedIndex, 1);
    agendaList.splice(targetIndex, 0, draggedItem);

    const updatedAgenda = recalculateAgendaTimesInModal(agendaList, startTime);
    setAgenda(updatedAgenda);
    setDraggedIndex(null);
  };

  const jaEParticipante = (nome: string, entraObjectId?: string) =>
    isAlreadyParticipant(participants, { name: nome, entraObjectId });

  /**
   * Inclui o responsável entre os participantes — só quando a opção ao lado do
   * campo foi marcada.
   *
   * Papel neutro, o mesmo do cadastro manual: participar de uma reunião não
   * implica apresentar nada. E entra sem presença confirmada, porque quem
   * marcou a opção foi quem monta a pauta, não a pessoa convidada.
   */
  const incluirComoParticipante = (nome: string, entraObjectId?: string, email?: string) => {
    if (!nome.trim()) return;
    setParticipants((prev) =>
      addParticipantOnce(prev, {
        name: nome.trim(),
        role: language === "en" ? "Participant" : "Convidado",
        confirmed: false,
        entraObjectId,
        // Capturado no momento da escolha no diretório: depois da reunião
        // gravada não há como voltar ao Graph para descobrir o endereço de
        // alguém que não tem conta no PGCP.
        email
      })
    );
  };

  /**
   * Opção explícita ao lado do campo de responsável.
   *
   * Só aparece quando há uma pessoa do diretório escolhida: área, órgão e
   * coletivo ("Todos", "Comitê de Auditoria") não são convidáveis, e texto
   * livre não traz identidade para deduplicar.
   */
  const renderOpcaoParticipante = (
    nome: string,
    entraObjectId: string | undefined,
    marcado: boolean,
    aoMarcar: (valor: boolean) => void
  ) => {
    if (!canOfferAsParticipant(entraObjectId)) return null;

    if (jaEParticipante(nome, entraObjectId)) {
      return (
        <p className="flex items-center gap-1.5 mt-1.5 text-[10px] font-bold text-emerald-600">
          <CheckCircle className="w-3 h-3 shrink-0" />
          {language === "en" ? "Already a participant of this meeting" : "Já é participante desta reunião"}
        </p>
      );
    }

    return (
      <label className="flex items-start gap-2 mt-1.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={marcado}
          onChange={(e) => aoMarcar(e.target.checked)}
          className="mt-0.5 rounded border-slate-300 text-[#00658d] focus:ring-[#00658d] cursor-pointer"
        />
        <span className="text-[10px] font-semibold text-slate-500 leading-snug">
          {language === "en"
            ? `Also add ${nome} as a participant of this meeting`
            : `Adicionar ${nome} também como participante da reunião`}
        </span>
      </label>
    );
  };

  const handleEditAgendaItem = (index: number) => {
    const item = agenda[index];
    if (!item) return;
    setEditingAgendaIndex(index);
    setEditingTopicTitle(item.title);
    setEditingTopicDuration(item.duration);
    setEditingTopicAuthor(item.author || "");
    setEditingTopicAuthorOid(item.authorEntraObjectId);
    // Pauta já existente não guarda endereço: ele só existe quando a pessoa é
    // escolhida no diretório agora.
    setEditingTopicAuthorEmail(undefined);
    /*
     * O que se sabe da pessoa é o par (id, nome) guardado na própria pauta —
     * o resto do registro do diretório não foi persistido. Os `null` dizem
     * "desconhecido", que é a verdade; nada aqui é inventado.
     */
    setEditingTopicAuthorUser(
      item.authorEntraObjectId
        ? {
            id: item.authorEntraObjectId,
            displayName: item.author,
            mail: null,
            userPrincipalName: null,
            jobTitle: null,
            userType: null,
            accountEnabled: null
          }
        : null
    );
    setEditingTopicAuthorAsParticipant(false);
  };

  const handleSaveEditedAgendaItem = () => {
    if (editingAgendaIndex === null) return;
    const autor = editingTopicAuthor.trim() || "Todos";
    const updatedAgenda = [...agenda];
    updatedAgenda[editingAgendaIndex] = {
      ...updatedAgenda[editingAgendaIndex],
      title: editingTopicTitle.trim(),
      duration: editingTopicDuration.trim(),
      author: autor,
      authorEntraObjectId: editingTopicAuthorOid
    };

    if (editingTopicAuthorAsParticipant && editingTopicAuthorOid) {
      incluirComoParticipante(autor, editingTopicAuthorOid, editingTopicAuthorEmail);
    }

    setAgenda(recalculateAgendaTimesInModal(updatedAgenda, startTime));
    setEditingAgendaIndex(null);
  };

  // Drawer fields
  const [tempPautaTitle, setTempPautaTitle] = useState("");
  const [tempPautaDuration, setTempPautaDuration] = useState("30 mins");
  /** Responsável escolhido no diretório. `null` = pauta sem pessoa definida. */
  const [tempPautaAuthorUser, setTempPautaAuthorUser] = useState<DirectoryUser | null>(null);
  /** Opção explícita de incluir o responsável entre os participantes. */
  const [tempPautaAuthorAsParticipant, setTempPautaAuthorAsParticipant] = useState(false);
  const [tempPautaDescription, setTempPautaDescription] = useState("");
  // Tema circular da nova pauta. Default Não. Só REGISTRA o fato: sem automação.
  const [tempPautaCircular, setTempPautaCircular] = useState(false);
  // Ficha (019): Tipo/Natureza usam os MESMOS cadastros da Biblioteca; FUP é só
  // classificação. Tipo/Natureza caem no primeiro cadastro disponível.
  const [tempPautaTypeId, setTempPautaTypeId] = useState("");
  const [tempPautaNatureId, setTempPautaNatureId] = useState("");
  const [tempPautaFup, setTempPautaFup] = useState(false);
  // Participantes da pauta (Opção A). No drawer eles nascem no TEMA criado e o
  // backend faz o snapshot para a reunião ao vincular.
  const [tempPautaParticipants, setTempPautaParticipants] = useState<TopicParticipantPayload[]>([]);

  useEffect(() => {
    if (pautaTypes.length > 0 && !tempPautaTypeId) setTempPautaTypeId(pautaTypes[0].id);
  }, [pautaTypes, tempPautaTypeId]);
  useEffect(() => {
    if (pautaNatures.length > 0 && !tempPautaNatureId) setTempPautaNatureId(pautaNatures[0].id);
  }, [pautaNatures, tempPautaNatureId]);

  /** Sem pessoa escolhida, a pauta fica no coletivo — o mesmo padrão de antes. */
  const tempPautaAuthor = tempPautaAuthorUser?.displayName?.trim() || "Todos";

  const [newAgendaTime, setNewAgendaTime] = useState("");
  const [newAgendaTitle, setNewAgendaTitle] = useState("");
  const [newAgendaDuration, setNewAgendaDuration] = useState("");
  const [newAgendaAuthor, setNewAgendaAuthor] = useState("");

  /*
   * REMOVIDO: o efeito que transformava todo `author` da agenda em
   * participante, com papel "Apresentador" e presença confirmada.
   *
   * Escapava apenas o literal "Todos", então áreas e coletivos —
   * "Finance Committee", "Everyone", "Audit Committee" — entravam na lista
   * como se fossem pessoas e contavam para o quórum.
   *
   * Responsável pela pauta e participante da reunião passaram a ser decisões
   * separadas: escolher o responsável não mexe em participantes, e incluir a
   * pessoa exige marcar a opção explícita ao lado do campo.
   */

  const t = {
    title: language === "en" ? "Schedule Corporate Meeting" : "Agendar Nova Reunião",
    subTitle: language === "en" 
      ? "Create a new compliant session, allocate agendas, and define expected quorum limits." 
      : "Registre uma nova sessão oficial de governança, configure o cronograma e escale participantes.",
    
    lblTitle: language === "en" ? "Meeting Topic / Title" : "Título ou Tema da Reunião",
    lblCategory: language === "en" ? "Meeting Template Category" : "Categoria do Colegiado / Reunião",
    lblDate: language === "en" ? "Scheduled Date" : "Data da Reunião",
    lblStartTime: language === "en" ? "Start Time" : "Horário de Início",
    lblEndTime: language === "en" ? "End Time" : "Horário de Término",
    lblTimeZone: "Fuso Horário",
    lblOrganizer: language === "en" ? "Meeting Organizer" : "Organizador da Reunião",
    lblDescription: language === "en" ? "Objective & Introductory Guidelines" : "Objetivos Principais e Diretrizes Executivas",
    
    lblParticipantsSec: language === "en" ? "Participants" : "Participantes",
    subParticipants: language === "en" ? "Add people to compute the official quorum requirements." : "Instancie os membros para controle de presenças e convocações.",
    addPartName: language === "en" ? "Name" : "Nome",
    addPartRole: language === "en" ? "Role" : "Cargo / Função",
    addPartConfirmedShort: language === "en" ? "Confirmed" : "Confirmado",
    noParticipants: language === "en" ? "No participants added." : "Nenhum participante adicionado.",

    lblAgendaSec: language === "en" ? "Agenda / Timeline Topics" : "Pauta de Assuntos",
    subAgenda: language === "en" ? "Define agenda items. Schedule times will calculate automatically." : "Cronograma detalhado de apresentações oficiais para ata.",
    addAgendaTime: language === "en" ? "Time" : "Início",
    addAgendaTitle: language === "en" ? "Topic Title" : "Título do Tema",
    addAgendaDuration: language === "en" ? "Duration" : "Duração",
    // `AgendaItem.author` pode ser pessoa, área, órgão, cargo ou coletivo
    // ("Todos"). O rótulo diz "Responsável" para não afirmar que é apresentador.
    addAgendaAuthor: language === "en" ? "Responsible" : "Responsável",
    noAgenda: language === "en" ? "No agenda items added." : "Nenhum tópico adicionado à pauta ainda.",
    lblImportStandalone: language === "en" ? "Quick Import from Saved Standalone Agendas" : "Importar Puta Pendente / Livre",
    importPlaceholder: language === "en" ? "-- Choose pre-registered topic --" : "-- Escolher pauta livre cadastrada --",

    btnCancel: language === "en" ? "Cancel" : "Cancelar",
    btnSubmit: language === "en" ? "Schedule & Log Session" : "Gravar e Agendar Reunião",
    placeholderTitle: language === "en" ? "e.g. Board of Directors Meeting" : "Ex: Reunião do Conselho de Administração (RCA)",
    placeholderDesc: language === "en" ? "Provide background contexts or briefing materials." : "Descreva em poucas palavras as pautas norteadoras e documentos anexos importantes.",
    btnAdd: language === "en" ? "Add" : "Adicionar",
  };

  const getInitials = (fullName: string): string => {
    if (!fullName.trim()) return "?";
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  };

  const handleAddParticipant = () => {
    if (!newPartName.trim()) return;
    setParticipants([
      ...participants,
      {
        name: newPartName.trim(),
        role: newPartRole.trim() || (language === "en" ? "Participant" : "Convidado"),
        confirmed: newPartConfirmed
      }
    ]);
    setNewPartName("");
    setNewPartRole("");
    setNewPartConfirmed(true);
  };

  const handleAddAgendaItem = () => {
    if (!newAgendaTitle.trim()) return;
    const authorVal = newAgendaAuthor.trim() || organizer || "Todos";
    setAgenda([
      ...agenda,
      {
        id: newId(),
        time: newAgendaTime.trim() || "10:00",
        title: newAgendaTitle.trim(),
        duration: newAgendaDuration.trim() || "15 mins",
        author: authorVal
      }
    ]);
    setNewAgendaTime("");
    setNewAgendaTitle("");
    setNewAgendaDuration("");
    setNewAgendaAuthor("");
  };

  /** Erro do POST, exibido junto ao botão. Nunca fecha o modal como sucesso. */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /**
   * Grava a reunião no PostgreSQL.
   *
   * Nada é inserido localmente: a fonte de verdade passou a ser o banco, e a
   * lista se atualiza relendo a API. O `status` inicial é decisão do servidor —
   * o payload não o carrega.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || isSaving) return;

    if (!governanceBodyId) {
      setSaveError(
        language === "en" ? "Select the governance body." : "Selecione o órgão de governança."
      );
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const payload = buildCreatePayload({
        governanceBodyId,
        organizer: organizerUser
          ? {
              entraObjectId: organizerUser.id,
              // Nome é obrigatório junto da identidade: a API recusa oid sem
              // rótulo, e com razão — a reunião precisa dizer quem organiza.
              displayName: organizerUser.displayName ?? "",
              email: enderecoDoDiretorio(organizerUser)
            }
          : undefined,
        title,
        description,
        date,
        startTime,
        endTime,
        timezone: timeZone,
        recurrence,
        participants,
        agendaItems: agenda
      });

      const criada = await createMeeting(payload);
      onCreated(criada.id, criada.title);
    } catch (error) {
      // Falha NÃO fecha o modal e não grava nada em lugar nenhum: o que a
      // usuária digitou continua na tela para ser corrigido.
      setSaveError(describeMeetingError(error, language));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
      {/* Outer wrapper modal frame */}
      {/*
        O painel ARREDONDA e RECORTA; quem rola é o miolo, logo abaixo.

        Com `rounded-3xl` e `overflow-y-auto` no mesmo elemento, a barra de
        rolagem é desenhada na borda reta do box e escapa do canto
        arredondado — o efeito visível era a barra "saindo do quadrado".
        Com `overflow-hidden` aqui, o recorte do raio vale para a barra do
        filho também.
      */}
      <div className="bg-white border border-slate-200 rounded-3xl max-w-5xl w-full relative animate-fade-in max-h-[95vh] overflow-hidden flex flex-col font-medium text-xs text-slate-705">
        
        {/* Close Button top-right */}
        <button
          onClick={onClose}
          type="button"
          className="absolute right-6 top-6 text-slate-400 hover:text-slate-600 transition-colors p-1.5 bg-slate-50 hover:bg-slate-100 rounded-full cursor-pointer z-10"
        >
          <X className="w-4.5 h-4.5" />
        </button>

        <div className="overflow-y-auto p-6 md:p-8">

        {/* Header decoration */}
        <div className="mb-6 border-b border-slate-100 pb-4 select-none">
          <span className="bg-[#00aeef]/10 text-[#00658d] px-3 py-1 rounded-full text-[9px] font-extrabold uppercase tracking-widest inline-block mb-2">
            Novo Evento
          </span>
          <h3 className="text-xl font-extrabold text-[#001e2d] flex items-center gap-2">
            <Calendar className="w-5 h-5 text-[#00658d]" />
            {t.title}
          </h3>
          <p className="text-slate-400 font-semibold text-[11px] mt-1 leading-relaxed">
            {t.subTitle}
          </p>
        </div>

        {/* Beautiful Form Layout */}
        <form onSubmit={handleSubmit} className="space-y-6">
          
          <div className="flex flex-col gap-6">
            
            {/* 1. INFORMACÕES CARD */}
            <div className="space-y-3.5 bg-slate-50/50 border border-slate-200/60 rounded-2xl p-4 md:p-5">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 mb-1.5 border-b border-slate-200/40 pb-2 select-none">
                <Info className="w-4 h-4 text-[#00658d]" />
                1. Informações Básicas
              </h4>

              {/* Title Input */}
              <div className="flex flex-col gap-1">
                <label htmlFor="meetTitle" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                  {language === "en" ? "Meeting Topic / Title" : "Título ou Tema da Reunião"} *
                </label>
                <input
                  id="meetTitle"
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t.placeholderTitle}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d] transition-all font-sans font-medium"
                />
              </div>

              {/* Date, Recurrence, Start & End Times row - compacted into a 4-col grid on tablet/destkop */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {/* Date */}
                <div className="flex flex-col gap-1">
                  <label htmlFor="meetDate" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                    {t.lblDate} *
                  </label>
                  <input
                    id="meetDate"
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none"
                  />
                </div>

                {/* Órgão de governança — identidade real, vinda do PostgreSQL */}
                <div className="flex flex-col gap-1">
                  <label htmlFor="meetGovernanceBody" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                    {language === "en" ? "Governance body" : "Órgão de Governança"} *
                  </label>
                  <select
                    id="meetGovernanceBody"
                    required
                    value={governanceBodyId}
                    onChange={(e) => setGovernanceBodyId(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                  >
                    <option value="">
                      {language === "en" ? "Select the body..." : "Selecione o órgão..."}
                    </option>
                    {/* `value` é o UUID: o nome serve só para a usuária ler. */}
                    {governanceBodies.map((body) => (
                      <option key={body.id} value={body.id}>{body.name}</option>
                    ))}
                  </select>
                </div>

                {/*
                  ORGANIZADOR — de quem é o calendário.

                  Explícito de propósito: assumir "organizador = quem está
                  logado" impediria a assessora de agendar em nome do
                  Presidente, que é justamente o fluxo real.
                */}
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                    {language === "en" ? "Organiser" : "Organizador"}
                  </label>
                  <DirectoryUserPicker
                    language={language}
                    selected={organizerUser}
                    onSelect={setOrganizerUser}
                    onClear={() => setOrganizerUser(null)}
                    placeholder={
                      language === "en"
                        ? "Search the directory — leave empty to organise it yourself"
                        : "Buscar no diretório — vazio organiza você mesma"
                    }
                  />
                  <p className="text-[10px] text-slate-400 font-medium">
                    {language === "en"
                      ? "The event is created in this person's calendar. Leave empty to organise it yourself."
                      : "O evento é criado no calendário desta pessoa. Deixe vazio para organizar você mesma."}
                  </p>
                </div>

                {/* Recurrence */}
                <div className="flex flex-col gap-1">
                  <label htmlFor="meetRecurrence" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                    {language === "en" ? "Recurrence" : "Recorrência"}
                  </label>
                  <select
                    id="meetRecurrence"
                    value={recurrence}
                    onChange={(e) => setRecurrence(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                  >
                    <option value="Single">{language === "en" ? "Does not repeat" : "Não se repete (Única)"}</option>
                    <option value="Semanal">{language === "en" ? "Weekly" : "Semanal"}</option>
                    <option value="Quinzenal">{language === "en" ? "Biweekly" : "Quinzenal"}</option>
                    <option value="Mensal">{language === "en" ? "Monthly" : "Mensal"}</option>
                    <option value="Trimestral">{language === "en" ? "Quarterly" : "Trimestral"}</option>
                  </select>
                </div>

                {/* Start Time */}
                <div className="flex flex-col gap-1">
                  <label htmlFor="startTime" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    {t.lblStartTime} *
                  </label>
                  <input
                    id="startTime"
                    type="text"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    placeholder="10:00"
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 text-center focus:outline-none"
                  />
                </div>

                {/* End Time */}
                <div className="flex flex-col gap-1">
                  <label htmlFor="endTime" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    {t.lblEndTime} *
                  </label>
                  <input
                    id="endTime"
                    type="text"
                    required
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    placeholder="12:00"
                    className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 text-center focus:outline-none"
                  />
                </div>
              </div>

              {/* Description Input */}
              <div className="flex flex-col gap-1">
                <label htmlFor="meetDesc" className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                  {t.lblDescription}
                </label>
                <textarea
                  id="meetDesc"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t.placeholderDesc}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none font-sans font-medium resize-none leading-normal"
                />
              </div>
            </div>

            {/* 2. PAUTAS CARD */}
            <div className="bg-white border border-slate-200 rounded-3xl p-5 md:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-3 gap-2 select-none">
                <div>
                  <h4 className="text-xs font-bold text-[#001e2d] flex items-center gap-1.5 uppercase tracking-wider">
                    <ListTodo className="w-4 h-4 text-[#001e2d]" />
                    Pautas
                  </h4>
                  <p className="text-[10px] text-slate-400 font-semibold mt-0.5">
                    {language === "en" ? "Define agenda items. Drag items to reorder them seamlessly." : "Cronograma detalhado de pautas. Arraste os itens para reordenar."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-[10px] font-extrabold bg-[#00658d]/5 text-[#00658d] px-2.5 py-1 rounded-full flex items-center gap-1">
                    <Users className="w-3 h-3 text-[#00658d]" />
                    {participants.length} {language === "en" ? "Attendees" : "Participantes"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAgendaIds([]);
                      setIsSelectAgendasOpen(true);
                    }}
                    className="px-2.5 py-1.5 bg-sky-600 text-white hover:bg-sky-500 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-white" />
                    {language === "en" ? "Select Agendas" : "Adicionar Pautas"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCreateAgendaDrawerOpen(true)}
                    className="px-2.5 py-1.5 bg-sky-600 text-white hover:bg-sky-500 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {language === "en" ? "New Pauta" : "Criar Nova Pauta"}
                  </button>
                </div>
              </div>

              {agenda.length === 0 ? (
                <div className="text-center py-6 bg-slate-50/50 border border-dashed border-slate-200 rounded-2xl">
                  <p className="text-xs text-slate-400 font-medium">
                    {language === "en" ? "No pautas added yet. Click 'Add Pautas' or 'Create New Pauta'." : "Nenhuma pauta adicionada. Adicione ou crie novas pautas acima."}
                  </p>
                </div>
              ) : (
                <div className="relative space-y-3">
                  {/* Timeline connecting vertical strip line */}
                  <div className="absolute left-6.5 top-3 bottom-0 w-0.5 bg-slate-100/80 -z-0" />

                  {agenda.map((item, index) => {

                    return (
                      <div
                        key={index}
                        draggable
                        onDragStart={(e) => handleDragStart(e, index)}
                        onDragOver={(e) => handleDragOver(e, index)}
                        onDrop={(e) => handleDrop(e, index)}
                        className={`relative rounded-xl border border-slate-100 bg-white hover:bg-slate-50/55 transition-all cursor-grab active:cursor-grabbing group select-none flex flex-col ${
                          draggedIndex === index ? "opacity-50 border-[#00658d]/50 bg-slate-50/10" : "shadow-sm"
                        }`}
                      >
                        {/* Header/Row Container */}
                        <div className="pl-12 pr-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          {/* Drag and drop handle on the left */}
                          <div className="absolute left-2.5 top-5 text-slate-300 group-hover:text-slate-400 transition-colors">
                            <GripVertical className="w-3.5 h-3.5" />
                          </div>

                          {/* Number bullet badge indicator */}
                          <div className="absolute left-7 top-5 w-4.5 h-4.5 rounded-full bg-slate-100 border border-slate-200 text-slate-600 flex items-center justify-center font-bold text-[9.5px]">
                            {index + 1}
                          </div>

                          {/* Text and details matching the left side of the cronograma dinâmico */}
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-[10px] font-extrabold text-[#00658d] bg-[#00658d]/5 px-2 py-0.5 rounded-md">
                                {item.time} ({item.duration})
                              </span>
                            </div>
                            
                            <h5 className="font-extrabold text-slate-800 text-[11.5px] tracking-tight">{item.title}</h5>
                            
                            <div className="text-[10px] text-slate-400 font-semibold flex items-center gap-1.5">
                              <User className="w-3 h-3 text-slate-400/80" />
                              <span>{language === "en" ? "Responsible" : "Responsável"}: <strong className="text-slate-500">{item.author || "Definido no ato"}</strong></span>
                            </div>
                          </div>

                          {/* Right side: edit and delete buttons */}
                          <div className="flex items-center gap-1.5 shrink-0 select-none self-end sm:self-center">

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEditAgendaItem(index);
                              }}
                              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition shrink-0 cursor-pointer"
                              title={language === "en" ? "Edit agenda topic" : "Editar pauta"}
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAgenda(agenda.filter((_, i) => i !== index));
                              }}
                              className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition shrink-0 cursor-pointer"
                              title={language === "en" ? "Delete agenda topic" : "Remover pauta"}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3. PARTICIPANTES CARD */}
            <div className="bg-white border border-slate-200 rounded-3xl p-5 md:p-6 space-y-3.5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2 select-none">
                <div>
                  <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-[#00658d]" />
                    {t.lblParticipantsSec}
                  </h4>
                  <p className="text-[10px] text-slate-400 font-semibold mt-0.5">
                    {t.subParticipants}
                  </p>
                </div>
                <span className="text-[10px] font-extrabold bg-[#00658d]/5 text-[#00658d] px-2 py-0.5 rounded-full">
                  {participants.length} {language === "en" ? "participants" : "participantes"}
                </span>
              </div>

              {/* List scrollbar */}
              <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                {participants.map((p, index) => {
                  const linkedTopics = agenda.filter(item => 
                    item.author && p.name && (
                      item.author.toLowerCase().includes(p.name.toLowerCase()) || 
                      p.name.toLowerCase().includes(item.author.toLowerCase())
                    )
                  );

                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between bg-white border border-slate-100 rounded-2xl p-3 md:p-4 hover:bg-slate-50/50 transition-colors shadow-xs"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1 sm:flex-row flex-col sm:items-center items-start sm:justify-between">
                        {/* Left Info: Avatar Initials, Name and Role */}
                        <div className="flex items-center gap-3 min-w-0 shrink-0">
                          <span className="w-8 h-8 rounded-full bg-[#00658d]/10 text-[#00658d] flex items-center justify-center font-extrabold text-[11px] shrink-0">
                            {getInitials(p.name)}
                          </span>
                          <div className="leading-tight select-none">
                            <span className="font-bold text-slate-800 block text-[12px] truncate max-w-[190px]">
                              {p.name}
                            </span>
                            <span className="text-[9.5px] text-slate-400 font-extrabold uppercase tracking-wide">
                              {p.role}
                            </span>
                          </div>
                        </div>

                        {/* Middle Info (the blue box): Connected agenda topic tags */}
                        <div className="flex flex-wrap gap-1.5 sm:ml-4 flex-1 justify-start min-w-0">
                          {linkedTopics.map((topic, tIdx) => (
                            <span 
                              key={tIdx} 
                              className="bg-sky-50 text-[#00658d] text-[8.5px] font-bold px-2 py-0.5 rounded border border-sky-100 uppercase tracking-tight truncate max-w-[160px]"
                              title={topic.title}
                            >
                              {topic.title}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Right Action: Delete icon button */}
                      <button
                        type="button"
                        onClick={() => setParticipants(participants.filter((_, i) => i !== index))}
                        className="text-rose-500 hover:text-rose-700 hover:bg-rose-50 p-1.5 rounded-lg transition shrink-0 ml-2"
                        title={language === "en" ? "Remove participant" : "Remover convidado"}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>

          {/* Action Footer Button Group */}
          {/* Erro do POST fica JUNTO do botão: quem falhou é a gravação. */}
          {saveError && (
            <div
              role="alert"
              className="mt-6 flex gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold"
            >
              <Info className="w-4 h-4 shrink-0 mt-px" />
              <span className="min-w-0">{saveError}</span>
            </div>
          )}

          <div className="pt-6 border-t border-slate-200 flex items-center justify-end gap-3 select-none">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold uppercase text-[10px] tracking-wider rounded-xl transition-all"
            >
              {t.btnCancel}
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-6 py-3 bg-[#00aeef] hover:bg-[#009bd4] text-white font-bold uppercase text-[10px] tracking-wider rounded-xl transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle className="w-4 h-4 text-white" />
              {isSaving
                ? (language === "en" ? "Saving..." : "Gravando...")
                : (language === "en" ? "Schedule Meeting" : "Gravar e Agendar a Reunião")}
            </button>
          </div>

        </form>

        {isSelectAgendasOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div className="bg-white border border-slate-200 rounded-3xl p-6 max-w-md w-full animate-fade-in">
              <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-2">
                <h4 className="text-sm font-extrabold text-[#001e2d] uppercase">
                  {language === "en" ? "Select Agendas to Add" : "Selecionar Pautas já Cadastradas"}
                </h4>
                <button type="button" onClick={() => setIsSelectAgendasOpen(false)} className="text-slate-400 hover:text-slate-600 bg-slate-50 hover:bg-slate-100 p-1 rounded-full">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                {standaloneAgendas.length === 0 ? (
                  <p className="text-xs text-slate-400 py-6 text-center font-medium">
                    {language === "en" ? "No pre-registered agendas found." : "Nenhuma pauta livre cadastrada encontrada no sistema."}
                  </p>
                ) : (
                  standaloneAgendas.map((sa) => {
                    const isChecked = selectedAgendaIds.includes(sa.id);
                    return (
                      <label 
                        key={sa.id} 
                        className={`flex gap-3 items-start p-3 rounded-xl border border-slate-200/50 cursor-pointer hover:bg-slate-50 transition ${
                          isChecked ? "bg-sky-50/40 border-sky-300" : "bg-slate-50/20"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedAgendaIds([...selectedAgendaIds, sa.id]);
                            } else {
                              setSelectedAgendaIds(selectedAgendaIds.filter(id => id !== sa.id));
                            }
                          }}
                          className="mt-0.5 rounded border-slate-300 text-[#00658d] focus:ring-[#00658d] cursor-pointer"
                        />
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-slate-800 leading-snug">{sa.title}</p>
                          <p className="text-[10px] text-slate-400 font-semibold mt-0.5 uppercase tracking-wider">
                            {sa.duration} &bull; Responsável: {sa.author}
                          </p>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>

              <div className="mt-5 pt-3 border-t border-slate-100 flex justify-end gap-2 select-none">
                <button
                  type="button"
                  onClick={() => setIsSelectAgendasOpen(false)}
                  className="px-4 py-2 bg-slate-100 text-slate-500 rounded-lg text-xs font-bold hover:bg-slate-205 transition"
                >
                  {language === "en" ? "Cancel" : "Cancelar"}
                </button>
                <button
                  type="button"
                  disabled={selectedAgendaIds.length === 0}
                  onClick={() => {
                    const newItems = standaloneAgendas
                      .filter(sa => selectedAgendaIds.includes(sa.id))
                      .map((sa) => ({
                        id: newId(),
                        time: "10:00",
                        title: sa.title,
                        duration: sa.duration,
                        author: sa.author,
                        authorEntraObjectId: sa.authorEntraObjectId,
                        // Vincular a Biblioteca: preserva a procedência
                        // (`agenda_topic_id`); o backend copia a ficha do tema
                        // (snapshot), depois independente. Espelhamos para exibir já.
                        agendaTopicId: sa.id,
                        isCircularTheme: sa.isCircularTheme,
                        agendaTopicTypeId: sa.pautaTypeId,
                        pautaType: sa.pautaType,
                        agendaTopicNatureId: sa.pautaNatureId,
                        pautaNature: sa.pautaNature,
                        description: sa.description || undefined,
                        generatesActionItem: sa.isFUP
                      }));
                    // avoid duplicate imports by title matching
                    const currentTitles = agenda.map(a => a.title.toLowerCase());
                    const uniqueNewItems = newItems.filter(item => !currentTitles.includes(item.title.toLowerCase()));
                    setAgenda([...agenda, ...uniqueNewItems]);
                    setIsSelectAgendasOpen(false);
                  }}
                  className="px-4 py-2 bg-[#00658d] text-white rounded-lg text-xs font-bold hover:bg-[#00aeef] transition disabled:opacity-50 cursor-pointer"
                >
                  {language === "en" ? "Add Selected" : "Adicionar Selecionadas"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 2) CREATE AGENDA DRAWER SLIDING OVERLAY PANEL */}
        {isCreateAgendaDrawerOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-end p-0">
            <div className="bg-white border-l border-slate-200 h-full max-w-md w-full p-6 md:p-8 flex flex-col justify-between animate-slide-in overflow-y-auto">
              <div>
                <div className="flex justify-between items-center mb-6 pb-2 border-b border-slate-100">
                  <div>
                    <span className="bg-[#00aeef]/10 text-[#00658d] px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-widest inline-block select-none">
                      {language === "en" ? "System-wide Pauta" : "Pauta Livre ou Corporativa"}
                    </span>
                    <h4 className="text-base font-extrabold text-[#001e2d] mt-1 uppercase">
                      {language === "en" ? "Create New Agenda" : "Criar Nova Pauta"}
                    </h4>
                  </div>
                  <button 
                    type="button" 
                    onClick={() => setIsCreateAgendaDrawerOpen(false)} 
                    className="p-1.5 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-50"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Pauta Title" : "Título do Assunto / Pauta"} *
                    </label>
                    <input
                      type="text"
                      required
                      value={tempPautaTitle}
                      onChange={(e) => setTempPautaTitle(e.target.value)}
                      placeholder={language === "en" ? "e.g. Q4 Revenue Projection" : "Ex: Apresentação de Orçamento 2026"}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Duration" : "Tempo Estimado"}
                      </label>
                      <input
                        type="text"
                        required
                        value={tempPautaDuration}
                        onChange={(e) => setTempPautaDuration(e.target.value)}
                        placeholder="Ex: 30 mins"
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 focus:outline-none"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Responsible" : "Responsável pela pauta"}
                      </label>
                      <DirectoryUserPicker
                        language={language}
                        selected={tempPautaAuthorUser}
                        onSelect={(u) => {
                          setTempPautaAuthorUser(u);
                          setTempPautaAuthorAsParticipant(false);
                        }}
                        onClear={() => {
                          setTempPautaAuthorUser(null);
                          setTempPautaAuthorAsParticipant(false);
                        }}
                      />
                      {!tempPautaAuthorUser && (
                        <p className="text-[10px] text-slate-400 font-semibold">
                          {language === "en" ? "No one chosen: All Board Members." : "Sem escolha: Todos os Membros."}
                        </p>
                      )}
                      {renderOpcaoParticipante(
                        tempPautaAuthor,
                        tempPautaAuthorUser?.id,
                        tempPautaAuthorAsParticipant,
                        setTempPautaAuthorAsParticipant
                      )}
                    </div>
                  </div>

                  {/* Tipo e Natureza — MESMOS cadastros da Biblioteca. */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Pauta type" : "Tipo de Pauta"}
                      </label>
                      <select
                        value={tempPautaTypeId}
                        onChange={(e) => setTempPautaTypeId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                      >
                        {pautaTypes.map((pt) => (
                          <option key={pt.id} value={pt.id}>{pt.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                        {language === "en" ? "Pauta nature" : "Natureza da Pauta"}
                      </label>
                      <select
                        value={tempPautaNatureId}
                        onChange={(e) => setTempPautaNatureId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                      >
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
                      checked={tempPautaFup}
                      onChange={(e) => setTempPautaFup(e.target.checked)}
                      className="w-4 h-4 accent-[#00658d] cursor-pointer"
                    />
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Classify as follow-up (FUP) theme" : "Classificar como Tema de FUP"}
                    </span>
                  </label>

                  {/* Tema circular? — copiado para a pauta da reunião ao gravar.
                      Só registra o fato; sem automação. Default Não. */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Recurring theme?" : "Tema circular?"}
                    </label>
                    <select
                      value={tempPautaCircular ? "sim" : "nao"}
                      onChange={(e) => setTempPautaCircular(e.target.value === "sim")}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                    >
                      <option value="nao">{language === "en" ? "No" : "Não"}</option>
                      <option value="sim">{language === "en" ? "Yes" : "Sim"}</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Description / Debate objective" : "Descrição / Objetivo de Debate"}
                    </label>
                    <textarea
                      rows={5}
                      value={tempPautaDescription}
                      onChange={(e) => setTempPautaDescription(e.target.value)}
                      placeholder={language === "en" ? "Enter the background context of this agenda item..." : "Diretrizes sobre o assunto para registro posterior em ata."}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 focus:outline-none resize-none font-sans"
                    />
                  </div>

                  {/* Participantes da pauta (Opção A). Ao criar a reunião, cada um
                      é adicionado também aos participantes dela (snapshot do tema). */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Pauta participants" : "Participantes da Pauta"}
                    </label>
                    <DirectoryUserPicker
                      language={language}
                      selected={null}
                      placeholder={language === "en" ? "Add a participant..." : "Adicionar participante..."}
                      onSelect={(u) => {
                        const oid = u.id;
                        setTempPautaParticipants((prev) =>
                          prev.some((p) => p.entraObjectId === oid)
                            ? prev
                            : [...prev, { entraObjectId: oid, displayName: u.displayName ?? enderecoDoDiretorio(u) ?? "", email: enderecoDoDiretorio(u) }],
                        );
                      }}
                      onClear={() => {}}
                    />
                    {tempPautaParticipants.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {tempPautaParticipants.map((p) => (
                          <span key={p.entraObjectId ?? p.displayName} className="inline-flex items-center gap-1 bg-[#00658d]/5 text-[#00658d] text-[10px] font-bold px-2 py-0.5 rounded-full">
                            {p.displayName}
                            <button
                              type="button"
                              onClick={() => setTempPautaParticipants((prev) => prev.filter((x) => x !== p))}
                              className="hover:text-red-600"
                              aria-label="Remover"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-slate-400 font-semibold">
                      {language === "en"
                        ? "These people will also be added to the meeting participants and invited when the meeting is sent."
                        : "Estas pessoas também serão adicionadas aos participantes da reunião e receberão o convite quando a reunião for enviada."}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-8 pt-4 border-t border-slate-100 flex gap-2.5 select-none">
                <button
                  type="button"
                  onClick={() => setIsCreateAgendaDrawerOpen(false)}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-xl text-[10px] font-bold uppercase tracking-wider transition"
                >
                  {language === "en" ? "Cancel" : "Cancelar"}
                </button>
                <button
                  type="button"
                  disabled={!tempPautaTitle.trim()}
                  onClick={async () => {
                    /*
                     * Cria o tema na Biblioteca pelo MESMO caminho/contrato e usa
                     * o tema criado para VINCULAR o item da reunião (agenda_topic_id).
                     * Assim a pauta da reunião nasce com procedência e recebe o
                     * SNAPSHOT (tipo/natureza/descrição/FUP/circular) do backend —
                     * nada de item solto (era o bug antigo do drawer).
                     */
                    const criado = await onAddStandaloneAgenda({
                      title: tempPautaTitle.trim(),
                      description: tempPautaDescription.trim(),
                      durationMinutes: parseDuracaoEmMinutos(tempPautaDuration),
                      responsibleLabel: tempPautaAuthor.trim(),
                      responsibleEntraObjectId: tempPautaAuthorUser?.id || undefined,
                      typeId: tempPautaTypeId || undefined,
                      natureId: tempPautaNatureId || undefined,
                      generatesActionItem: tempPautaFup,
                      isCircularTheme: tempPautaCircular,
                      participants: tempPautaParticipants.length ? tempPautaParticipants : undefined
                    });
                    // Se a criação falhou (toast já avisou), não adiciona item solto.
                    if (!criado) return;

                    // Item da reunião VINCULADO ao tema recém-criado. O backend
                    // copia a ficha do tema (snapshot); aqui espelhamos para exibir
                    // já na lista antes do reload.
                    setAgenda(prev => [...prev, {
                      id: newId(),
                      time: "10:00",
                      title: tempPautaTitle,
                      duration: tempPautaDuration,
                      author: tempPautaAuthor,
                      authorEntraObjectId: tempPautaAuthorUser?.id,
                      isCircularTheme: tempPautaCircular,
                      agendaTopicId: criado.id,
                      agendaTopicTypeId: criado.pautaTypeId,
                      pautaType: criado.pautaType,
                      agendaTopicNatureId: criado.pautaNatureId,
                      pautaNature: criado.pautaNature,
                      description: tempPautaDescription.trim() || undefined,
                      generatesActionItem: tempPautaFup
                    }]);

                    if (tempPautaAuthorAsParticipant && tempPautaAuthorUser) {
                      incluirComoParticipante(
                        tempPautaAuthor,
                        tempPautaAuthorUser.id,
                        enderecoDoDiretorio(tempPautaAuthorUser)
                      );
                    }

                    // Reset states
                    setTempPautaTitle("");
                    setTempPautaDuration("30 mins");
                    setTempPautaAuthorUser(null);
                    setTempPautaAuthorAsParticipant(false);
                    setTempPautaDescription("");
                    setTempPautaCircular(false);
                    setTempPautaFup(false);
                    setTempPautaParticipants([]);
                    setTempPautaTypeId(pautaTypes[0]?.id || "");
                    setTempPautaNatureId(pautaNatures[0]?.id || "");
                    setIsCreateAgendaDrawerOpen(false);
                  }}
                  className="w-full py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-50 cursor-pointer"
                >
                  {language === "en" ? "Save & Bind" : "Gravar e Vincular"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* EDIT AGENDA TOPIC SUB-MODAL */}
        {editingAgendaIndex !== null && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div className="bg-white border border-slate-200 rounded-3xl p-6 max-w-md w-full animate-fade-in shadow-2xl font-medium text-xs text-slate-705">
              <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-2">
                <h4 className="text-sm font-extrabold text-[#001e2d] uppercase">
                  {language === "en" ? "Edit Agenda Topic" : "Editar Tópico da Pauta"}
                </h4>
                <button 
                  type="button" 
                  onClick={() => setEditingAgendaIndex(null)} 
                  className="text-slate-400 hover:text-slate-600 bg-slate-50 hover:bg-slate-100 p-1.5 rounded-full"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                    {language === "en" ? "Topic Title" : "Título ou Assunto"} *
                  </label>
                  <input
                    type="text"
                    required
                    value={editingTopicTitle}
                    onChange={(e) => setEditingTopicTitle(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Duration" : "Duração"}
                    </label>
                    <input
                      type="text"
                      required
                      value={editingTopicDuration}
                      onChange={(e) => setEditingTopicDuration(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-850 focus:outline-none focus:ring-1 focus:ring-[#00658d]"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                      {language === "en" ? "Responsible" : "Responsável"}
                    </label>
                    <DirectoryUserPicker
                      language={language}
                      selected={editingTopicAuthorUser}
                      selectedLabel={editingTopicAuthorUser ? null : editingTopicAuthor || null}
                      onSelect={(u) => {
                        setEditingTopicAuthorUser(u);
                        setEditingTopicAuthor(u.displayName?.trim() || "");
                        setEditingTopicAuthorOid(u.id);
                        setEditingTopicAuthorEmail(enderecoDoDiretorio(u));
                        setEditingTopicAuthorAsParticipant(false);
                      }}
                      onClear={() => {
                        setEditingTopicAuthorUser(null);
                        setEditingTopicAuthor("");
                        setEditingTopicAuthorOid(undefined);
                        setEditingTopicAuthorEmail(undefined);
                        setEditingTopicAuthorAsParticipant(false);
                      }}
                    />
                    {!editingTopicAuthor.trim() && (
                      <p className="text-[10px] text-slate-400 font-semibold">
                        {language === "en" ? "No one chosen: All Board Members." : "Sem escolha: Todos os Membros."}
                      </p>
                    )}
                    {renderOpcaoParticipante(
                      editingTopicAuthor,
                      editingTopicAuthorOid,
                      editingTopicAuthorAsParticipant,
                      setEditingTopicAuthorAsParticipant
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-3 border-t border-slate-100 flex justify-end gap-2 select-none">
                <button
                  type="button"
                  onClick={() => setEditingAgendaIndex(null)}
                  className="px-4 py-2 bg-slate-100 text-slate-500 rounded-lg text-xs font-bold hover:bg-slate-205 transition"
                >
                  {language === "en" ? "Cancel" : "Cancelar"}
                </button>
                <button
                  type="button"
                  disabled={!editingTopicTitle.trim()}
                  onClick={handleSaveEditedAgendaItem}
                  className="px-4 py-2 bg-[#00658d] text-white rounded-lg text-xs font-bold hover:bg-[#00aeef] transition disabled:opacity-50 cursor-pointer"
                >
                  {language === "en" ? "Save Changes" : "Gravar Alterações"}
                </button>
              </div>
            </div>
          </div>
        )}

        </div>
      </div>
    </div>
  );
}
