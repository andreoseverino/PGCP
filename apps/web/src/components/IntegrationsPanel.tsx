import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Lock, Plug, RefreshCw, Unplug } from "lucide-react";
import {
  describeIntegrationsError,
  fetchIntegrations,
  stateClasses,
  stateDotClasses,
  stateLabel,
  fetchAgendaValidationTemplate,
  saveAgendaValidationTemplate,
  testIntegration,
  type EmailTemplate,
  type IntegrationId,
  type IntegrationStatus
} from "../lib/integrations";

interface IntegrationsPanelProps {
  language: "en" | "pt";
}

/**
 * Sub-abas do painel. Cada uma resolve para uma ou mais integrações do
 * catálogo da API — "Microsoft Teams" cobre reunião online e mensagens, que são
 * integrações distintas com permissões distintas.
 */
/*
 * Uma aba por integração. Não há "Visão Geral": ela repetia, em resumo, o que
 * cada aba já diz por inteiro — e o resumo perdia justamente o que interessa
 * (variáveis, verificações, botão de testar).
 */
const SUB_TABS: Array<{ id: string; labelPt: string; labelEn: string; shows: IntegrationId[] }> = [
  { id: "entra", labelPt: "Login / Entra ID", labelEn: "Sign-in / Entra ID", shows: ["entra"] },
  { id: "graph", labelPt: "Microsoft Graph", labelEn: "Microsoft Graph", shows: ["graph"] },
  { id: "outlook", labelPt: "Outlook / Calendário", labelEn: "Outlook / Calendar", shows: ["outlook"] },
  { id: "teams", labelPt: "Microsoft Teams", labelEn: "Microsoft Teams", shows: ["teams-meeting", "teams-messages"] },
  { id: "mail", labelPt: "E-mail", labelEn: "E-mail", shows: ["mail"] },
  { id: "postgres", labelPt: "PostgreSQL", labelEn: "PostgreSQL", shows: ["postgres"] },
  { id: "docusign", labelPt: "DocuSign", labelEn: "DocuSign", shows: ["docusign"] },
  { id: "observability", labelPt: "Observabilidade", labelEn: "Observability", shows: ["observability"] }
];

function formatMoment(iso: string | null, language: "en" | "pt"): string {
  if (!iso) return language === "pt" ? "Nunca verificado" : "Never checked";
  return new Date(iso).toLocaleString(language === "pt" ? "pt-BR" : "en-US");
}

/**
 * Agrupa as variáveis preservando a ordem em que a API as declarou — a ordem do
 * catálogo é intencional (tenant, depois cada App Registration).
 */
function groupEnv(
  env: IntegrationStatus["env"]
): Array<[string | undefined, IntegrationStatus["env"]]> {
  const grupos: Array<[string | undefined, IntegrationStatus["env"]]> = [];

  for (const variable of env) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo[0] === variable.group) {
      ultimo[1].push(variable);
    } else {
      grupos.push([variable.group, [variable]]);
    }
  }

  return grupos;
}

