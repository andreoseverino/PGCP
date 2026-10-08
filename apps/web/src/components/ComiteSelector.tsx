import React, { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { apiRequest } from "../lib/api";
import type { GovernanceBody } from "../types";
import { listMeetings, meetingFromApi } from "../lib/meetings";
import type { ComiteVinculo } from "../lib/committee-link";

/**
 * COMITÊ — substitui a Recorrência do tema (040). Além do órgão "dono" do
 * tema/reunião, outros órgãos por onde o tema também deve passar: "Todos"
 * marca em toda reunião já agendada do órgão; "Dias Específicos" deixa
 * escolher quais. Autossuficiente: busca órgãos e reuniões por conta própria,
 * como `ParticipantPicker`/`DirectoryUserPicker`.
 */

interface Props {
  language: "en" | "pt";
  /**
   * Órgão "dono" (da reunião/tema) — aparece como opção igual aos demais:
   * marcá-lo com "Todos"/"Dias Específicos" replica o tema nas OUTRAS
   * reuniões do MESMO comitê (a reunião atual já tem o tema, então entra uma
   * vez só nela mesmo que ela apareça entre as opções de "Dias Específicos").
   */
  homeGovernanceBodyId?: string | null;
  value: ComiteVinculo[];
  onChange: (value: ComiteVinculo[]) => void;
  disabled?: boolean;
}

const LABEL = "text-[9.5px] font-bold text-slate-400 uppercase tracking-wider";
const CAMPO =
  "w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200";

export default function ComiteSelector({ language, homeGovernanceBodyId, value, onChange, disabled }: Props) {
  const pt = language === "pt";
  const [orgaos, setOrgaos] = useState<GovernanceBody[]>([]);
  const [reunioes, setReunioes] = useState<Array<{ id: string; governanceBodyId: string; title: string; date: string; startTime: string }>>([]);
  const [novoOrgaoId, setNovoOrgaoId] = useState("");

  useEffect(() => {
    void apiRequest<GovernanceBody[]>("/governance-bodies", { auth: true })
      .then(setOrgaos)
      .catch(() => setOrgaos([]));
    const agora = Date.now();
    void listMeetings()
      .then((lista) =>
        setReunioes(
          lista
            // Comparação pelo INSTANTE (igual ao `start_at > now()` do backend) —
            // nunca por data em UTC, que erra perto da virada do dia em fusos
            // atrás de UTC (a reunião ainda "não aconteceu" no fuso dela).
            .filter((api) => !api.cancelledAt && new Date(api.startAt).getTime() > agora)
            .map(meetingFromApi)
            .map((m) => ({ id: m.id, governanceBodyId: m.governanceBodyId, title: m.title, date: m.date, startTime: m.startTime })),
        ),
      )
      .catch(() => setReunioes([]));
  }, []);

  const nomeDoOrgao = (id: string) => orgaos.find((o) => o.id === id)?.name ?? id;
  const reunioesDoOrgao = (id: string) => reunioes.filter((m) => m.governanceBodyId === id);

  const disponiveis = orgaos.filter((o) => !value.some((v) => v.governanceBodyId === o.id));

  const adicionar = (id: string) => {
    if (!id) return;
    onChange([...value, { governanceBodyId: id, modo: "todos" }]);
    setNovoOrgaoId("");
  };

  const remover = (id: string) => onChange(value.filter((v) => v.governanceBodyId !== id));

  const atualizar = (id: string, patch: Partial<ComiteVinculo>) =>
    onChange(value.map((v) => (v.governanceBodyId === id ? { ...v, ...patch } : v)));

  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL}>{pt ? "Comitê" : "Committee"}</label>
      {homeGovernanceBodyId && (
        <p className="text-[10px] text-slate-400 font-medium -mt-0.5">
          {pt ? "Esta reunião já é de: " : "This meeting already belongs to: "}
          <span className="font-bold text-slate-500">{nomeDoOrgao(homeGovernanceBodyId)}</span>
          {pt
            ? ". Marque-o abaixo para repetir em OUTRAS reuniões dele; marque outros comitês para estender a eles."
            : ". Select it below to repeat into its OTHER meetings; select other committees to extend to them."}
        </p>
      )}

      {value.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {value.map((v) => (
            <li key={v.governanceBodyId} className="flex flex-col gap-1 bg-slate-50/70 border border-slate-200/60 rounded-xl p-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[10.5px] font-bold text-slate-700 truncate">{nomeDoOrgao(v.governanceBodyId)}</span>
                <select
                  value={v.modo}
                  disabled={disabled}
                  onChange={(e) => atualizar(v.governanceBodyId, { modo: e.target.value as ComiteVinculo["modo"], meetingIds: undefined })}
                  className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-semibold text-slate-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#00658d]/20"
                >
                  <option value="todos">{pt ? "Todos" : "All"}</option>
                  <option value="especificas">{pt ? "Dias Específicos" : "Specific dates"}</option>
                </select>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remover(v.governanceBodyId)}
                  className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 p-1 rounded-lg cursor-pointer"
                  aria-label={pt ? "Remover comitê" : "Remove committee"}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {v.modo === "especificas" && (
                <select
                  multiple
                  disabled={disabled}
                  value={v.meetingIds ?? []}
                  onChange={(e) =>
                    atualizar(v.governanceBodyId, {
                      meetingIds: Array.from(e.target.selectedOptions).map((o) => o.value),
                    })
                  }
                  className={`${CAMPO} cursor-pointer min-h-[72px]`}
                >
                  {reunioesDoOrgao(v.governanceBodyId).length === 0 && (
                    <option disabled value="">
                      {pt ? "Nenhuma reunião agendada para este órgão" : "No scheduled meeting for this body"}
                    </option>
                  )}
                  {reunioesDoOrgao(v.governanceBodyId).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.date} {m.startTime} — {m.title}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}

      {disponiveis.length > 0 && (
        <div className="flex items-center gap-1.5">
          <select
            value={novoOrgaoId}
            disabled={disabled}
            onChange={(e) => adicionar(e.target.value)}
            className={`${CAMPO} cursor-pointer`}
          >
            <option value="">{pt ? "Adicionar comitê..." : "Add committee..."}</option>
            {disponiveis.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <Plus className="w-3.5 h-3.5 text-slate-300 shrink-0" />
        </div>
      )}
    </div>
  );
}
