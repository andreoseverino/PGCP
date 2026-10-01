import React, { useEffect, useState } from "react";
import type { TaxonomyItem, TaxonomyKind } from "../lib/agenda-topics";
import {
  Layers,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  ShieldCheck,
  Calendar,
  Sparkles,
  Search,
  CheckCircle,
  HelpCircle,
  Check,
  AlertCircle,
  Loader2,
  Pencil
} from "lucide-react";
import { GovernanceBody, GovernanceBodyChairInput } from "../types";
import DirectoryUserPicker from "./DirectoryUserPicker";
import ParticipantsPanel from "./ParticipantsPanel";
import type { DirectoryUser } from "../lib/directory";

interface AdministrationViewProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
  governanceBodiesLoading: boolean;
  governanceBodiesError: string | null;
  onReloadGovernanceBodies: () => void;
  onCreateGovernanceBody: (name: string, chair: GovernanceBodyChairInput | null) => Promise<void>;
  onUpdateGovernanceBody: (
    id: string,
    name: string,
    chair: GovernanceBodyChairInput | null
  ) => Promise<void>;
  onSetGovernanceBodyActive: (id: string, isActive: boolean) => Promise<void>;
  /**
   * Cadastros reais de `agenda_topic_types` / `agenda_topic_natures`.
   * Identidade é o `id`; o nome é rótulo e pode ser corrigido sem quebrar
   * o vínculo das pautas que o usam.
   */
  pautaTypes: TaxonomyItem[];
  pautaNatures: TaxonomyItem[];
  onCreateTaxonomy: (kind: TaxonomyKind, name: string) => Promise<void>;
  onRenameTaxonomy: (kind: TaxonomyKind, id: string, name: string) => Promise<void>;
  /** Exclusão REAL. Cadastro em uso devolve 409 e nada sai da tela. */
  onDeleteTaxonomy: (kind: TaxonomyKind, id: string) => Promise<void>;
}

