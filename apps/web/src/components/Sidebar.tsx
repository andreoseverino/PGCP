import React from "react";
import { CieloLogo } from "./CieloLogo";
import {
  LayoutDashboard,
  CalendarDays,
  FileSpreadsheet,
  ShieldAlert,
  Settings,
  Layers,
  Menu,
  X,
  ListTodo,
  CalendarRange,
  Workflow,
} from "lucide-react";

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  language: "en" | "pt";
  setLanguage: (lang: "en" | "pt") => void;
  /**
   * A pessoa tem `PGCP.Admin`?
   *
   * Governa Auditoria e Configurações — administração TÉCNICA.
   */
  canAdminister?: boolean;
  /**
   * A pessoa pode abrir Administração? `PGCP.Assessoria` **ou** `PGCP.Admin`.
   *
   * A Assessoria entra para manter os cadastros funcionais; o conteúdo da tela
   * é que difere. Cortesia, não barreira: cada rota do servidor revalida, e
   * `App.tsx` também recusa renderizar a área.
   */
  canOpenAdministration?: boolean;
}

export default function Sidebar({
  activeTab,
  setActiveTab,
  language,
  setLanguage,
  canAdminister = false,
  canOpenAdministration = false,
}: SidebarProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  /**
   * Navegação agrupada. Os `id` são os mesmos de antes — agrupar é apenas
   * organização visual e não altera rotas, telas nem regras de acesso.
   */
  const menuGroups = [
    {
      titleEn: "Main",
      titlePt: "Principal",
      items: [
        {
          id: "dashboard",
          labelEn: "Overview",
          labelPt: "Visão Geral",
          icon: LayoutDashboard,
          badge: null,
        },
        /*
         * Fluxo principal (025): Calendário agenda, Agenda Anual planeja e
         * reserva, Pipeline prepara. "Reuniões" virou o modo Lista do
         * Pipeline — duas entradas para as mesmas reuniões seriam duplicidade.
         */
        {
          id: "calendar",
          labelEn: "Calendar",
          labelPt: "Calendário",
          icon: CalendarDays,
          badge: null,
        },
        {
          id: "annual-agenda",
          labelEn: "Annual plan",
          labelPt: "Agenda Anual",
          icon: CalendarRange,
          badge: null,
        },
        {
          id: "pipeline",
          labelEn: "Pipeline",
          labelPt: "Pipeline",
          icon: Workflow,
          badge: null,
        },
        {
          // Biblioteca de TEMAS reutilizáveis (`agenda_topics`). Reunião ->
          // Pauta -> Tema: o que a biblioteca guarda são temas.
          id: "unlinked-agendas",
          labelEn: "Topic library",
          labelPt: "Biblioteca de Temas",
          icon: ListTodo,
          badge: null,
        },
        {
          id: "fup",
          labelEn: "FUP",
          labelPt: "FUP",
          icon: ShieldAlert,
          badge: null,
        },
      ],
    },
    /*
     * "Busca Rápida" saiu do menu: a busca do topo (App.tsx) já leva direto
     * pra lá — manter os dois seria dois caminhos pro mesmo lugar. A aba
     * continua existindo e navegável (activeTab === "search"), só não tem
     * mais entrada própria aqui.
     */
    /*
     * Gestão — item a item, não bloco único: Administração abre para a
     * Assessoria; Auditoria e Configurações, só para a administração técnica.
     * Quem não pode nada aqui não vê nem o título do grupo.
     */
    ...(canOpenAdministration || canAdminister
      ? [
          {
            titleEn: "Management",
            titlePt: "Gestão",
            items: [
              ...(canOpenAdministration
                ? [
                    {
                      id: "administration",
                      labelEn: "Administration",
                      labelPt: "Administração",
                      icon: Layers,
                      badge: null,
                    },
                  ]
                : []),
              ...(canAdminister
                ? [
                    {
                      id: "audit-logs",
                      labelEn: "Audit",
                      labelPt: "Auditoria",
                      icon: FileSpreadsheet,
                      badge: null,
                    },
                    {
                      id: "settings",
                      labelEn: "System Settings",
                      labelPt: "Configurações",
                      icon: Settings,
                      badge: null,
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
  ];

  return (
    <>
      {/* Mobile Top Header Bar */}
      <div className="md:hidden fixed top-0 left-0 w-full z-50 flex justify-between items-center px-5 h-16 bg-white/90 backdrop-blur-md border-b border-slate-200">
        <div className="flex items-center gap-3">
          <CieloLogo variant="wordmark" className="h-7 w-auto shrink-0" />
          <div className="leading-tight text-left min-w-0">
            <span className="font-extrabold text-[14px] tracking-tight text-slate-800 uppercase block">
              PGCP
            </span>
            <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wide block truncate">
              Gestão de Pautas
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="text-slate-600 hover:text-[#00658d] p-1"
          >
            {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Backdrop for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Navigation Drawer (Desktop Sidebar / Mobile Drawer).
          Mobile: continua encostada na borda (comportamento de gaveta).
          Desktop: flutua com margem e cantos arredondados — só o md: muda. */}
      <aside
        className={`fixed left-0 top-0 bottom-0 w-64 bg-white border-r border-slate-200 z-50 p-5 flex flex-col justify-between transition-transform duration-300 md:translate-x-0 md:top-3 md:left-3 md:bottom-3 md:rounded-2xl md:border md:shadow-sm ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex flex-col flex-1">
          {/* Top Logo and Head */}
          <div className="pt-2 pb-5 px-1.5 border-b border-slate-200/60 mb-6 flex items-center justify-center select-none">
            <CieloLogo variant="wordmark" className="h-10 w-auto shrink-0" />
          </div>

          {/* Nav Items */}
          <nav className="flex-1 overflow-y-auto pr-1 space-y-6">
            {menuGroups.map((group) => (
              <div key={group.titlePt} className="space-y-1.5">
                <p className="px-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider select-none">
                  {language === "en" ? group.titleEn : group.titlePt}
                </p>

                {group.items.map((item) => {
                  const active = activeTab === item.id;
                  const IconComp = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setActiveTab(item.id);
                        setIsOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors group ${
                        active
                          ? "bg-[#00658d]/8 text-[#00658d] font-semibold"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <IconComp
                          className={`w-4 h-4 transition-colors ${
                            active
                              ? "text-[#00658d]"
                              : "text-slate-400 group-hover:text-[#00658d]"
                          }`}
                        />
                        <span className="truncate">
                          {language === "en" ? item.labelEn : item.labelPt}
                        </span>
                      </div>
                      {item.badge && (
                        <span className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-slate-200 text-slate-500 scale-90">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </div>
      </aside>
    </>
  );
}
