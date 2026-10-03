import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  CalendarRange,
  CheckCircle,
  ExternalLink,
  Eye,
  FileCheck2,
  Info,
  Link2,
  Lock,
  Mail,
  Send,
  Trash2
} from "lucide-react";
import {
  DEFAULT_TIMEZONE,
  instantToLocal
} from "../lib/meeting-adapters";
import {
  annualStatusLabel,
  associateAnnualMeeting,
  createAnnualAgenda,
  deleteAnnualAgenda,
  describeAnnualAgendaError,
  downloadAnnualAgendaDocument,
  downloadAnnualAgendaPdf,
  getAnnualAgenda,
  getAnnualOverview,
  markAnnualAgendaApproved,
  requestAnnualAgendaApproval,
  withdrawAnnualAgendaApproval,
  type AnnualAgendaDetail,
  type AnnualOverviewGroup
} from "../lib/annual-agendas";
import {
  anoInicial,
  bloqueiosDeTempo,
  candidatasAssociaveis,
  estadoDaVisao,
  gruposDoContexto,
  mensagemDeBloqueio,
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
 *   reuniões do órgão/ano, prepara Pauta -> Tema, gera o compilado e envia
 *   para aprovação -> aprovada = versão bloqueada -> Pipeline opera.
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

const COR_STATUS = {
  draft: "bg-slate-100 text-slate-600",
  pending_approval: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700"
} as const;

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
                <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full ${g.agenda ? COR_STATUS[g.agenda.status] : "bg-white border border-dashed border-slate-300 text-slate-500"}`}>
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
          ? `Preparar cria a Agenda Anual de ${ano} deste órgão e inclui ${aAssociar.length} reunião(ões) do Calendário — as mesmas reuniões, sem novo convite. Reuniões criadas depois no Calendário entram automaticamente enquanto a agenda estiver em elaboração.`
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
}

/**
 * Uma Agenda Anual: as reuniões do órgão/ano (as MESMAS do Calendário e do
 * Pipeline) com Pauta -> Tema, o compilado e a aprovação.
 *
 *   Em elaboração   associa reuniões, edita pautas/temas, gera prévia, envia
 *   Enviada         somente leitura; "Retirar da aprovação" volta a editar
 *   Aprovada        somente leitura; documento = versão aprovada (snapshot)
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
  setErro
}: AgendaDetailProps) {
  const pt = language === "pt";
  const editavel = podeEditarAgenda(agenda, canManage);
  const bloqueio = mensagemDeBloqueio(agenda.status, language);
  const resumo = resumoDaAgenda(agenda);
  /** Reuniões com excesso de tempo ou tema sem duração: impedem o envio. */
  const bloqueiosTempo = bloqueiosDeTempo(agenda);
  const associaveis = candidatasAssociaveis(agenda);

  // Aprovação
  const [email, setEmail] = useState(agenda.approvalSentTo ?? "");

  const baixar = async (tipo: "previa" | "documento") => {
    try {
      const { blob, filename } = await (tipo === "previa" ? downloadAnnualAgendaPdf(agenda.id) : downloadAnnualAgendaDocument(agenda.id));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename ?? `agenda-anual-${agenda.year}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    }
  };

  const podeExcluir = editavel && agenda.meetingsCount === 0 && agenda.reservedCount === 0 && !agenda.version;

  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 space-y-5 min-w-0">
      <header className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-extrabold text-[#00658d] uppercase tracking-wide">{agenda.governanceBody.name}</p>
          <h3 className="text-xl font-extrabold text-[#001e2d]">{agenda.title} — {agenda.year}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${COR_STATUS[agenda.status]}`}>
              {annualStatusLabel(agenda.status, language)}
            </span>
            {/* Resumo calculado dos dados reais. */}
            <span className="text-[10px] text-slate-500 font-semibold">
              {resumo.reunioes} {pt ? "reuniões" : "meetings"} · {resumo.pautas} {pt ? "pautas" : "agendas"} · {resumo.temas} {pt ? "temas" : "topics"}
            </span>
            {agenda.version && (
              <span className="text-[10px] text-slate-400 font-semibold">
                {pt ? `Versão ${agenda.version.number}` : `Version ${agenda.version.number}`}
                {agenda.version.state === "approved"
                  ? pt ? ` aprovada em ${new Date(agenda.version.approvedAt!).toLocaleDateString("pt-BR")}` : " approved"
                  : pt ? ` enviada a ${agenda.version.sentTo}` : ` sent to ${agenda.version.sentTo}`}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap shrink-0">
          {agenda.status === "draft" && (
            <button type="button" onClick={() => void baixar("previa")} className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
              <Eye className="w-3.5 h-3.5" />{pt ? "Gerar prévia" : "Preview"}
            </button>
          )}
          {agenda.version && (
            <button type="button" onClick={() => void baixar("documento")} className="px-3 py-2 border border-emerald-200 rounded-xl text-xs font-bold text-emerald-700 hover:bg-emerald-50 inline-flex items-center gap-1.5 cursor-pointer">
              <FileCheck2 className="w-3.5 h-3.5" />
              {agenda.version.state === "approved"
                ? pt ? "Visualizar documento aprovado" : "View approved document"
                : pt ? "Documento enviado" : "Sent document"}
            </button>
          )}
          {podeExcluir && (
            <button
              type="button"
              onClick={() =>
                window.confirm(pt ? "Excluir esta Agenda Anual?" : "Delete this annual plan?") &&
                void executar(async () => {
                  await deleteAnnualAgenda(agenda.id);
                  onDeleted();
                }, pt ? "Agenda Anual excluída." : "Annual plan deleted.")
              }
              className="px-3 py-2 border border-rose-100 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />{pt ? "Excluir" : "Delete"}
            </button>
          )}
        </div>
      </header>

      {bloqueio && (
        <div
          role="status"
          className={`flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-xl border text-[11px] font-semibold ${
            agenda.status === "approved" ? "bg-emerald-50 border-emerald-100 text-emerald-800" : "bg-amber-50 border-amber-100 text-amber-800"
          }`}
        >
          <Lock className="w-4 h-4 shrink-0" />
          <span className="flex-1">{bloqueio}</span>
          {agenda.status === "pending_approval" && canManage && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() => void executar(() => withdrawAnnualAgendaApproval(agenda.id), pt ? "Agenda Anual retirada da aprovação." : "Withdrawn from approval.")}
              className="px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-[11px] font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50 cursor-pointer shrink-0"
            >
              {pt ? "Retirar da aprovação" : "Withdraw"}
            </button>
          )}
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
            approved={agenda.version?.state === "approved"}
            ocupado={ocupado}
            libraryTopics={libraryTopics}
            pautaTypes={pautaTypes}
            pautaNatures={pautaNatures}
            /* Mutações de conteúdo da reunião: Calendário/Pipeline recarregam (1x por ação). */
            executar={(acao, sucesso) => executar(acao, sucesso, onMeetingsChanged)}
            onOpenMeeting={onOpenMeeting}
          />
        ))}
        {agenda.removedAfterSending.length > 0 && (
          <p className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            {pt ? "Estavam na versão enviada e não estão mais (excluídas pelo Pipeline): " : "In the sent version but no longer present: "}
            {agenda.removedAfterSending
              .map((r) => `${r.title} (${local(r.startAt, r.timezone).date.split("-").reverse().join("/")})`)
              .join("; ")}
          </p>
        )}
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

      {/* Aprovação */}
      {canManage && (agenda.status !== "approved" ? resumo.reunioes > 0 : true) && (
        <div className="border-t border-slate-100 pt-4 space-y-2">
          <h4 className="text-xs font-extrabold text-slate-800 flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5 text-[#00658d]" />
            {pt ? "Aprovação da Agenda Anual" : "Plan approval"}
          </h4>
          {agenda.status === "approved" ? (
            <p className="text-[11px] text-emerald-700 font-semibold">
              {pt ? "Agenda Anual aprovada. O documento aprovado é a versão enviada ao aprovador." : "Plan approved."}
            </p>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={pt ? "E-mail de quem aprova" : "Approver e-mail"}
                className={`${INPUT} sm:max-w-xs`}
              />
              <button
                type="button"
                disabled={ocupado || !email.trim() || bloqueiosTempo.length > 0}
                title={bloqueiosTempo.length > 0 ? (pt ? "Ajuste a duração dos temas antes de enviar." : "Fix topic durations first.") : undefined}
                onClick={() => void executar(() => requestAnnualAgendaApproval(agenda.id, email.trim()), pt
                    ? "E-mail aceito pelo Microsoft 365 e enviado pela sua caixa (confira em Itens Enviados). A entrega depende do servidor de e-mail do destinatário."
                    : "E-mail accepted by Microsoft 365 and sent from your mailbox (see Sent Items). Delivery depends on the recipient's mail server.")}
                className="px-4 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                {agenda.status === "pending_approval" ? (pt ? "Reenviar (nova versão)" : "Resend (new version)") : pt ? "Enviar para aprovação" : "Send for approval"}
              </button>
              {agenda.status === "pending_approval" && (
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => void executar(() => markAnnualAgendaApproved(agenda.id), pt ? "Agenda Anual marcada como aprovada." : "Plan marked as approved.")}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  <CheckCircle className="w-3.5 h-3.5" />{pt ? "Registrar aprovação" : "Record approval"}
                </button>
              )}
            </div>
          )}
          {agenda.status !== "approved" && bloqueiosTempo.length > 0 && (
            <p role="alert" className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              {pt
                ? `Envio bloqueado: a programação de ${bloqueiosTempo.length} reunião(ões) ultrapassa o horário disponível ou tem tema sem duração (${bloqueiosTempo.join("; ")}). A prévia continua disponível.`
                : "Sending is blocked until every meeting's topics fit its time and have a duration."}
            </p>
          )}
          <p className="text-[10px] text-slate-400 font-semibold">
            {pt
              ? "O e-mail sai da sua caixa (Microsoft 365) com o compilado em PDF. O conteúdo enviado fica gravado como versão; a aprovação registrada aqui vale para essa versão."
              : "The e-mail is sent from your mailbox with the compiled PDF. The sent content is stored as a version; the approval recorded here applies to it."}
          </p>
        </div>
      )}
    </section>
  );
}
