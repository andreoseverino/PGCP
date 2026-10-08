import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Users, X } from "lucide-react";
import DirectoryUserPicker from "./DirectoryUserPicker";
import DurationHoursMinutesSelect from "./DurationHoursMinutesSelect";
import ParticipantPicker from "./ParticipantPicker";
import ComiteSelector from "./ComiteSelector";
import TemaFuturoFields from "./TemaFuturoFields";
import type { DirectoryUser } from "../lib/directory";
import { directoryEmail } from "../lib/directory";
import { formatMinutesAsTime } from "../lib/agenda-time";
import { problemaDoTemaFuturo, TEMA_FUTURO_VAZIO, type TaxonomyItem, type TemaFuturo } from "../lib/agenda-topic-adapters";
import type { CreateParticipantPayload } from "../lib/meeting-adapters";
import { nomeDoSelecionado, selecionadoParaPayload, type ParticipanteSelecionado } from "../lib/participant-search";
import type { ComiteVinculo } from "../lib/committee-link";

/**
 * CADASTRO COMPLETO DE TEMA da Agenda Anual ("+ Novo tema" e "Editar").
 *
 * Mesmos campos e componentes do formulário de Tema da Biblioteca — nome,
 * responsável (diretório Entra), tipo e natureza (taxonomias da
 * Administração), tema circular, duração (Horas/Minutos), descrição — e o
 * mesmo layout de modal: dados à esquerda, PARTICIPANTES DO TEMA à direita.
 *
 * Novo tema: o servidor cadastra o tema na Biblioteca (os participantes
 * viram os participantes padrão) e cria a instância nesta reunião, vinculada
 * a ele. Editar depois altera só a instância. Revalidado pelo mesmo parser do
 * Pipeline. Escolher tema existente é o `AnnualBibliotecaModal`.
 */

export interface DadosDoTemaCompleto {
  title: string;
  durationMinutes: number;
  responsibleLabel: string;
  responsibleEntraObjectId: string | null;
  agendaTopicTypeId: string | null;
  agendaTopicNatureId: string | null;
  isCircularTheme: boolean;
  /** Comitê (040): órgãos extras por onde o tema também deve passar. */
  comites: ComiteVinculo[];
  description: string | null;
  agendaId?: string;
  /** Só no "Novo tema": vinculados na mesma transação da criação. */
  participants: CreateParticipantPayload[];
  /**
   * Só no "Novo tema": TEMA FUTURO (042). Marcado = NÃO entra nesta reunião;
   * vai só para a Biblioteca (aba Temas Futuros) com mês/comitê previstos.
   */
  futuro?: TemaFuturo;
}

export interface TemaEmEdicao {
  title: string;
  durationMinutes: number | null;
  responsibleLabel: string | null;
  responsibleEntraObjectId: string | null;
  typeId: string | null;
  natureId: string | null;
  isCircularTheme: boolean;
  description: string | null;
  agendaId: string | null;
  participants: Array<{ id: string; name: string }>;
}

interface Props {
  language: "en" | "pt";
  modo: "novo" | "editar";
  ocupado: boolean;
  pautaTypes: TaxonomyItem[];
  pautaNatures: TaxonomyItem[];
  /** Pautas da reunião: o seletor só aparece com duas ou mais. */
  pautas: ReadonlyArray<{ id: string; title: string }>;
  /** Sugestões de participantes (órgão/tema). */
  orgao: { id: string; name: string };
  inicial?: TemaEmEdicao;
  onCancel: () => void;
  onSave: (dados: DadosDoTemaCompleto) => void;
  /** Edição: participantes do tema são vinculados/desvinculados na hora. */
  onLinkParticipant?: (payload: CreateParticipantPayload) => void;
  onUnlinkParticipant?: (participantId: string) => void;
}

const LABEL = "text-[9.5px] font-bold text-slate-400 uppercase tracking-wider";
const CAMPO =
  "w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-3 py-2 text-xs text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all duration-200";

