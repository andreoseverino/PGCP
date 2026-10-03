import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, CalendarPlus, CheckCircle, Clock, Info, Users, X } from "lucide-react";
import type { GovernanceBody } from "../types";
import type { DirectoryUser } from "../lib/directory";
import { enderecoDoDiretorio } from "../lib/corporate-email";
import { createMeeting, DEFAULT_TIMEZONE, describeMeetingError, instantToLocal } from "../lib/meetings";
import { CalendarPreconditionError, syncMeetingCalendar } from "../lib/calendar-sync";
import { buildNewMeetingPayload, validateNewMeeting, type Modality, type NewMeetingForm } from "../lib/new-meeting";
import { previaDoTitulo, SESSION_TYPE_OPTIONS, type SessionType } from "../lib/meeting-title";
import { ajustarTermino, opcoesDeHorario } from "../lib/time-options";
import TimeSelect from "./TimeSelect";
import {
  ModalityDisclaimer,
  ModalityFields,
  OrganizerAndParticipants,
  type InviteParticipant
} from "./MeetingInviteFields";

/**
 * NOVA REUNIÃO — único ponto da interface que cria reunião individual.
 *
 * Cadastro deliberadamente simples: agendar e reservar a agenda. Pautas, temas,
 * documentos e demais itens de preparação entram DEPOIS, pelo Pipeline.
 *
 * Fluxo: preencher -> revisar (mesmo modal) -> `POST /meetings` -> convite
 * (`POST /:id/calendar-sync`). São dois atos com resultado próprio: se o
 * convite falhar, a reunião continua criada e o Pipeline oferece reenviar.
 */

interface NewMeetingModalProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  /** Dia sugerido pelo Calendário (YYYY-MM-DD). */
  initialDate?: string;
  /** Órgão do contexto global (só se ativo). Vazio = escolher no formulário. */
  initialGovernanceBodyId?: string;
  onClose: () => void;
  /** Reunião criada; `inviteMessage` descreve o resultado do convite. */
  onCreated: (meetingId: string, title: string, inviteMessage: string) => void;
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";

