import React, { useEffect, useState } from "react";
import { Info, MapPin, MonitorSmartphone, Trash2, Users } from "lucide-react";
import type { DirectoryUser } from "../lib/directory";
import { enderecoDoDiretorio } from "../lib/corporate-email";
import { addParticipantOnce, papelPadraoDoParticipante } from "../lib/participants";
import { describeMeetingError, listMeetingLocations } from "../lib/meetings";
import { MODALITY_DISCLAIMER, type Modality, type NewMeetingForm } from "../lib/new-meeting";
import type { PhysicalLocation } from "../types";
import { locationLabel, opcoesDeLocal, rotuloDaOpcao } from "../lib/meeting-locations-rules";
import { getInitials } from "../lib/user";
import ParticipantPicker from "./ParticipantPicker";
import { selecionadoComoConvidado } from "../lib/participant-search";
import { jaNaLista, MSG_JA_PARTICIPA } from "../lib/group-participants";

/**
 * Campos do CONVITE compartilhados pelo agendamento do Calendário e pela
 * reserva da Agenda Anual: modalidade, local físico, organizador e
 * participantes. Um componente só para as duas telas aplicarem a mesma regra.
 */

export type InviteParticipant = NewMeetingForm["participants"][number];

/**
 * Participante na lista do convite. `participantId` = linha JÁ gravada em
 * `meeting_participants` (edição da reunião); ausente = pessoa nova.
 */
export type ParticipanteDoConvite = InviteParticipant & {
  participantId?: string;
  /** Veio do grupo do órgão (só UX: selo "Do órgão"). Não é vínculo com o cadastro. */
  doOrgao?: boolean;
};

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

interface ModalityFieldsProps {
  language: "en" | "pt";
  modality: Modality;
  /** Id do local cadastrado (Administração → Locais). */
  physicalLocationId: string;
  /**
   * Local que a reunião JÁ tem (cópia gravada), na edição. Entra marcado na
   * lista mesmo que tenha sido inativado depois, para não trocar sem querer.
   */
  currentLocation?: PhysicalLocation | null;
  /** `label` = nome e endereço do local escolhido, para resumo. */
  onChange: (modality: Modality, physicalLocationId: string, label: string) => void;
}

export function ModalityFields({ language, modality, physicalLocationId, currentLocation, onChange }: ModalityFieldsProps) {
  const pt = language === "pt";
  const [ativos, setAtivos] = useState<PhysicalLocation[]>([]);
  const [carregado, setCarregado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const controlador = new AbortController();
    listMeetingLocations(controlador.signal)
      .then((lista) => {
        setAtivos(lista);
        setCarregado(true);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErro(describeMeetingError(e, language));
      });
    return () => controlador.abort();
  }, [language]);

  const opcoes = opcoesDeLocal(ativos, currentLocation);
  const locais = opcoes.map((o) => o.local);

  const opcao = (valor: Modality, rotulo: string, Icone: typeof MapPin) => (
    <button
      type="button"
      onClick={() => {
        const chave = valor === "online" ? "" : physicalLocationId;
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

  const selecionado = opcoes.find((o) => o.local.id === physicalLocationId);

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
            {pt ? "Local" : "Location"} *
          </label>
          <select
            id="physicalLocation"
            required
            value={physicalLocationId}
            onChange={(e) => {
              const local = locais.find((l) => l.id === e.target.value);
              onChange("in_person", e.target.value, local ? locationLabel(local) : "");
            }}
            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
          >
            <option value="">{pt ? "Selecione o local..." : "Select the location..."}</option>
            {opcoes.map(({ local, atual }) => (
              <option key={local.id} value={local.id}>
                {rotuloDaOpcao(local)}
                {atual ? (pt ? " (local atual da reunião)" : " (current meeting location)") : ""}
              </option>
            ))}
          </select>
          {selecionado && (
            <p className="text-[10px] text-slate-500 font-semibold break-words">{locationLabel(selecionado.local)}</p>
          )}
          {selecionado?.atual && (
            <p className="text-[10px] text-slate-400 font-semibold">
              {pt
                ? "Endereço guardado quando o local foi escolhido. Este local não está mais disponível para novas escolhas."
                : "Address saved when the location was chosen. This location is no longer available for new choices."}
            </p>
          )}
          {carregado && ativos.length === 0 && !selecionado && (
            <p className="text-[10px] text-amber-700 font-semibold">
              {pt
                ? "Nenhum local ativo. Cadastre em Administração → Locais."
                : "No active location. Register one in Administration → Locations."}
            </p>
          )}
          {erro && <p className="text-[10px] text-red-500 font-semibold">{erro}</p>}
        </div>
      )}
    </div>
  );
}

