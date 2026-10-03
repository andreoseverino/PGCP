import React from "react";
import type { GovernanceBody } from "../types";
import { opcoesDoContexto } from "../lib/governance-context";

/**
 * Seletor "Órgão colegiado" do CONTEXTO GLOBAL (cabeçalho e faixa mobile).
 * Opções vêm dos órgãos do PGCP: ativos primeiro, inativos marcados ao fim —
 * agendas/reuniões históricas continuam alcançáveis. Filtro, não autorização.
 */
interface GovernanceBodyFilterProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  value: string;
  onChange: (governanceBodyId: string) => void;
  id?: string;
  /** Versão de cabeçalho: rótulo visualmente oculto, controle compacto. */
  compact?: boolean;
}

export default function GovernanceBodyFilter({
  language,
  governanceBodies,
  value,
  onChange,
  id = "filtro-orgao",
  compact = false
}: GovernanceBodyFilterProps) {
  const pt = language === "pt";
  return (
    <div className={`flex ${compact ? "items-center gap-2" : "flex-col gap-1"} min-w-0`}>
      <label
        htmlFor={id}
        className={`text-[10px] font-bold text-slate-500 uppercase tracking-wide ${compact ? "whitespace-nowrap sr-only xl:not-sr-only" : ""}`}
      >
        {pt ? "Órgão colegiado" : "Governance body"}
      </label>
      <select
        id={id}
        title={pt ? "Órgão colegiado (contexto de navegação)" : "Governance body (navigation context)"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-white border border-slate-200 rounded-full px-3 py-1.5 text-xs font-semibold text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d] ${
          compact ? "max-w-[130px] lg:max-w-[200px] xl:max-w-[240px] truncate" : "rounded-xl py-2"
        }`}
      >
        <option value="">{pt ? "Todos os órgãos colegiados" : "All governance bodies"}</option>
        {opcoesDoContexto(governanceBodies).map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}{b.isActive ? "" : pt ? " (inativo)" : " (inactive)"}
          </option>
        ))}
      </select>
    </div>
  );
}
