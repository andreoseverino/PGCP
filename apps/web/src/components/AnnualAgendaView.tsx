import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarCheck,
  CalendarRange,
  CheckCircle,
  Download,
  ExternalLink,
  Info,
  Mail,
  Pencil,
  Plus,
  Send,
  Trash2,
  X
} from "lucide-react";
import type { GovernanceBody } from "../types";
import type { DirectoryUser } from "../lib/directory";
import { enderecoDoDiretorio } from "../lib/corporate-email";
import { DEFAULT_TIMEZONE, instantToLocal, localToInstant, participantsPayload } from "../lib/meeting-adapters";
import {
  addAnnualAgendaItem,
  annualStatusLabel,
  createAnnualAgenda,
  deleteAnnualAgenda,
  deleteAnnualAgendaItem,
  describeAnnualAgendaError,
  downloadAnnualAgendaPdf,
  getAnnualAgenda,
  listAnnualAgendas,
  markAnnualAgendaApproved,
  requestAnnualAgendaApproval,
  reserveAnnualAgenda,
  updateAnnualAgendaItem,
  type AnnualAgendaDetail,
  type AnnualAgendaItem,
  type AnnualAgendaSummary
} from "../lib/annual-agendas";
import type { Modality } from "../lib/new-meeting";
import {
  ModalityDisclaimer,
  ModalityFields,
  OrganizerAndParticipants,
  type InviteParticipant
} from "./MeetingInviteFields";

/**
 * AGENDA ANUAL — planejamento das reuniões de um órgão no ano.
 *
 *   criar agenda -> definir datas -> RESERVAR (reuniões + convites) ->
 *   reuniões aparecem no Pipeline -> enviar para aprovação -> aprovar
 *
 * A reserva NÃO espera a aprovação: é assim que a agenda de executivos é
 * bloqueada cedo. A tela mostra os dois eixos lado a lado — aprovação da
 * agenda e reserva de cada data.
 *
 * Data já reservada é editada pelo Pipeline (o evento existente é atualizado,
 * sem convite duplicado); aqui ela fica somente leitura.
 */

