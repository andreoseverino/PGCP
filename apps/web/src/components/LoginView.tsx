import React, { useState } from "react";
import { motion } from "motion/react";
import { CieloLogo } from "./CieloLogo";
import { ShieldCheck, FlaskConical, AlertCircle, Loader2 } from "lucide-react";
import { TestProfile } from "../types";

interface LoginViewProps {
  language: "en" | "pt";
  onSignIn: () => void;
  testProfiles: TestProfile[];
  onTestSignIn: (profile: TestProfile) => void;
  /** Entra configurado: o botão Microsoft executa login real. */
  entraEnabled: boolean;
  /** Modo de teste liberado. Falso quando o Entra está ativo. */
  mockAllowed: boolean;
  /** Login em andamento. */
  isSigningIn: boolean;
  /** Mensagem humana da última falha, ou `null`. Nunca token nem stack. */
  authError: string | null;
}

/** Logotipo da Microsoft (quatro quadrados), nas cores oficiais da marca. */
function MicrosoftLogo({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 23 23"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

/**
 * Tela de acesso. Ocupa a viewport inteira e antecede toda a aplicação.
 *
 * Com o Entra configurado, o botão executa login Microsoft real (Authorization
 * Code + PKCE via MSAL) e o modo de teste desaparece. Sem configuração, o modo
 * de teste libera a sessão local de desenvolvimento. Os dois caminhos nunca
 * aparecem juntos — não existe bypass permanente de autenticação.
 */
export default function LoginView({
  language,
  onSignIn,
  testProfiles,
  onTestSignIn,
  entraEnabled,
  mockAllowed,
  isSigningIn,
  authError,
}: LoginViewProps) {
  const [selectedProfileId, setSelectedProfileId] = useState("");

  const t = {
    eyebrow:
      language === "en"
        ? "Corporate Agenda Management Platform"
        : "Plataforma de Governança Corporativa",
    welcome: language === "en" ? "Welcome" : "Bem-vindo",
    lead:
      language === "en"
        ? "Access is restricted to corporate accounts. Sign in with your organization credentials to continue."
        : "O acesso é restrito a contas corporativas. Entre com sua conta da organização para continuar.",
    button:
      language === "en" ? "Sign in with Microsoft" : "Entrar com Microsoft",
    buttonBusy: language === "en" ? "Signing in..." : "Entrando...",
    secure:
      language === "en"
        ? "Secure corporate access"
        : "Acesso corporativo seguro",
    devNote:
      language === "en"
        ? "Development environment — Microsoft authentication not yet configured."
        : "Ambiente de desenvolvimento — autenticação Microsoft ainda não configurada.",
    entraNote:
      language === "en"
        ? "Corporate authentication via Microsoft Entra ID."
        : "Autenticação corporativa via Microsoft Entra ID.",
    testMode: language === "en" ? "Test mode" : "Modo de teste",
    testHint:
      language === "en"
        ? "Local development only. Choose a mocked profile to browse the application."
        : "Somente desenvolvimento local. Escolha um perfil mockado para navegar na aplicação.",
    testPlaceholder:
      language === "en" ? "Select a profile..." : "Selecione um perfil...",
    testButton:
      language === "en" ? "Enter in test mode" : "Acessar em modo de teste",
    testEmpty:
      language === "en"
        ? "No mocked profile available."
        : "Nenhum perfil mockado disponível.",
  };

  const selectedProfile = testProfiles.find((p) => p.id === selectedProfileId);

  const handleTestSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (selectedProfile) onTestSignIn(selectedProfile);
  };

  return (
    <div className="min-h-screen w-full bg-[#f7f9fb] flex items-center justify-center p-5 relative overflow-hidden font-sans antialiased">
      {/* Atmosfera: brilho difuso nas cores da marca, sem competir com o card */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -right-32 w-[36rem] h-[36rem] rounded-full bg-[#00aeef]/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-48 -left-40 w-[32rem] h-[32rem] rounded-full bg-[#00658d]/10 blur-3xl"
      />

      <motion.main
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-sm"
      >
        <div className="bg-white border border-slate-200 rounded-2xl shadow-xl shadow-slate-900/5 overflow-hidden">
          {/* Faixa superior nas cores da marca */}
          <div className="h-1 bg-gradient-to-r from-[#00658d] via-[#00aeef] to-[#00658d]" />

          <div className="px-7 py-9 sm:px-9 sm:py-10">
            <div className="flex flex-col items-center text-center">
              <CieloLogo className="w-14 h-14 shadow-sm" />

              <p className="mt-5 text-[10px] font-bold text-[#00658d] uppercase tracking-[0.14em] leading-relaxed max-w-[17rem]">
                {t.eyebrow}
              </p>

              <h1 className="mt-2.5 text-2xl font-extrabold text-[#001e2d] tracking-tight">
                {t.welcome}
              </h1>

              <p className="mt-3 text-xs leading-relaxed text-slate-500 font-medium max-w-[19rem]">
                {t.lead}
              </p>
            </div>

            <button
              type="button"
              onClick={onSignIn}
              disabled={isSigningIn || !entraEnabled}
              className="mt-8 w-full py-3.5 rounded-xl bg-[#00658d] hover:bg-[#00aeef] active:scale-[0.985] text-white transition-all font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-3 cursor-pointer shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00aeef] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#00658d]"
            >
              <span className="w-6 h-6 rounded-md bg-white flex items-center justify-center shrink-0">
                {isSigningIn ? (
                  <Loader2 className="w-3.5 h-3.5 text-[#00658d] animate-spin" />
                ) : (
                  <MicrosoftLogo className="w-3.5 h-3.5" />
                )}
              </span>
              {isSigningIn ? t.buttonBusy : t.button}
            </button>

            {/* Mensagem humana. Sem token, sem stack, sem metadata do tenant. */}
            {authError && (
              <div
                role="alert"
                className="mt-4 flex gap-2.5 p-3 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold leading-relaxed text-left"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <span className="min-w-0">{authError}</span>
              </div>
            )}

            <div className="mt-7 pt-5 border-t border-slate-100 flex items-center justify-center gap-2 text-slate-400">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span className="text-[10.5px] font-bold uppercase tracking-wider">
                {t.secure}
              </span>
            </div>
          </div>

          {/* MODO DE TESTE — área discreta, separada do acesso corporativo.
              Some por completo quando o Entra está configurado: manter um
              caminho alternativo ao lado do login real seria bypass. */}
          {mockAllowed && (
            <div className="border-t border-dashed border-slate-200 bg-slate-50/70 px-7 py-6 sm:px-9">
              <div className="flex items-center gap-2 text-slate-500">
                <FlaskConical className="w-3.5 h-3.5" />
                <span className="text-[10px] font-bold uppercase tracking-[0.12em]">
                  {t.testMode}
                </span>
              </div>

              <p className="mt-2 text-[11px] leading-relaxed text-slate-400 font-medium">
                {t.testHint}
              </p>

              {testProfiles.length === 0 ? (
                <p className="mt-4 text-[11px] text-slate-400 font-semibold italic">
                  {t.testEmpty}
                </p>
              ) : (
                <form onSubmit={handleTestSubmit} className="mt-4 space-y-3">
                  <select
                    value={selectedProfileId}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                    aria-label={t.testMode}
                    className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs font-semibold text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#00658d] transition-all"
                  >
                    <option value="">{t.testPlaceholder}</option>
                    {testProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} — {profile.role}
                      </option>
                    ))}
                  </select>

                  {selectedProfile && (
                    <p className="text-[10.5px] text-slate-400 font-medium truncate">
                      {selectedProfile.email}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={!selectedProfile}
                    className="w-full py-2.5 rounded-xl bg-white border border-slate-300 text-slate-600 hover:border-[#00658d] hover:text-[#00658d] active:scale-[0.985] transition-all font-bold text-[11px] uppercase tracking-wider cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-slate-300 disabled:hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00aeef] focus-visible:ring-offset-2"
                  >
                    {t.testButton}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-[10.5px] text-slate-400 font-semibold leading-relaxed px-4">
          {entraEnabled ? t.entraNote : t.devNote}
        </p>
      </motion.main>
    </div>
  );
}
