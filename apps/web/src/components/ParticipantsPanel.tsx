import React, { useEffect, useMemo, useState } from "react";
import { Info, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { GovernanceBody } from "../types";
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

/**
 * Administração → Participantes — SOMENTE pessoas externas ao Microsoft Entra
 * ID, cadastradas no PGCP. Não lista, não busca e não edita o diretório
 * corporativo: a busca daqui filtra apenas os registros locais, sem Graph.
 * (A busca Entra + PGCP é a da seleção de participantes das reuniões.)
 * Cadastro não dá acesso ao PGCP.
 */

interface ParticipantsPanelProps {
  language: "en" | "pt";
  governanceBodies: GovernanceBody[];
}

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";
const VAZIO: ExternalParticipantPayload = { fullName: "", email: "", phone: "", governanceBodyId: null };

export default function ParticipantsPanel({ language, governanceBodies }: ParticipantsPanelProps) {
  const pt = language === "pt";
  const [locais, setLocais] = useState<ExternalParticipant[]>([]);
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [form, setForm] = useState<ExternalParticipantPayload | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregarLocais = async () => {
    try {
      setLocais(await listExternalParticipants());
    } catch (e) {
      setErro(describeExternalParticipantError(e, language));
    }
  };

  useEffect(() => {
    void carregarLocais();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Busca só nos cadastrados (já carregados): nenhuma chamada ao Graph aqui.
  const linhas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return termo
      ? locais.filter((p) => p.fullName.toLowerCase().includes(termo) || p.email.toLowerCase().includes(termo))
      : locais;
  }, [locais, busca]);

  const abrirNovo = () => {
    setEditandoId(null);
    setForm({ ...VAZIO });
    setErro(null);
    setAviso(null);
  };

  const abrirEdicao = (p: ExternalParticipant) => {
    setEditandoId(p.id);
    setForm({ fullName: p.fullName, email: p.email, phone: p.phone, governanceBodyId: p.governanceBody?.id ?? null });
    setErro(null);
    setAviso(null);
  };

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || salvando) return;
    const problema = validateExternalParticipant(form, language);
    if (problema) {
      setErro(problema);
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      if (editandoId) await updateExternalParticipant(editandoId, form);
      else await createExternalParticipant(form);
      setAviso(pt ? "Participante salvo." : "Participant saved.");
      setForm(null);
      setEditandoId(null);
      await carregarLocais();
    } catch (e2) {
      setErro(describeExternalParticipantError(e2, language));
    } finally {
      setSalvando(false);
    }
  };

  const remover = async (p: ExternalParticipant) => {
    if (!window.confirm(pt ? `Remover ${p.fullName}? Reuniões já convidadas não são alteradas.` : `Remove ${p.fullName}?`)) return;
    try {
      await deleteExternalParticipant(p.id);
      setAviso(pt ? "Participante removido." : "Participant removed.");
      await carregarLocais();
    } catch (e) {
      setErro(describeExternalParticipantError(e, language));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={pt ? "Buscar cadastrados" : "Search registered"}
            className={`${INPUT} pl-9`}
          />
        </div>
        <button type="button" onClick={abrirNovo}
          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer">
          <Plus className="w-4 h-4" />{pt ? "Novo participante" : "New participant"}
        </button>
      </div>

      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? "Cadastre pessoas que não pertencem ao diretório corporativo. Elas poderão receber convites e participar de reuniões, mas não terão acesso ao PGCP."
          : "Register people who are not in the corporate directory. They can be invited to and join meetings, but will not have access to PGCP."}
      </p>

      {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}
      {aviso && <p className="text-[11px] font-semibold text-emerald-700">{aviso}</p>}

      {form && (
        <form onSubmit={salvar} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-slate-800 uppercase">
              {editandoId ? (pt ? "Editar participante" : "Edit participant") : pt ? "Novo participante" : "New participant"}
            </h4>
            <button type="button" onClick={() => setForm(null)} aria-label={pt ? "Fechar" : "Close"} className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="epNome" className={LABEL}>{pt ? "Nome completo" : "Full name"} *</label>
              <input id="epNome" required maxLength={200} value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="epEmail" className={LABEL}>E-mail *</label>
              <input id="epEmail" type="email" required maxLength={254} value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="epTel" className={LABEL}>{pt ? "Telefone" : "Phone"} *</label>
              <input id="epTel" type="tel" required maxLength={30} value={form.phone} placeholder="+55 (11) 91234-5678"
                onChange={(e) => setForm({ ...form, phone: e.target.value })} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="epOrgao" className={LABEL}>{pt ? "Órgão colegiado" : "Governance body"}</label>
              <select id="epOrgao" value={form.governanceBodyId ?? ""}
                onChange={(e) => setForm({ ...form, governanceBodyId: e.target.value || null })} className={`${INPUT} cursor-pointer`}>
                <option value="">{pt ? "— Nenhum —" : "— None —"}</option>
                {governanceBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={salvando}
              className="px-4 py-2 bg-[#00658d] text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer">
              {salvando ? (pt ? "Salvando..." : "Saving...") : pt ? "Salvar" : "Save"}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-3 px-4">{pt ? "Nome" : "Name"}</th>
              <th className="py-3 px-2">E-mail</th>
              <th className="py-3 px-2">{pt ? "Telefone" : "Phone"}</th>
              <th className="py-3 px-2">{pt ? "Órgão colegiado" : "Body"}</th>
              <th className="py-3 px-4 text-right">{pt ? "Ações" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-400 font-semibold">
                  {pt ? "Nenhum participante externo cadastrado." : "No external participants registered."}
                </td>
              </tr>
            )}
            {linhas.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="py-3 px-4 font-bold text-slate-800">{p.fullName}</td>
                <td className="py-3 px-2 text-slate-600">{p.email}</td>
                <td className="py-3 px-2 text-slate-600">{p.phone}</td>
                <td className="py-3 px-2 text-slate-600">{p.governanceBody?.name ?? "—"}</td>
                <td className="py-3 px-4 text-right whitespace-nowrap">
                  <button type="button" onClick={() => abrirEdicao(p)} title={pt ? "Editar" : "Edit"}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"><Pencil className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => void remover(p)} title={pt ? "Remover" : "Remove"}
                    className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
