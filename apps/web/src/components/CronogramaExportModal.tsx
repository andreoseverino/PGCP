import React, { useEffect, useState } from "react";
import { CalendarRange, Download } from "lucide-react";
import { apiRequest } from "../lib/api";
import { describeMeetingError } from "../lib/meetings";
import { exportarCronograma } from "../lib/calendar-export";
import type { GovernanceBody } from "../types";
import ModalShell, { BOTAO_CANCELAR, BOTAO_PRINCIPAL } from "./ModalShell";

/**
 * Exportar o CRONOGRAMA ANUAL (PDF): grade órgão × mês com as datas das
 * reuniões do ano. Filtros: ano (começa no ano exibido) e comitê (começa no
 * órgão do contexto global). O servidor decide o conteúdo.
 */
export default function CronogramaExportModal({
  language,
  governanceBodyId,
  ano: anoInicial,
  onClose
}: {
  language: "en" | "pt";
  /** Órgão do contexto global ("" = todos): valor inicial do filtro. */
  governanceBodyId: string;
  /** Ano exibido no Calendário: valor inicial. */
  ano: number;
  onClose: () => void;
}) {
  const pt = language === "pt";
  const [ano, setAno] = useState(anoInicial);
  const [orgaoId, setOrgaoId] = useState(governanceBodyId);
  const [orgaos, setOrgaos] = useState<GovernanceBody[]>([]);
  const [exportando, setExportando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void apiRequest<GovernanceBody[]>("/governance-bodies", { auth: true })
      .then(setOrgaos)
      .catch(() => setOrgaos([]));
  }, []);

  const exportar = async () => {
    if (exportando) return;
    setExportando(true);
    setErro(null);
    try {
      await exportarCronograma(ano, orgaoId);
      onClose();
    } catch (error) {
      setErro(describeMeetingError(error, language));
    } finally {
      setExportando(false);
    }
  };

  const CAMPO =
    "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d]";
  const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
  const anos = Array.from({ length: 7 }, (_, i) => anoInicial - 3 + i);

  return (
    <ModalShell
      language={language}
      icone={CalendarRange}
      titulo={pt ? "Exportar cronograma" : "Export schedule"}
      subtitulo={pt ? "Visão anual em grade: comitês × meses, com as datas das reuniões (PDF)." : "Yearly grid: committees × months with meeting dates (PDF)."}
      ocupado={exportando}
      onClose={onClose}
      rodape={
        <>
          <button type="button" onClick={onClose} disabled={exportando} className={BOTAO_CANCELAR}>
            {pt ? "Cancelar" : "Cancel"}
          </button>
          <button type="button" onClick={() => void exportar()} disabled={exportando} className={BOTAO_PRINCIPAL}>
            <Download className="w-3.5 h-3.5" />
            {exportando ? (pt ? "Gerando..." : "Generating...") : pt ? "Exportar" : "Export"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cronogramaAno" className={LABEL}>{pt ? "Ano" : "Year"}</label>
            <select id="cronogramaAno" value={ano} onChange={(e) => setAno(Number(e.target.value))} className={CAMPO}>
              {anos.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cronogramaComite" className={LABEL}>{pt ? "Comitê" : "Committee"}</label>
            <select id="cronogramaComite" value={orgaoId} onChange={(e) => setOrgaoId(e.target.value)} className={CAMPO}>
              <option value="">{pt ? "Todos os comitês" : "All committees"}</option>
              {orgaos.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
        </div>
        {erro && (
          <p role="alert" className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{erro}</p>
        )}
      </div>
    </ModalShell>
  );
}
