import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, X } from "lucide-react";
import type { GovernanceBody, Meeting } from "../types";
import { describeMeetingError, meetingFromApi, updateMeeting } from "../lib/meetings";
import { previaDoTitulo, SESSION_TYPE_OPTIONS, type SessionType } from "../lib/meeting-title";
import { formularioDaReuniao, montarPatchDaEdicao, type FormDeEdicao } from "../lib/edit-meeting";
import { descricaoAposMudanca, type DadosDoTemplate } from "../lib/rich-text";
import { ConfirmarTrocaDeOrgao, ModalityFields, ParticipantsField } from "./MeetingInviteFields";
import { listGovernanceBodyGroupMembers } from "../lib/participation-groups";
import { convidadosDoGrupo, somarSemDuplicar } from "../lib/group-participants";
import RichTextEditor from "./RichTextEditor";

/**
 * EDITAR REUNIÃO — o ÚNICO formulário de edição do cabeçalho da reunião,
 * aberto pelo Pipeline (detalhe) e pelo Calendário. Mesma regra
 * (`montarPatchDaEdicao`), mesmo endpoint (`PATCH /meetings/:id`): o servidor
 * exige `PGCP.Assessoria`, atualiza o Outlook/Teams, audita e versiona.
 *
 * Esconder o botão para quem não pode é cortesia; a barreira é o servidor.
 */

interface EditMeetingModalProps {
  language: "en" | "pt";
  meeting: Meeting;
  governanceBodies: GovernanceBody[];
  onClose: () => void;
  /** Reunião relida do servidor depois de salvar. */
  onSaved: (atualizada: Meeting) => void;
  /** Nada mudou: fecha sem chamar a API. */
  onUnchanged?: () => void;
}

// Mesmos tokens do modal "Nova reunião" (NewMeetingModal/MeetingInviteFields).
const ROTULO = "text-[10px] font-bold text-slate-500 uppercase tracking-wide";
const CAMPO =
  "w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d]";