export default function NewMeetingModal({
  language,
  governanceBodies,
  initialDate,
  initialGovernanceBodyId = "",
  onClose,
  onCreated
}: NewMeetingModalProps) {
  const pt = language === "pt";
  const [sessionType, setSessionType] = useState<SessionType | "">("");
  const [date, setDate] = useState(
    () => initialDate ?? instantToLocal(new Date().toISOString(), DEFAULT_TIMEZONE).date
  );
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [governanceBodyId, setGovernanceBodyId] = useState(initialGovernanceBodyId);
  const [modality, setModality] = useState<Modality>("online");
  const [physicalLocationKey, setPhysicalLocationKey] = useState("");
  const [locationName, setLocationName] = useState("");
  const [organizer, setOrganizer] = useState<DirectoryUser | null>(null);
  const [participants, setParticipants] = useState<InviteParticipant[]>([]);

  const [etapa, setEtapa] = useState<"form" | "review">("form");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const form: NewMeetingForm = {
    sessionType,
    date,
    startTime,
    endTime,
    timezone: DEFAULT_TIMEZONE,
    governanceBodyId,
    modality,
    physicalLocationKey,
    organizer: organizer
      ? { entraObjectId: organizer.id, displayName: organizer.displayName ?? "", email: enderecoDoDiretorio(organizer) }
      : undefined,
    participants
  };

  const revisar = (e: React.FormEvent) => {
    e.preventDefault();
    const problema = validateNewMeeting(form, language);
    setErro(problema);
    if (!problema) setEtapa("review");
  };

  const confirmar = async () => {
    if (salvando) return;
    setSalvando(true);
    setErro(null);
    try {
      const criada = await createMeeting(buildNewMeetingPayload(form));

      // Convite logo em seguida: agendar = reservar a agenda (025).
      let convite: string;
      try {
        const integracao = await syncMeetingCalendar(criada.id);
        convite =
          integracao.syncStatus === "synced"
            ? pt
              ? "Convite Outlook/Teams enviado."
              : "Outlook/Teams invitation sent."
            : pt
              ? "Reunião criada; o convite ficou pendente — reenvie pelo Pipeline."
              : "Meeting created; the invitation is pending — resend from the Pipeline.";
      } catch (error) {
        convite =
          error instanceof CalendarPreconditionError
            ? `${pt ? "Reunião criada, convite não enviado" : "Meeting created, invitation not sent"}: ${error.message}`
            : pt
              ? "Reunião criada, mas o convite falhou. Tente novamente pelo Pipeline."
              : "Meeting created, but the invitation failed. Retry from the Pipeline.";
      }
      onCreated(criada.id, criada.title, convite);
    } catch (error) {
      setErro(describeMeetingError(error, language));
      setEtapa("form");
    } finally {
      setSalvando(false);
    }
  };

  const orgao = governanceBodies.find((b) => b.id === governanceBodyId)?.name ?? "";
  // Título padronizado: só prévia — quem grava é o servidor (030).
  const titulo = previaDoTitulo({ startTime, orgao, tipo: sessionType, modalidade: modality });

  // Esc = Cancelar (mesmo padrão do modal de Tema). Durante o envio, não fecha.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !salvando) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [salvando, onClose]);

  /*
   * Mesmo padrão visual do modal de Novo/Editar tema: portal no <body>
   * (centralizado na viewport), fundo só desfocado, header e rodapé fixos,
   * corpo com rolagem única. Formulário: dados à esquerda, pessoas à direita
   * (md+); abaixo de md empilha.
   */
  return createPortal(
    <div className="fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nova-reuniao-titulo"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in text-xs"
      >
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="min-w-0">
            <h3 id="nova-reuniao-titulo" className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
              <CalendarPlus className="w-4 h-4 text-[#00658d]" />
              {pt ? "Nova reunião" : "New meeting"}
            </h3>
            <p className="text-[11px] text-slate-500 font-medium mt-0.5">
              {pt
                ? "Agende e reserve a agenda. Pautas, temas e documentos são preparados depois, no Pipeline."
                : "Schedule and reserve the calendar. Agendas, topics and documents are prepared later, in the Pipeline."}
            </p>
          </div>
          <button
            onClick={onClose}
            type="button"
            disabled={salvando}
            aria-label={pt ? "Fechar" : "Close"}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {etapa === "form" ? (
          <form
            id="nova-reuniao"
            onSubmit={revisar}
            className="flex-1 min-h-0 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,360px)]"
          >
            {/* DADOS DA REUNIÃO — coluna esquerda */}
            <section aria-labelledby="nova-reuniao-dados" className="px-6 py-5 space-y-4">
              <h4 id="nova-reuniao-dados" className="text-xs font-extrabold text-slate-800">
                {pt ? "Dados da reunião" : "Meeting details"}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="nmDate" className={LABEL}>{pt ? "Data" : "Date"} *</label>
                  <input id="nmDate" type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="nmStart" className={`${LABEL} flex items-center gap-1`}>
                    <Clock className="w-3 h-3" />{pt ? "Início" : "Start"} *
                  </label>
                  {/* Seletor do PGCP em passos de 5 min (sem o picker nativo). */}
                  <TimeSelect
                    id="nmStart"
                    value={startTime}
                    options={opcoesDeHorario()}
                    onChange={(novo) => {
                      // Término que ficaria inválido acompanha o início (mantém a duração).
                      setEndTime(ajustarTermino(startTime, endTime, novo));
                      setStartTime(novo);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="nmEnd" className={`${LABEL} flex items-center gap-1`}>
                    <Clock className="w-3 h-3" />{pt ? "Término" : "End"} *
                  </label>
                  {/* Só horários DEPOIS do início. */}
                  <TimeSelect id="nmEnd" value={endTime} options={opcoesDeHorario(startTime)} onChange={setEndTime} />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="nmBody" className={LABEL}>{pt ? "Órgão de governança / comitê" : "Governance body"} *</label>
                <select id="nmBody" required value={governanceBodyId} onChange={(e) => setGovernanceBodyId(e.target.value)} className={`${INPUT} cursor-pointer`}>
                  <option value="">{pt ? "Selecione o órgão..." : "Select the body..."}</option>
                  {governanceBodies.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              <ModalityFields
                language={language}
                modality={modality}
                physicalLocationKey={physicalLocationKey}
                onChange={(m, local, rotulo) => {
                  setModality(m);
                  setPhysicalLocationKey(local);
                  setLocationName(rotulo);
                }}
              />

              <div className="flex flex-col gap-1">
                <label htmlFor="nmType" className={LABEL}>{pt ? "Tipo" : "Type"} *</label>
                <select id="nmType" required value={sessionType} onChange={(e) => setSessionType(e.target.value as SessionType | "")} className={`${INPUT} cursor-pointer`}>
                  <option value="">{pt ? "Selecione..." : "Select..."}</option>
                  {SESSION_TYPE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{pt ? o.pt : o.en}</option>)}
                </select>
              </div>

              {/* Título gerado pelos campos — não editável (padrão corporativo). */}
              <div className="flex flex-col gap-1">
                <span className={LABEL}>{pt ? "Título (gerado automaticamente)" : "Title (generated)"}</span>
                <p id="nmTitlePreview" className="px-3 py-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700 break-words min-h-[34px]">
                  {titulo ?? (pt ? "Preencha início, órgão, formato e tipo." : "Fill in start, body, format and type.")}
                </p>
              </div>
            </section>

            {/* PESSOAS DA REUNIÃO — coluna direita */}
            <aside
              aria-labelledby="nova-reuniao-pessoas"
              className="px-6 py-5 space-y-4 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/60 flex flex-col"
            >
              <h4 id="nova-reuniao-pessoas" className="text-xs font-extrabold text-slate-800 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-[#00658d]" />
                {pt ? "Pessoas da reunião" : "Meeting people"}
              </h4>
              <OrganizerAndParticipants
                language={language}
                sugestao={governanceBodyId ? { governanceBodyId, rotuloOrgao: governanceBodies.find((b) => b.id === governanceBodyId)?.name } : undefined}
                organizer={organizer}
                onOrganizerChange={setOrganizer}
                participants={participants}
                onParticipantsChange={setParticipants}
              />
              <div className="mt-auto pt-1">
                <ModalityDisclaimer language={language} />
              </div>
            </aside>
          </form>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-3">
            <h4 className="text-sm font-extrabold text-[#001e2d]">{pt ? "Confira antes de agendar" : "Review before scheduling"}</h4>
            <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-[12px]">
              <dt className="text-slate-500 font-bold">{pt ? "Reunião" : "Meeting"}</dt><dd className="font-bold text-slate-800 break-words">{titulo}</dd>
              <dt className="text-slate-500 font-bold">{pt ? "Quando" : "When"}</dt>
              <dd className="text-slate-800">{date.split("-").reverse().join("/")} · {startTime}–{endTime} ({DEFAULT_TIMEZONE})</dd>
              <dt className="text-slate-500 font-bold">{pt ? "Órgão" : "Body"}</dt><dd className="text-slate-800">{orgao}</dd>
              <dt className="text-slate-500 font-bold">{pt ? "Modalidade" : "Format"}</dt>
              <dd className="text-slate-800">
                {modality === "online" ? (pt ? "Videoconferência (Microsoft Teams)" : "Video conference (Microsoft Teams)") : `${pt ? "Presencial" : "In person"} — ${locationName} · Teams ${pt ? "como contingência" : "as fallback"}`}
              </dd>
              <dt className="text-slate-500 font-bold">{pt ? "Organizador" : "Organiser"}</dt>
              <dd className="text-slate-800">{organizer?.displayName ?? (pt ? "Você" : "You")}</dd>
              <dt className="text-slate-500 font-bold">{pt ? "Convidados" : "Invitees"}</dt>
              <dd className="text-slate-800">{participants.length > 0 ? participants.map((p) => p.name).join(", ") : pt ? "Nenhum" : "None"}</dd>
            </dl>
            <ModalityDisclaimer language={language} />
          </div>
        )}

        {erro && (
          <div role="alert" className="mx-6 my-3 flex gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold shrink-0">
            <Info className="w-4 h-4 shrink-0 mt-px" />
            <span>{erro}</span>
          </div>
        )}

        {/* Rodapé fixo: fica visível com o corpo rolando. */}
        <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0">
          {etapa === "form" ? (
            <>
              <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer">
                {pt ? "Cancelar" : "Cancel"}
              </button>
              <button type="submit" form="nova-reuniao" className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer">
                {pt ? "Revisar" : "Review"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEtapa("form")} disabled={salvando} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50">
                <ArrowLeft className="w-3.5 h-3.5" />{pt ? "Voltar" : "Back"}
              </button>
              <button type="button" onClick={() => void confirmar()} disabled={salvando} className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                <CheckCircle className="w-4 h-4" />
                {salvando ? (pt ? "Agendando..." : "Scheduling...") : pt ? "Agendar e enviar convite" : "Schedule and send invite"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
