import React, { useEffect, useMemo, useState } from "react";
import { Info, Pencil, Plus, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import ConfirmRemovalDialog from "./ConfirmRemovalDialog";
import ParticipantPicker from "./ParticipantPicker";
import {
  createExternalParticipant,
  deleteExternalParticipant,
  describeExternalParticipantError,
  listExternalParticipants,
  updateExternalParticipant,
  validateExternalParticipant,
  type ExternalParticipant,
  type ExternalParticipantPayload
} from "../lib/external-participants";
import {
  addGovernanceBodyGroupMember,
  corpoDoParticipantePadrao,
  describeGroupError,
  filtrarPorNome,
  jaNoGrupo,
  listGovernanceBodyGroupMembers,
  listGovernanceBodyGroups,
  membroDoTema,
  removeGovernanceBodyGroupMember,
  avisoDeInclusaoNoGrupo,
  rotuloDaOrigem,
  rotuloDePessoas,
  type GrupoDeOrgao,
  type MembroDoGrupo
} from "../lib/participation-groups";
import { addAgendaTopicParticipant, getAgendaTopic, removeAgendaTopicParticipant } from "../lib/agenda-topics";
import type { ParticipanteSelecionado } from "../lib/participant-search";
import type { ConfirmacaoRemocao } from "../lib/participant-removal";

/**
 * Administração → Participantes, em dois blocos para quem não é técnico:
 *
 *   Pessoas externas          convidados de fora da Cielo: nome e e-mail
 *                             (telefone e empresa opcionais). Recebem
 *                             convites; não acessam o PGCP.
 *   Grupos de participação    quem normalmente participa de cada Órgão
 *                             colegiado (entra automaticamente nas reuniões
 *                             NOVAS do órgão) e os participantes padrão de cada
 *                             Tema da Biblioteca (entram quando o tema é
 *                             adicionado a uma reunião).
 *
 * Remover alguém de uma reunião não muda o grupo. Grupo não dá acesso ao PGCP.
 * Tela administrativa: NÃO é filtrada pelo órgão do contexto global.
 */

interface ParticipantsPanelProps {
  language: "en" | "pt";
  /** Temas da Biblioteca com a contagem de participantes padrão. */
  libraryTopics: Array<{ id: string; title: string; participantsCount?: number }>;
  /** Participantes padrão de um tema mudaram: a Biblioteca recarrega. */
  onLibraryChanged?: () => void;
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";
const VAZIO: ExternalParticipantPayload = { fullName: "", email: "", phone: "", company: "" };

const aba = (ativa: boolean) =>
  `px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
    ativa ? "bg-[#00658d] text-white shadow-sm" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
  }`;

export default function ParticipantsPanel({ language, libraryTopics, onLibraryChanged }: ParticipantsPanelProps) {
  const pt = language === "pt";
  const [bloco, setBloco] = useState<"externos" | "grupos">("externos");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={pt ? "Participantes" : "Participants"} className="flex flex-wrap gap-2">
        <button type="button" role="tab" aria-selected={bloco === "externos"} onClick={() => setBloco("externos")} className={aba(bloco === "externos")}>
          {pt ? "Pessoas externas" : "External people"}
        </button>
        <button type="button" role="tab" aria-selected={bloco === "grupos"} onClick={() => setBloco("grupos")} className={aba(bloco === "grupos")}>
          {pt ? "Grupos de participação" : "Participation groups"}
        </button>
      </div>
      {bloco === "externos" ? (
        <PessoasExternas language={language} />
      ) : (
        <GruposDeParticipacao language={language} libraryTopics={libraryTopics} onLibraryChanged={onLibraryChanged} />
      )}
    </div>
  );
}

// =============================================================================
// Pessoas externas
// =============================================================================

function PessoasExternas({ language }: { language: "en" | "pt" }) {
  const pt = language === "pt";
  const [pessoas, setPessoas] = useState<ExternalParticipant[]>([]);
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState<ExternalParticipantPayload | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [removendo, setRemovendo] = useState<ExternalParticipant | null>(null);

  const carregar = async () => {
    try {
      setPessoas(await listExternalParticipants());
    } catch (e) {
      setErro(describeExternalParticipantError(e, language));
    }
  };

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const termo = busca.trim().toLowerCase();
  const visiveis = useMemo(
    () => (termo ? pessoas.filter((p) => p.fullName.toLowerCase().includes(termo) || p.email.toLowerCase().includes(termo) || (p.company ?? "").toLowerCase().includes(termo)) : pessoas),
    [pessoas, termo]
  );

  const executar = async (acao: () => Promise<unknown>, sucesso: string) => {
    if (salvando) return false;
    setSalvando(true);
    setErro(null);
    try {
      await acao();
      setAviso(sucesso);
      await carregar();
      return true;
    } catch (e) {
      setErro(describeExternalParticipantError(e, language));
      return false;
    } finally {
      setSalvando(false);
    }
  };

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const problema = validateExternalParticipant(form, language);
    if (problema) {
      setErro(problema);
      return;
    }
    // Só o cadastro: os grupos da pessoa não são enviados nem alterados.
    const ok = await executar(
      () => (editandoId ? updateExternalParticipant(editandoId, form) : createExternalParticipant(form)),
      pt ? "Pessoa externa salva." : "External person saved."
    );
    if (ok) {
      setForm(null);
      setEditandoId(null);
    }
  };

  const confirmacao: ConfirmacaoRemocao | null = removendo
    ? {
        titulo: pt ? `Remover ${removendo.fullName}?` : `Remove ${removendo.fullName}?`,
        paragrafos: [
          pt
            ? "O cadastro sai do PGCP e dos grupos de participação. Reuniões que já convidaram a pessoa não são alteradas."
            : "The record leaves the PGCP and its participation groups. Meetings that already invited the person are not changed."
        ],
        temas: [],
        acao: pt ? "Remover pessoa" : "Remove person"
      }
    : null;

  return (
    <section className="space-y-4" aria-label={pt ? "Pessoas externas" : "External people"}>
      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? "Cadastre convidados externos à Cielo. Eles poderão receber convites e participar de reuniões, mas não terão acesso ao PGCP."
          : "Register guests from outside Cielo. They can receive invitations and attend meetings, but have no access to the PGCP."}
      </p>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} aria-label={pt ? "Buscar pessoa" : "Search person"}
            placeholder={pt ? "Buscar pessoa" : "Search person"} className={`${INPUT} pl-9`} />
        </div>
        <button type="button" onClick={() => { setEditandoId(null); setForm({ ...VAZIO }); setErro(null); setAviso(null); }}
          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer">
          <Plus className="w-4 h-4" />{pt ? "Nova pessoa externa" : "New external person"}
        </button>
      </div>

      {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}
      {aviso && <p className="text-[11px] font-semibold text-emerald-700">{aviso}</p>}

      {form && (
        <form onSubmit={salvar} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-slate-800 uppercase">
              {editandoId ? (pt ? "Editar pessoa externa" : "Edit external person") : pt ? "Nova pessoa externa" : "New external person"}
            </h4>
            <button type="button" onClick={() => setForm(null)} aria-label={pt ? "Fechar" : "Close"} className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="epNome" className={LABEL}>{pt ? "Nome completo" : "Full name"} *</label>
              <input id="epNome" required maxLength={200} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="epEmail" className={LABEL}>E-mail *</label>
              <input id="epEmail" type="email" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="epTel" className={LABEL}>{pt ? "Telefone (opcional)" : "Phone (optional)"}</label>
              <input id="epTel" type="tel" maxLength={30} value={form.phone} placeholder="+55 (11) 91234-5678" onChange={(e) => setForm({ ...form, phone: e.target.value })} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="epEmpresa" className={LABEL}>{pt ? "Empresa (opcional)" : "Company (optional)"}</label>
              <input id="epEmpresa" maxLength={200} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className={INPUT} />
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={salvando} className="px-4 py-2 bg-[#00658d] text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer">
              {salvando ? (pt ? "Salvando..." : "Saving...") : pt ? "Salvar" : "Save"}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-3 px-4">{pt ? "Nome" : "Name"}</th>
              <th className="py-3 px-2">E-mail</th>
              <th className="py-3 px-2">{pt ? "Empresa" : "Company"}</th>
              <th className="py-3 px-2">{pt ? "Telefone" : "Phone"}</th>
              <th className="py-3 px-4 text-right">{pt ? "Ações" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-slate-400 font-semibold">{pt ? "Nenhuma pessoa externa cadastrada." : "No external people."}</td></tr>
            )}
            {visiveis.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="py-3 px-4 font-bold text-slate-800">{p.fullName}</td>
                <td className="py-3 px-2 text-slate-600">{p.email}</td>
                <td className="py-3 px-2 text-slate-600">{p.company || "—"}</td>
                <td className="py-3 px-2 text-slate-600">{p.phone || "—"}</td>
                <td className="py-3 px-4 text-right whitespace-nowrap">
                  <button type="button" title={pt ? "Editar" : "Edit"} aria-label={pt ? `Editar ${p.fullName}` : `Edit ${p.fullName}`}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"
                    onClick={() => { setEditandoId(p.id); setForm({ fullName: p.fullName, email: p.email, phone: p.phone ?? "", company: p.company ?? "" }); setErro(null); setAviso(null); }}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title={pt ? "Remover" : "Remove"} aria-label={pt ? `Remover ${p.fullName}` : `Remove ${p.fullName}`}
                    className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg cursor-pointer" onClick={() => setRemovendo(p)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {removendo && confirmacao && (
        <ConfirmRemovalDialog
          language={language}
          confirmacao={confirmacao}
          busy={salvando}
          onCancel={() => setRemovendo(null)}
          onConfirm={() => {
            const alvo = removendo;
            void executar(() => deleteExternalParticipant(alvo.id), pt ? "Pessoa removida." : "Person removed.").then(() => setRemovendo(null));
          }}
        />
      )}
    </section>
  );
}

