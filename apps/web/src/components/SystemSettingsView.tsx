import React, { useState } from "react";
import { ChevronRight } from "lucide-react";
import IntegrationsPanel from "./IntegrationsPanel";
import DirectoryPanel from "./DirectoryPanel";

interface SystemSettingsViewProps {
  language: "en" | "pt";
}

export default function SystemSettingsView({ language }: SystemSettingsViewProps) {
  const [activeMenu, setActiveMenu] = useState("integrations");

  const t = {
    title: "Configurações do Sistema",
    subTitle: "Configure integrações da plataforma, residência de dados e segurança global.",
    menuIntegrations: "Integrações",
    menuDirectory: "Diretório de Usuários",
    menuStorage: "Armazenamento e Residência",
    menuSearch: "Indexação de Busca",
    menuLimits: "Limites da Plataforma",
    menuRetention: "Retenção de Auditoria"
  };

  return (
    <div className="space-y-6">
      <header className="pb-4 border-b border-slate-200/60">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">
          {t.title}
        </h2>
        <p className="text-slate-500 font-medium text-sm mt-1.5 matches-subheading-style">
          {t.subTitle}
        </p>
      </header>

      <div className="flex flex-col lg:flex-row gap-8 items-start">
        {/* Inner Settings side panel navigation bar */}
        <nav className="w-full lg:w-64 flex flex-col gap-1.5 shrink-0 select-none">
          <button
            onClick={() => setActiveMenu("integrations")}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              activeMenu === "integrations"
                ? "bg-[#d5e0f8] text-[#00658d] border-slate-200/50 shadow-xs"
                : "bg-white border-slate-200/50 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <span className="truncate">{t.menuIntegrations}</span>
            <ChevronRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => setActiveMenu("directory")}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              activeMenu === "directory"
                ? "bg-[#d5e0f8] text-[#00658d] border-slate-200/50 shadow-xs"
                : "bg-white border-slate-200/50 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <span className="truncate">{t.menuDirectory}</span>
            <ChevronRight className="w-4 h-4 opacity-50" />
          </button>

          <button
            onClick={() => {
              setActiveMenu("storage");
            }}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              activeMenu === "storage"
                ? "bg-[#d5e0f8] text-[#00658d] border-slate-200/50 shadow-xs"
                : "bg-white border-slate-200/80 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <span className="truncate">{t.menuStorage}</span>
            <ChevronRight className="w-4 h-4 opacity-50" />
          </button>

          <button
            onClick={() => {
              setActiveMenu("search");
            }}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              activeMenu === "search"
                ? "bg-[#d5e0f8] text-[#00658d] border-slate-200/50 shadow-xs"
                : "bg-white border-slate-200/80 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <span className="truncate">{t.menuSearch}</span>
            <ChevronRight className="w-4 h-4 opacity-50" />
          </button>

          <button
            onClick={() => {
              setActiveMenu("limits");
            }}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              activeMenu === "limits"
                ? "bg-[#d5e0f8] text-[#00658d] border-slate-200/50 shadow-xs"
                : "bg-white border-slate-200/80 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <span className="truncate">{t.menuLimits}</span>
            <ChevronRight className="w-4 h-4 opacity-50" />
          </button>

          <button
            onClick={() => {
              setActiveMenu("retention");
            }}
            className={`flex items-center justify-between px-4 py-3 rounded-xl border font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              activeMenu === "retention"
                ? "bg-[#d5e0f8] text-[#00658d] border-slate-200/50 shadow-xs"
                : "bg-white border-slate-200/80 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <span className="truncate">{t.menuRetention}</span>
            <ChevronRight className="w-4 h-4 opacity-50" />
          </button>
        </nav>

        {/* Settings Content main dynamic panels */}
        <div className="flex-1 w-full bg-white rounded-2xl border border-slate-200 p-6 md:p-8 card-shadow">
          {activeMenu === "integrations" ? (
            <IntegrationsPanel language={language} />
          ) : activeMenu === "directory" ? (
            <DirectoryPanel language={language} />
          ) : (
            /* Other mock configs sub menus */
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-[#0b1c30] uppercase tracking-wide">
                {activeMenu === "storage" ? t.menuStorage : activeMenu === "search" ? t.menuSearch : activeMenu === "limits" ? t.menuLimits : t.menuRetention}
              </h3>
              <p className="text-sm text-slate-500 leading-relaxed">
                {language === "en"
                  ? "Configure dynamic policies regarding encrypted cloud environments, regulatory compliance retention, data boundaries, and indexing schedules."
                  : "Defina as diretrizes dinâmicas e criptografadas referentes às políticas de governança, redundância geográfica de dados do portal e ciclos de backup."
                }
              </p>

              <div className="p-6 border border-slate-100 bg-slate-50 rounded-xl space-y-4 max-w-md">
                <div className="flex items-center justify-between text-xs font-bold text-slate-600 border-b border-slate-200/50 pb-2.5">
                  <span>{language === "en" ? "Feature Param" : "Parâmetro"}</span>
                  <span>{language === "en" ? "Config Status" : "Estado Atual"}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-800 font-bold">{language === "en" ? "Region" : "Região Principal"}</span>
                  <span className="text-slate-500 font-medium">{language === "en" ? "us-east1 (Primary Cloud)" : "us-east1 (Nuvem Principal)"}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-800 font-bold">{language === "en" ? "Retention Cap" : "Tempo de Retenção"}</span>
                  <span className="text-slate-500 font-medium">7 {language === "en" ? "Years" : "Anos"}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-800 font-bold">{language === "en" ? "Backups Clock" : "Frequência Backup"}</span>
                  <span className="text-slate-500 font-medium">{language === "en" ? "Daily (UTC 03:00)" : "Diário (UTC 03:00)"}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
