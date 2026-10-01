import React from "react";
import type { GovernanceBody } from "../types";

/**
 * Filtro "Órgão colegiado" — mesmo controle em Calendário, Pipeline e Agenda
 * Anual. Opções vêm dos órgãos cadastrados no PGCP; "Todos" = sem filtro.
 */
interface GovernanceBodyFilterProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  value: string;
  onChange: (governanceBodyId: string) => void;
  id?: string;
}

export default function GovernanceBodyFilter({
  language,
  governanceBodies,
  value,
  onChange,
  id = "filtro-orgao"
}: GovernanceBodyFilterProps) {
  const pt = language === "pt";
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label htmlFor={id} className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
        {pt ? "Órgão colegiado" : "Governance body"}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]"
      >
        <option value="">{pt ? "Todos" : "All"}</option>
        {governanceBodies.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </div>
  );
}
