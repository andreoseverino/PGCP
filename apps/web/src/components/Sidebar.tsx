import React from "react";
import { motion } from "motion/react";
import { CieloLogo } from "./CieloLogo";
import { SessionUser } from "../types";
import { getInitials } from "../lib/user";
import {
  LayoutDashboard,
  CalendarDays,
  Search,
  FileSpreadsheet,
  ShieldAlert,
  Settings,
  LogOut,
  Layers,
  Menu,
  X,
  ListTodo,
} from "lucide-react";

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  language: "en" | "pt";
  setLanguage: (lang: "en" | "pt") => void;
  /**
   * Usuário da sessão atual. A Sidebar apenas exibe o que recebe e não sabe
   * se a sessão veio do Modo de teste ou, futuramente, do Microsoft Entra ID.
   */
  currentUser: SessionUser;
  onLogout: () => void;
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
  currentUser,
  onLogout,
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
        {
          id: "meetings",
          labelEn: "Meetings",
          labelPt: "Reuniões",
          icon: CalendarDays,
          badge: null,
        },
        {
          id: "unlinked-agendas",
          labelEn: "Agendas",
          labelPt: "Pautas",
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
    {
      titleEn: "Tools",
      titlePt: "Ferramentas",
      items: [
        {
          id: "search",
          labelEn: "Search Portal",
          labelPt: "Busca Rápida",
          icon: Search,
          badge: null,
        },
      ],
    },
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
          <CieloLogo className="w-10 h-10 rounded-lg shrink-0 shadow-sm" />
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

      {/* Navigation Drawer (Desktop Sidebar / Mobile Drawer) */}
      <aside
        className={`fixed left-0 top-0 h-screen w-64 bg-[#f8fafc] border-r border-slate-200 z-50 p-5 flex flex-col justify-between transition-transform duration-300 md:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex flex-col flex-1">
          {/* Top Logo and Head */}
          <div className="pt-2 pb-5 px-1.5 border-b border-slate-200/60 mb-6 flex items-center gap-3.5 select-none">
            <CieloLogo className="w-12 h-12 rounded-lg shrink-0 shadow-sm" />
            <div className="leading-tight text-left min-w-0">
              <h1 className="font-extrabold text-[15px] tracking-tight text-slate-800 uppercase block">
                PGCP
              </h1>
              <span className="text-[8.5px] font-bold text-slate-400 uppercase tracking-wide block leading-snug mt-0.5">
                Plataforma de
                <br />
                Governança Corporativa
              </span>
            </div>
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

        {/* Footer info & toggle */}
        <div className="pt-4 border-t border-slate-200 mt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-full bg-[#94a4bd] text-[#0b1c30] flex items-center justify-center font-semibold text-xs shrink-0 select-none">
                {getInitials(currentUser.name)}
              </div>
              <div className="truncate leading-tight">
                <h4 className="text-xs font-semibold text-slate-800 truncate">
                  {currentUser.name}
                </h4>
                <span className="text-[10px] text-slate-500 block truncate">
                  {currentUser.role}
                </span>
              </div>
            </div>
            <button
              onClick={onLogout}
              className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
              title={language === "en" ? "Sign Out" : "Sair do Sistema"}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
