import React, { useState, useMemo } from "react";
import { Search, CalendarDays, FileText, ArrowRight, Sparkles } from "lucide-react";
import { Meeting } from "../types";

interface QuickSearchViewProps {
  language: "en" | "pt";
  meetings: Meeting[];
  onNavigateToMeeting: (meet: Meeting) => void;
  onNavigateToTab: (tab: string) => void;
}

export default function QuickSearchView({
  language,
  meetings,
  onNavigateToMeeting,
  onNavigateToTab
}: QuickSearchViewProps) {
  const [query, setQuery] = useState("");

  const t = {
    title: language === "en" ? "Global Search Index" : "Busca Global Governamental",
    subTitle: language === "en" 
      ? "Instantly scan through upcoming assemblies." 
      : "Pesquise instantaneamente nas reuniões.",
    placeholder: language === "en" ? "Type keywords to scan directory..." : "Digite termos para escanear a base de governança...",
    
    secMeetings: language === "en" ? "Meetings & Assemblies" : "Reuniões e Assembleias",
    
    noResults: language === "en" ? "No matches found for your query. Try 'Q3', 'Board', 'Ata', or 'Security'." : "Sem correspondências. Experimente termos como 'Q3', 'Diretoria', 'Ata', ou 'Filtro'."
  };

  const results = useMemo(() => {
    if (!query.trim()) return { meetings: [] };
    
    const lc = query.toLowerCase();

    // Scan Meetings & Agenda items
    const matchedMeetings = meetings.filter(m => 
      m.title.toLowerCase().includes(lc) || 
      m.location.toLowerCase().includes(lc) ||
      m.description.toLowerCase().includes(lc) ||
      m.organizer.toLowerCase().includes(lc) ||
      m.agenda?.some(a => a.title.toLowerCase().includes(lc) || a.author.toLowerCase().includes(lc))
    );

    /*
     * A busca por auditoria saiu na 4.12a: varria a trilha LOCAL do navegador,
     * que deixou de existir. A trilha real vive em `audit_logs` no PostgreSQL e
     * é paginada — carregar o histórico inteiro no App só para permitir busca
     * client-side seria trocar um problema por outro. Busca server-side de
     * auditoria é decisão de outra onda.
     */
    return {
      meetings: matchedMeetings
    };
  }, [query, meetings]);

  const hasResults = query.trim() !== "" && results.meetings.length > 0;

  return (
    <div className="space-y-6 select-none font-sans text-slate-700">
      <header className="pb-4 border-b border-slate-200/60">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">
          {t.title}
        </h2>
        <p className="text-slate-500 font-medium text-sm mt-1.5 matches-subheading-style">
          {t.subTitle}
        </p>
      </header>

      {/* Hero input bar */}
      <div className="relative max-w-3xl mx-auto py-4">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.placeholder}
          autoFocus
          className="w-full pl-12 pr-4 py-3.5 bg-white border-2 border-slate-200 rounded-2xl text-sm placeholder:text-slate-400 focus:outline-none focus:border-[#00658d] focus:ring-1 focus:ring-[#00658d] transition-all text-slate-800 font-medium card-shadow"
        />
      </div>

      {/* Results grid panel */}
      {query.trim() === "" ? (
        <div className="text-center py-16 text-slate-400 max-w-md mx-auto">
          <Search className="w-12 h-12 text-slate-350 mx-auto mb-4 stroke-1" />
          <p className="text-sm font-semibold">{t.placeholder}</p>
        </div>
      ) : !hasResults ? (
        <div className="text-center py-12 text-slate-400 max-w-sm mx-auto font-medium">
          <p className="text-sm">{t.noResults}</p>
        </div>
      ) : (
        <div className="space-y-8 max-w-4xl mx-auto">
          
          {/* Section: Meetings */}
          {results.meetings.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 border-b border-slate-100 pb-1.5">
                <CalendarDays className="w-4 h-4 text-[#00658d]" />
                {t.secMeetings} ({results.meetings.length})
              </h3>
              <div className="grid grid-cols-1 gap-3">
                {results.meetings.map(m => (
                  <div
                    key={m.id}
                    onClick={() => onNavigateToMeeting(m)}
                    className="p-4 bg-white hover:bg-[#d5e0f8]/10 border border-slate-100 rounded-xl flex items-center justify-between cursor-pointer group transition"
                  >
                    <div>
                      <h4 className="text-xs md:text-sm font-bold text-slate-950 group-hover:text-[#00658d]">
                        {m.title}
                      </h4>
                      <p className="text-[11px] text-slate-400 font-semibold mt-0.5">
                        {m.date} • {m.startTime} {m.timeZone}
                      </p>
                    </div>
                    <span className="text-[11px] text-[#00658d] font-bold group-hover:underline flex items-center gap-1">
                      {language === "en" ? "View Meeting" : "Ver Reunião"}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section: Logs */}


        </div>
      )}
    </div>
  );
}