// =============================================================================
// Grupos de participação
// =============================================================================

type Tipo = "orgaos" | "temas";

function GruposDeParticipacao({
  language,
  libraryTopics,
  onLibraryChanged
}: {
  language: "en" | "pt";
  libraryTopics: ParticipantsPanelProps["libraryTopics"];
  onLibraryChanged?: () => void;
}) {
  const pt = language === "pt";
  const [tipo, setTipo] = useState<Tipo>("orgaos");
  const [orgaos, setOrgaos] = useState<GrupoDeOrgao[]>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [membros, setMembros] = useState<MembroDoGrupo[]>([]);
  const [busca, setBusca] = useState("");
  const [adicionando, setAdicionando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [removendo, setRemovendo] = useState<MembroDoGrupo | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregarOrgaos = async () => {
    try {
      setOrgaos(await listGovernanceBodyGroups());
    } catch (e) {
      setErro(describeGroupError(e, language));
    }
  };

  useEffect(() => {
    void carregarOrgaos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Membros do grupo selecionado (órgão: grupo; tema: participantes padrão da Biblioteca).
  useEffect(() => {
    setMembros([]);
    setAdicionando(false);
    if (!selecionado) return;
    const c = new AbortController();
    (tipo === "orgaos"
      ? listGovernanceBodyGroupMembers(selecionado, c.signal)
      : getAgendaTopic(selecionado, c.signal).then((t) => t.participants.map(membroDoTema))
    )
      .then(setMembros)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErro(describeGroupError(e, language));
      });
    return () => c.abort();
  }, [tipo, selecionado, language]);

  const lista = useMemo(
    () =>
      tipo === "orgaos"
        ? filtrarPorNome(orgaos, busca).map((o) => ({ id: o.id, nome: o.isActive ? o.name : `${o.name} ${pt ? "(inativo)" : "(inactive)"}`, total: o.members }))
        : filtrarPorNome(libraryTopics, busca)
            .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"))
            .map((t) => ({ id: t.id, nome: t.title, total: t.participantsCount ?? 0 })),
    [tipo, orgaos, libraryTopics, busca, pt]
  );
  const atual = lista.find((i) => i.id === selecionado) ?? null;

  const executar = async (acao: () => Promise<MembroDoGrupo[]>) => {
    if (ocupado || !selecionado) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      setMembros(await acao());
      if (tipo === "orgaos") await carregarOrgaos();
      else onLibraryChanged?.();
    } catch (e) {
      setErro(describeGroupError(e, language));
    } finally {
      setOcupado(false);
    }
  };

  const adicionar = (sel: ParticipanteSelecionado) => {
    const id = selecionado!;
    void executar(async () => {
      if (tipo === "temas") return (await addAgendaTopicParticipant(id, corpoDoParticipantePadrao(sel))).participants.map(membroDoTema);
      const r = await addGovernanceBodyGroupMember(id, sel);
      const nome = sel.origem === "entra" ? sel.user.displayName ?? "" : sel.participante.fullName;
      setAviso(avisoDeInclusaoNoGrupo(nome, language));
      return r.membros;
    });
  };

  const remover = (m: MembroDoGrupo) => {
    const id = selecionado!;
    void executar(async () =>
      tipo === "orgaos"
        ? removeGovernanceBodyGroupMember(id, m.id)
        : (await removeAgendaTopicParticipant(id, m.id)).participants.map(membroDoTema)
    ).then(() => setRemovendo(null));
  };

  const trocarTipo = (t: Tipo) => {
    setTipo(t);
    setSelecionado(null);
    setBusca("");
    setErro(null);
    setAviso(null);
  };

  const confirmacao: ConfirmacaoRemocao | null =
    removendo && atual
      ? {
          titulo: pt ? `Remover ${removendo.nome} do grupo?` : `Remove ${removendo.nome} from the group?`,
          paragrafos: [
            pt
              ? `${removendo.nome} deixa de entrar automaticamente ${tipo === "orgaos" ? `nas próximas reuniões de “${atual.nome}”` : `quando o tema “${atual.nome}” for adicionado a uma reunião`}.`
              : `${removendo.nome} will no longer be added automatically ${tipo === "orgaos" ? `to future meetings of “${atual.nome}”` : `when “${atual.nome}” is added to a meeting`}.`,
            pt ? "Reuniões já criadas não mudam." : "Existing meetings do not change."
          ],
          temas: [],
          acao: pt ? "Remover do grupo" : "Remove from group"
        }
      : null;

  return (
    <section className="space-y-4" aria-label={pt ? "Grupos de participação" : "Participation groups"}>
      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Users className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? "Defina quem normalmente participa de cada Órgão colegiado e de cada Tema. Quem entra no grupo do órgão é incluído nas reuniões ainda não realizadas e nas novas; os participantes padrão do tema entram quando o tema é adicionado a uma reunião. Remover alguém de uma reunião específica não tira a pessoa do grupo."
          : "Define who usually attends each governance body and each topic. Body group members are added to meetings not yet held and to new ones; default topic participants join when the topic is added to a meeting. Removing someone from one meeting keeps them in the group."}
      </p>

      <div role="tablist" aria-label={pt ? "Tipo de grupo" : "Group type"} className="flex gap-1 border-b border-slate-200">
        {(["orgaos", "temas"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tipo === t} onClick={() => trocarTipo(t)}
            className={`px-4 py-2 text-xs font-bold border-b-2 -mb-px cursor-pointer ${tipo === t ? "border-[#00658d] text-[#00658d]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {t === "orgaos" ? (pt ? "Órgãos colegiados" : "Governance bodies") : pt ? "Temas" : "Topics"}
          </button>
        ))}
      </div>

      {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}
      {aviso && <p role="status" className="text-[11px] font-semibold text-emerald-700">{aviso}</p>}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)] gap-4">
        {/* Lista (master) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-2 space-y-2 h-fit">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} className={`${INPUT} pl-9`}
              aria-label={tipo === "orgaos" ? (pt ? "Buscar órgão colegiado" : "Search body") : pt ? "Buscar tema" : "Search topic"}
              placeholder={tipo === "orgaos" ? (pt ? "Buscar órgão colegiado" : "Search body") : pt ? "Buscar tema" : "Search topic"} />
          </div>
          <ul className="space-y-0.5 max-h-[60vh] overflow-y-auto">
            {lista.length === 0 && (
              <li className="text-[11px] text-slate-400 font-semibold text-center py-4">
                {tipo === "orgaos" ? (pt ? "Nenhum órgão colegiado." : "No governance bodies.") : pt ? "Nenhum tema na Biblioteca." : "No topics in the Library."}
              </li>
            )}
            {lista.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => { setSelecionado(i.id); setErro(null); }} aria-current={selecionado === i.id}
                  className={`w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs cursor-pointer transition ${
                    selecionado === i.id ? "bg-[#00658d]/10 text-[#00658d] font-bold" : "text-slate-700 hover:bg-slate-50 font-semibold"
                  }`}>
                  <span className="truncate">{i.nome}</span>
                  <span className="text-[10px] text-slate-400 font-bold shrink-0">{rotuloDePessoas(i.total, language)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Detalhe */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3 min-w-0">
          {!atual ? (
            <p className="text-[11px] text-slate-400 font-semibold text-center py-8">
              {tipo === "orgaos"
                ? pt ? "Selecione um órgão colegiado para ver quem faz parte do grupo." : "Select a governance body."
                : pt ? "Selecione um tema para ver os participantes padrão." : "Select a topic."}
            </p>
          ) : (
            <>
              <div>
                <h4 className="text-sm font-extrabold text-slate-800">{atual.nome}</h4>
                <p className="text-[11px] text-slate-500 font-semibold">
                  {tipo === "orgaos" ? (pt ? "Participantes do grupo" : "Group participants") : pt ? "Participantes padrão do Tema" : "Default topic participants"}
                  {" · "}
                  {tipo === "orgaos"
                    ? pt ? "entram automaticamente nas reuniões ainda não realizadas e nas novas deste órgão" : "added to this body's meetings not yet held and new ones"
                    : pt ? "entram quando o tema é adicionado a uma reunião" : "added when the topic is added to a meeting"}
                </p>
              </div>

              <ul className="divide-y divide-slate-100 border border-slate-100 rounded-xl">
                {membros.length === 0 && (
                  <li className="text-[11px] text-slate-400 font-semibold text-center py-4">{pt ? "Ninguém neste grupo ainda." : "No one in this group yet."}</li>
                )}
                {membros.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-800 truncate">{m.nome}</p>
                      {m.email && <p className="text-[10px] text-slate-400 font-semibold truncate">{m.email}</p>}
                    </div>
                    <span className={`text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${
                      m.origem === "cielo" ? "bg-sky-50 text-[#00658d] border-sky-100" : "bg-amber-50 text-amber-700 border-amber-100"
                    }`}>
                      {rotuloDaOrigem(m.origem, language)}
                    </span>
                    <button type="button" disabled={ocupado} onClick={() => setRemovendo(m)}
                      className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer disabled:opacity-40"
                      aria-label={pt ? `Remover ${m.nome} do grupo` : `Remove ${m.nome} from group`}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>

              {adicionando ? (
                <div className="space-y-1.5">
                  <ParticipantPicker
                    language={language}
                    disabled={ocupado}
                    jaEscolhidos={jaNoGrupo(membros)}
                    placeholder={pt ? "Buscar pessoa da Cielo ou externa..." : "Search Cielo or external person..."}
                    onSelect={adicionar}
                  />
                  <button type="button" onClick={() => setAdicionando(false)} className="text-[11px] font-bold text-slate-500 hover:text-slate-700 cursor-pointer">
                    {pt ? "Concluir" : "Done"}
                  </button>
                </div>
              ) : (
                <button type="button" disabled={ocupado} onClick={() => setAdicionando(true)}
                  className="px-3 py-2 border border-[#00658d]/30 text-[#00658d] hover:bg-sky-50 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40">
                  <UserPlus className="w-4 h-4" />{pt ? "Adicionar participantes" : "Add participants"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {removendo && confirmacao && (
        <ConfirmRemovalDialog language={language} confirmacao={confirmacao} busy={ocupado} onCancel={() => setRemovendo(null)} onConfirm={() => remover(removendo)} />
      )}
    </section>
  );
}
