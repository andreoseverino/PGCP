import React, { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { apiRequest } from "../lib/api";
import type { TemaFuturo } from "../lib/agenda-topic-adapters";
import type { GovernanceBody } from "../types";

/**
 * Bloco "TEMA FUTURO" dos formulários de tema (Biblioteca, Agenda Anual e
 * detalhe da reunião). A caixa de seleção revela MÊS/ANO e COMITÊ previstos.
 * Tema futuro vai só para a Biblioteca (aba Temas Futuros) e vira regular
 * sozinho quando entra numa reunião (servidor, 042).
 */
const LABEL = "text-[9.5px] font-bold text-slate-400 uppercase tracking-wider";
const CAMPO =
  "w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200";

export default function TemaFuturoFields({
  language,
  value,
  onChange,
  aviso
}: {
  language: "en" | "pt";
  value: TemaFuturo;
  onChange: (v: TemaFuturo) => void;
  /** Texto sob a caixa (ex.: "não entra nesta reunião"). */
  aviso?: string;
}) {
  const pt = language === "pt";
  const [orgaos, setOrgaos] = useState<GovernanceBody[]>([]);

  useEffect(() => {
    if (!value.ativo || orgaos.length > 0) return;
    void apiRequest<GovernanceBody[]>("/governance-bodies", { auth: true })
      .then((lista) => setOrgaos(lista.filter((o) => o.isActive || o.id === value.comiteId)))
      .catch(() => setOrgaos([]));
  }, [value.ativo, value.comiteId, orgaos.length]);

  return (
    <div className={`rounded-xl border p-3 space-y-2.5 ${value.ativo ? "border-[#00658d]/30 bg-sky-50/40" : "border-slate-200/70 bg-slate-50/40"}`}>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value.ativo}
          onChange={(e) => onChange({ ...value, ativo: e.target.checked })}
          className="mt-0.5 accent-[#00658d] cursor-pointer"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
            <CalendarClock className="w-3.5 h-3.5 text-[#00658d]" />
            {pt ? "Tema futuro" : "Future topic"}
          </span>
          <span className="block text-[10px] text-slate-400 font-medium">
            {aviso ??
              (pt
                ? "Ainda sem reunião: fica em Temas Futuros até entrar numa reunião."
                : "No meeting yet: stays in Future topics until added to a meeting.")}
          </span>
        </span>
      </label>
      {value.ativo && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="temaFuturoMes" className={LABEL}>{pt ? "Data prevista (mês/ano)" : "Expected month"} *</label>
            <input
              id="temaFuturoMes"
              type="month"
              value={value.mes}
              onChange={(e) => onChange({ ...value, mes: e.target.value })}
              className={CAMPO}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="temaFuturoComite" className={LABEL}>{pt ? "Comitê previsto" : "Expected committee"} *</label>
            <select
              id="temaFuturoComite"
              value={value.comiteId}
              onChange={(e) => onChange({ ...value, comiteId: e.target.value })}
              className={`${CAMPO} cursor-pointer`}
            >
              <option value="">{pt ? "Selecione o comitê..." : "Select committee..."}</option>
              {orgaos.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
