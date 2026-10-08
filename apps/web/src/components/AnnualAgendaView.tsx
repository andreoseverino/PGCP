import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  CalendarRange,
  CheckCircle,
  ExternalLink,
  FileDown,
  Info,
  Link2,
  Lock,
  Mail,
  Send,
  Trash2
} from "lucide-react";
import ConfirmRemovalDialog from "./ConfirmRemovalDialog";
import {
  DEFAULT_TIMEZONE,
  instantToLocal
} from "../lib/meeting-adapters";
import {
  annualStatusLabel,
  approveAnnualAgenda,
  associateAnnualMeeting,
  createAnnualAgenda,
  deleteAnnualAgenda,
  describeAnnualAgendaError,
  downloadAnnualAgendaDocument,
  downloadAnnualAgendaPdf,
  getAnnualAgenda,
  getAnnualOverview,
  type AnnualAgendaDetail,
  type AnnualOverviewGroup
} from "../lib/annual-agendas";
import {
  anoInicial,
  candidatasAssociaveis,
  estadoDaVisao,
  gruposDoContexto,
  podeEditarAgenda,
  reunioesAAssociar,
  resumoDaAgenda,
  rodarMutacao
} from "../lib/annual-agenda-rules";
import {
  originLabel
} from "../lib/pipeline";
import AnnualAgendaMeetingCard from "./AnnualAgendaMeetingCard";
import type { TaxonomyItem } from "../lib/agenda-topic-adapters";
import type { TemaDaBibliotecaResumo } from "../lib/annual-agenda-rules";

/**
 * AGENDA ANUAL — consolida as reuniões do órgão no ano.
 *
 *   Calendário cria a reunião (Outlook/Teams) -> Agenda Anual reúne as
 *   reuniões do órgão/ano, prepara Pauta -> Tema e gera o compilado (PDF).
 *   Sem aprovação (10/2026): a Agenda é sempre editável e o Pipeline opera as
 *   mesmas reuniões desde o agendamento.
 *
 * Mesmas reuniões em Calendário, Agenda Anual e Pipeline: associar não copia
 * nada nem envia convite. Pautas e temas são os da reunião.
 */

