import React, { useEffect, useMemo, useState } from "react";
import { Info, MapPin, Pencil, Plus, Power, Search, X } from "lucide-react";
import {
  LOCAL_VAZIO,
  UFS,
  cidadeUf,
  createMeetingLocation,
  describeMeetingLocationError,
  linhaDaRua,
  listAdminMeetingLocations,
  paraPayload,
  setMeetingLocationActive,
  updateMeetingLocation,
  validateMeetingLocation,
  type MeetingLocation,
  type MeetingLocationPayload
} from "../lib/meeting-locations";

/**
 * Administração → Locais: endereços reutilizáveis para reunião PRESENCIAL.
 *
 * Sem exclusão: inativar tira o local da escolha de reuniões novas; reuniões
 * que já o usam guardam a própria cópia do endereço (nada muda nelas, nem ao
 * editar o cadastro). Endereço digitado: sem mapa, sem consulta de CEP.
 * A autorização é do servidor (Assessoria ou Admin); a tela só reflete.
 */

const LABEL = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const INPUT =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";

export default function LocationsPanel({ language }: { language: "en" | "pt" }) {
  const pt = language === "pt";
  const [locais, setLocais] = useState<MeetingLocation[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState("");
  const [status, setStatus] = useState<"todos" | "ativos" | "inativos">("todos");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState<MeetingLocationPayload | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);

  const carregar = async () => {
    try {
      setLocais(await listAdminMeetingLocations());
    } catch (e) {
      setErro(describeMeetingLocationError(e, language));
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const termo = busca.trim().toLowerCase();
  const visiveis = useMemo(
    () =>
      locais.filter((l) => {
        if (status === "ativos" && !l.isActive) return false;
        if (status === "inativos" && l.isActive) return false;
        if (!termo) return true;
        return [l.name, l.street, l.city, l.neighborhood].some((v) => (v ?? "").toLowerCase().includes(termo));
      }),
    [locais, status, termo]
  );

  const executar = async (acao: () => Promise<unknown>, sucesso: string) => {
    if (salvando) return false;
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await acao();
      setAviso(sucesso);
      await carregar();
      return true;
    } catch (e) {
      setErro(describeMeetingLocationError(e, language));
      return false;
    } finally {
      setSalvando(false);
    }
  };

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const problema = validateMeetingLocation(form, language);
    if (problema) {
      setErro(problema);
      return;
    }
    const ok = await executar(
      () => (editandoId ? updateMeetingLocation(editandoId, form) : createMeetingLocation(form)),
      editandoId
        ? pt ? "Local atualizado. Reuniões já agendadas mantêm o endereço da época." : "Location updated. Scheduled meetings keep their address."
        : pt ? "Local cadastrado." : "Location created."
    );
    if (ok) {
      setForm(null);
      setEditandoId(null);
    }
  };

  const campo = (id: keyof MeetingLocationPayload, rotulo: string, obrigatorio: boolean, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`loc-${id}`} className={LABEL}>{rotulo}{obrigatorio ? " *" : ""}</label>
      <input
        id={`loc-${id}`}
        required={obrigatorio}
        value={form?.[id] ?? ""}
        onChange={(e) => setForm((f) => (f ? { ...f, [id]: e.target.value } : f))}
        className={INPUT}
        {...extra}
      />
    </div>
  );

  return (
    <section className="space-y-4" aria-label={pt ? "Locais" : "Locations"}>
      <p className="flex gap-2 p-3 rounded-xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 font-medium">
        <Info className="w-4 h-4 shrink-0 mt-px text-[#00658d]" />
        {pt
          ? "Cadastre os locais usados nas reuniões presenciais. Só locais ativos aparecem no agendamento. Editar ou inativar um local não altera reuniões já agendadas: cada reunião guarda o endereço escolhido."
          : "Register the places used for in-person meetings. Only active locations appear when scheduling. Editing or deactivating a location does not change meetings already scheduled: each meeting keeps the address chosen."}
      </p>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div className="flex flex-col sm:flex-row gap-2 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} aria-label={pt ? "Buscar local" : "Search location"}
              placeholder={pt ? "Buscar local" : "Search location"} className={`${INPUT} pl-9`} />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label={pt ? "Status" : "Status"}
            className={`${INPUT} sm:w-40 cursor-pointer`}>
            <option value="todos">{pt ? "Todos" : "All"}</option>
            <option value="ativos">{pt ? "Ativos" : "Active"}</option>
            <option value="inativos">{pt ? "Inativos" : "Inactive"}</option>
          </select>
        </div>
        <button type="button" onClick={() => { setEditandoId(null); setForm({ ...LOCAL_VAZIO }); setErro(null); setAviso(null); }}
          className="px-4 py-2 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer">
          <Plus className="w-4 h-4" />{pt ? "Novo local" : "New location"}
        </button>
      </div>

      {erro && <p role="alert" className="text-[11px] font-semibold text-red-600">{erro}</p>}
      {aviso && <p className="text-[11px] font-semibold text-emerald-700">{aviso}</p>}

      {form && (
        <form onSubmit={salvar} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-extrabold text-slate-800 uppercase">
              {editandoId ? (pt ? "Editar local" : "Edit location") : pt ? "Novo local" : "New location"}
            </h4>
            <button type="button" onClick={() => { setForm(null); setEditandoId(null); }} aria-label={pt ? "Fechar" : "Close"} className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="md:col-span-2">{campo("name", pt ? "Nome do local" : "Location name", true, { maxLength: 120, placeholder: pt ? "Ex.: Sede Centro — Sala do Conselho" : "" })}</div>
            <div className="md:col-span-2">{campo("street", pt ? "Logradouro" : "Street", true, { maxLength: 200 })}</div>
            {campo("number", pt ? "Número" : "Number", true, { maxLength: 20 })}
            {campo("complement", pt ? "Complemento" : "Complement", false, { maxLength: 120 })}
            {campo("neighborhood", pt ? "Bairro" : "District", false, { maxLength: 120 })}
            {campo("postalCode", "CEP", true, { maxLength: 9, inputMode: "numeric", placeholder: "00000-000" })}
            <div className="md:col-span-2">{campo("city", pt ? "Cidade" : "City", true, { maxLength: 120 })}</div>
            <div className="flex flex-col gap-1">
              <label htmlFor="loc-state" className={LABEL}>{pt ? "Estado (UF)" : "State"} *</label>
              <select id="loc-state" required value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={`${INPUT} cursor-pointer`}>
                <option value="">{pt ? "Selecione" : "Select"}</option>
                {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
              </select>
            </div>
            <div className="md:col-span-2 xl:col-span-4 flex flex-col gap-1">
              <label htmlFor="loc-notes" className={LABEL}>{pt ? "Observação (interna)" : "Notes (internal)"}</label>
              <textarea id="loc-notes" rows={2} maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={INPUT} />
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
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-3 px-4">{pt ? "Nome" : "Name"}</th>
              <th className="py-3 px-2">{pt ? "Endereço" : "Address"}</th>
              <th className="py-3 px-2">{pt ? "Cidade/UF" : "City/State"}</th>
              <th className="py-3 px-2">Status</th>
              <th className="py-3 px-4 text-right">{pt ? "Ações" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {!carregando && visiveis.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-slate-400 font-semibold">
                {locais.length === 0 ? (pt ? "Nenhum local cadastrado." : "No locations yet.") : pt ? "Nenhum local encontrado." : "No location found."}
              </td></tr>
            )}
            {visiveis.map((l) => (
              <tr key={l.id} className={`border-t border-slate-100 ${l.isActive ? "" : "bg-slate-50/60"}`}>
                <td className="py-3 px-4 font-bold text-slate-800">
                  <span className="inline-flex items-start gap-1.5 break-words"><MapPin className="w-3.5 h-3.5 shrink-0 mt-px text-slate-400" />{l.name}</span>
                </td>
                <td className="py-3 px-2 text-slate-600">
                  {linhaDaRua(l) || <span className="text-amber-700 font-semibold">{pt ? "Endereço a completar" : "Address missing"}</span>}
                  {l.neighborhood && <span className="text-slate-400"> · {l.neighborhood}</span>}
                </td>
                <td className="py-3 px-2 text-slate-600">{cidadeUf(l) || "—"}</td>
                <td className="py-3 px-2">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${l.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                    {l.isActive ? (pt ? "Ativo" : "Active") : pt ? "Inativo" : "Inactive"}
                  </span>
                </td>
                <td className="py-3 px-4 text-right whitespace-nowrap">
                  <button type="button" title={pt ? "Editar" : "Edit"} aria-label={pt ? `Editar ${l.name}` : `Edit ${l.name}`}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"
                    onClick={() => { setEditandoId(l.id); setForm(paraPayload(l)); setErro(null); setAviso(null); }}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" disabled={salvando}
                    title={l.isActive ? (pt ? "Inativar" : "Deactivate") : pt ? "Ativar" : "Activate"}
                    aria-label={l.isActive ? (pt ? `Inativar ${l.name}` : `Deactivate ${l.name}`) : pt ? `Ativar ${l.name}` : `Activate ${l.name}`}
                    className={`p-1.5 rounded-lg cursor-pointer disabled:opacity-50 ${l.isActive ? "text-rose-500 hover:bg-rose-50" : "text-emerald-600 hover:bg-emerald-50"}`}
                    onClick={() => void executar(
                      () => setMeetingLocationActive(l.id, !l.isActive),
                      l.isActive
                        ? pt ? `${l.name} inativado. Reuniões que já o usam não mudam.` : `${l.name} deactivated. Meetings already using it are unchanged.`
                        : pt ? `${l.name} ativado.` : `${l.name} activated.`
                    )}>
                    <Power className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