export default function EditMeetingModal({
  language,
  meeting,
  governanceBodies,
  onClose,
  onSaved,
  onUnchanged
}: EditMeetingModalProps) {
  const en = language === "en";
  const [form, setForm] = useState<FormDeEdicao>(() => formularioDaReuniao(meeting));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [avisoDescricao, setAvisoDescricao] = useState<string | null>(null);
  const alterar = <K extends keyof FormDeEdicao>(campo: K, valor: FormDeEdicao[K]) => setForm((f) => ({ ...f, [campo]: valor }));

  /*
   * TROCA DE ÓRGÃO na edição. Abrir o modal NUNCA recalcula a lista pelo órgão
   * (alguém pode ter sido removido de propósito). Só ao trocar o órgão a
   * usuária decide: "Sim" ACRESCENTA o grupo do novo órgão à lista atual (sem
   * duplicar, ninguém sai); "Não" troca o órgão e mantém a lista.
   */
  const [trocaPendente, setTrocaPendente] = useState<ReturnType<typeof convidadosDoGrupo> | null>(null);
  const [erroGrupo, setErroGrupo] = useState<string | null>(null);
  const pedidoDoGrupo = useRef(0);
  const trocarOrgao = (novoId: string) => {
    alterar("governanceBodyId", novoId);
    setTrocaPendente(null);
    setErroGrupo(null);
    const pedido = ++pedidoDoGrupo.current;
    // Sem lista carregada, ou voltando ao órgão original: nada a perguntar.
    if (!form.participants || !novoId || novoId === meeting.governanceBodyId) return;
    listGovernanceBodyGroupMembers(novoId)
      .then((membros) => {
        if (pedido !== pedidoDoGrupo.current) return;
        const lista = convidadosDoGrupo(membros, language);
        if (lista.length > 0) setTrocaPendente(lista);
      })
      .catch(() => {
        if (pedido !== pedidoDoGrupo.current) return;
        setErroGrupo(
          en
            ? "Could not load the new body's participants. The current list was kept."
            : "Não foi possível carregar os participantes do novo órgão. A lista atual foi mantida."
        );
      });
  };

  const nomeDoOrgao =
    governanceBodies.find((b) => b.id === (form.governanceBodyId || meeting.governanceBodyId))?.name ?? meeting.category;
  const tituloExibido = form.sessionType
    ? previaDoTitulo({ startTime: form.startTime, orgao: nomeDoOrgao, tipo: form.sessionType, modalidade: form.modality }) ?? meeting.title
    : form.title;

  /*
   * Descrição feita a partir do TEMPLATE acompanha data/horário/órgão/título;
   * texto que a pessoa editou nunca é sobrescrito — só um aviso para revisar.
   */
  // Sem temas: o template nasce na criação, antes de existir pauta.
  const dadosDoTemplate: DadosDoTemplate = {
    titulo: tituloExibido,
    data: form.date,
    inicio: form.startTime,
    fim: form.endTime,
    orgao: nomeDoOrgao
  };
  const anterior = useRef<DadosDoTemplate>(dadosDoTemplate);
  const chave = JSON.stringify(dadosDoTemplate);
  useEffect(() => {
    const antes = anterior.current;
    anterior.current = dadosDoTemplate;
    if (JSON.stringify(antes) === chave) return;
    const resultado = descricaoAposMudanca(form.description, antes, dadosDoTemplate, language);
    if (resultado?.atualizada) {
      setForm((f) => ({ ...f, description: resultado.descricao }));
      setAvisoDescricao(null);
    } else if (!resultado && (antes.data !== form.date || antes.inicio !== form.startTime || antes.fim !== form.endTime)) {
      setAvisoDescricao(
        en
          ? "The description was edited and is not updated automatically. Review any date/time mentioned in it."
          : "A descrição foi editada e não é atualizada automaticamente. Revise data e horário citados nela."
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  const salvar = async () => {
    if (salvando) return;
    setErro(null);
    if (trocaPendente) {
      setErro(en ? "Decide whether to add the new body's participants." : "Decida se os participantes do novo órgão devem ser acrescentados.");
      return;
    }
    if (form.endTime <= form.startTime) {
      setErro(en ? "End time must be after the start time." : "O término deve ser depois do início.");
      return;
    }
    const patch = montarPatchDaEdicao(meeting, form);
    if (Object.keys(patch).length === 0) {
      (onUnchanged ?? onClose)();
      return;
    }
    setSalvando(true);
    try {
      onSaved(meetingFromApi(await updateMeeting(meeting.id, patch)));
    } catch (error) {
      // Fica no modal: a pessoa corrige sem perder o que digitou.
      setErro(describeMeetingError(error, language));
    } finally {
      setSalvando(false);
    }
  };

  // Portal no <body>: centralizado na VIEWPORT, independente de ancestral com
  // transform/backdrop-filter (mesmo padrão do modal Nova reunião).
  return createPortal(
    <div className="fixed inset-0 bg-white/10 backdrop-blur-md flex items-center justify-center z-[9999] p-4 sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="editar-reuniao-titulo"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl max-h-[94vh] flex flex-col overflow-hidden animate-fade-in text-xs"
      >
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="min-w-0">
            <h3 id="editar-reuniao-titulo" className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
              <Pencil className="w-4 h-4 text-[#00658d]" />
              {en ? "Edit meeting" : "Editar reunião"}
            </h3>
            <p className="text-[11px] text-slate-500 font-medium mt-0.5">
              {en ? "Update information for this governance session." : "Atualize os metadados desta sessão de governança."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={en ? "Close" : "Fechar"}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/*
          Duas colunas em tela larga (dados à esquerda, descrição à direita):
          o conteúdo cabe sem rolagem. Em tela pequena empilha e o corpo rola
          sem barra visível (regra global de [role="dialog"] em index.css).
        */}
        <form
          onSubmit={(e) => e.preventDefault()}
          className="flex-1 min-h-0 overflow-y-auto px-6 py-5 grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-x-8 gap-y-4"
        >
          <div className="space-y-3 min-w-0">
          {/*
            Tipo + TÍTULO PADRONIZADO (030): com tipo, o título é montado pelo
            servidor a partir de hora, órgão, formato e tipo. Reunião antiga sem
            tipo mantém o título livre até alguém escolher o tipo.
          */}
          <div className="flex flex-col gap-1">
            <label htmlFor="editSessionType" className={ROTULO}>{en ? "Type" : "Tipo"}</label>
            <select
              id="editSessionType"
              value={form.sessionType}
              onChange={(e) => alterar("sessionType", e.target.value as SessionType | "")}
              className={`${CAMPO} cursor-pointer`}
            >
              {!meeting.sessionType && <option value="">{en ? "No type (keep free title)" : "Sem tipo (manter título atual)"}</option>}
              {SESSION_TYPE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{en ? o.en : o.pt}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="editTitle" className={ROTULO}>
              {form.sessionType
                ? en ? "Meeting Title (generated)" : "Título da Reunião (gerado automaticamente)"
                : en ? "Meeting Title" : "Título da Reunião"}
            </label>
            {form.sessionType ? (
              <p className="px-3 py-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700 break-words min-h-[34px]">
                {tituloExibido}
              </p>
            ) : (
              <input id="editTitle" type="text" value={form.title} onChange={(e) => alterar("title", e.target.value)} className={CAMPO} />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="editDate" className={ROTULO}>{en ? "Date" : "Data"}</label>
              <input id="editDate" type="date" value={form.date} onChange={(e) => alterar("date", e.target.value)} className={CAMPO} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="editStart" className={ROTULO}>{en ? "Start Time" : "Hora Início"}</label>
              <input id="editStart" type="time" value={form.startTime} onChange={(e) => alterar("startTime", e.target.value)} className={CAMPO} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="editEnd" className={ROTULO}>{en ? "End Time" : "Hora Fim"}</label>
              <input id="editEnd" type="time" value={form.endTime} onChange={(e) => alterar("endTime", e.target.value)} className={CAMPO} />
            </div>
          </div>

          {/* Recorrência saiu do modal (recurso não implementado); o valor gravado não muda. */}
          <div className="grid grid-cols-1 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="editGovernanceBody" className={ROTULO}>{en ? "Governance body" : "Órgão de Governança"}</label>
              <select
                id="editGovernanceBody"
                value={form.governanceBodyId}
                onChange={(e) => trocarOrgao(e.target.value)}
                className={`${CAMPO} cursor-pointer`}
              >
                {/* Inativos só aparecem se forem o órgão atual. */}
                {governanceBodies
                  .filter((body) => body.isActive || body.id === meeting.governanceBodyId)
                  .map((body) => (
                    <option key={body.id} value={body.id}>{body.name}</option>
                  ))}
              </select>
            </div>
          </div>

          {/* Modalidade/local (025): atualiza o MESMO evento do Outlook. */}
          <ModalityFields
            language={language}
            modality={form.modality}
            physicalLocationId={form.physicalLocationId}
            // Local atual da reunião (cópia): continua escolhível mesmo se inativado depois.
            currentLocation={meeting.physicalLocation ?? null}
            onChange={(m, local) => setForm((f) => ({ ...f, modality: m, physicalLocationId: local }))}
          />

          {/* Formato e descrição na coluna esquerda; a direita fica com organizador e convidados. */}
          <div className="flex flex-col gap-1">
            <span className={ROTULO}>{en ? "Description" : "Descrição"}</span>
            <RichTextEditor
              language={language}
              ariaLabel={en ? "Meeting description" : "Descrição da reunião"}
              value={form.description}
              onChange={(html) => alterar("description", html)}
              placeholder={en ? "Meeting description..." : "Descrição da reunião..."}
              minHeightClass="min-h-[120px] lg:min-h-[150px]"
            />
            <p className="text-[10px] text-slate-400 font-semibold">
              {en
                ? "Sent in the body of the Outlook/Teams invitation."
                : "Vai no corpo do convite do Outlook/Teams."}
            </p>
            {avisoDescricao && (
              <p role="status" className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                {avisoDescricao}
              </p>
            )}
          </div>
          </div>

          <div className="space-y-3 min-w-0">
          <div className="flex flex-col gap-1">
            <label htmlFor="editOrganizer" className={ROTULO}>{en ? "Organizer" : "Organizador"}</label>
            {/* Somente leitura: o convite mora no calendário do organizador. */}
            <input
              id="editOrganizer"
              type="text"
              value={meeting.organizer || (en ? "Not informed" : "Não informado")}
              readOnly
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-500 outline-none cursor-not-allowed"
            />
            <p className="text-[10px] text-slate-400 font-semibold">
              {en ? "Defined when the meeting is scheduled." : "Definido no agendamento da reunião."}
            </p>
          </div>
          {/*
            Participantes: MESMO componente do agendamento. A lista vai inteira no
            PATCH e o servidor aplica a diferença numa edição só (uma versão, uma
            atualização do convite). Sem a lista carregada, o bloco não aparece.
          */}
          {trocaPendente && (
            <ConfirmarTrocaDeOrgao
              mensagem={
                en
                  ? "You are changing the meeting's body. Add the new body's participants to the current list? Nobody is removed."
                  : "Você está alterando o órgão da reunião. Deseja atualizar a lista de participantes com base no novo órgão? Os participantes do novo órgão serão acrescentados; ninguém é removido."
              }
              rotuloAtualizar={en ? "Yes, add participants" : "Sim, acrescentar"}
              rotuloManter={en ? "No, keep the list" : "Não, manter lista"}
              onAtualizar={() => {
                setForm((f) => ({ ...f, participants: somarSemDuplicar(f.participants ?? [], trocaPendente) }));
                setTrocaPendente(null);
              }}
              onManter={() => setTrocaPendente(null)}
            />
          )}
          {erroGrupo && <p role="status" className="text-[10px] font-semibold text-amber-700">{erroGrupo}</p>}
          {form.participants && (
            <ParticipantsField
              language={language}
              participants={form.participants}
              onParticipantsChange={(lista) => setForm((f) => ({ ...f, participants: lista }))}
              sugestao={{ governanceBodyId: form.governanceBodyId || meeting.governanceBodyId, rotuloOrgao: nomeDoOrgao }}
              hint={
                en
                  ? "Changes apply when you save, in a single invitation update."
                  : "Inclusões e remoções valem ao salvar, numa única atualização do convite."
              }
            />
          )}

          {erro && (
            <p role="alert" className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
              {erro}
            </p>
          )}
          </div>
        </form>

        <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 transition rounded-xl cursor-pointer"
          >
            {en ? "Cancel" : "Cancelar"}
          </button>
          <button
            type="button"
            disabled={salvando}
            onClick={() => void salvar()}
            className="px-4 py-2 text-xs font-bold bg-[#00658d] hover:bg-[#00aeef] active:scale-95 text-white transition rounded-xl shadow-sm cursor-pointer disabled:opacity-50"
          >
            {salvando ? (en ? "Saving..." : "Salvando...") : en ? "Save changes" : "Salvar alterações"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
