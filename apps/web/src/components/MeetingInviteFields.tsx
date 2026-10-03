import React, { useEffect, useState } from "react";
import { Info, MapPin, MonitorSmartphone, Trash2, Users } from "lucide-react";
import DirectoryUserPicker from "./DirectoryUserPicker";
import type { DirectoryUser } from "../lib/directory";
import { enderecoDoDiretorio } from "../lib/corporate-email";
import { addParticipantOnce, papelPadraoDoParticipante } from "../lib/participants";
import { describeMeetingError, listMeetingLocations } from "../lib/meetings";
import { MODALITY_DISCLAIMER, type Modality, type NewMeetingForm } from "../lib/new-meeting";
import type { PhysicalLocation } from "../types";
import { getInitials } from "../lib/user";
import ParticipantPicker from "./ParticipantPicker";
import { selecionadoComoConvidado } from "../lib/participant-search";

/**
 * Campos do CONVITE compartilhados pelo agendamento do Calendário e pela
 * reserva da Agenda Anual: modalidade, local físico, organizador e
 * participantes. Um componente só para as duas telas aplicarem a mesma regra.
 */

export type InviteParticipant = NewMeetingForm["participants"][number];

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";

/** Aviso fixo de modalidade — visível e discreto, sem modal próprio. */
export function ModalityDisclaimer({ language }: { language: "en" | "pt" }) {
  return (
    <p className="flex gap-2 p-3 rounded-xl bg-sky-50 border border-sky-100 text-[11px] text-sky-900 font-medium leading-relaxed">
      <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
      <span>{MODALITY_DISCLAIMER[language]}</span>
    </p>
  );
}

/** Rótulo do local, com endereço só quando configurado. */
export function locationLabel(local: PhysicalLocation): string {
  const cidade = [local.city, local.state].filter(Boolean).join("/");
  const partes = [local.address, local.complement, cidade].filter(Boolean);
  return partes.length > 0 ? `${local.name} — ${partes.join(", ")}` : local.name;
}

interface ModalityFieldsProps {
  language: "en" | "pt";
  modality: Modality;
  physicalLocationKey: string;
  /** `label` = nome (e endereço, se configurado) do local escolhido, para resumo. */
  onChange: (modality: Modality, physicalLocationKey: string, label: string) => void;
}

