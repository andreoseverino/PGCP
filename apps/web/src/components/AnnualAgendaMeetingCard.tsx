import React, { useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  Unlink,
  UserRound,
  Users,
  X
} from "lucide-react";
import {
  addAnnualMeetingParticipant,
  createAnnualTema,
  deleteAnnualPauta,
  deleteAnnualTema,
  dissociateAnnualMeeting,
  linkAnnualTemaParticipant,
  removeAnnualMeetingParticipant,
  renameAnnualPauta,
  reorderAnnualTemas,
  unlinkAnnualTemaParticipant,
  updateAnnualTema,
  type AnnualAgendaDetail,
  type AnnualAgendaMeeting
} from "../lib/annual-agendas";
import {
  destinoSobre,
  fichaDaLinha,
  indiceNaPauta,
  ordemComDestino,
  linhaDoParticipante,
  pautasComTemas,
  resumoDosParticipantes
} from "../lib/annual-agenda-rules";
import { cronogramaDosTemas } from "../lib/agenda-schedule";
import {
  originLabel
} from "../lib/pipeline";
import {
  instantToLocal
} from "../lib/meeting-adapters";
import {
  selecionadoParaPayload
} from "../lib/participant-search";
import { confirmacaoRemoverDaReuniao, type ConfirmacaoRemocao } from "../lib/participant-removal";
import ConfirmRemovalDialog from "./ConfirmRemovalDialog";
import ParticipantPicker from "./ParticipantPicker";
import AnnualTemaModal, { type DadosDoTemaCompleto } from "./AnnualTemaModal";
import AnnualBibliotecaModal from "./AnnualBibliotecaModal";
import type { TaxonomyItem } from "../lib/agenda-topic-adapters";
import type { TemaDaBibliotecaResumo } from "../lib/annual-agenda-rules";

/**
 * Uma reunião da Agenda Anual, orientada a TEMAS ("+ Novo tema", "Adicionar da
 * Biblioteca"). O modelo segue Reunião -> Pauta -> Tema nas MESMAS entidades
 * que o Pipeline opera. Com permissão, a Agenda edita pautas e temas por rotas
 * próprias (pertença conferida no servidor); sem permissão, só leitura.
 *
 * Pauta: com uma só (o caso comum, inclusive a pauta padrão criada pelo
 * servidor no primeiro tema), ela fica oculta e os temas aparecem direto; com
 * duas ou mais, volta o agrupamento por pauta e o "Mover para...".
 *
 * Cronograma: horários calculados no servidor (mesma regra do Pipeline) pela
 * ordem global dos temas, a partir do início da reunião. Arrastar ordena os
 * temas DENTRO da pauta; trocar de pauta é "Mover para...".
 *
 * Arrastar (drag nativo, como no Pipeline): só a alça ⠿ inicia; a imagem do
 * arraste é a LINHA inteira; a linha de origem vira o espaço de destino e
 * anda conforme o ponteiro (os demais temas se reposicionam com animação
 * curta). Soltar persiste a mesma ordem mostrada na prévia.
 */

interface Props {
  language: "en" | "pt";
  agendaId: string;
  orgao: { id: string; name: string };
  meeting: AnnualAgendaMeeting;
  editable: boolean;
  ocupado: boolean;
  libraryTopics: TemaDaBibliotecaResumo[];
  /** Taxonomias da Administração (tipo/natureza do tema). */
  pautaTypes: TaxonomyItem[];
  pautaNatures: TaxonomyItem[];
  executar: (acao: () => Promise<AnnualAgendaDetail | void>, sucesso?: string) => Promise<void>;
  onOpenMeeting: (meetingId: string) => void;
}

type Tema = AnnualAgendaMeeting["items"][number];

const INPUT =
  "bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d] min-w-0";
const ICONE = "p-1 rounded-lg cursor-pointer disabled:opacity-40";

function quando(iso: string, fuso: string) {
  const l = instantToLocal(iso, fuso);
  return `${l.date.split("-").reverse().join("/")} ${l.time}`;
}

/** Duração das animações do arraste (abrir espaço, reposicionar, assentar). */
const ANIMACAO_MS = 180;

/**
 * Reposiciona as linhas com animação curta quando a ORDEM visível muda —
 * enquanto o espaço de destino anda e ao assentar. Sem dependência: mede
 * `offsetTop` (ignora transform) antes/depois e anima só `transform` (FLIP).
 * Mudança de altura sem troca de ordem (ex.: abrir participantes) não anima.
 */