/** Pessoa do diretório como convidada (organizador escolhido também é convidado). */
export function convidadoDoDiretorio(user: DirectoryUser, language: "en" | "pt"): InviteParticipant {
  return {
    name: user.displayName ?? "",
    role: papelPadraoDoParticipante(language),
    confirmed: false,
    entraObjectId: user.id,
    email: enderecoDoDiretorio(user)
  };
}

/**
 * Pergunta da TROCA DE ÓRGÃO (Nova reunião e Editar reunião). Nada muda na
 * lista até a usuária escolher; o órgão já trocado continua trocado.
 */
export function ConfirmarTrocaDeOrgao({
  mensagem,
  rotuloAtualizar,
  rotuloManter,
  onAtualizar,
  onManter
}: {
  mensagem: string;
  rotuloAtualizar: string;
  rotuloManter: string;
  onAtualizar: () => void;
  onManter: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={mensagem} className="p-3 rounded-xl bg-amber-50 border border-amber-200 space-y-2">
      <p className="text-[11px] font-semibold text-amber-900 leading-relaxed">{mensagem}</p>
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" onClick={onManter} className="px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-amber-100 rounded-lg cursor-pointer">
          {rotuloManter}
        </button>
        <button type="button" onClick={onAtualizar} className="px-3 py-1.5 text-[11px] font-bold bg-[#00658d] hover:bg-[#00aeef] text-white rounded-lg cursor-pointer">
          {rotuloAtualizar}
        </button>
      </div>
    </div>
  );
}

interface ParticipantsFieldProps {
  language: "en" | "pt";
  participants: ParticipanteDoConvite[];
  onParticipantsChange: (list: ParticipanteDoConvite[]) => void;
  /** Órgão da reunião/agenda para sugerir pessoas classificadas (027). */
  sugestao?: { governanceBodyId?: string; rotuloOrgao?: string };
  /** Texto de apoio abaixo do rótulo. */
  hint?: string | null;
}

/**
 * Participantes do convite (Entra ID + externos do PGCP): busca, sugestão,
 * selo "Externo" e remoção. Usado no agendamento (Nova reunião, Agenda Anual)
 * e na EDIÇÃO da reunião — uma tela só, mesma regra. A validação definitiva
 * (duplicidade, responsável por tema, identidade) é do servidor.
 */
export function ParticipantsField({ language, participants, onParticipantsChange, sugestao, hint }: ParticipantsFieldProps) {
  const pt = language === "pt";
  const [duplicado, setDuplicado] = useState(false);
  return (
      <div className="flex flex-col gap-1">
        <span className={`${LABEL} flex items-center gap-1`}>
          <Users className="w-3 h-3" />
          {pt ? "Participantes (convite)" : "Participants (invite)"}
        </span>
        {hint && <span className="text-[10px] text-slate-400 font-semibold">{hint}</span>}
        {/* Participar: Entra ID + externos do PGCP. O organizador
            fica fora deste bloco: é de quem é o calendário. */}
        <ParticipantPicker
          language={language}
          showHint
          sugestao={sugestao}
          placeholder={pt ? "Adicionar participante..." : "Add participant..."}
          jaEscolhidos={{
            entraIds: participants.map((p) => p.entraObjectId ?? "").filter(Boolean),
            emails: participants.map((p) => p.email ?? "")
          }}
          onSelect={(sel) => {
            const novo = selecionadoComoConvidado(sel, papelPadraoDoParticipante(language));
            // Mesma pessoa (oid) ou mesmo e-mail (externo repetido): avisa, não duplica.
            // O servidor recusa de novo ao salvar (409).
            if (jaNaLista(participants, novo)) {
              setDuplicado(true);
              return;
            }
            setDuplicado(false);
            onParticipantsChange(addParticipantOnce(participants, novo));
          }}
        />
        {duplicado && (
          <p role="status" className="text-[10px] font-bold text-amber-700">{MSG_JA_PARTICIPA[language]}</p>
        )}
        {participants.length > 0 && (
          <ul className="mt-1.5 space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {participants.map((p) => (
              <li
                key={p.participantId ?? p.entraObjectId ?? p.email ?? p.name}
                className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-100 rounded-xl px-3 py-1.5"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-full bg-[#00658d]/10 text-[#00658d] flex items-center justify-center font-extrabold text-[9px] shrink-0">
                    {getInitials(p.name)}
                  </span>
                  <span className="text-[11px] font-bold text-slate-700 truncate">{p.name}</span>
                  {p.doOrgao && (
                    <span
                      title={pt ? "Veio do grupo do órgão. Remover daqui não altera o cadastro do órgão." : "From the body's group. Removing here doesn't change the body."}
                      className="text-[9px] font-bold text-[#00658d] bg-[#00658d]/10 px-1.5 rounded shrink-0"
                    >
                      {pt ? "Do órgão" : "From body"}
                    </span>
                  )}
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
                  onClick={() => {
                    setDuplicado(false);
                    onParticipantsChange(participants.filter((x) => x !== p));
                  }}
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
  );
}