export function ModalityFields({ language, modality, physicalLocationKey, onChange }: ModalityFieldsProps) {
  const pt = language === "pt";
  const [locais, setLocais] = useState<PhysicalLocation[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const controlador = new AbortController();
    listMeetingLocations(controlador.signal)
      .then(setLocais)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErro(describeMeetingError(e, language));
      });
    return () => controlador.abort();
  }, [language]);

  const opcao = (valor: Modality, rotulo: string, Icone: typeof MapPin) => (
    <button
      type="button"
      onClick={() => {
        const chave = valor === "online" ? "" : physicalLocationKey;
        const local = locais.find((l) => l.id === chave);
        onChange(valor, chave, local ? locationLabel(local) : "");
      }}
      aria-pressed={modality === valor}
      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition cursor-pointer ${
        modality === valor
          ? "bg-[#00658d] border-[#00658d] text-white"
          : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
      }`}
    >
      <Icone className="w-3.5 h-3.5" />
      {rotulo}
    </button>
  );

  const selecionado = locais.find((l) => l.id === physicalLocationKey);

  return (
    <div className="space-y-2">
      <span className={LABEL}>{pt ? "Formato" : "Format"} *</span>
      <div className="flex gap-2">
        {opcao("online", pt ? "Videoconferência" : "Video conference", MonitorSmartphone)}
        {opcao("in_person", pt ? "Presencial" : "In person", MapPin)}
      </div>

      {modality === "in_person" && (
        <div className="flex flex-col gap-1 pt-1">
          <label htmlFor="physicalLocation" className={LABEL}>
            {pt ? "Local físico" : "Physical location"} *
          </label>
          <select
            id="physicalLocation"
            required
            value={physicalLocationKey}
            onChange={(e) => {
              const local = locais.find((l) => l.id === e.target.value);
              onChange("in_person", e.target.value, local ? locationLabel(local) : "");
            }}
            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
          >
            <option value="">{pt ? "Selecione o local..." : "Select the location..."}</option>
            {locais.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {selecionado && !selecionado.address && (
            <p className="text-[10px] text-slate-400 font-semibold">
              {pt
                ? "Endereço oficial ainda não cadastrado: o convite levará apenas o nome da sede."
                : "Official address not configured yet: the invite will include only the site name."}
            </p>
          )}
          {selecionado?.address && (
            <p className="text-[10px] text-slate-500 font-semibold">{locationLabel(selecionado)}</p>
          )}
          {erro && <p className="text-[10px] text-red-500 font-semibold">{erro}</p>}
        </div>
      )}
    </div>
  );
}

interface OrganizerAndParticipantsProps {
  language: "en" | "pt";
  organizer: DirectoryUser | null;
  onOrganizerChange: (user: DirectoryUser | null) => void;
  participants: InviteParticipant[];
  onParticipantsChange: (list: InviteParticipant[]) => void;
  /** Órgão da reunião/agenda para sugerir pessoas classificadas (027). */
  sugestao?: { governanceBodyId?: string; rotuloOrgao?: string };
}

/**
 * Organizador (de quem é o calendário) e convidados, sempre do diretório.
 * O organizador entra na lista — mesma regra do agendamento anterior.
 */
export function OrganizerAndParticipants({
  language,
  organizer,
  onOrganizerChange,
  participants,
  onParticipantsChange,
  sugestao
}: OrganizerAndParticipantsProps) {
  const pt = language === "pt";

  const incluir = (user: DirectoryUser) =>
    onParticipantsChange(
      addParticipantOnce(participants, {
        name: user.displayName ?? "",
        role: papelPadraoDoParticipante(language),
        confirmed: false,
        entraObjectId: user.id,
        email: enderecoDoDiretorio(user)
      })
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <span className={LABEL}>{pt ? "Organizador" : "Organiser"}</span>
        <DirectoryUserPicker
          language={language}
          selected={organizer}
          onSelect={(u) => {
            onOrganizerChange(u);
            incluir(u);
          }}
          onClear={() => onOrganizerChange(null)}
          placeholder={pt ? "Você, ou busque no diretório..." : "You, or search the directory..."}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className={`${LABEL} flex items-center gap-1`}>
          <Users className="w-3 h-3" />
          {pt ? "Participantes (convite)" : "Participants (invite)"}
        </span>
        {/* Grupo do órgão (Administração → Participantes): incluído pelo servidor ao agendar. */}
        <span className="text-[10px] text-slate-400 font-semibold">
          {pt
            ? "Quem faz parte do grupo do órgão colegiado entra automaticamente ao agendar."
            : "Members of the governance body's group are added automatically when scheduling."}
        </span>
        {/* Participar: Entra ID + externos do PGCP. O organizador (acima)
            continua só do diretório: é de quem é o calendário. */}
        <ParticipantPicker
          language={language}
          showHint
          sugestao={sugestao}
          placeholder={pt ? "Adicionar participante..." : "Add participant..."}
          jaEscolhidos={{
            entraIds: participants.map((p) => p.entraObjectId ?? "").filter(Boolean),
            emails: participants.map((p) => p.email ?? "")
          }}
          onSelect={(sel) =>
            onParticipantsChange(
              addParticipantOnce(participants, selecionadoComoConvidado(sel, papelPadraoDoParticipante(language)))
            )
          }
        />
        {participants.length > 0 && (
          <ul className="mt-1.5 space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {participants.map((p) => (
              <li
                key={p.entraObjectId ?? p.email ?? p.name}
                className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-100 rounded-xl px-3 py-1.5"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-full bg-[#00658d]/10 text-[#00658d] flex items-center justify-center font-extrabold text-[9px] shrink-0">
                    {getInitials(p.name)}
                  </span>
                  <span className="text-[11px] font-bold text-slate-700 truncate">{p.name}</span>
                  {!p.entraObjectId && p.email && (
                    <span className="text-[9px] font-bold text-amber-700 bg-amber-50 px-1.5 rounded shrink-0">
                      {pt ? "Externo" : "External"}
                    </span>
                  )}
                  {!p.email && (
                    <span className="text-[9px] font-bold text-amber-600 shrink-0">
                      {pt ? "sem e-mail" : "no e-mail"}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => onParticipantsChange(participants.filter((x) => x !== p))}
                  className="p-1 text-rose-500 hover:bg-rose-50 rounded-lg cursor-pointer"
                  aria-label={pt ? "Remover participante" : "Remove participant"}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