interface AnnualAgendaViewProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  /** Mostra as ações. Cortesia: o servidor exige `PGCP.Assessoria`. */
  canManage: boolean;
  onOpenMeeting: (meetingId: string) => void;
  /** Reuniões novas nasceram: o Pipeline/Calendário precisam recarregar. */
  onMeetingsChanged: () => void;
  triggerToast: (msg: string) => void;
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";
const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

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
  governanceBodies,
  canManage,
  onOpenMeeting,
  onMeetingsChanged,
  triggerToast
}: AnnualAgendaViewProps) {
  const pt = language === "pt";
  const [lista, setLista] = useState<AnnualAgendaSummary[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [selecionada, setSelecionada] = useState<AnnualAgendaDetail | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Nova agenda
  const [criando, setCriando] = useState(false);
  const [novoOrgao, setNovoOrgao] = useState("");
  const [novoAno, setNovoAno] = useState(() => new Date().getFullYear() + 1);
  const [novoTitulo, setNovoTitulo] = useState("");

  const carregarLista = async () => {
    setCarregando(true);
    try {
      setLista(await listAnnualAgendas());
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    void carregarLista();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const abrir = async (id: string) => {
    setErro(null);
    try {
      setSelecionada(await getAnnualAgenda(id));
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    }
  };

  /** Executa uma mutação que devolve a agenda relida; atualiza lista e detalhe. */
  const executar = async (acao: () => Promise<AnnualAgendaDetail | void>, sucesso?: string) => {
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    try {
      const resultado = await acao();
      if (resultado) setSelecionada(resultado);
      await carregarLista();
      if (sucesso) triggerToast(sucesso);
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    } finally {
      setOcupado(false);
    }
  };

  const criarAgenda = async (e: React.FormEvent) => {
    e.preventDefault();
    const corpo = { governanceBodyId: novoOrgao, year: novoAno, title: novoTitulo.trim() };
    if (!corpo.governanceBodyId || !corpo.title) {
      setErro(pt ? "Informe o órgão e o título." : "Enter the body and the title.");
      return;
    }
    await executar(async () => {
      const criada = await createAnnualAgenda(corpo);
      setCriando(false);
      setNovoTitulo("");
      return criada;
    }, pt ? "Agenda Anual criada." : "Annual plan created.");
  };

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
              ? "Planeje as reuniões do ano de cada órgão e reserve as agendas antecipadamente. A reserva não espera a aprovação do planejamento."
              : "Plan each body's meetings for the year and reserve calendars in advance. Reservation does not wait for plan approval."}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setCriando((v) => !v)}
            className="px-5 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {pt ? "Nova Agenda Anual" : "New annual plan"}
          </button>
        )}
      </div>

      {criando && (
        <form onSubmit={criarAgenda} className="bg-white border border-slate-200 rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-[1fr_120px_1fr_auto] gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{pt ? "Órgão / comitê" : "Body"} *</label>
            <select required value={novoOrgao} onChange={(e) => setNovoOrgao(e.target.value)} className={`${INPUT} cursor-pointer`}>
              <option value="">{pt ? "Selecione..." : "Select..."}</option>
              {governanceBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{pt ? "Ano" : "Year"} *</label>
            <input type="number" min={2000} max={2100} required value={novoAno} onChange={(e) => setNovoAno(Number(e.target.value))} className={INPUT} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{pt ? "Título" : "Title"} *</label>
            <input required value={novoTitulo} onChange={(e) => setNovoTitulo(e.target.value)} className={INPUT}
              placeholder={pt ? "Ex.: Comitê Executivo" : "e.g. Executive Committee"} />
          </div>
          <button type="submit" disabled={ocupado} className="px-4 py-2 bg-[#00658d] text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer">
            {pt ? "Criar" : "Create"}
          </button>
        </form>
      )}

      {erro && (
        <div role="alert" className="flex gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold">
          <Info className="w-4 h-4 shrink-0 mt-px" />
          <span>{erro}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 items-start">
        <aside className="space-y-2">
          {carregando && <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Carregando..." : "Loading..."}</p>}
          {!carregando && lista.length === 0 && (
            <p className="text-[11px] text-slate-400 font-semibold bg-white border border-dashed border-slate-200 rounded-2xl p-4">
              {pt ? "Nenhuma Agenda Anual cadastrada." : "No annual plans yet."}
            </p>
          )}
          {lista.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => void abrir(a.id)}
              className={`w-full text-left bg-white border rounded-2xl p-4 space-y-1 cursor-pointer transition ${
                selecionada?.id === a.id ? "border-[#00658d] ring-1 ring-[#00658d]/30" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-extrabold text-[#00658d]">{a.year}</span>
                <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full ${COR_STATUS[a.status]}`}>
                  {annualStatusLabel(a.status, language)}
                </span>
              </div>
              <p className="text-[13px] font-extrabold text-slate-800">{a.title}</p>
              <p className="text-[10px] text-slate-500 font-semibold">{a.governanceBody.name}</p>
              <p className="text-[10px] text-slate-400 font-semibold">
                {a.reservedCount}/{a.itemsCount} {pt ? "reservadas" : "reserved"}
              </p>
            </button>
          ))}
        </aside>

        {selecionada ? (
          <AgendaDetail
            key={selecionada.id}
            language={language}
            agenda={selecionada}
            canManage={canManage}
            ocupado={ocupado}
            executar={executar}
            onOpenMeeting={onOpenMeeting}
            onMeetingsChanged={onMeetingsChanged}
            onDeleted={() => setSelecionada(null)}
            setErro={setErro}
          />
        ) : (
          <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-10 text-center text-[11px] text-slate-400 font-semibold">
            {pt ? "Selecione uma Agenda Anual para planejar as reuniões do ano." : "Select an annual plan to plan the year's meetings."}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface AgendaDetailProps {
  language: "en" | "pt";
  agenda: AnnualAgendaDetail;
  canManage: boolean;
  ocupado: boolean;
  executar: (acao: () => Promise<AnnualAgendaDetail | void>, sucesso?: string) => Promise<void>;
  onOpenMeeting: (meetingId: string) => void;
  onMeetingsChanged: () => void;
  onDeleted: () => void;
  setErro: (erro: string | null) => void;
}

function AgendaDetail({
  language,
  agenda,
  canManage,
  ocupado,
  executar,
  onOpenMeeting,
  onMeetingsChanged,
  onDeleted,
  setErro
}: AgendaDetailProps) {
  const pt = language === "pt";
  const fuso = DEFAULT_TIMEZONE;

  // Formulário de data (nova ou edição)
  const [editando, setEditando] = useState<AnnualAgendaItem | null>(null);
  const [titulo, setTitulo] = useState("");
  const [data, setData] = useState(`${agenda.year}-01-15`);
  const [inicio, setInicio] = useState("09:00");
  const [fim, setFim] = useState("11:00");
  const [repetir, setRepetir] = useState(false);

  // Reserva
  const [reservando, setReservando] = useState(false);
  const [modality, setModality] = useState<Modality>("online");
  const [physicalLocationKey, setPhysicalLocationKey] = useState("");
  const [organizer, setOrganizer] = useState<DirectoryUser | null>(null);
  const [participants, setParticipants] = useState<InviteParticipant[]>([]);
  const [resultado, setResultado] = useState<string | null>(null);

  // Aprovação
  const [email, setEmail] = useState(agenda.approvalSentTo ?? "");

  const aReservar = agenda.items.filter((i) => !i.meeting).length;
  const convitesPendentes = agenda.items.filter(
    (i) => i.meeting && (i.meeting.calendarSyncStatus === "pending" || i.meeting.calendarSyncStatus === "failed")
  ).length;

  const porMes = useMemo(() => {
    const grupos = new Map<number, AnnualAgendaItem[]>();
    for (const item of agenda.items) {
      const vigente = item.meeting ?? item;
      const mes = Number(local(vigente.startAt, vigente.timezone).date.slice(5, 7)) - 1;
      grupos.set(mes, [...(grupos.get(mes) ?? []), item]);
    }
    return [...grupos.entries()].sort((a, b) => a[0] - b[0]);
  }, [agenda.items]);

  const limparForm = () => {
    setEditando(null);
    setTitulo("");
    setRepetir(false);
  };

  const editar = (item: AnnualAgendaItem) => {
    const i = local(item.startAt, item.timezone);
    setEditando(item);
    setTitulo(item.title);
    setData(i.date);
    setInicio(i.time);
    setFim(local(item.endAt, item.timezone).time);
  };

  const salvarData = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!titulo.trim() || fim <= inicio) {
      setErro(pt ? "Informe o título e um horário de término após o início." : "Enter a title and an end time after the start.");
      return;
    }
    const corpo = (dia: string) => ({
      title: titulo.trim(),
      startAt: localToInstant(dia, inicio, fuso),
      endAt: localToInstant(dia, fim, fuso),
      timezone: fuso
    });

    if (editando) {
      await executar(() => updateAnnualAgendaItem(agenda.id, editando.id, corpo(data)), pt ? "Data atualizada." : "Date updated.");
      limparForm();
      return;
    }

    // "Repetir nos meses seguintes": mesmo dia do mês até dezembro; dias que
    // não existem no mês (ex.: 31) são pulados, nunca deslocados.
    const [ano, mes, dia] = data.split("-").map(Number) as [number, number, number];
    const dias = repetir
      ? Array.from({ length: 12 - mes + 1 }, (_, k) => mes + k)
          .filter((m) => dia <= new Date(ano, m, 0).getDate())
          .map((m) => `${ano}-${String(m).padStart(2, "0")}-${String(dia).padStart(2, "0")}`)
      : [data];

    await executar(async () => {
      let atual: AnnualAgendaDetail | undefined;
      for (const d of dias) {
        const nomeMes = MESES[Number(d.slice(5, 7)) - 1];
        const corpoDoDia = corpo(d);
        if (repetir) corpoDoDia.title = `${titulo.trim()} — ${nomeMes}`;
        atual = await addAnnualAgendaItem(agenda.id, corpoDoDia);
      }
      return atual;
    }, pt ? `${dias.length} data(s) incluída(s).` : `${dias.length} date(s) added.`);
    limparForm();
  };

  const reservar = async () => {
    if (modality === "in_person" && !physicalLocationKey) {
      setErro(pt ? "Selecione o local físico da reunião presencial." : "Select the physical location.");
      return;
    }
    const participantes = participantsPayload(participants);

    await executar(async () => {
      const r = await reserveAnnualAgenda(agenda.id, {
        modality,
        ...(modality === "in_person" ? { physicalLocationKey } : {}),
        organizer: organizer
          ? { entraObjectId: organizer.id, displayName: organizer.displayName ?? "", email: enderecoDoDiretorio(organizer) }
          : undefined,
        participants: participantes
      });
      const falhas = r.invitations.filter((i) => i.syncStatus !== "synced");
      setResultado(
        pt
          ? `${r.created} reunião(ões) criada(s); ${r.invitations.length - falhas.length} convite(s) enviado(s)` +
              (falhas.length ? `; ${falhas.length} com falha (${falhas[0]!.error ?? "ver Pipeline"}).` : ".")
          : `${r.created} meeting(s) created; ${r.invitations.length - falhas.length} invite(s) sent` +
              (falhas.length ? `; ${falhas.length} failed.` : ".")
      );
      setReservando(false);
      onMeetingsChanged();
      return r.agenda;
    });
  };

  const baixarPdf = async () => {
    try {
      const { blob, filename } = await downloadAnnualAgendaPdf(agenda.id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename ?? `agenda-anual-${agenda.year}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErro(describeAnnualAgendaError(e, language));
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 space-y-5 min-w-0">
      <header className="flex flex-col md:flex-row md:items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-extrabold text-[#00658d] uppercase tracking-wide">{agenda.governanceBody.name}</p>
          <h3 className="text-xl font-extrabold text-[#001e2d]">{agenda.title} — {agenda.year}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${COR_STATUS[agenda.status]}`}>
              {annualStatusLabel(agenda.status, language)}
            </span>
            <span className="text-[10px] text-slate-500 font-semibold">
              {agenda.reservedCount}/{agenda.itemsCount} {pt ? "datas reservadas" : "dates reserved"}
            </span>
            {agenda.approvalSentTo && (
              <span className="text-[10px] text-slate-400 font-semibold">
                {pt ? "Aprovação solicitada a" : "Approval requested from"} {agenda.approvalSentTo}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={() => void baixarPdf()} className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
            <Download className="w-3.5 h-3.5" />PDF
          </button>
          {canManage && agenda.reservedCount === 0 && (
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

      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? "Reservar cria as reuniões e envia os convites Outlook/Teams agora — sem esperar a aprovação. Depois de reservada, a data é alterada pelo Pipeline e o evento existente é atualizado."
          : "Reserving creates the meetings and sends Outlook/Teams invites now — without waiting for approval. Once reserved, a date is changed from the Pipeline and the existing event is updated."}
      </p>

      {/* Datas do ano */}
      <div className="space-y-3">
        {porMes.length === 0 && (
          <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Nenhuma data planejada ainda." : "No dates planned yet."}</p>
        )}
        {porMes.map(([mes, itens]) => (
          <div key={mes} className="grid grid-cols-[90px_1fr] gap-3 items-start">
            <span className="text-[11px] font-extrabold text-slate-500 uppercase pt-2">{MESES[mes]}</span>
            <ul className="space-y-1.5">
              {itens.map((item) => {
                const vigente = item.meeting ?? item;
                const i = local(vigente.startAt, vigente.timezone);
                const f = local(vigente.endAt, vigente.timezone);
                return (
                  <li key={item.id} className="flex items-center justify-between gap-3 border border-slate-100 rounded-xl px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[12px] font-bold text-slate-800 truncate">{item.meeting?.title ?? item.title}</p>
                      <p className="text-[10px] text-slate-500 font-semibold">
                        {i.date.split("-").reverse().join("/")} · {i.time}–{f.time}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.meeting ? (
                        <>
                          <span className={`text-[10px] font-bold inline-flex items-center gap-1 ${item.meeting.calendarSyncStatus === "synced" || item.meeting.calendarSyncStatus === "stale" ? "text-emerald-600" : "text-amber-600"}`}>
                            <CalendarCheck className="w-3.5 h-3.5" />
                            {item.meeting.calendarSyncStatus === "synced" || item.meeting.calendarSyncStatus === "stale"
                              ? pt ? "Reservada" : "Reserved"
                              : pt ? "Convite pendente" : "Invite pending"}
                          </span>
                          <button type="button" onClick={() => onOpenMeeting(item.meeting!.id)} className="p-1.5 text-[#00658d] hover:bg-sky-50 rounded-lg cursor-pointer" title={pt ? "Abrir no Pipeline" : "Open in Pipeline"}>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] font-bold text-slate-400">{pt ? "A reservar" : "To reserve"}</span>
                          {canManage && (
                            <>
                              <button type="button" onClick={() => editar(item)} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer" title={pt ? "Editar" : "Edit"}>
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button type="button" onClick={() => void executar(() => deleteAnnualAgendaItem(agenda.id, item.id))} className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg cursor-pointer" title={pt ? "Remover" : "Remove"}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {canManage && (
        <form onSubmit={salvarData} className="border-t border-slate-100 pt-4 grid grid-cols-1 sm:grid-cols-[1fr_140px_100px_100px] gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{editando ? (pt ? "Editar reunião" : "Edit meeting") : pt ? "Reunião planejada" : "Planned meeting"} *</label>
            <input required value={titulo} onChange={(e) => setTitulo(e.target.value)} className={INPUT}
              placeholder={pt ? `Ex.: ${agenda.title} — Reunião ordinária` : "e.g. Ordinary meeting"} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{pt ? "Data" : "Date"} *</label>
            <input type="date" required min={`${agenda.year}-01-01`} max={`${agenda.year}-12-31`} value={data} onChange={(e) => setData(e.target.value)} className={INPUT} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{pt ? "Início" : "Start"}</label>
            <input type="time" required value={inicio} onChange={(e) => setInicio(e.target.value)} className={INPUT} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL}>{pt ? "Término" : "End"}</label>
            <input type="time" required value={fim} onChange={(e) => setFim(e.target.value)} className={INPUT} />
          </div>
          <div className="sm:col-span-4 flex items-center justify-between gap-3 flex-wrap">
            {!editando ? (
              <label className="text-[11px] text-slate-600 font-semibold inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={repetir} onChange={(e) => setRepetir(e.target.checked)} />
                {pt ? "Repetir no mesmo dia nos meses seguintes do ano" : "Repeat on the same day in the following months"}
              </label>
            ) : <span />}
            <div className="flex gap-2">
              {editando && (
                <button type="button" onClick={limparForm} className="px-3 py-2 bg-slate-100 rounded-xl text-xs font-bold text-slate-500 cursor-pointer">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <button type="submit" disabled={ocupado} className="px-4 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                <Plus className="w-3.5 h-3.5" />{editando ? (pt ? "Salvar data" : "Save date") : pt ? "Incluir data" : "Add date"}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Reserva */}
      {canManage && (aReservar > 0 || convitesPendentes > 0) && (
        <div className="border border-[#00658d]/20 bg-sky-50/40 rounded-2xl p-4 space-y-3">
          {!reservando ? (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] text-slate-700 font-semibold">
                {aReservar > 0
                  ? pt ? `${aReservar} data(s) ainda não reservada(s).` : `${aReservar} date(s) not reserved yet.`
                  : pt ? `${convitesPendentes} convite(s) pendente(s).` : `${convitesPendentes} pending invite(s).`}
              </p>
              <button type="button" onClick={() => setReservando(true)} className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer">
                <CalendarCheck className="w-3.5 h-3.5" />{pt ? "Reservar agendas" : "Reserve calendars"}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <h4 className="text-xs font-extrabold text-slate-800">
                {pt ? "Convite de todas as datas a reservar" : "Invitation for all dates to reserve"}
              </h4>
              <ModalityFields language={language} modality={modality} physicalLocationKey={physicalLocationKey}
                onChange={(m, l) => { setModality(m); setPhysicalLocationKey(l); }} />
              <OrganizerAndParticipants language={language} organizer={organizer} onOrganizerChange={setOrganizer}
                participants={participants} onParticipantsChange={setParticipants} />
              <ModalityDisclaimer language={language} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setReservando(false)} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold text-slate-500 cursor-pointer">
                  {pt ? "Cancelar" : "Cancel"}
                </button>
                <button type="button" disabled={ocupado} onClick={() => void reservar()} className="px-4 py-2 bg-[#00aeef] hover:bg-[#009bd4] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                  <CheckCircle className="w-3.5 h-3.5" />
                  {ocupado ? (pt ? "Reservando..." : "Reserving...") : pt ? "Confirmar reserva e enviar convites" : "Confirm and send invites"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {resultado && <p className="text-[11px] text-slate-600 font-semibold">{resultado}</p>}

      {/* Aprovação — eixo independente da reserva */}
      {canManage && agenda.itemsCount > 0 && (
        <div className="border-t border-slate-100 pt-4 space-y-2">
          <h4 className="text-xs font-extrabold text-slate-800 flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5 text-[#00658d]" />
            {pt ? "Aprovação da Agenda Anual" : "Plan approval"}
          </h4>
          {agenda.status !== "approved" ? (
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
                disabled={ocupado || !email.trim()}
                onClick={() => void executar(() => requestAnnualAgendaApproval(agenda.id, email.trim()), pt ? "Agenda Anual enviada para aprovação (PDF anexado)." : "Plan sent for approval.")}
                className="px-4 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                {agenda.status === "pending_approval" ? (pt ? "Reenviar PDF" : "Resend PDF") : pt ? "Enviar PDF para aprovação" : "Send PDF for approval"}
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
          ) : (
            <p className="text-[11px] text-emerald-700 font-semibold">
              {pt ? "Agenda Anual aprovada." : "Plan approved."}
            </p>
          )}
          <p className="text-[10px] text-slate-400 font-semibold">
            {pt
              ? "O e-mail sai da sua caixa (Microsoft 365) com o PDF da programação. A aprovação é registrada aqui quando a resposta chegar."
              : "The e-mail is sent from your mailbox with the schedule PDF. Approval is recorded here when the reply arrives."}
          </p>
        </div>
      )}
    </section>
  );
}