export default function AdministrationView({
  language,
  governanceBodies = [],
  governanceBodiesLoading,
  governanceBodiesError,
  onReloadGovernanceBodies,
  onCreateGovernanceBody,
  onUpdateGovernanceBody,
  onSetGovernanceBodyActive,
  pautaTypes = [],
  pautaNatures = [],
  onCreateTaxonomy,
  onRenameTaxonomy,
  onDeleteTaxonomy
}: AdministrationViewProps) {
  /*
   * Aba inicial depende de quem entrou: a Assessoria não tem a aba de usuários,
   * e abrir numa aba inexistente deixaria a tela vazia.
   */
  const [activeTab, setActiveTab] = useState<"organs" | "pautaTypes" | "pautaNatures" | "participants">("organs");

  // Simple list string items state
  const [newStringItem, setNewStringItem] = useState("");

  // Search queries
  const [searchQuery, setSearchQuery] = useState("");

  // Órgãos: estado da chamada de rede (só esta aba fala com a API)
  const [editingBodyId, setEditingBodyId] = useState<string | null>(null);
  /**
   * Presidente da Mesa em edição no formulário. Reconstruído como
   * `DirectoryUser` a partir do snapshot salvo (`chairEntraObjectId` +
   * `chairName`) — o resto do registro do diretório não foi persistido, e os
   * `null` dizem "desconhecido", que é a verdade. Mesmo padrão já usado para
   * reidratar responsável de pauta em `MeetingDetailView`.
   */
  const [newGovernanceBodyChair, setNewGovernanceBodyChair] = useState<DirectoryUser | null>(null);
  const [bodySubmitting, setBodySubmitting] = useState(false);
  const [bodyActionError, setBodyActionError] = useState<string | null>(null);
  const [togglingBodyId, setTogglingBodyId] = useState<string | null>(null);

  const t = {
    title: language === "en" ? "Administration Portal" : "Painel de Administração",
    subTitle: language === "en"
      ? "Review PGCP users, manage governance bodies and define agenda rules."
      : "Consulte os usuários do PGCP, administre os órgãos colegiados e defina as regras das pautas.",

    // Rótulos do cadastro manual de usuários foram removidos junto com o
    // formulário: usuário do PGCP nasce pelo JIT do login, não por digitação.
    btnRegister: language === "en" ? "Save" : "Salvar",

    lblActive: language === "en" ? "Active" : "Ativo",
    lblInactive: language === "en" ? "Inactive" : "Inativo",

    secTableTitle: language === "en" ? "Registered Items Database" : "Dados no Sistema",
    colStatus: "Status",
    colActions: language === "en" ? "Actions" : "Ações",

    plcSearch: language === "en" ? "Search items in view..." : "Filtrar ou buscar...",
  };

  // Órgãos passam pela API; os demais cadastros seguem em memória/localStorage.
  const handleSubmitGovernanceBody = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newStringItem.trim();
    if (!name || bodySubmitting) return;

    // Reenvia sempre o estado ATUAL do formulário — mesmo princípio de `name`
    // e `icon` aqui: nunca um PATCH parcial que dependa do que já existia.
    const chair = newGovernanceBodyChair
      ? { entraObjectId: newGovernanceBodyChair.id, displayName: newGovernanceBodyChair.displayName ?? "" }
      : null;

    setBodySubmitting(true);
    setBodyActionError(null);
    try {
      if (editingBodyId) {
        await onUpdateGovernanceBody(editingBodyId, name, chair);
      } else {
        await onCreateGovernanceBody(name, chair);
      }
      setNewStringItem("");
      setEditingBodyId(null);
      setNewGovernanceBodyChair(null);
    } catch (error) {
      setBodyActionError(error instanceof Error ? error.message : "Não foi possível salvar o órgão.");
    } finally {
      setBodySubmitting(false);
    }
  };

  const handleEditGovernanceBody = (body: GovernanceBody) => {
    setEditingBodyId(body.id);
    setNewStringItem(body.name);
    setNewGovernanceBodyChair(
      body.chairEntraObjectId
        ? {
            id: body.chairEntraObjectId,
            displayName: body.chairName,
            mail: null,
            userPrincipalName: null,
            jobTitle: null,
            userType: null,
            accountEnabled: null
          }
        : null
    );
    setBodyActionError(null);
  };

  /** Limpa o formulário compartilhado ao trocar de aba ou cancelar a edição. */
  const resetGovernanceBodyForm = () => {
    setEditingBodyId(null);
    setNewStringItem("");
    setNewGovernanceBodyChair(null);
    setBodyActionError(null);
  };

  const handleCancelEditGovernanceBody = resetGovernanceBodyForm;

  /**
   * Desativa ou reativa. Nunca exclui: o registro permanece no banco e
   * reuniões, pautas e ações já vinculadas seguem intactas.
   */
  const handleToggleGovernanceBodyActive = async (body: GovernanceBody) => {
    if (togglingBodyId) return;
    setTogglingBodyId(body.id);
    setBodyActionError(null);
    try {
      await onSetGovernanceBodyActive(body.id, !body.isActive);
      if (editingBodyId === body.id) resetGovernanceBodyForm();
    } catch (error) {
      setBodyActionError(
        error instanceof Error ? error.message : "Não foi possível alterar o estado do órgão."
      );
    } finally {
      setTogglingBodyId(null);
    }
  };

  const handleAddStringItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStringItem.trim()) return;

    if (activeTab === "pautaTypes") {
      // O servidor recusa nome repetido com 409: checar aqui também seria
      // uma segunda regra para o mesmo fato, e as duas divergiriam.
      void onCreateTaxonomy("types", newStringItem.trim());
    } else if (activeTab === "pautaNatures") {
      void onCreateTaxonomy("natures", newStringItem.trim());
    }

    setNewStringItem("");
  };

  const handleDeleteStringItem = (itemToDelete: string) => {
    if (activeTab === "pautaTypes") {
      // Nada some da tela por conta própria: cadastro em uso volta 409 e a
      // lista só muda depois que o banco confirmou.
      const alvo = pautaTypes.find((pt) => pt.name === itemToDelete);
      if (alvo) void onDeleteTaxonomy("types", alvo.id);
    } else if (activeTab === "pautaNatures") {
      const alvo = pautaNatures.find((pn) => pn.name === itemToDelete);
      if (alvo) void onDeleteTaxonomy("natures", alvo.id);
    }
  };

  // Filtro local sobre a lista já carregada — a base é pequena por natureza:
  // só quem foi provisionado no PGCP, não o diretório inteiro.
  const busca = searchQuery.trim().toLowerCase();
  const getSimpleItemsList = () => {
    // A tela lista NOMES; a identidade é resolvida na hora de mutar.
    if (activeTab === "pautaTypes") return pautaTypes.map((pt) => pt.name);
    if (activeTab === "pautaNatures") return pautaNatures.map((pn) => pn.name);
    return [];
  };

  const filteredSimpleItems = getSimpleItemsList().filter(item =>
    item.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredGovernanceBodies = governanceBodies.filter(body =>
    body.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Helper colors for avatars
  const getAvatarBg = (name: string) => {
    const code = name.charCodeAt(0) + (name.charCodeAt(1) || 0);
    const colors = ["bg-sky-100 text-sky-850", "bg-[#00aeef]/10 text-[#00658d]", "bg-indigo-50 text-indigo-700", "bg-emerald-50 text-emerald-800", "bg-amber-50 text-amber-800"];
    return colors[code % colors.length];
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  };

  return (
    <div className="space-y-8 animate-fade-in text-slate-705 text-xs text-slate-700 font-semibold leading-relaxed font-sans">
      
      {/* HEADER SECTION */}
      <header className="pb-4 border-b border-slate-200/60">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 select-none">
          {t.title}
        </h2>
        <p className="text-slate-500 font-medium text-sm mt-1.5">
          {t.subTitle}
        </p>
      </header>

      {/* TABS ROW COHESIVE WITH MODERN PANEL DESIGN */}
      <div className="flex border-b border-slate-200 gap-1.5 md:gap-4 overflow-x-auto pb-1 select-none">
        {/* Usuários do PGCP: administração TÉCNICA, só para quem a tem. */}
        <button
          onClick={() => { setActiveTab("organs"); setSearchQuery(""); resetGovernanceBodyForm(); }}
          className={`px-4 py-2.5 rounded-t-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
            activeTab === "organs"
              ? "bg-[#00658d]/5 text-[#00658d] border-b-2 border-b-[#00658d]"
              : "text-slate-450 hover:bg-slate-50 border-b-2 border-b-transparent"
          }`}
        >
          {language === "en" ? "Committees / Organs" : "Órgãos Colegiados (Orgão)"}
        </button>

        <button
          onClick={() => { setActiveTab("pautaTypes"); setSearchQuery(""); resetGovernanceBodyForm(); }}
          className={`px-4 py-2.5 rounded-t-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
            activeTab === "pautaTypes"
              ? "bg-[#00658d]/5 text-[#00658d] border-b-2 border-b-[#00658d]"
              : "text-slate-450 hover:bg-slate-50 border-b-2 border-b-transparent"
          }`}
        >
          {language === "en" ? "Pauta Types" : "Tipos de Pauta"}
        </button>

        <button
          onClick={() => { setActiveTab("pautaNatures"); setSearchQuery(""); resetGovernanceBodyForm(); }}
          className={`px-4 py-2.5 rounded-t-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
            activeTab === "pautaNatures"
              ? "bg-[#00658d]/5 text-[#00658d] border-b-2 border-b-[#00658d]"
              : "text-slate-450 hover:bg-slate-50 border-b-2 border-b-transparent"
          }`}
        >
          {language === "en" ? "Debate Natures" : "Naturezas de Pauta"}
        </button>

        {/* Participantes: Microsoft (leitura) + externos do PGCP (cadastro). */}
        <button
          onClick={() => { setActiveTab("participants"); setSearchQuery(""); resetGovernanceBodyForm(); }}
          className={`px-4 py-2.5 rounded-t-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
            activeTab === "participants"
              ? "bg-[#00658d]/5 text-[#00658d] border-b-2 border-b-[#00658d]"
              : "text-slate-450 hover:bg-slate-50 border-b-2 border-b-transparent"
          }`}
        >
          {language === "en" ? "Participants" : "Participantes"}
        </button>
      </div>

      {activeTab === "participants" ? (
        <ParticipantsPanel language={language} governanceBodies={governanceBodies.filter((b) => b.isActive)} />
      ) : (
      /* TWO-COLUMN GRID */
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* LEFT COLUMN: ACTIVE REGISTER FORM */}
        <section className="lg:col-span-1 bg-white border border-slate-200 rounded-2xl p-6 shadow-xs h-fit">
          <div className="flex items-center gap-2 mb-6 border-b border-slate-100 pb-3">
            <Plus className="w-5 h-5 text-[#00658d]" />
            <h3 className="font-bold text-sm uppercase text-slate-800">
              {activeTab === "organs" && (language === "en" ? "Add Organ" : "Cadastrar Órgão")}
              {activeTab === "pautaTypes" && (language === "en" ? "Add Pauta Type" : "Cadastrar Tipo")}
              {activeTab === "pautaNatures" && (language === "en" ? "Add Nature" : "Cadastrar Natureza")}
            </h3>
          </div>

            <form
              onSubmit={activeTab === "organs" ? handleSubmitGovernanceBody : handleAddStringItem}
              className="space-y-5 font-semibold text-xs"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="newStringItem" className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wide">
                  {activeTab === "organs" && (language === "en" ? "Organ Name" : "Nome do Órgão")}
                  {activeTab === "pautaTypes" && (language === "en" ? "Pauta Type" : "Tipo de Pauta")}
                  {activeTab === "pautaNatures" && (language === "en" ? "Nature of Debate" : "Natureza de Pauta")} *
                </label>
                <input
                  id="newStringItem"
                  type="text"
                  required
                  value={newStringItem}
                  onChange={(e) => setNewStringItem(e.target.value)}
                  placeholder={
                    activeTab === "organs"
                      ? "Ex: Comitê Executivo (COMEX)"
                      : activeTab === "pautaTypes"
                      ? "Ex: Pauta Regular"
                      : "Ex: Deliberativa"
                  }
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d] transition-all font-medium"
                />
              </div>

              {activeTab === "organs" && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wide">
                    {language === "en" ? "Chair" : "Presidente da Mesa"}
                  </label>
                  <DirectoryUserPicker
                    language={language}
                    selected={newGovernanceBodyChair}
                    onSelect={setNewGovernanceBodyChair}
                    onClear={() => setNewGovernanceBodyChair(null)}
                    placeholder={language === "en" ? "Search in directory..." : "Buscar no diretório..."}
                  />
                  <p className="text-[10px] text-slate-400 font-semibold normal-case tracking-normal">
                    {language === "en"
                      ? "Feeds the MESA section of this organ's meeting minutes."
                      : "Alimenta a seção MESA da Ata das reuniões deste órgão."}
                  </p>
                </div>
              )}

              {activeTab === "organs" && bodyActionError && (
                <p className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 leading-snug">
                  {bodyActionError}
                </p>
              )}

              <button
                type="submit"
                disabled={activeTab === "organs" && bodySubmitting}
                className="w-full py-3 rounded-xl bg-[#00658d] hover:bg-[#00aeef] text-white transition-all font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer shadow-xs mt-6 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-4 h-4" />
                {activeTab === "organs" && bodySubmitting
                  ? (language === "en" ? "Saving..." : "Salvando...")
                  : activeTab === "organs" && editingBodyId
                  ? (language === "en" ? "Save Changes" : "Salvar Alterações")
                  : t.btnRegister}
              </button>

              {activeTab === "organs" && editingBodyId && (
                <button
                  type="button"
                  onClick={handleCancelEditGovernanceBody}
                  className="w-full py-2 rounded-xl text-slate-500 hover:bg-slate-100 transition font-bold text-xs cursor-pointer"
                >
                  {language === "en" ? "Cancel" : "Cancelar edição"}
                </button>
              )}
            </form>
        </section>

        {/* RIGHT COLUMN: LIST ITEMS TABLE */}
        <section className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-6 md:p-8 card-shadow flex flex-col justify-between">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-2 border-b border-slate-100">
              <h3 className="font-bold text-base text-slate-950 flex items-center gap-2">
                <Layers className="w-5 h-5 text-[#00658d]" />
                {t.secTableTitle}
              </h3>

              {/* Search Toolbar */}
              <div className="relative min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.plcSearch}
                  className="w-full pl-9 pr-4 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d] transition-all font-medium text-slate-800"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              {activeTab === "organs" ? (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100/80 text-xs font-bold text-slate-400 uppercase tracking-wider py-2">
                      <th className="pb-3 px-2">{language === "en" ? "Organ Colegial" : "Órgão Colegiado"}</th>
                      <th className="pb-3 px-2 w-24 text-right">{t.colActions}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100/60 font-medium text-slate-700 text-xs">
                    {governanceBodiesLoading ? (
                      <tr>
                        <td colSpan={2} className="py-8 text-center text-slate-400 text-xs italic">
                          {language === "en" ? "Loading..." : "Carregando órgãos..."}
                        </td>
                      </tr>
                    ) : governanceBodiesError ? (
                      <tr>
                        <td colSpan={2} className="py-8 text-center">
                          <p className="text-xs font-bold text-rose-700 mb-3">{governanceBodiesError}</p>
                          <button
                            onClick={onReloadGovernanceBodies}
                            className="px-4 py-2 rounded-xl bg-[#00658d] hover:bg-[#00aeef] text-white text-[11px] font-bold uppercase tracking-wider cursor-pointer transition"
                          >
                            {language === "en" ? "Retry" : "Tentar novamente"}
                          </button>
                        </td>
                      </tr>
                    ) : filteredGovernanceBodies.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="py-8 text-center text-slate-400 text-xs italic">
                          Nenhum item configurado. Adicione um novo no formulário à esquerda.
                        </td>
                      </tr>
                    ) : (
                      filteredGovernanceBodies.map((body) => (
                        <tr key={body.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-4 px-2">
                            <div className="flex items-center gap-2.5">
                              <span className={`font-bold ${body.isActive ? "text-slate-800" : "text-slate-400 line-through"}`}>
                                {body.name}
                              </span>
                              <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] border uppercase select-none ${
                                body.isActive
                                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                  : "bg-slate-100 text-slate-500 border-slate-200"
                              }`}>
                                {body.isActive ? t.lblActive : t.lblInactive}
                              </span>
                            </div>
                            <p className="text-[10.5px] font-semibold text-slate-400 mt-0.5">
                              {body.chairName
                                ? `${language === "en" ? "Chair" : "Presidente"}: ${body.chairName}`
                                : (language === "en" ? "No chair registered" : "Sem presidente cadastrado")}
                            </p>
                          </td>
                          <td className="py-4 px-2 text-right whitespace-nowrap">
                            <button
                              onClick={() => handleEditGovernanceBody(body)}
                              className="p-1.5 text-slate-400 hover:text-[#00658d] hover:bg-sky-50 rounded-lg transition cursor-pointer"
                              title={language === "en" ? "Edit organ" : "Editar órgão"}
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleToggleGovernanceBodyActive(body)}
                              disabled={togglingBodyId === body.id}
                              className={`p-1.5 rounded-lg transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                                body.isActive
                                  ? "text-slate-400 hover:text-amber-700 hover:bg-amber-50"
                                  : "text-slate-400 hover:text-emerald-700 hover:bg-emerald-50"
                              }`}
                              title={
                                body.isActive
                                  ? (language === "en" ? "Deactivate organ" : "Desativar órgão")
                                  : (language === "en" ? "Reactivate organ" : "Reativar órgão")
                              }
                            >
                              {body.isActive ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100/80 text-xs font-bold text-slate-400 uppercase tracking-wider py-2">
                      <th className="pb-3 px-2">
                        {activeTab === "pautaTypes" && (language === "en" ? "Pauta Type" : "Tipo de Pauta")}
                        {activeTab === "pautaNatures" && (language === "en" ? "Nature of Debate" : "Natureza da Pauta")}
                      </th>
                      <th className="pb-3 px-2 w-20 text-right">{t.colActions}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100/60 font-medium text-slate-700 text-xs">
                    {filteredSimpleItems.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="py-8 text-center text-slate-400 text-xs italic">
                          Nenhum item configurado. Adicione um novo no formulário à esquerda.
                        </td>
                      </tr>
                    ) : (
                      filteredSimpleItems.map((item) => (
                        <tr key={item} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-4 px-2 font-bold text-slate-800">
                            {item}
                          </td>
                          <td className="py-4 px-2 text-right">
                            <button
                              onClick={() => handleDeleteStringItem(item)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition cursor-pointer"
                              title="Excluir item"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </section>

      </div>
      )}
    </div>
  );
}