/** Ativos + o valor atual (mesmo inativo), para não perder a ficha gravada. */
const opcoesDe = (lista: TaxonomyItem[], atual: string | null) => lista.filter((t) => t.isActive || t.id === atual);

export default function AnnualTemaModal({
  language,
  modo,
  ocupado,
  pautaTypes,
  pautaNatures,
  pautas,
  orgao,
  inicial,
  onCancel,
  onSave,
  onLinkParticipant,
  onUnlinkParticipant
}: Props) {
  const pt = language === "pt";
  const tipos = opcoesDe(pautaTypes, inicial?.typeId ?? null);
  const naturezas = opcoesDe(pautaNatures, inicial?.natureId ?? null);

  const [titulo, setTitulo] = useState(inicial?.title ?? "");
  const [responsavel, setResponsavel] = useState(inicial?.responsibleLabel ?? "");
  const [responsavelId, setResponsavelId] = useState<string | null>(inicial?.responsibleEntraObjectId ?? null);
  const [responsavelUser, setResponsavelUser] = useState<DirectoryUser | null>(null);
  const [tipoId, setTipoId] = useState(inicial?.typeId ?? tipos[0]?.id ?? "");
  const [naturezaId, setNaturezaId] = useState(inicial?.natureId ?? naturezas[0]?.id ?? "");
  const [circular, setCircular] = useState(inicial?.isCircularTheme ?? false);
  const [comites, setComites] = useState<ComiteVinculo[]>([]);
  const [minutos, setMinutos] = useState<number>(inicial?.durationMinutes ?? 30);
  const [descricao, setDescricao] = useState(inicial?.description ?? "");
  const [pautaId, setPautaId] = useState(inicial?.agendaId ?? pautas[0]?.id ?? "");
  // Novo tema: participantes escolhidos aqui e gravados junto com o tema.
  const [novos, setNovos] = useState<ParticipanteSelecionado[]>([]);
  const [futuro, setFuturo] = useState<TemaFuturo>(TEMA_FUTURO_VAZIO);
  const [erroFuturo, setErroFuturo] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ocupado) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ocupado, onCancel]);

  const valido = titulo.trim().length > 0 && responsavel.trim().length > 0 && minutos >= 1 && minutos <= 1440;

  const salvar = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valido) return;
    const problema = problemaDoTemaFuturo(futuro, language);
    setErroFuturo(problema);
    if (problema) return;
    onSave({
      title: titulo.trim(),
      durationMinutes: minutos,
      responsibleLabel: responsavel.trim(),
      responsibleEntraObjectId: responsavelId,
      agendaTopicTypeId: tipoId || null,
      agendaTopicNatureId: naturezaId || null,
      isCircularTheme: circular,
      comites: futuro.ativo ? [] : comites,
      description: descricao.trim() || null,
      ...(pautas.length > 1 && pautaId ? { agendaId: pautaId } : {}),
      participants: novos.map(selecionadoParaPayload),
      ...(modo === "novo" && futuro.ativo ? { futuro } : {})
    });
  };

  const listaParticipantes =
    modo === "editar"
      ? (inicial?.participants ?? []).map((p) => ({ chave: p.id, nome: p.name, remover: () => onUnlinkParticipant?.(p.id) }))
      : novos.map((s, i) => ({ chave: `${nomeDoSelecionado(s)}-${i}`, nome: nomeDoSelecionado(s), remover: () => setNovos((v) => v.filter((_, k) => k !== i)) }));

  return createPortal(
    <div className="fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="annual-tema-titulo"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in"
      >
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 shrink-0">
          <h3 id="annual-tema-titulo" className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
            <Pencil className="w-4 h-4 text-[#00658d]" />
            {modo === "editar" ? (pt ? "Editar tema" : "Edit topic") : pt ? "Novo tema" : "New topic"}
          </h3>
          <button type="button" onClick={onCancel} disabled={ocupado} className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer" aria-label={pt ? "Fechar" : "Close"}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          id="annual-tema-form"
          onSubmit={salvar}
          className="scroll-visivel flex-1 min-h-0 overflow-y-auto md:overflow-hidden md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,320px)] md:grid-rows-[minmax(0,1fr)] font-semibold text-xs text-slate-750"
        >
          <div className="scroll-visivel px-6 py-5 space-y-3.5 md:overflow-y-auto md:min-h-0">
            <div className="flex flex-col gap-1">
              <label htmlFor="annualTemaNome" className={LABEL}>{pt ? "Nome do tema" : "Topic name"} *</label>
              <input id="annualTemaNome" autoFocus required maxLength={300} value={titulo} onChange={(e) => setTitulo(e.target.value)} className={CAMPO}
                placeholder={pt ? "Ex.: Resultado Financeiro" : "e.g. Financial results"} />
            </div>

            <div className="flex flex-col gap-1">
              <label className={LABEL}>{pt ? "Responsável pelo tema (EntraID)" : "Responsible"} *</label>
              <DirectoryUserPicker
                language={language}
                selected={responsavelUser}
                selectedLabel={responsavel || null}
                placeholder={pt ? "Selecione o responsável..." : "Select responsible..."}
                onSelect={(user) => {
                  setResponsavel(user.displayName ?? directoryEmail(user) ?? "");
                  setResponsavelId(user.id);
                  setResponsavelUser(user);
                }}
                onClear={() => {
                  setResponsavel("");
                  setResponsavelId(null);
                  setResponsavelUser(null);
                }}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="annualTemaTipo" className={LABEL}>{pt ? "Tipo do tema" : "Topic type"}</label>
                <select id="annualTemaTipo" value={tipoId} onChange={(e) => setTipoId(e.target.value)} className={`${CAMPO} cursor-pointer`}>
                  {tipos.length === 0 && <option value="">{pt ? "Nenhum cadastrado" : "None"}</option>}
                  {tipos.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="annualTemaNatureza" className={LABEL}>{pt ? "Natureza do tema" : "Topic nature"}</label>
                <select id="annualTemaNatureza" value={naturezaId} onChange={(e) => setNaturezaId(e.target.value)} className={`${CAMPO} cursor-pointer`}>
                  {naturezas.length === 0 && <option value="">{pt ? "Nenhuma cadastrada" : "None"}</option>}
                  {naturezas.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="annualTemaCircular" className={LABEL}>{pt ? "Tema circular?" : "Recurring theme?"}</label>
                <select id="annualTemaCircular" value={circular ? "sim" : "nao"} onChange={(e) => setCircular(e.target.value === "sim")} className={`${CAMPO} cursor-pointer`}>
                  <option value="nao">{pt ? "Não" : "No"}</option>
                  <option value="sim">{pt ? "Sim" : "Yes"}</option>
                </select>
              </div>
            </div>

            {modo === "novo" && (
              <TemaFuturoFields
                language={language}
                value={futuro}
                onChange={setFuturo}
                aviso={
                  pt
                    ? "Não entra nesta reunião: vai só para a Biblioteca (Temas Futuros) até ser incluído numa reunião."
                    : "Not added to this meeting: goes to the Library (Future topics) until added to a meeting."
                }
              />
            )}

            {/* Comitê replica o tema em reuniões: não se aplica a tema futuro. */}
            {!futuro.ativo && (
              <ComiteSelector language={language} homeGovernanceBodyId={orgao.id} value={comites} onChange={setComites} />
            )}

            <div className="flex flex-col gap-1">
              <label className={LABEL}>{pt ? "Tempo estimado (duração)" : "Estimated duration"} *</label>
              <DurationHoursMinutesSelect
                language={language}
                value={formatMinutesAsTime(minutos)}
                onChangeMinutes={setMinutos}
                selectClassName="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] focus:bg-white outline-none cursor-pointer transition-all duration-200"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="annualTemaDescricao" className={LABEL}>{pt ? "Descrição / Objetivo de Debate" : "Executive summary"}</label>
              <textarea id="annualTemaDescricao" rows={3} maxLength={5000} value={descricao} onChange={(e) => setDescricao(e.target.value)}
                className={`${CAMPO} resize-none leading-relaxed`}
                placeholder={pt ? "Pontos fundamentais e materiais a serem lidos previamente." : "Strategic context and expected decisions..."} />
            </div>

            {pautas.length > 1 && (
              <div className="flex flex-col gap-1">
                <label htmlFor="annualTemaPauta" className={LABEL}>{pt ? "Pauta" : "Agenda"}</label>
                <select id="annualTemaPauta" value={pautaId} onChange={(e) => setPautaId(e.target.value)} className={`${CAMPO} cursor-pointer`}>
                  {pautas.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
            )}
            {erroFuturo && (
              <p role="alert" className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{erroFuturo}</p>
            )}
            <p className="text-[10px] text-slate-400 font-medium">
              {pt
                ? modo === "novo"
                  ? "O horário é calculado pela ordem dos temas, a partir do início da reunião. O tema também é cadastrado na Biblioteca, com estes participantes como padrão."
                  : "O horário é calculado pela ordem dos temas, a partir do início da reunião. A edição vale só para esta reunião (a Biblioteca não muda)."
                : modo === "novo"
                  ? "Times follow the topic order. The topic is also saved to the Library, with these participants as default."
                  : "Times follow the topic order. Changes apply only to this meeting (the Library does not change)."}
            </p>
          </div>

          {/* PARTICIPANTES DO TEMA — coluna direita (md+). */}
          <aside aria-labelledby="annual-tema-participantes" className="px-6 py-5 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/60 flex flex-col gap-3 md:overflow-y-auto md:min-h-0 scroll-visivel">
            <div>
              <h4 id="annual-tema-participantes" className="text-xs font-extrabold text-slate-800 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-[#00658d]" />{pt ? "Participantes do tema" : "Topic participants"}</span>
                <span className="text-[9px] text-[#00658d] font-extrabold bg-[#00658d]/5 px-2 py-0.5 rounded-full">{listaParticipantes.length}</span>
              </h4>
              <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                {pt ? "O responsável entra automaticamente. Vincular adiciona a pessoa à reunião, se preciso." : "The responsible person is added automatically."}
              </p>
            </div>
            <ParticipantPicker
              language={language}
              sugestao={{ governanceBodyId: orgao.id, rotuloOrgao: orgao.name }}
              placeholder={pt ? "Vincular participante ao tema..." : "Link participant..."}
              onSelect={(sel) => (modo === "editar" ? onLinkParticipant?.(selecionadoParaPayload(sel)) : setNovos((v) => [...v, sel]))}
            />
            <ul className="space-y-1">
              {listaParticipantes.length === 0 && (
                <li className="text-[10px] italic text-slate-400 p-2 text-center font-medium">{pt ? "Nenhum participante adicionado." : "No participants."}</li>
              )}
              {listaParticipantes.map((p) => (
                <li key={p.chave} className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-100 flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-800 text-[10.5px] truncate">{p.nome}</span>
                  <button type="button" disabled={ocupado} onClick={p.remover} className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 p-0.5 rounded-lg cursor-pointer" aria-label={pt ? `Remover ${p.nome}` : `Remove ${p.nome}`}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </form>

        <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0">
          <button type="button" onClick={onCancel} disabled={ocupado} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer">
            {pt ? "Cancelar" : "Cancel"}
          </button>
          <button type="submit" form="annual-tema-form" disabled={ocupado || !valido}
            className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer disabled:opacity-50">
            {modo === "editar" ? (pt ? "Salvar alterações" : "Save changes") : pt ? "Salvar tema" : "Save topic"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