function useReordenacaoAnimada(raiz: React.RefObject<HTMLElement | null>, ordem: string) {
  const posicoes = useRef(new Map<string, number>());
  const ordemAnterior = useRef(ordem);
  useLayoutEffect(() => {
    const el = raiz.current;
    if (!el) return;
    const animar =
      ordem !== ordemAnterior.current &&
      !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const atuais = new Map<string, number>();
    el.querySelectorAll<HTMLElement>("[data-tema-id]").forEach((li) => {
      const id = li.dataset.temaId!;
      const topo = li.offsetTop;
      atuais.set(id, topo);
      const antes = posicoes.current.get(id);
      if (!animar || antes === undefined || antes === topo) return;
      li.style.transition = "none";
      li.style.transform = `translateY(${antes - topo}px)`;
      void li.offsetWidth; // aplica a posição antiga antes de animar
      li.style.transition = `transform ${ANIMACAO_MS}ms ease-out`;
      li.style.transform = "";
      li.addEventListener("transitionend", () => (li.style.transition = ""), { once: true });
    });
    posicoes.current = atuais;
    ordemAnterior.current = ordem;
  });
}


export default function AnnualAgendaMeetingCard({
  language,
  agendaId,
  orgao,
  meeting,
  editable,
  ocupado,
  libraryTopics,
  pautaTypes,
  pautaNatures,
  executar,
  onOpenMeeting
}: Props) {
  const pt = language === "pt";
  const [aberta, setAberta] = useState(true);
  const [renomeando, setRenomeando] = useState<{ tipo: "pauta" | "tema"; id: string; titulo: string } | null>(null);
  /** Modal aberto: cadastro completo (novo/editar) ou seleção da Biblioteca. */
  const [modalTema, setModalTema] = useState<{ modo: "novo" | "biblioteca" | "editar"; tema?: Tema } | null>(null);
  const [pessoasAbertas, setPessoasAbertas] = useState<string | null>(null);
  /** "Todos os participantes da reunião": recolhido por padrão. */
  const [participantesAbertos, setParticipantesAbertos] = useState(false);
  const [gerenciandoParticipantes, setGerenciandoParticipantes] = useState(false);
  /** Tema sendo arrastado e o destino (índice na pauta, sem ele) da prévia. */
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [destino, setDestino] = useState<number | null>(null);
  /** Ordem já solta, mantida até o servidor responder (sem "voltar e ir"). */
  const [ordemPendente, setOrdemPendente] = useState<string[] | null>(null);
  const raiz = useRef<HTMLElement>(null);
  const [confirmacao, setConfirmacao] = useState<{ dados: ConfirmacaoRemocao; acao: () => Promise<AnnualAgendaDetail> } | null>(null);

  const inicio = instantToLocal(meeting.startAt, meeting.timezone);
  const fim = instantToLocal(meeting.endAt, meeting.timezone);
  const mes = new Intl.DateTimeFormat(pt ? "pt-BR" : "en-US", { month: "short", timeZone: meeting.timezone })
    .format(new Date(meeting.startAt))
    .replace(".", "")
    .toUpperCase();
  const { pautas, semPauta } = pautasComTemas(meeting);
  const tempo = meeting.tempo;
  const resumo = resumoDosParticipantes(meeting.participants);

  // Ordem VISÍVEL: a prévia do arraste (ou a já solta) sobre a ordem real.
  const emPrevia = ordemPendente ?? (arrastando && destino !== null ? ordemComDestino(meeting.items, arrastando, destino) : null);
  const ordemVisivel = emPrevia ?? meeting.items.map((t) => t.id);
  const posicao = new Map(ordemVisivel.map((id, i) => [id, i]));
  const naOrdem = (temas: Tema[]) => [...temas].sort((a, b) => (posicao.get(a.id) ?? 0) - (posicao.get(b.id) ?? 0));
  // Horários da prévia pela MESMA regra do servidor (só exibição; ao soltar, o servidor recalcula).
  const horarioDaPrevia = emPrevia
    ? new Map(
        cronogramaDosTemas(
          inicio.time,
          naOrdem(meeting.items).map((t) => ({ id: t.id, durationMinutes: t.durationMinutes }))
        ).map((h) => [h.id, h])
      )
    : null;
  useReordenacaoAnimada(raiz, ordemVisivel.join());

  const salvarNome = async () => {
    if (!renomeando || !renomeando.titulo.trim()) return;
    const { tipo, id, titulo } = renomeando;
    await executar(
      () =>
        tipo === "pauta"
          ? renameAnnualPauta(agendaId, meeting.id, id, titulo.trim())
          : updateAnnualTema(agendaId, meeting.id, id, { title: titulo.trim() }),
      pt ? "Alteração salva." : "Saved."
    );
    setRenomeando(null);
  };

  /** "+ Novo tema" (cadastra na Biblioteca + instância nesta reunião) ou "Editar" (só a instância). */
  const salvarTema = (dados: DadosDoTemaCompleto) => {
    const alvo = modalTema;
    void executar(async () => {
      const r =
        alvo?.modo === "editar" && alvo.tema
          ? await updateAnnualTema(agendaId, meeting.id, alvo.tema.id, {
              title: dados.title,
              durationMinutes: dados.durationMinutes,
              responsibleLabel: dados.responsibleLabel,
              responsibleEntraObjectId: dados.responsibleEntraObjectId,
              agendaTopicTypeId: dados.agendaTopicTypeId,
              agendaTopicNatureId: dados.agendaTopicNatureId,
              isCircularTheme: dados.isCircularTheme,
              recurrence: dados.recurrence,
              description: dados.description,
              ...(dados.agendaId ? { agendaId: dados.agendaId } : {})
            })
          : await createAnnualTema(agendaId, meeting.id, {
              title: dados.title,
              durationMinutes: dados.durationMinutes,
              responsibleLabel: dados.responsibleLabel,
              ...(dados.responsibleEntraObjectId ? { responsibleEntraObjectId: dados.responsibleEntraObjectId } : {}),
              ...(dados.agendaTopicTypeId ? { agendaTopicTypeId: dados.agendaTopicTypeId } : {}),
              ...(dados.agendaTopicNatureId ? { agendaTopicNatureId: dados.agendaTopicNatureId } : {}),
              isCircularTheme: dados.isCircularTheme,
              recurrence: dados.recurrence,
              ...(dados.description ? { description: dados.description } : {}),
              ...(dados.agendaId ? { agendaId: dados.agendaId } : {}),
              participants: dados.participants
            });
      setModalTema(null);
      return r;
    }, alvo?.modo === "editar" ? (pt ? "Tema atualizado; horários recalculados." : "Topic updated.") : pt ? "Tema adicionado." : "Topic added.");
  };

  /** "Adicionar da Biblioteca": só o id do tema-mestre (+ duração/pauta). */
  const adicionarDaBiblioteca = (dados: { agendaTopicId: string; durationMinutes: number; agendaId?: string }) =>
    void executar(async () => {
      const r = await createAnnualTema(agendaId, meeting.id, dados);
      setModalTema(null);
      return r;
    }, pt ? "Tema da Biblioteca adicionado." : "Library topic added.");

  /** Tema em edição com os dados VIVOS (participantes mudam enquanto o modal está aberto). */
  const temaVivo = modalTema?.tema ? meeting.items.find((t) => t.id === modalTema.tema!.id) ?? modalTema.tema : undefined;

  /**
   * Início do arraste pela alça: a imagem é a LINHA inteira (mesma largura,
   * sombra discreta). No quadro seguinte a linha de origem vira o espaço de
   * destino — antes disso o navegador ainda está capturando a imagem.
   */
  const iniciarArraste = (e: React.DragEvent<HTMLElement>, tema: Tema) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tema.id);
    const linha = e.currentTarget.closest("li");
    if (linha) {
      const r = linha.getBoundingClientRect();
      const fantasma = linha.cloneNode(true) as HTMLElement;
      Object.assign(fantasma.style, {
        position: "fixed",
        top: "-10000px",
        left: "0",
        width: `${r.width}px`,
        transform: "none",
        background: "#fff",
        boxShadow: "0 10px 24px -6px rgba(15, 23, 42, 0.25)",
        pointerEvents: "none"
      });
      document.body.appendChild(fantasma);
      e.dataTransfer.setDragImage(fantasma, e.clientX - r.left, e.clientY - r.top);
      window.setTimeout(() => fantasma.remove(), 0);
    }
    const partida = indiceNaPauta(meeting.items, tema.id);
    window.setTimeout(() => {
      setArrastando(tema.id);
      setDestino(partida);
    }, 0);
  };

  const encerrarArraste = () => {
    setArrastando(null);
    setDestino(null);
  };

  /** Soltar: persiste a ordem da prévia (só dentro da pauta); o servidor recalcula os horários. */
  const soltar = async () => {
    const origem = arrastando;
    const alvo = destino;
    encerrarArraste();
    if (!origem || alvo === null) return;
    const ordem = ordemComDestino(meeting.items, origem, alvo);
    if (ordem.join() === meeting.items.map((t) => t.id).join()) return;
    setOrdemPendente(ordem);
    await executar(() => reorderAnnualTemas(agendaId, meeting.id, ordem), pt ? "Ordem atualizada; horários recalculados." : "Order updated.");
    setOrdemPendente(null);
  };

  /** Área de soltura de uma lista de temas (aceita só arraste de tema dela). */
  const soltavel = (temas: Tema[]) => {
    const daLista = Boolean(arrastando && temas.some((t) => t.id === arrastando));
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!daLista) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDrop: (e: React.DragEvent) => {
        if (!daLista) return;
        e.preventDefault();
        void soltar();
      }
    };
  };

  const confirmar = (dados: ConfirmacaoRemocao, acao: () => Promise<AnnualAgendaDetail>) => setConfirmacao({ dados, acao });

  const nomeEditavel = (tipo: "pauta" | "tema", id: string, titulo: string, classe: string) =>
    renomeando?.tipo === tipo && renomeando.id === id ? (
      <span className="flex items-center gap-1 flex-1 min-w-0">
        <input
          autoFocus
          aria-label={pt ? "Novo nome" : "New name"}
          value={renomeando.titulo}
          onChange={(e) => setRenomeando({ ...renomeando, titulo: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void salvarNome();
            if (e.key === "Escape") setRenomeando(null);
          }}
          className={`${INPUT} flex-1`}
        />
        <button type="button" disabled={ocupado} onClick={() => void salvarNome()} className={`${ICONE} text-emerald-600 hover:bg-emerald-50`} aria-label={pt ? "Salvar" : "Save"}>
          <Check className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={() => setRenomeando(null)} className={`${ICONE} text-slate-400 hover:bg-slate-100`} aria-label={pt ? "Cancelar" : "Cancel"}>
          <X className="w-3.5 h-3.5" />
        </button>
      </span>
    ) : (
      <span className={`${classe} truncate min-w-0`} title={titulo}>{titulo}</span>
    );

  const linhaDeTema = (tema: Tema) => {
    const ficha = fichaDaLinha(tema, pautaTypes, pautaNatures, language);
    const nomes = tema.participants.map((p) => p.name);
    const podeArrastar = editable && Boolean(tema.agendaId);
    const ehEspaco = arrastando === tema.id;
    const horario = horarioDaPrevia?.get(tema.id) ?? { inicio: tema.inicio, fim: tema.fim };
    return (
      <li
        key={tema.id}
        data-tema-id={tema.id}
        onDragOver={(e) => {
          if (!arrastando) return;
          const r = e.currentTarget.getBoundingClientRect();
          const novo = destinoSobre(meeting.items, arrastando, tema.id, e.clientY > r.top + r.height / 2);
          if (novo !== null && novo !== destino) setDestino(novo);
        }}
        className={`rounded-xl border px-2.5 py-2 transition-colors ${
          ehEspaco ? "border-dashed border-[#00658d]/40 bg-sky-50/50" : "border-slate-100 bg-white"
        }`}
      >
        {/* Linha de origem durante o arraste: o conteúdo some (o espaço mantém a altura) e volta ao assentar. */}
        <div className={`transition-opacity duration-200 ${ehEspaco ? "opacity-0" : "opacity-100"}`}>
        <div className="flex items-start gap-2">
          {podeArrastar ? (
            <span
              draggable
              onDragStart={(e) => iniciarArraste(e, tema)}
              onDragEnd={encerrarArraste}
              className="mt-0.5 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing shrink-0 select-none"
              title={pt ? "Arraste para reordenar" : "Drag to reorder"}
              aria-label={pt ? `Arrastar ${tema.title}` : `Drag ${tema.title}`}
            >
              <GripVertical className="w-4 h-4" />
            </span>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {/* Principal: nome (+ marca Biblioteca). */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[12px] text-slate-800 font-bold flex-1 truncate min-w-0" title={tema.title}>{tema.title}</span>
              {ficha.biblioteca && (
                <span className="text-[9px] font-bold text-[#00658d] bg-[#00658d]/5 px-1.5 rounded shrink-0">{pt ? "Biblioteca" : "Library"}</span>
              )}
            </div>
            {/* Secundário: horário · duração · responsável · participantes. */}
            <p className="text-[10px] font-semibold flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
              <span className={`inline-flex items-center gap-1 ${horario.fim ? "text-slate-600" : "text-amber-700"}`}>
                <Clock className="w-3 h-3" />
                {horario.fim ? `${horario.inicio}–${horario.fim}` : horario.inicio}
              </span>
              <button
                type="button"
                disabled={!editable}
                onClick={() => setModalTema({ modo: "editar", tema })}
                className={`${tema.durationMinutes ? "text-slate-500" : "text-amber-700"} ${editable ? "hover:underline cursor-pointer" : "cursor-default"}`}
                title={editable ? (pt ? "Alterar duração" : "Change duration") : undefined}
              >
                · {tema.durationMinutes ? `${tema.durationMinutes} min` : pt ? "sem duração" : "no duration"}
              </button>
              {ficha.responsavel && (
                <span
                  className="inline-flex items-center gap-1 text-slate-600 min-w-0 max-w-[14rem]"
                  title={pt ? `Responsável pelo tema: ${ficha.responsavel}` : `Topic owner: ${ficha.responsavel}`}
                >
                  <UserRound className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span className="sr-only">{pt ? "Responsável:" : "Owner:"}</span>
                  <span className="truncate">{ficha.responsavel}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => setPessoasAbertas((v) => (v === tema.id ? null : tema.id))}
                className="inline-flex items-center gap-1 text-slate-500 hover:text-[#00658d] cursor-pointer"
                title={ficha.participantesTitulo || undefined}
                aria-expanded={pessoasAbertas === tema.id}
                aria-label={pt ? `Participantes do tema (${ficha.totalParticipantes})` : `Topic participants (${ficha.totalParticipantes})`}
              >
                <Users className="w-3 h-3" />
                {ficha.totalParticipantes > 0 ? ficha.participantes : pt ? "sem participantes" : "no participants"}
              </button>
            </p>
            {/* Terciário (uma linha, truncada): tipo · natureza · circular — descrição curta. */}
            {(ficha.classificacao.length > 0 || ficha.descricao) && (
              <p className="text-[10px] text-slate-400 font-medium flex items-center gap-1.5 min-w-0">
                {ficha.classificacao.length > 0 && <span className="shrink-0">{ficha.classificacao.join(" · ")}</span>}
                {ficha.descricao && (
                  <span className="hidden sm:block truncate min-w-0" title={ficha.descricaoCompleta ?? undefined}>
                    {ficha.classificacao.length > 0 ? "— " : ""}
                    {ficha.descricao}
                  </span>
                )}
              </p>
            )}
          </div>
          {editable && (
            <span className="flex items-center gap-1 shrink-0">
              {(pautas.length > 1 || (!tema.agendaId && pautas.length > 0)) && (
                <select
                  aria-label={pt ? "Mover para a pauta" : "Move to agenda"}
                  value={tema.agendaId ?? ""}
                  disabled={ocupado}
                  onChange={(e) =>
                    e.target.value &&
                    void executar(() => updateAnnualTema(agendaId, meeting.id, tema.id, { agendaId: e.target.value }), pt ? "Tema movido." : "Topic moved.")
                  }
                  className="bg-white border border-slate-200 rounded-lg px-1.5 py-1 text-[10px] text-slate-600 cursor-pointer max-w-[130px]"
                >
                  {!tema.agendaId && <option value="">{pt ? "Mover para..." : "Move to..."}</option>}
                  {pautas.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              )}
              <button type="button" disabled={ocupado} onClick={() => setModalTema({ modo: "editar", tema })} className={`${ICONE} text-slate-400 hover:bg-slate-100`} aria-label={pt ? "Editar tema" : "Edit topic"}>
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                disabled={ocupado}
                onClick={() =>
                  confirmar(
                    {
                      titulo: pt ? "Remover tema da reunião?" : "Remove topic from the meeting?",
                      paragrafos: [
                        pt ? `O tema “${tema.title}” será removido desta reunião.` : `The topic “${tema.title}” will be removed from this meeting.`,
                        pt ? "A Biblioteca de Temas não é afetada." : "The Topic library is not affected."
                      ],
                      temas: [],
                      acao: pt ? "Remover tema" : "Remove topic"
                    },
                    () => deleteAnnualTema(agendaId, meeting.id, tema.id)
                  )
                }
                className={`${ICONE} text-rose-500 hover:bg-rose-50`}
                aria-label={pt ? "Remover tema" : "Remove topic"}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          )}
        </div>

        {/* Participantes DO TEMA — lista completa sob demanda. */}
        {pessoasAbertas === tema.id && (
          <div className="mt-2 ml-6 space-y-1.5">
            {nomes.length === 0 && <p className="text-[10px] text-slate-400 font-semibold">{pt ? "Nenhum participante neste tema." : "No participants."}</p>}
            <ul className="flex flex-wrap gap-1.5">
              {tema.participants.map((p) => (
                <li key={p.id} className="inline-flex items-center gap-1 bg-slate-50 border border-slate-100 rounded-full pl-2 pr-1 py-0.5 text-[10px] font-semibold text-slate-700">
                  {p.name}
                  {editable && (
                    <button
                      type="button"
                      disabled={ocupado}
                      onClick={() => void executar(() => unlinkAnnualTemaParticipant(agendaId, meeting.id, tema.id, p.id), pt ? "Participante desvinculado do tema." : "Participant unlinked.")}
                      className="p-0.5 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                      aria-label={pt ? `Desvincular ${p.name}` : `Unlink ${p.name}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editable && (
              <div className="max-w-sm">
                <ParticipantPicker
                  language={language}
                  sugestao={{ governanceBodyId: orgao.id, rotuloOrgao: orgao.name, agendaTopicId: tema.agendaTopicId ?? undefined, rotuloTema: tema.title }}
                  placeholder={pt ? "Vincular participante ao tema..." : "Link participant to topic..."}
                  onSelect={(sel) =>
                    void executar(
                      () => linkAnnualTemaParticipant(agendaId, meeting.id, tema.id, selecionadoParaPayload(sel)),
                      pt ? "Participante vinculado ao tema." : "Participant linked."
                    )
                  }
                />
              </div>
            )}
          </div>
        )}
        </div>
      </li>
    );
  };

  return (
    <article ref={raiz} className="relative border border-slate-200 rounded-2xl bg-white">
      <header className="flex items-start gap-3 p-3.5">
        <button
          type="button"
          onClick={() => setAberta((v) => !v)}
          aria-expanded={aberta}
          aria-label={aberta ? (pt ? "Recolher" : "Collapse") : pt ? "Expandir" : "Expand"}
          className="mt-0.5 p-1 rounded-lg text-slate-400 hover:bg-slate-100 cursor-pointer shrink-0"
        >
          {aberta ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="w-12 shrink-0 text-center">
          <p className="text-lg font-extrabold text-[#001e2d] leading-none">{inicio.date.slice(8, 10)}</p>
          <p className="text-[10px] font-extrabold text-[#00658d]">{mes}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-extrabold text-slate-800 truncate" title={meeting.title}>{meeting.title}</p>
          <p className="text-[10px] text-slate-500 font-semibold flex flex-wrap gap-x-2">
            <span>{inicio.time}–{fim.time}</span>
            <span>· {originLabel(meeting.origin, language)}</span>
            <span>· {meeting.agendas.length} {pt ? "pauta(s)" : "agenda(s)"} · {meeting.items.length} {pt ? "tema(s)" : "topic(s)"}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Toda reunião da Agenda opera no Pipeline desde o agendamento (10/2026). */}
          <button type="button" onClick={() => onOpenMeeting(meeting.id)} className="p-1.5 text-[#00658d] hover:bg-sky-50 rounded-lg cursor-pointer" title={pt ? "Abrir no Pipeline" : "Open in Pipeline"} aria-label={pt ? "Abrir no Pipeline" : "Open in Pipeline"}>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          {editable && !meeting.plannedItemId && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() =>
                confirmar(
                  {
                    titulo: pt ? "Desassociar reunião da Agenda Anual?" : "Remove meeting from the annual plan?",
                    paragrafos: [
                      pt ? `“${meeting.title}” deixa de fazer parte desta Agenda Anual.` : `“${meeting.title}” will no longer be part of this annual plan.`,
                      pt
                        ? "A reunião, o convite Outlook/Teams, as pautas e os temas continuam como estão no Calendário e no Pipeline."
                        : "The meeting, its Outlook/Teams invite, agendas and topics stay as they are."
                    ],
                    temas: [],
                    acao: pt ? "Desassociar" : "Remove"
                  },
                  () => dissociateAnnualMeeting(agendaId, meeting.id)
                )
              }
              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer disabled:opacity-40"
              title={pt ? "Desassociar da Agenda Anual" : "Remove from annual plan"}
              aria-label={pt ? "Desassociar da Agenda Anual" : "Remove from annual plan"}
            >
              <Unlink className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </header>

      {aberta && (
        <div className="px-4 pb-4 space-y-3">
          {/* Tempo: soma das durações x janela da reunião. */}
          {tempo.excessoMin > 0 ? (
            <p role="alert" className="flex items-start gap-2 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>
                {pt ? `A pauta ultrapassa a duração da reunião em ${tempo.excessoMin} minutos.` : `Topics exceed the meeting by ${tempo.excessoMin} minutes.`}
                <span className="block text-[10px] font-medium text-amber-700">
                  {pt ? `Reunião: ${tempo.reuniaoMin} min · Temas: ${tempo.temasMin} min` : `Meeting: ${tempo.reuniaoMin} min · Topics: ${tempo.temasMin} min`}
                </span>
              </span>
            </p>
          ) : (
            meeting.items.length > 0 && (
              <p className="text-[10px] font-semibold text-slate-500">
                {pt ? `Reunião: ${tempo.reuniaoMin} min · Temas: ${tempo.temasMin} min` : `Meeting: ${tempo.reuniaoMin} min · Topics: ${tempo.temasMin} min`}
                {tempo.disponivelMin > 0 && <span className="text-emerald-700"> · {pt ? `Disponível: ${tempo.disponivelMin} min` : `Available: ${tempo.disponivelMin} min`}</span>}
              </p>
            )
          )}
          {tempo.semDuracao > 0 && (
            <p role="alert" className="text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-1.5">
              {pt
                ? `${tempo.semDuracao} tema(s) sem duração: defina a duração para calcular os horários.`
                : `${tempo.semDuracao} topic(s) without duration.`}
            </p>
          )}

          {/*
            TODOS OS PARTICIPANTES DA REUNIÃO — quem está de fato convidado
            (meeting_participants, uma vez cada — não a soma dos temas).
            Recolhida: nomes como destinatários de e-mail ("A; B; C; +5").
            Com permissão, a Agenda gerencia pelo MESMO seletor e pelas MESMAS
            regras da aba Participantes do Pipeline. Sem permissão: só leitura.
          */}
          <section aria-label={pt ? "Todos os participantes da reunião" : "All meeting participants"} className="rounded-xl border border-slate-100 bg-slate-50/60">
            <button
              type="button"
              onClick={() => setParticipantesAbertos((v) => !v)}
              aria-expanded={participantesAbertos}
              className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer min-w-0"
            >
              <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider shrink-0">
                {pt ? "Todos os participantes da reunião" : "All meeting participants"} ({meeting.participants.length})
              </span>
              {!participantesAbertos && meeting.participants.length > 0 && (
                <span className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="text-[11px] text-slate-600 font-medium truncate min-w-0">{resumo.nomes.join("; ")}</span>
                  {resumo.restantes > 0 && <span className="text-[10px] font-bold text-[#00658d] shrink-0">+{resumo.restantes}</span>}
                </span>
              )}
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 shrink-0 ml-auto transition-transform ${participantesAbertos ? "rotate-180" : ""}`} />
            </button>
            {participantesAbertos && (
              <div className="px-3 pb-2.5 space-y-2">
                <p className="text-[10px] text-slate-400 font-medium">
                  {pt
                    ? "Esta lista reúne todos os participantes da reunião, independentemente do órgão colegiado, dos temas ou de inclusão manual."
                    : "This list gathers every meeting participant, whatever the governance body, topics or manual inclusion."}
                </p>
                {meeting.participants.length === 0 ? (
                  <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Nenhum participante nesta reunião." : "No participants in this meeting."}</p>
                ) : (
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                    {meeting.participants.map((p) => {
                      const linha = linhaDoParticipante(meeting, p, orgao.name, language);
                      return (
                        <li key={p.id} className="flex items-start gap-1.5 min-w-0">
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-semibold text-slate-700 truncate" title={p.name}>{p.name}</p>
                            {linha.email && <p className="text-[10px] text-slate-500 truncate" title={linha.email}>{linha.email}</p>}
                            <p className="text-[10px] text-slate-400 truncate" title={linha.contexto}>{linha.contexto}</p>
                          </div>
                          {editable && (
                            <button
                              type="button"
                              disabled={ocupado}
                              onClick={() =>
                                confirmar(
                                  confirmacaoRemoverDaReuniao(
                                    p.name,
                                    meeting.items.filter((t) => t.participants.some((x) => x.id === p.id)).map((t) => t.title),
                                    language,
                                    p.inGovernanceBodyGroup ? orgao.name : null
                                  ),
                                  () => removeAnnualMeetingParticipant(agendaId, meeting.id, p.id)
                                )
                              }
                              className="p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer disabled:opacity-40 shrink-0"
                              aria-label={pt ? `Remover ${p.name} desta reunião` : `Remove ${p.name} from this meeting`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {editable ? (
                  gerenciandoParticipantes ? (
                    <div className="max-w-sm space-y-1">
                      <ParticipantPicker
                        language={language}
                        disabled={ocupado}
                        sugestao={{ governanceBodyId: orgao.id, rotuloOrgao: orgao.name }}
                        jaEscolhidos={{ emails: meeting.participants.map((p) => p.email ?? "").filter(Boolean) }}
                        placeholder={pt ? "Adicionar pessoa da Cielo ou externa..." : "Add Cielo or external person..."}
                        onSelect={(sel) =>
                          void executar(
                            () => addAnnualMeetingParticipant(agendaId, meeting.id, selecionadoParaPayload(sel)),
                            pt ? "Participante incluído na reunião." : "Participant added."
                          )
                        }
                      />
                      <button type="button" onClick={() => setGerenciandoParticipantes(false)} className="text-[10px] font-bold text-slate-500 hover:text-slate-700 cursor-pointer">
                        {pt ? "Concluir" : "Done"}
                      </button>
                    </div>
                  ) : (
                    <button type="button" disabled={ocupado} onClick={() => setGerenciandoParticipantes(true)} className="text-[10px] font-bold text-[#00658d] hover:underline cursor-pointer inline-flex items-center gap-1 disabled:opacity-40">
                      <Plus className="w-3 h-3" />{pt ? "Gerenciar participantes" : "Manage participants"}
                    </button>
                  )
                ) : (
                  <p className="text-[10px] text-slate-400 font-semibold">{pt ? "Somente leitura." : "Read-only."}</p>
                )}
              </div>
            )}
          </section>

          {/* TEMAS DA REUNIÃO — ações principais de conteúdo. */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h5 className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">{pt ? "Temas da reunião" : "Meeting topics"}</h5>
            {editable && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => setModalTema({ modo: "novo" })}
                  className="px-2.5 py-1.5 bg-[#00658d] hover:bg-[#00aeef] text-white rounded-lg text-[10px] font-bold inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />{pt ? "Novo tema" : "New topic"}
                </button>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => setModalTema({ modo: "biblioteca" })}
                  className="px-2.5 py-1.5 border border-[#00658d]/30 text-[#00658d] hover:bg-sky-50 rounded-lg text-[10px] font-bold inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
                >
                  <BookOpen className="w-3 h-3" />{pt ? "Adicionar da Biblioteca" : "Add from Library"}
                </button>
              </div>
            )}
          </div>

          {meeting.items.length === 0 && (
            <p className="text-[11px] text-slate-400 font-semibold">{pt ? "Nenhum tema ainda." : "No topics yet."}</p>
          )}

          {pautas.length <= 1 ? (
            // Uma pauta (ou nenhuma): ela fica oculta; os temas aparecem direto, na ordem.
            <ul className="space-y-1.5" {...soltavel(meeting.items)}>{naOrdem(meeting.items).map(linhaDeTema)}</ul>
          ) : (
            <>
              {pautas.map((pauta) => (
                <section key={pauta.id} aria-label={pauta.title} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-extrabold text-slate-400 uppercase shrink-0">{pt ? "Pauta" : "Agenda"}</span>
                    {nomeEditavel("pauta", pauta.id, pauta.title, "text-[12px] font-extrabold text-[#00658d] flex-1")}
                    {editable && renomeando?.id !== pauta.id && (
                      <span className="flex items-center gap-1 shrink-0">
                        <button type="button" disabled={ocupado} onClick={() => setRenomeando({ tipo: "pauta", id: pauta.id, titulo: pauta.title })} className={`${ICONE} text-slate-400 hover:bg-slate-100`} aria-label={pt ? "Renomear pauta" : "Rename agenda"}>
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={ocupado}
                          onClick={() =>
                            confirmar(
                              {
                                titulo: pt ? "Excluir pauta?" : "Delete agenda?",
                                paragrafos: [
                                  pt ? `A pauta “${pauta.title}” será excluída desta reunião.` : `The agenda “${pauta.title}” will be deleted.`,
                                  pt ? "Pauta com temas não é excluída: mova ou remova os temas antes." : "Agendas with topics cannot be deleted: move or remove the topics first."
                                ],
                                temas: [],
                                acao: pt ? "Excluir pauta" : "Delete agenda"
                              },
                              () => deleteAnnualPauta(agendaId, meeting.id, pauta.id)
                            )
                          }
                          className={`${ICONE} text-rose-500 hover:bg-rose-50`}
                          aria-label={pt ? "Excluir pauta" : "Delete agenda"}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1.5" {...soltavel(pauta.temas)}>{naOrdem(pauta.temas).map(linhaDeTema)}</ul>
                  {pauta.temas.length === 0 && <p className="text-[10px] text-slate-400 font-semibold">{pt ? "Sem temas." : "No topics."}</p>}
                </section>
              ))}
              {semPauta.length > 0 && (
                <section className="space-y-1.5">
                  <p className="text-[10px] font-extrabold text-slate-400 uppercase">{pt ? "Temas sem pauta" : "Topics without agenda"}</p>
                  <ul className="space-y-1.5">{semPauta.map(linhaDeTema)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {modalTema?.modo === "biblioteca" && (
        <AnnualBibliotecaModal
          language={language}
          ocupado={ocupado}
          temas={libraryTopics}
          pautas={pautas}
          onCancel={() => setModalTema(null)}
          onAdd={adicionarDaBiblioteca}
        />
      )}
      {modalTema && modalTema.modo !== "biblioteca" && (
        <AnnualTemaModal
          language={language}
          modo={modalTema.modo}
          ocupado={ocupado}
          pautaTypes={pautaTypes}
          pautaNatures={pautaNatures}
          pautas={pautas}
          orgao={orgao}
          inicial={
            temaVivo
              ? {
                  title: temaVivo.title,
                  durationMinutes: temaVivo.durationMinutes,
                  responsibleLabel: temaVivo.responsibleLabel,
                  responsibleEntraObjectId: temaVivo.responsibleEntraObjectId,
                  typeId: temaVivo.typeId,
                  natureId: temaVivo.natureId,
                  isCircularTheme: temaVivo.isCircularTheme,
                  recurrence: temaVivo.recurrence ?? null,
                  description: temaVivo.description,
                  agendaId: temaVivo.agendaId,
                  participants: temaVivo.participants
                }
              : undefined
          }
          onCancel={() => setModalTema(null)}
          onSave={salvarTema}
          onLinkParticipant={(payload) =>
            temaVivo &&
            void executar(() => linkAnnualTemaParticipant(agendaId, meeting.id, temaVivo.id, payload), pt ? "Participante vinculado ao tema." : "Participant linked.")
          }
          onUnlinkParticipant={(participantId) =>
            temaVivo &&
            void executar(() => unlinkAnnualTemaParticipant(agendaId, meeting.id, temaVivo.id, participantId), pt ? "Participante desvinculado do tema." : "Participant unlinked.")
          }
        />
      )}

      {confirmacao && (
        <ConfirmRemovalDialog
          language={language}
          confirmacao={confirmacao.dados}
          busy={ocupado}
          onCancel={() => setConfirmacao(null)}
          onConfirm={() =>
            void executar(async () => {
              const r = await confirmacao.acao();
              setConfirmacao(null);
              return r;
            })
          }
        />
      )}
    </article>
  );
}