interface AnnualAgendaViewProps {
  language: "en" | "pt";
  /** Órgão colegiado do CONTEXTO GLOBAL (""=Todos): filtra a listagem e pré-seleciona a criação. */
  orgaoContexto: string;
  /** Mostra as ações. Cortesia: o servidor exige `PGCP.Assessoria`. */
  canManage: boolean;
  /** Resumo dos temas da Biblioteca para "Adicionar da Biblioteca". */
  libraryTopics?: TemaDaBibliotecaResumo[];
  /** Taxonomias da Administração (tipo/natureza) para o cadastro de tema. */
  pautaTypes?: TaxonomyItem[];
  pautaNatures?: TaxonomyItem[];
  /** Estado vazio: leva ao Calendário, onde a reunião é criada. */
  onGoToCalendar?: () => void;
  onOpenMeeting: (meetingId: string) => void;
  /** Conteúdo de reunião mudou (temas, pautas, ordem): o Pipeline/Calendário recarregam. */
  onMeetingsChanged: () => void;
  triggerToast: (msg: string) => void;
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";


function local(iso: string, fuso: string) {
  return instantToLocal(iso, fuso);
}

export default function AnnualAgendaView({
  language,
  orgaoContexto,
  canManage,
  libraryTopics = [],
  pautaTypes = [],
  pautaNatures = [],
  onGoToCalendar,
  onOpenMeeting,
  onMeetingsChanged,
  triggerToast
}: AnnualAgendaViewProps) {
  const pt = language === "pt";
  const anoAtual = useMemo(() => Number(instantToLocal(new Date().toISOString(), DEFAULT_TIMEZONE).date.slice(0, 4)), []);

  // Ano da visão: padrão = ano atual (o usuário pode trocar).
  const [ano, setAno] = useState<number>(anoAtual);
  /** Anos que EXISTEM nos dados (reunião ou Agenda Anual) — vêm do servidor. */
  const [anos, setAnos] = useState<number[]>([]);
  const [grupos, setGrupos] = useState<AnnualOverviewGroup[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [orgaoSelecionado, setOrgaoSelecionado] = useState<string | null>(null);
  const [selecionada, setSelecionada] = useState<AnnualAgendaDetail | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Órgão = CONTEXTO GLOBAL (cabeçalho). Sem filtro local de órgão.
  const visiveis = useMemo(() => gruposDoContexto(grupos, orgaoContexto), [grupos, orgaoContexto]);
  const estado = estadoDaVisao(visiveis);
  const grupoAtual = visiveis.find((g) => g.governanceBody.id === orgaoSelecionado) ?? null;


  /** Recarrega a visão do ano e os anos disponíveis (somente leitura). */
  const carregar = async (anoAlvo = ano) => {
    setCarregando(true);
    try {
      const visao = await getAnnualOverview(anoAlvo);
      setGrupos(visao.groups);
      setAnos(visao.years);
      // Ano sem dados: vai para o atual (se existir) ou o mais próximo existente.
      const inicial = anoInicial(visao.years, anoAtual);
      if (!visao.years.includes(anoAlvo) && inicial !== null && inicial !== anoAlvo) setAno(inicial);
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    setSelecionada(null);
    setOrgaoSelecionado(null);
    void carregar(ano);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ano]);

  // Com um órgão no contexto, abre direto o grupo dele.
  useEffect(() => {
    if (orgaoContexto && visiveis.some((g) => g.governanceBody.id === orgaoContexto)) {
      void abrirGrupo(orgaoContexto);
    } else if (orgaoSelecionado && !visiveis.some((g) => g.governanceBody.id === orgaoSelecionado)) {
      setOrgaoSelecionado(null);
      setSelecionada(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgaoContexto, grupos]);

  const abrirGrupo = async (orgaoId: string) => {
    setErro(null);
    setOrgaoSelecionado(orgaoId);
    const grupo = grupos.find((g) => g.governanceBody.id === orgaoId);
    if (!grupo?.agenda) {
      setSelecionada(null);
      return;
    }
    try {
      setSelecionada(await getAnnualAgenda(grupo.agenda.id));
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    }
  };

  /** Executa uma mutação que devolve a agenda relida; atualiza visão e detalhe. */
  /**
   * Uma ação do usuário. `reunioesMudaram` (conteúdo de reunião: temas, pautas,
   * participantes, ordem) recarrega Calendário/Pipeline UMA vez, só no sucesso.
   */
  const executar = async (
    acao: () => Promise<AnnualAgendaDetail | void>,
    sucesso?: string,
    reunioesMudaram?: () => void
  ) => {
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    await rodarMutacao(acao, {
      aplicar: async (resultado) => {
        if (resultado) {
          setSelecionada(resultado);
          setOrgaoSelecionado(resultado.governanceBody.id);
        }
        await carregar();
        if (sucesso) triggerToast(sucesso);
      },
      falhar: (e) => setErro(describeAnnualAgendaError(e, language)),
      reunioesMudaram
    });
    setOcupado(false);
  };

  /** FORMALIZA o grupo: cria a Agenda Anual do órgão/ano e associa as reuniões dele. */
  const prepararAgenda = (grupo: AnnualOverviewGroup) =>
    executar(
      () => createAnnualAgenda({ governanceBodyId: grupo.governanceBody.id, year: ano, title: grupo.governanceBody.name }),
      pt ? "Agenda Anual preparada com as reuniões do Calendário." : "Annual plan prepared with the Calendar meetings."
    );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-[#001e2d] flex items-center gap-2">
            <CalendarRange className="w-6 h-6 text-[#00658d]" />
            {pt ? "Agenda Anual" : "Annual plan"}
          </h2>
          <p className="text-xs text-slate-500 font-medium mt-1 max-w-2xl">
            {pt
              ? "As reuniões do Calendário do ano, por órgão colegiado. Prepare a Agenda Anual do órgão, cadastre os temas de cada reunião e envie o compilado para aprovação. A operação das reuniões continua no Pipeline."
              : "The year's Calendar meetings by governance body. Prepare the body's annual plan to organise agendas and topics and send it for approval. Meetings are run in the Pipeline."}
          </p>
        </div>
      </div>

      {erro && (
        <div role="alert" className="flex gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold">
          <Info className="w-4 h-4 shrink-0 mt-px" />
          <span>{erro}</span>
        </div>
      )}

      {/* Esquerda compacta (ano + órgãos); a direita fica com o espaço de trabalho. */}
      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-5 items-start">
        <aside className="space-y-2">
          <div className="bg-white border border-slate-200 rounded-2xl p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="agenda-ano" className={LABEL}>{pt ? "Ano" : "Year"}</label>
              <select id="agenda-ano" value={anos.length > 0 ? ano : ""} disabled={anos.length === 0} onChange={(e) => setAno(Number(e.target.value))}
                className="bg-white border border-slate-200 rounded-xl px-2 py-2 text-xs text-slate-700 cursor-pointer disabled:cursor-not-allowed disabled:text-slate-400">
                {anos.length === 0 && <option value="">{pt ? "Sem dados" : "No data"}</option>}
                {anos.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
          {carregando && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}
          {!carregando && estado === "sem_reunioes" && (
            <p className="text-[11px] text-slate-400 font-semibold bg-white border border-dashed border-slate-200 rounded-2xl p-4">
              {pt ? "Nenhuma reunião encontrada." : "No meetings found."}
            </p>
          )}
          {!carregando && estado === "a_formalizar" && (
            <p className="text-[10px] text-slate-500 font-semibold px-1">
              {pt
                ? "Estas reuniões já estão no Calendário e podem ser preparadas para a Agenda Anual."
                : "These meetings are already in the Calendar and can be prepared for the annual plan."}
            </p>
          )}
          {visiveis.map((g) => (
            <button
              key={g.governanceBody.id}
              type="button"
              onClick={() => void abrirGrupo(g.governanceBody.id)}
              className={`w-full text-left bg-white border rounded-2xl p-4 space-y-1 cursor-pointer transition ${
                orgaoSelecionado === g.governanceBody.id ? "border-[#00658d] ring-1 ring-[#00658d]/30" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-extrabold text-[#00658d]">{ano}</span>
                <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full ${
                  !g.agenda
                    ? "bg-white border border-dashed border-slate-300 text-slate-500"
                    : g.agenda.status === "approved"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-600"
                }`}>
                  {g.agenda ? annualStatusLabel(g.agenda.status, language) : pt ? "Não formalizada" : "Not prepared"}
                </span>
              </div>
              <p className="text-[13px] font-extrabold text-slate-800">
                {g.governanceBody.name}
                {!g.governanceBody.isActive && <span className="text-[10px] text-slate-400 font-semibold"> {pt ? "(inativo)" : "(inactive)"}</span>}
              </p>
              <p className="text-[10px] text-slate-500 font-semibold">
                {g.meetings.length} {pt ? (g.meetings.length === 1 ? "reunião no Calendário" : "reuniões no Calendário") : "Calendar meetings"}
              </p>
            </button>
          ))}
        </aside>

        {selecionada && grupoAtual?.agenda?.id === selecionada.id ? (
          <AgendaDetail
            key={selecionada.id}
            language={language}
            agenda={selecionada}
            canManage={canManage}
            ocupado={ocupado}
            libraryTopics={libraryTopics}
            pautaTypes={pautaTypes}
            pautaNatures={pautaNatures}
            executar={executar}
            onOpenMeeting={onOpenMeeting}
            onMeetingsChanged={onMeetingsChanged}
            onDeleted={() => {
              setSelecionada(null);
              void carregar();
            }}
            setErro={setErro}
            triggerToast={triggerToast}
          />
        ) : grupoAtual && !grupoAtual.agenda ? (
          <GrupoNaoFormalizado
            language={language}
            ano={ano}
            grupo={grupoAtual}
            canManage={canManage}
            ocupado={ocupado}
            onPreparar={() => void prepararAgenda(grupoAtual)}
            onOpenMeeting={onOpenMeeting}
          />
        ) : (
          <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-10 text-center text-[11px] text-slate-400 font-semibold space-y-3">
            {visiveis.length > 0 ? (
              <p>{pt ? "Selecione um órgão para ver as reuniões do ano." : "Select a body to see the year's meetings."}</p>
            ) : (
              <>
                {/* A reunião nasce no Calendário; daqui não se cria reunião nem agenda vazia. */}
                <p>
                  {pt
                    ? "Nenhuma reunião encontrada para este ano. Crie a reunião no Calendário para preparar sua Agenda Anual."
                    : "No meetings found for this year. Create the meeting in the Calendar to prepare the annual plan."}
                </p>
                {onGoToCalendar && (
                  <button type="button" onClick={onGoToCalendar}
                    className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer">
                    <CalendarRange className="w-3.5 h-3.5" />{pt ? "Ir para Calendário" : "Go to Calendar"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Órgão com reuniões no Calendário e SEM Agenda Anual formal. Mostra as
 * reuniões (as mesmas do Calendário/Pipeline) e a ação explícita de preparar
 * — abrir a tela não grava nada.
 */
function GrupoNaoFormalizado({
  language,
  ano,
  grupo,
  canManage,
  ocupado,
  onPreparar,
  onOpenMeeting
}: {
  language: "en" | "pt";
  ano: number;
  grupo: AnnualOverviewGroup;
  canManage: boolean;
  ocupado: boolean;
  onPreparar: () => void;
  onOpenMeeting: (meetingId: string) => void;
}) {
  const pt = language === "pt";
  const aAssociar = reunioesAAssociar(grupo);
  const emOutra = grupo.meetings.length - aAssociar.length;
  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 space-y-4 min-w-0">
      <header className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-extrabold text-[#00658d] uppercase tracking-wide">{grupo.governanceBody.name}</p>
          <h3 className="text-xl font-extrabold text-[#001e2d]">{pt ? `Agenda Anual ${ano}` : `Annual plan ${ano}`}</h3>
          <p className="text-[10px] text-slate-500 font-semibold mt-1">
            {grupo.meetings.length} {pt ? "reunião(ões) encontrada(s)" : "meeting(s) found"} ·{" "}
            <span className="text-slate-400">{pt ? "Agenda Anual ainda não formalizada" : "Annual plan not prepared yet"}</span>
          </p>
        </div>
        {canManage && grupo.governanceBody.isActive && (
          <button
            type="button"
            disabled={ocupado}
            onClick={onPreparar}
            className="px-4 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-2 disabled:opacity-50 cursor-pointer shrink-0"
          >
            <CalendarCheck className="w-4 h-4" />
            {pt ? "Preparar Agenda Anual" : "Prepare annual plan"}
          </button>
        )}
      </header>

      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? `Preparar cria a Agenda Anual de ${ano} deste órgão e inclui ${aAssociar.length} reunião(ões) do Calendário — as mesmas reuniões, sem novo convite. Reuniões criadas depois no Calendário entram automaticamente.`
          : `Preparing creates this body's ${ano} annual plan with ${aAssociar.length} Calendar meeting(s) — the same meetings, no new invite.`}
      </p>

      <ul className="space-y-1.5">
        {grupo.meetings.map((m) => {
          const i = local(m.startAt, m.timezone);
          const f = local(m.endAt, m.timezone);
          const mes = new Intl.DateTimeFormat(pt ? "pt-BR" : "en-US", { month: "short", timeZone: m.timezone })
            .format(new Date(m.startAt))
            .replace(".", "")
            .toUpperCase();
          return (
            <li key={m.id} className="flex items-center gap-3 border border-slate-100 rounded-xl px-3 py-2">
              <div className="w-12 shrink-0 text-center">
                <p className="text-base font-extrabold text-[#001e2d] leading-none">{i.date.slice(8, 10)}</p>
                <p className="text-[9px] font-extrabold text-[#00658d]">{mes}</p>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-slate-800 truncate" title={m.title}>{m.title}</p>
                <p className="text-[10px] text-slate-500 font-semibold">
                  {i.time}–{f.time} · {originLabel(m.origin, language)}
                  {m.annualAgendaId && <span className="text-amber-700"> · {pt ? "em outra Agenda Anual" : "in another plan"}</span>}
                </p>
              </div>
              <button type="button" onClick={() => onOpenMeeting(m.id)} className="p-1.5 text-[#00658d] hover:bg-sky-50 rounded-lg cursor-pointer shrink-0" title={pt ? "Abrir no Pipeline" : "Open in Pipeline"} aria-label={pt ? "Abrir no Pipeline" : "Open in Pipeline"}>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {emOutra > 0 && (
        <p className="text-[10px] text-amber-700 font-semibold">
          {pt
            ? `${emOutra} reunião(ões) já pertence(m) a outra Agenda Anual e não será(ão) incluída(s).`
            : `${emOutra} meeting(s) already belong to another plan and will not be included.`}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

interface AgendaDetailProps {
  language: "en" | "pt";
  agenda: AnnualAgendaDetail;
  canManage: boolean;
  ocupado: boolean;
  libraryTopics: TemaDaBibliotecaResumo[];
  pautaTypes: TaxonomyItem[];
  pautaNatures: TaxonomyItem[];
  executar: (acao: () => Promise<AnnualAgendaDetail | void>, sucesso?: string, reunioesMudaram?: () => void) => Promise<void>;
  onOpenMeeting: (meetingId: string) => void;
  onMeetingsChanged: () => void;
  onDeleted: () => void;
  setErro: (erro: string | null) => void;
  triggerToast: (msg: string) => void;
}

/**
 * Uma Agenda Anual: as reuniões do órgão/ano (as MESMAS do Calendário e do
 * Pipeline) com Pauta -> Tema e o compilado (PDF). Em elaboração: associa
 * reuniões e edita pautas/temas, com permissão. "Marcar como aprovada" (sem
 * e-mail) grava a versão oficial e TRAVA a agenda: a tela passa a mostrar a
 * foto aprovada e as reuniões seguem operando só no Pipeline.
 */
function AgendaDetail({
  language,
  agenda,
  canManage,
  ocupado,
  libraryTopics,
  pautaTypes,
  pautaNatures,
  executar,
  onOpenMeeting,
  onMeetingsChanged,
  onDeleted,
  setErro,
  triggerToast
}: AgendaDetailProps) {
  const pt = language === "pt";
  const editavel = podeEditarAgenda(agenda, canManage);
  const resumo = resumoDaAgenda(agenda);
  const associaveis = candidatasAssociaveis(agenda);

  const aprovada = agenda.status === "approved";
  const versaoAprovada = agenda.version?.state === "approved" ? agenda.version : null;

  /** Prévia (estado atual) ou o PDF OFICIAL da versão aprovada. */
  const baixar = async (oficial: boolean) => {
    try {
      const { blob, filename } = await (oficial ? downloadAnnualAgendaDocument(agenda.id) : downloadAnnualAgendaPdf(agenda.id));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename ?? `agenda-anual-${agenda.year}${oficial ? "-aprovada" : ""}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    }
  };

  const [confirmandoAprovacao, setConfirmandoAprovacao] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  const excluir = () =>
    void executar(async () => {
      await deleteAnnualAgenda(agenda.id);
      onDeleted();
    }, pt ? "Agenda Anual excluída." : "Annual plan deleted.").finally(() => setConfirmandoExclusao(false));
  const aprovar = () =>
    void executar(() => approveAnnualAgenda(agenda.id), pt ? "Agenda Anual aprovada." : "Annual plan approved.").finally(() =>
      setConfirmandoAprovacao(false)
    );

  const podeExcluir = editavel && agenda.meetingsCount === 0 && agenda.reservedCount === 0 && !agenda.version;

  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 space-y-5 min-w-0">
      <header className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-extrabold text-[#00658d] uppercase tracking-wide">{agenda.governanceBody.name}</p>
          <h3 className="text-xl font-extrabold text-[#001e2d]">{agenda.title} — {agenda.year}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {/* Resumo calculado dos dados reais. */}
            <span className="text-[10px] text-slate-500 font-semibold">
              {resumo.reunioes} {pt ? "reuniões" : "meetings"} · {resumo.pautas} {pt ? "pautas" : "agendas"} · {resumo.temas} {pt ? "temas" : "topics"}
            </span>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap shrink-0">
          {aprovada ? (
            versaoAprovada && (
              <button type="button" onClick={() => void baixar(true)} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer">
                <FileDown className="w-3.5 h-3.5" />{pt ? "PDF oficial" : "Official PDF"}
              </button>
            )
          ) : (
            <button type="button" onClick={() => void baixar(false)} className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
              <FileDown className="w-3.5 h-3.5" />{pt ? "Gerar documento" : "Generate document"}
            </button>
          )}
          {editavel && agenda.meetings.length > 0 && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() => setConfirmandoAprovacao(true)}
              className="px-3 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              <CheckCircle className="w-3.5 h-3.5" />{pt ? "Marcar como aprovada" : "Mark as approved"}
            </button>
          )}
          {podeExcluir && (
            <button
              type="button"
              onClick={() => setConfirmandoExclusao(true)}
              className="px-3 py-2 border border-rose-100 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />{pt ? "Excluir" : "Delete"}
            </button>
          )}
        </div>
      </header>

      {confirmandoExclusao && (
        <ConfirmRemovalDialog
          language={language}
          busy={ocupado}
          confirmacao={{
            titulo: pt ? "Excluir esta Agenda Anual?" : "Delete this annual plan?",
            paragrafos: [
              pt
                ? `A Agenda Anual “${agenda.title} — ${agenda.year}” será excluída. Ela não tem reuniões; esta ação não pode ser desfeita.`
                : `The annual plan “${agenda.title} — ${agenda.year}” will be deleted. It has no meetings; this cannot be undone.`
            ],
            temas: [],
            acao: pt ? "Excluir" : "Delete"
          }}
          onCancel={() => setConfirmandoExclusao(false)}
          onConfirm={excluir}
        />
      )}

      {confirmandoAprovacao && (
        <ConfirmRemovalDialog
          language={language}
          variante="aprovar"
          busy={ocupado}
          confirmacao={{
            titulo: pt ? "Marcar a Agenda Anual como aprovada?" : "Mark the annual plan as approved?",
            paragrafos: [
              pt
                ? `O PDF oficial de “${agenda.title} — ${agenda.year}” será gerado com a agenda como está agora.`
                : `The official PDF of “${agenda.title} — ${agenda.year}” will be generated from the plan as it is now.`,
              pt
                ? "Depois de aprovada, a Agenda Anual fica travada e não pode mais ser alterada por aqui. As reuniões continuam sendo editadas no Pipeline."
                : "Once approved, the plan is locked and can no longer be changed here. Meetings can still be edited in the Pipeline."
            ],
            temas: [],
            acao: pt ? "Aprovar" : "Approve"
          }}
          onCancel={() => setConfirmandoAprovacao(false)}
          onConfirm={aprovar}
        />
      )}

      {aprovada && (
        <div className="flex items-start gap-2.5 bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3">
          <Lock className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
          <div className="text-[11px] text-emerald-900 font-semibold space-y-0.5">
            <p className="font-extrabold">
              {pt ? "Agenda Anual aprovada" : "Annual plan approved"}
              {versaoAprovada?.approvedAt && (
                <>
                  {" "}
                  {pt ? "em" : "on"} {new Date(versaoAprovada.approvedAt).toLocaleString(pt ? "pt-BR" : "en-US")}
                  {versaoAprovada.approvedByName && <> {pt ? "por" : "by"} {versaoAprovada.approvedByName}</>}
                  {" · "}
                  {pt ? `versão ${versaoAprovada.number}` : `version ${versaoAprovada.number}`}
                </>
              )}
            </p>
            <p className="text-emerald-800">
              {pt
                ? "Esta visão mostra a agenda como foi aprovada e não muda mais. Alterações nas reuniões são feitas no Pipeline."
                : "This view shows the plan as approved and no longer changes. Meeting changes are made in the Pipeline."}
            </p>
          </div>
        </div>
      )}

      {/* Reuniões da agenda — as mesmas do Calendário e do Pipeline */}
      <div className="space-y-2.5">
        <h4 className="text-xs font-extrabold text-slate-800">{pt ? "Reuniões da Agenda Anual" : "Meetings in this plan"}</h4>
        {agenda.meetings.length === 0 && (
          <p className="text-[11px] text-slate-400 font-semibold bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4">
            {pt
              ? "Nenhuma reunião associada. Crie as reuniões no Calendário e associe-as aqui."
              : "No meetings yet. Create meetings in the Calendar and add them here."}
          </p>
        )}
        {agenda.meetings.map((m) => (
          <AnnualAgendaMeetingCard
            key={m.id}
            language={language}
            agendaId={agenda.id}
            orgao={agenda.governanceBody}
            meeting={m}
            editable={editavel}
            agendaAprovada={agenda.status === "approved"}
            ocupado={ocupado}
            libraryTopics={libraryTopics}
            pautaTypes={pautaTypes}
            pautaNatures={pautaNatures}
            /* Mutações de conteúdo da reunião: Calendário/Pipeline recarregam (1x por ação). */
            executar={(acao, sucesso) => executar(acao, sucesso, onMeetingsChanged)}
            onOpenMeeting={onOpenMeeting}
            triggerToast={triggerToast}
          />
        ))}
      </div>

      {/* Reuniões do Calendário ainda fora desta agenda (mesmo órgão e ano) */}
      {editavel && agenda.candidates.length > 0 && (
        <div className="border border-[#00658d]/20 bg-sky-50/40 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h4 className="text-xs font-extrabold text-slate-800">
              {pt ? `Reuniões do Calendário — ${agenda.governanceBody.name}, ${agenda.year}` : `Calendar meetings — ${agenda.governanceBody.name}, ${agenda.year}`}
            </h4>
            {associaveis.length > 1 && (
              <button
                type="button"
                disabled={ocupado}
                onClick={() =>
                  void executar(async () => {
                    let atual: AnnualAgendaDetail | undefined;
                    for (const c of associaveis) atual = await associateAnnualMeeting(agenda.id, c.id);
                    return atual;
                  }, pt ? `${associaveis.length} reuniões associadas.` : `${associaveis.length} meetings added.`)
                }
                className="px-3 py-1.5 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-lg text-[11px] font-bold disabled:opacity-50 cursor-pointer"
              >
                {pt ? "Associar todas" : "Add all"}
              </button>
            )}
          </div>
          <p className="text-[10px] text-slate-500 font-semibold">
            {pt
              ? "Associar não cria reunião nem envia convite: a mesma reunião (e o mesmo evento Outlook/Teams) passa a fazer parte da Agenda Anual."
              : "Adding does not create a meeting or send an invite: the same meeting becomes part of the plan."}
          </p>
          <ul className="space-y-1.5">
            {agenda.candidates.map((c) => {
              const i = local(c.startAt, c.timezone);
              return (
                <li key={c.id} className="flex items-center justify-between gap-3 bg-white border border-slate-100 rounded-xl px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-slate-800 truncate">{c.title}</p>
                    <p className="text-[10px] text-slate-500 font-semibold">
                      {i.date.split("-").reverse().join("/")} · {i.time} · {originLabel(c.origin, language)}
                    </p>
                  </div>
                  {c.linkedToOtherAgenda ? (
                    <span className="text-[10px] font-bold text-slate-400 shrink-0">{pt ? "Em outra Agenda Anual" : "In another plan"}</span>
                  ) : (
                    <button
                      type="button"
                      disabled={ocupado}
                      onClick={() => void executar(() => associateAnnualMeeting(agenda.id, c.id), pt ? "Reunião associada." : "Meeting added.")}
                      className="px-3 py-1.5 border border-[#00658d]/30 text-[#00658d] rounded-lg text-[11px] font-bold hover:bg-sky-50 inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      <Link2 className="w-3.5 h-3.5" />{pt ? "Associar" : "Add"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

    </section>
  );
}