/** Selo de estado. Reaproveita o formato de pílula já usado nas telas aprovadas. */
function StateBadge({ status, language }: { status: IntegrationStatus; language: "en" | "pt" }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border font-bold text-[10px] uppercase tracking-wider shrink-0 select-none ${stateClasses(
        status.state
      )}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${stateDotClasses(status.state)}`} />
      {stateLabel(status, language)}
    </span>
  );
}

/**
 * Uma variável de ambiente. Variável secreta mostra apenas se está configurada:
 * o valor nunca chega ao browser, nem mascarado.
 */
function EnvRow({ variable, language }: { variable: IntegrationStatus["env"][number]; language: "en" | "pt" }) {
  const pt = language === "pt";

  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 py-2.5 border-b border-slate-100 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-[11px] font-bold text-slate-800 font-mono">{variable.name}</code>
          {variable.secret && (
            <span className="inline-flex items-center gap-1 text-[8.5px] font-extrabold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              <Lock className="w-2.5 h-2.5" />
              {pt ? "Segredo" : "Secret"}
            </span>
          )}
          {!variable.required && (
            <span className="text-[8.5px] font-extrabold uppercase tracking-wider text-slate-400">
              {pt ? "Opcional" : "Optional"}
            </span>
          )}
          {variable.inheritedFrom && (
            <span className="text-[8.5px] font-extrabold uppercase tracking-wider text-[#00658d] bg-[#c6e7ff]/30 border border-[#00658d]/20 px-1.5 py-0.5 rounded">
              {pt ? "Herdado do Entra ID" : "Inherited from Entra ID"}
            </span>
          )}
        </div>
        <p className="text-[10px] text-slate-400 font-semibold mt-1 leading-relaxed">{variable.description}</p>
      </div>

      <div className="shrink-0 sm:text-right">
        {variable.secret ? (
          <span className="font-mono text-[11px] text-slate-400 tracking-widest">
            {variable.configured ? "••••••••••••" : "—"}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-slate-700 break-all">{variable.value ?? "—"}</span>
        )}
        <p
          className={`text-[9px] font-extrabold uppercase tracking-wider mt-0.5 ${
            variable.configured ? "text-emerald-600" : "text-slate-400"
          }`}
        >
          {variable.configured ? (pt ? "✓ Configurado" : "✓ Configured") : pt ? "Não configurado" : "Not configured"}
        </p>
      </div>
    </div>
  );
}

/** Card completo de uma integração, com parâmetros e teste de conexão. */
function IntegrationCard({
  status,
  language,
  onTest,
  testing
}: {
  status: IntegrationStatus;
  language: "en" | "pt";
  onTest: (id: IntegrationId) => void;
  testing: boolean;
}) {
  const pt = language === "pt";

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 md:p-6 card-shadow space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-4 border-b border-slate-100">
        <div className="min-w-0">
          <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wide flex items-center gap-2">
            <Plug className="w-4 h-4 text-[#00658d]" />
            {status.name}
          </h3>
          <p className="text-[11px] text-slate-400 font-semibold mt-1 leading-relaxed max-w-2xl">
            {status.description}
          </p>
        </div>
        <StateBadge status={status} language={language} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: pt ? "Ambiente" : "Environment", value: status.environment },
          { label: pt ? "Etapa" : "Stage", value: status.roadmapStage },
          {
            label: pt ? "Última verificação" : "Last checked",
            value: formatMoment(status.lastCheckedAt, language)
          },
          {
            label: pt ? "Parâmetros" : "Parameters",
            value: `${status.env.filter((v) => v.configured).length}/${status.env.length}`
          }
        ].map((cell) => (
          <div key={cell.label}>
            <p className="text-[8.5px] font-extrabold text-slate-400 uppercase tracking-widest">{cell.label}</p>
            <p className="text-[11px] font-bold text-slate-700 mt-0.5 break-words">{cell.value}</p>
          </div>
        ))}
      </div>

      {/* Mensagem factual da API. Nunca afirma sucesso não verificado. */}
      <div
        className={`flex gap-2.5 p-3 rounded-xl border text-[11px] font-semibold leading-relaxed ${
          status.state === "error"
            ? "bg-red-50 border-red-100 text-red-800"
            : status.state === "connected"
              ? "bg-emerald-50 border-emerald-100 text-emerald-900"
              : "bg-slate-50 border-slate-100 text-slate-600"
        }`}
      >
        {status.state === "error" ? (
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
        ) : status.state === "connected" ? (
          <CheckCircle className="w-4 h-4 shrink-0 mt-px" />
        ) : (
          <Unplug className="w-4 h-4 shrink-0 mt-px text-slate-400" />
        )}
        <span className="min-w-0">{status.message}</span>
      </div>

      {/* Níveis de verificação. Configurado ≠ alcançável ≠ funcionando. */}
      {status.checks && status.checks.length > 0 && (
        <div>
          <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-1.5">
            {pt ? "Etapas de verificação" : "Verification steps"}
          </p>
          <div className="space-y-1.5">
            {status.checks.map((check) => (
              <div key={check.label} className="flex items-start gap-2.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 mt-[5px] ${
                    check.state === "ok"
                      ? "bg-emerald-500"
                      : check.state === "failed"
                        ? "bg-red-500"
                        : "bg-slate-300"
                  }`}
                />
                <div className="min-w-0">
                  <p
                    className={`text-[11px] font-bold leading-tight ${
                      check.state === "ok"
                        ? "text-emerald-700"
                        : check.state === "failed"
                          ? "text-red-700"
                          : "text-slate-500"
                    }`}
                  >
                    {check.label}
                    {check.state === "pending" && (
                      <span className="ml-1.5 text-[9px] font-extrabold uppercase tracking-wider text-slate-400">
                        {pt ? "Não verificado" : "Not verified"}
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-slate-400 font-semibold leading-relaxed mt-0.5">
                    {check.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {status.env.length > 0 && (
        <div>
          <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-1">
            {pt ? "Parâmetros de configuração" : "Configuration parameters"}
          </p>
          {/*
            Agrupa por `group` quando a API informa. No Entra ID isso separa o
            App Registration do SPA do da API — dois registros distintos, e
            trocar um client id pelo outro faz todo token ser rejeitado.
          */}
          {groupEnv(status.env).map(([groupName, variables]) => (
            <div key={groupName ?? "_"} className="mt-2 first:mt-0">
              {groupName && (
                <p className="text-[9px] font-extrabold text-[#00658d] uppercase tracking-widest mb-1 px-0.5">
                  {groupName}
                </p>
              )}
              <div className="rounded-xl border border-slate-100 px-3.5">
                {variables.map((variable) => (
                  <EnvRow key={variable.name} variable={variable} language={language} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {status.pending && status.state !== "not_configured" && (
        <p className="text-[10px] text-slate-400 font-semibold leading-relaxed border-l-2 border-slate-200 pl-3">
          <strong className="text-slate-500 uppercase tracking-wider text-[9px]">
            {pt ? "Situação" : "Status"}:
          </strong>{" "}
          {status.pending}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        {!status.testable && (
          <span className="text-[10px] text-slate-400 font-semibold italic">
            {status.configured
              ? pt
                ? "Sem verificação disponível nesta etapa."
                : "No check available at this stage."
              : pt
                ? "Configure os parâmetros obrigatórios para habilitar o teste."
                : "Set the required parameters to enable the test."}
          </span>
        )}
        <button
          type="button"
          onClick={() => onTest(status.id)}
          disabled={!status.testable || testing}
          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white text-xs font-bold rounded-xl transition inline-flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-xs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${testing ? "animate-spin" : ""}`} />
          {testing ? (pt ? "Verificando..." : "Checking...") : pt ? "Testar conexão" : "Test connection"}
        </button>
      </div>
    </div>
  );
}

export default function IntegrationsPanel({ language }: IntegrationsPanelProps) {
  const pt = language === "pt";
  const [activeSubTab, setActiveSubTab] = useState(SUB_TABS[0].id);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<IntegrationId | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchIntegrations();
      setIntegrations(response.integrations);
    } catch (error) {
      // Estado honesto: a lista fica vazia porque a chamada falhou, e é a
      // falha que a tela precisa dizer.
      setIntegrations([]);
      setLoadError(describeIntegrationsError(error, language));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTest = async (id: IntegrationId) => {
    setTestingId(id);
    try {
      const updated = await testIntegration(id);
      setIntegrations((prev) => prev.map((item) => (item.id === id ? updated : item)));
      // Auditoria funcional registra o resultado REAL, não a tentativa.
    } catch (error) {
      setLoadError(describeIntegrationsError(error, language));
    } finally {
      setTestingId(null);
    }
  };

  const current = SUB_TABS.find((tab) => tab.id === activeSubTab) ?? SUB_TABS[0];
  const visible = integrations.filter((item) => current.shows.includes(item.id));

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <Plug className="w-5 h-5 text-[#00658d]" />
            {pt ? "Integrações" : "Integrations"}
          </h2>
          <p className="text-slate-500 font-medium text-xs mt-1 max-w-2xl">
            {pt
              ? "Toda integração externa do PGCP aparece aqui, configurada ou não. Segredos ficam apenas na API — o navegador só sabe se estão preenchidos."
              : "Every external integration appears here, configured or not. Secrets stay in the API — the browser only learns whether they are set."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="px-3.5 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold rounded-xl transition inline-flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {pt ? "Atualizar" : "Refresh"}
        </button>
      </div>

      {/* Sub-abas conceituais */}
      <nav className="flex flex-wrap gap-1.5 select-none">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveSubTab(tab.id)}
            className={`px-3 py-1.5 rounded-xl border text-[10.5px] font-extrabold uppercase tracking-wider transition cursor-pointer ${
              activeSubTab === tab.id
                ? "bg-[#d5e0f8] text-[#00658d] border-[#00658d]/20"
                : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {pt ? tab.labelPt : tab.labelEn}
          </button>
        ))}
      </nav>

      {loadError && (
        <div className="flex gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span>{loadError}</span>
        </div>
      )}

      {loading ? (
        <div className="py-16 flex items-center justify-center">
          <span className="w-6 h-6 border-2 border-slate-200 border-t-[#00658d] rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-5">
          {visible.length === 0 ? (
            /*
              Com falha na chamada, quem fala é a mensagem de erro acima. Dizer
              "não encontrada no catálogo" aqui confundiria ausência com recusa —
              era o mesmo defeito que a Visão Geral tinha.
            */
            loadError ? null : (
              <p className="text-xs text-slate-400 font-semibold italic py-8 text-center">
                {pt ? "Integração não encontrada no catálogo da API." : "Integration not found in the API catalog."}
              </p>
            )
          ) : (
            visible.map((item) => (
              <IntegrationCard
                key={item.id}
                status={item}
                language={language}
                onTest={(id) => void handleTest(id)}
                testing={testingId === item.id}
              />
            ))
          )}

          {/*
            O modelo de e-mail vive na sub-aba de E-mail porque é o texto que
            sai por ela. Restrito a `PGCP.Admin` pelo backend — a guarda está no
            router de /integrations, então esta tela já é inacessível a quem não
            pode.
          */}
          {activeSubTab === "mail" && <AgendaValidationTemplateCard language={language} />}
        </div>
      )}
    </div>
  );
}

/**
 * Modelo de e-mail da validação de pautas.
 *
 * Dois campos de texto, sem editor rico: um editor HTML traria sanitização,
 * colagem de estilo e um vetor novo, para um texto que o servidor envia como
 * TEXTO PURO de qualquer forma.
 */
function AgendaValidationTemplateCard({ language }: { language: "en" | "pt" }) {
  const pt = language === "pt";

  const [template, setTemplate] = useState<EmailTemplate | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);

  useEffect(() => {
    let ativo = true;
    fetchAgendaValidationTemplate()
      .then((carregado) => {
        if (!ativo) return;
        setTemplate(carregado);
        setSubject(carregado.subject);
        setBody(carregado.body);
      })
      .catch((falha) => {
        if (ativo) setErro(describeIntegrationsError(falha, language));
      })
      .finally(() => {
        if (ativo) setCarregando(false);
      });
    return () => {
      ativo = false;
    };
  }, [language]);

  const alterado = template !== null && (subject !== template.subject || body !== template.body);

  const salvar = async () => {
    if (salvando || !alterado) return;
    setErro(null);
    setSalvo(false);
    setSalvando(true);
    try {
      const atualizado = await saveAgendaValidationTemplate(subject, body);
      setTemplate(atualizado);
      setSubject(atualizado.subject);
      setBody(atualizado.body);
      setSalvo(true);
    } catch (falha) {
      // O servidor recusa assunto com quebra de linha, campo vazio e texto
      // acima do teto — a mensagem dele já é acionável.
      setErro(
        falha instanceof Error && falha.message
          ? falha.message
          : describeIntegrationsError(falha, language)
      );
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) {
    return (
      <div className="py-8 flex items-center justify-center">
        <span className="w-5 h-5 border-2 border-slate-200 border-t-[#00658d] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl card-shadow p-5 space-y-4">
      <div>
        <h3 className="text-xs font-extrabold text-slate-900 uppercase tracking-widest">
          {pt ? "Modelo de e-mail — Validação de pautas" : "E-mail template — Agenda validation"}
        </h3>
        <p className="text-[11px] text-slate-500 font-medium mt-1 leading-relaxed">
          {pt
            ? "Texto enviado a quem valida as pautas. Enviado como texto puro, com o PDF em anexo."
            : "Text sent to whoever validates the agenda. Sent as plain text, with the PDF attached."}
        </p>
      </div>

      {template && template.variables.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {template.variables.map((variavel) => (
            <code
              key={variavel}
              className="px-2 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold"
            >
              {`{{${variavel}}}`}
            </code>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <label
          htmlFor="modelo-assunto"
          className="block text-[11px] font-extrabold text-slate-700 uppercase tracking-wider"
        >
          {pt ? "Assunto" : "Subject"}
        </label>
        <input
          id="modelo-assunto"
          type="text"
          value={subject}
          maxLength={200}
          onChange={(evento) => {
            setSubject(evento.target.value);
            setSalvo(false);
          }}
          className="w-full px-3 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#00658d]/30 focus:border-[#00658d]"
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="modelo-corpo"
          className="block text-[11px] font-extrabold text-slate-700 uppercase tracking-wider"
        >
          {pt ? "Corpo" : "Body"}
        </label>
        <textarea
          id="modelo-corpo"
          rows={10}
          value={body}
          maxLength={20000}
          onChange={(evento) => {
            setBody(evento.target.value);
            setSalvo(false);
          }}
          className="w-full px-3 py-2 border border-slate-300 rounded-xl text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#00658d]/30 focus:border-[#00658d]"
        />
      </div>

      {erro && <p className="text-[11px] font-bold text-red-600">{erro}</p>}
      {salvo && !alterado && (
        <p className="text-[11px] font-bold text-emerald-600">
          {pt ? "Modelo salvo." : "Template saved."}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] text-slate-400 font-semibold">
          {template?.updatedAt &&
            `${pt ? "Atualizado em" : "Updated on"} ${formatMoment(template.updatedAt, language)}`}
        </p>
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando || !alterado}
          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white text-xs font-extrabold rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
        >
          {salvando ? (pt ? "Salvando..." : "Saving...") : pt ? "Salvar modelo" : "Save template"}
        </button>
      </div>
    </div>
  );
}
