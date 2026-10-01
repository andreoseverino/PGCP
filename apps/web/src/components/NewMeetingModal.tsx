import React, { useState } from "react";
import { ArrowLeft, CalendarPlus, CheckCircle, Clock, Info, X } from "lucide-react";
import type { GovernanceBody } from "../types";
import type { DirectoryUser } from "../lib/directory";
import { enderecoDoDiretorio } from "../lib/corporate-email";
import { createMeeting, DEFAULT_TIMEZONE, describeMeetingError, instantToLocal } from "../lib/meetings";
import { CalendarPreconditionError, syncMeetingCalendar } from "../lib/calendar-sync";
import { buildNewMeetingPayload, validateNewMeeting, type Modality, type NewMeetingForm } from "../lib/new-meeting";
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
  onClose,
  onCreated
}: NewMeetingModalProps) {
  const pt = language === "pt";
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(
    () => initialDate ?? instantToLocal(new Date().toISOString(), DEFAULT_TIMEZONE).date
  );
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [governanceBodyId, setGovernanceBodyId] = useState("");
  const [modality, setModality] = useState<Modality>("online");
  const [physicalLocationKey, setPhysicalLocationKey] = useState("");
  const [locationName, setLocationName] = useState("");
  const [organizer, setOrganizer] = useState<DirectoryUser | null>(null);
  const [participants, setParticipants] = useState<InviteParticipant[]>([]);

  const [etapa, setEtapa] = useState<"form" | "review">("form");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const form: NewMeetingForm = {
    title,
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

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-3xl max-w-3xl w-full relative animate-fade-in max-h-[95vh] overflow-hidden flex flex-col text-xs">
        <button
          onClick={onClose}
          type="button"
          aria-label={pt ? "Fechar" : "Close"}
          className="absolute right-5 top-5 text-slate-400 hover:text-slate-600 p-1.5 bg-slate-50 hover:bg-slate-100 rounded-full cursor-pointer z-10"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="overflow-y-auto p-6 md:p-8 space-y-5">
          <div className="border-b border-slate-100 pb-3 pr-10">
            <h3 className="text-lg font-extrabold text-[#001e2d] flex items-center gap-2">
              <CalendarPlus className="w-5 h-5 text-[#00658d]" />
              {pt ? "Nova reunião" : "New meeting"}
            </h3>
            <p className="text-[11px] text-slate-500 font-medium mt-1">
              {pt
                ? "Agende e reserve a agenda. Pautas, temas e documentos são preparados depois, no Pipeline."
                : "Schedule and reserve the calendar. Agendas, topics and documents are prepared later, in the Pipeline."}
            </p>
          </div>

          {etapa === "form" ? (
            <form id="nova-reuniao" onSubmit={revisar} className="space-y-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="nmTitle" className={LABEL}>{pt ? "Título da reunião" : "Meeting title"} *</label>
                <input id="nmTitle" required value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT}
                  placeholder={pt ? "Ex.: Reunião do Comitê Executivo" : "e.g. Executive Committee meeting"} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="nmDate" className={LABEL}>{pt ? "Data" : "Date"} *</label>
                  <input id="nmDate" type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="nmStart" className={`${LABEL} flex items-center gap-1`}>
                    <Clock className="w-3 h-3" />{pt ? "Início" : "Start"} *
                  </label>
                  <input id="nmStart" type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} className={INPUT} />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="nmEnd" className={`${LABEL} flex items-center gap-1`}>
                    <Clock className="w-3 h-3" />{pt ? "Término" : "End"} *
                  </label>
                  <input id="nmEnd" type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} className={INPUT} />
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

              <OrganizerAndParticipants
                language={language}
                organizer={organizer}
                onOrganizerChange={setOrganizer}
                participants={participants}
                onParticipantsChange={setParticipants}
              />

              <ModalityDisclaimer language={language} />
            </form>
          ) : (
            <div className="space-y-3">
              <h4 className="text-sm font-extrabold text-[#001e2d]">{pt ? "Confira antes de agendar" : "Review before scheduling"}</h4>
              <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-[12px]">
                <dt className="text-slate-500 font-bold">{pt ? "Reunião" : "Meeting"}</dt><dd className="font-bold text-slate-800">{title}</dd>
                <dt className="text-slate-500 font-bold">{pt ? "Quando" : "When"}</dt>
                <dd className="text-slate-800">{date.split("-").reverse().join("/")} · {startTime}–{endTime} ({DEFAULT_TIMEZONE})</dd>
                <dt className="text-slate-500 font-bold">{pt ? "Órgão" : "Body"}</dt><dd className="text-slate-800">{orgao}</dd>
                <dt className="text-slate-500 font-bold">{pt ? "Modalidade" : "Format"}</dt>
                <dd className="text-slate-800">
                  {modality === "online" ? "Online (Microsoft Teams)" : `${pt ? "Presencial" : "In person"} — ${locationName} · Teams ${pt ? "como contingência" : "as fallback"}`}
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
            <div role="alert" className="flex gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold">
              <Info className="w-4 h-4 shrink-0 mt-px" />
              <span>{erro}</span>
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            {etapa === "form" ? (
              <>
                <button type="button" onClick={onClose} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold uppercase text-[10px] tracking-wider rounded-xl cursor-pointer">
                  {pt ? "Cancelar" : "Cancel"}
                </button>
                <button type="submit" form="nova-reuniao" className="px-6 py-2.5 bg-[#00658d] hover:bg-[#00aeef] text-white font-bold uppercase text-[10px] tracking-wider rounded-xl cursor-pointer">
                  {pt ? "Revisar" : "Review"}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setEtapa("form")} disabled={salvando} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold uppercase text-[10px] tracking-wider rounded-xl cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50">
                  <ArrowLeft className="w-3.5 h-3.5" />{pt ? "Voltar" : "Back"}
                </button>
                <button type="button" onClick={() => void confirmar()} disabled={salvando} className="px-6 py-2.5 bg-[#00aeef] hover:bg-[#009bd4] text-white font-bold uppercase text-[10px] tracking-wider rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                  <CheckCircle className="w-4 h-4" />
                  {salvando ? (pt ? "Agendando..." : "Scheduling...") : pt ? "Agendar e enviar convite" : "Schedule and send invite"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
