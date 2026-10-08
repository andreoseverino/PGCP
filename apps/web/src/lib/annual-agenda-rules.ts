import type { AnnualAgendaDetail, AnnualAgendaMeeting, AnnualOverviewGroup } from "./annual-agendas";

/**
 * AGENDA ANUAL — regras de TELA, puras. O servidor revalida tudo; aqui só se
 * decide o que mostrar.
 */

/**
 * Edição de conteúdo pela Agenda Anual: só a permissão. Sem aprovação
 * (10/2026) não há estado que bloqueie — o status gravado é histórico.
 */
export function podeEditarAgenda(agenda: Pick<AnnualAgendaDetail, "editable">, canManage: boolean): boolean {
  return canManage && agenda.editable !== false;
}

/** Pautas na ordem, cada uma com seus temas; temas sem pauta ao final. */
export function pautasComTemas(meeting: Pick<AnnualAgendaMeeting, "agendas" | "items">) {
  const pautas = [...meeting.agendas].sort((a, b) => a.position - b.position);
  const ids = new Set(pautas.map((p) => p.id));
  const porPosicao = <T extends { position: number }>(lista: T[]) => [...lista].sort((a, b) => a.position - b.position);
  return {
    pautas: pautas.map((p) => ({ ...p, temas: porPosicao(meeting.items.filter((t) => t.agendaId === p.id)) })),
    semPauta: porPosicao(meeting.items.filter((t) => !t.agendaId || !ids.has(t.agendaId)))
  };
}

/** Resumo calculado dos dados reais (nunca número fixo). */
export function resumoDaAgenda(agenda: Pick<AnnualAgendaDetail, "meetings">) {
  return {
    reunioes: agenda.meetings.length,
    pautas: agenda.meetings.reduce((n, m) => n + m.agendas.length, 0),
    temas: agenda.meetings.reduce((n, m) => n + m.items.length, 0)
  };
}

/** Candidatas que podem ser associadas (as de outra agenda só informam). */
export function candidatasAssociaveis(agenda: Pick<AnnualAgendaDetail, "candidates">) {
  return agenda.candidates.filter((c) => !c.linkedToOtherAgenda);
}

// --- Visão anual (ano -> órgão -> reuniões) -----------------------------------

/** Grupos do ano no CONTEXTO global ("" = todos os órgãos). Filtro visual. */
export function gruposDoContexto(grupos: readonly AnnualOverviewGroup[], orgaoContexto: string): AnnualOverviewGroup[] {
  return orgaoContexto ? grupos.filter((g) => g.governanceBody.id === orgaoContexto) : [...grupos];
}

/**
 * Ano inicial do seletor (anos vêm do servidor: só os que têm reunião ou
 * Agenda Anual). O atual se existir; senão o mais próximo; `null` sem dados.
 */
export function anoInicial(anos: readonly number[], atual: number): number | null {
  if (anos.length === 0) return null;
  if (anos.includes(atual)) return atual;
  return [...anos].sort((a, b) => Math.abs(a - atual) - Math.abs(b - atual) || b - a)[0]!;
}

/** "André, Maria +2" — resumo compacto dos participantes do tema. */
export function resumoDeParticipantes(nomes: readonly string[], visiveis = 2): string {
  if (nomes.length === 0) return "";
  const primeiros = nomes.slice(0, visiveis).map((n) => n.split(/\s+/)[0]);
  return nomes.length > visiveis ? `${primeiros.join(", ")} +${nomes.length - visiveis}` : primeiros.join(", ");
}

/**
 * Nova ordem GLOBAL com o tema arrastado em `destino` — índice entre os temas
 * da MESMA pauta, sem contar o próprio arrastado (0 = primeiro). Os temas da
 * pauta se redistribuem entre as posições que já ocupavam; os demais ficam
 * onde estão. Arrastar não muda a pauta (para isso, "Mover para...").
 *
 * É a mesma ordem usada na prévia durante o arraste e na persistência ao soltar.
 */
export function ordemComDestino(
  globais: ReadonlyArray<{ id: string; agendaId: string | null }>,
  arrastadoId: string,
  destino: number
): string[] {
  const arrastado = globais.find((t) => t.id === arrastadoId);
  if (!arrastado || !arrastado.agendaId) return globais.map((t) => t.id);
  const semArrastado = globais
    .filter((t) => t.agendaId === arrastado.agendaId && t.id !== arrastadoId)
    .map((t) => t.id);
  semArrastado.splice(Math.max(0, Math.min(destino, semArrastado.length)), 0, arrastadoId);
  let k = 0;
  return globais.map((t) => (t.agendaId === arrastado.agendaId ? semArrastado[k++]! : t.id));
}

/** Índice atual do tema entre os da sua pauta (ponto de partida do arraste). */
export function indiceNaPauta(globais: ReadonlyArray<{ id: string; agendaId: string | null }>, temaId: string): number {
  const tema = globais.find((t) => t.id === temaId);
  return tema ? globais.filter((t) => t.agendaId === tema.agendaId).findIndex((t) => t.id === temaId) : -1;
}

/**
 * Destino ao passar sobre `alvoId`: metade de cima = antes dele, metade de
 * baixo = depois. `null` se o alvo é o próprio arrastado ou de outra pauta.
 */
export function destinoSobre(
  globais: ReadonlyArray<{ id: string; agendaId: string | null }>,
  arrastadoId: string,
  alvoId: string,
  metadeDeBaixo: boolean
): number | null {
  const arrastado = globais.find((t) => t.id === arrastadoId);
  const alvo = globais.find((t) => t.id === alvoId);
  if (!arrastado || !alvo || alvoId === arrastadoId || !arrastado.agendaId || alvo.agendaId !== arrastado.agendaId) return null;
  const semArrastado = globais.filter((t) => t.agendaId === arrastado.agendaId && t.id !== arrastadoId).map((t) => t.id);
  return semArrastado.indexOf(alvoId) + (metadeDeBaixo ? 1 : 0);
}

// --- Participantes da reunião (visão consolidada) -------------------------------

/**
 * Resumo tipo "destinatários de e-mail": os primeiros nomes completos
 * separados por "; " e quantos faltam ("+5"). Base: `meeting_participants`
 * (uma vez cada), nunca a soma das listas dos temas.
 */
export function resumoDosParticipantes(
  participantes: ReadonlyArray<{ name: string }>,
  visiveis = 3
): { nomes: string[]; restantes: number } {
  return {
    nomes: participantes.slice(0, visiveis).map((p) => p.name),
    restantes: Math.max(0, participantes.length - visiveis)
  };
}

/**
 * Por que a pessoa está na reunião, quando dá para saber sem adivinhar:
 * pertence hoje ao grupo do órgão e/ou está em temas desta reunião. Sem
 * nenhum dos dois, nada é afirmado (a origem manual não é registrada).
 */
export function origensDoParticipante(
  meeting: Pick<AnnualAgendaMeeting, "items" | "participants">,
  participanteId: string,
  orgao: string,
  language: "en" | "pt"
): string[] {
  const pt = language === "pt";
  const p = meeting.participants.find((x) => x.id === participanteId);
  const temas = meeting.items.filter((t) => t.participants.some((x) => x.id === participanteId)).map((t) => t.title);
  return [
    ...(p?.inGovernanceBodyGroup ? [`${pt ? "Grupo" : "Group"}: ${orgao}`] : []),
    ...(temas.length > 0 ? [`${pt ? (temas.length > 1 ? "Temas" : "Tema") : temas.length > 1 ? "Topics" : "Topic"}: ${temas.join(", ")}`] : [])
  ];
}

/**
 * Linha da pessoa na lista expandida: e-mail (se houver) e o contexto —
 * "Cielo · Grupo: X · Tema: Y" / "Externo · Tema: Y". Nada técnico.
 */
export function linhaDoParticipante(
  meeting: Pick<AnnualAgendaMeeting, "items" | "participants">,
  p: { id: string; email?: string | null; external: boolean },
  orgao: string,
  language: "en" | "pt"
): { email: string | null; contexto: string } {
  const pt = language === "pt";
  const email = p.email?.trim() || null;
  const origem = p.external ? (pt ? "Externo" : "External") : "Cielo";
  return { email, contexto: [origem, ...origensDoParticipante(meeting, p.id, orgao, language)].join(" · ") };
}

// --- Linha do tema (dados que já existem) -------------------------------------

const DESCRICAO_MAX = 140;

/**
 * O que a linha compacta do tema mostra, em três níveis: nome (principal);
 * horário/duração/responsável/participantes (secundário); tipo, natureza,
 * circular, descrição curta (terciário, uma linha). Dado ausente é omitido.
 */
export function fichaDaLinha(
  tema: Pick<
    AnnualAgendaMeeting["items"][number],
    "responsibleLabel" | "typeId" | "natureId" | "isCircularTheme" | "description" | "participants" | "agendaTopicId"
  >,
  tipos: ReadonlyArray<{ id: string; name: string }>,
  naturezas: ReadonlyArray<{ id: string; name: string }>,
  language: "en" | "pt"
) {
  const pt = language === "pt";
  const responsavel = tema.responsibleLabel?.trim() || null;
  const nomes = tema.participants.map((p) => p.name);
  const tipo = (tema.typeId && tipos.find((t) => t.id === tema.typeId)?.name) || null;
  const natureza = (tema.natureId && naturezas.find((n) => n.id === tema.natureId)?.name) || null;
  const texto = tema.description?.replace(/\s+/g, " ").trim() || null;
  const descricao = texto && texto.length > DESCRICAO_MAX ? `${texto.slice(0, DESCRICAO_MAX - 1).trimEnd()}…` : texto;
  const temTerciario = Boolean(tipo || natureza || descricao || tema.isCircularTheme);
  return {
    responsavel,
    participantes: resumoDeParticipantes(nomes),
    /** Lista completa para o tooltip; o responsável identificado. */
    participantesTitulo: nomes.map((n) => (responsavel && n === responsavel ? `${n} (${pt ? "responsável" : "owner"})` : n)).join(", "),
    totalParticipantes: nomes.length,
    /** Tipo · Natureza · Circular — `[]` quando nada a mostrar. */
    classificacao: temTerciario
      ? [tipo, natureza, `Circular: ${tema.isCircularTheme ? (pt ? "Sim" : "Yes") : pt ? "Não" : "No"}`].filter(
          (v): v is string => Boolean(v)
        )
      : [],
    descricao,
    descricaoCompleta: texto,
    biblioteca: Boolean(tema.agendaTopicId)
  };
}

// --- Mutação de conteúdo -----------------------------------------------------

/**
 * Executa UMA ação do usuário e, só se ela der certo, aplica o resultado e
 * avisa UMA vez que as reuniões mudaram (Calendário/Pipeline recarregam). As
 * operações internas do servidor (pauta padrão, participantes, horários) são
 * a mesma chamada — não geram avisos extras. Falha: nenhum aviso.
 */
export async function rodarMutacao<T>(
  acao: () => Promise<T>,
  passos: { aplicar: (resultado: T) => void | Promise<void>; falhar: (erro: unknown) => void; reunioesMudaram?: () => void }
): Promise<boolean> {
  let resultado: T;
  try {
    resultado = await acao();
  } catch (erro) {
    passos.falhar(erro);
    return false;
  }
  try {
    await passos.aplicar(resultado);
  } catch (erro) {
    passos.falhar(erro);
  }
  passos.reunioesMudaram?.();
  return true;
}

/**
 * Estado do ano no contexto:
 *   sem_reunioes      nada no Calendário e nenhuma agenda
 *   a_formalizar      há reuniões/órgãos sem Agenda Anual formal
 *   formalizado       todos os grupos já têm agenda
 */
export function estadoDaVisao(grupos: readonly AnnualOverviewGroup[]): "sem_reunioes" | "a_formalizar" | "formalizado" {
  if (grupos.length === 0) return "sem_reunioes";
  return grupos.some((g) => !g.agenda) ? "a_formalizar" : "formalizado";
}

/** Reuniões do grupo que a formalização vai trazer (sem outra agenda). */
export function reunioesAAssociar(grupo: AnnualOverviewGroup): AnnualOverviewGroup["meetings"] {
  return grupo.meetings.filter((m) => !m.annualAgendaId);
}

// --- Biblioteca no fluxo "Adicionar da Biblioteca" -----------------------------

/** O que o seletor mostra de cada tema da Biblioteca (só para escolher). */
export interface TemaDaBibliotecaResumo {
  id: string;
  title: string;
  durationMinutes?: number | null;
  tipo?: string | null;
  natureza?: string | null;
  responsavel?: string | null;
  participantes?: number;
  /** TEMA FUTURO (042): mês/ano ("AAAA-MM") e comitê previstos. */
  isFuture?: boolean;
  expectedMonth?: string | null;
  expectedGovernanceBodyId?: string | null;
  expectedGovernanceBodyName?: string | null;
}

/**
 * Seções do seletor: temas FUTUROS no topo (os previstos para o comitê desta
 * reunião primeiro, depois por mês previsto) e, abaixo, os REGULARES na ordem
 * recebida. Todos selecionáveis: entrar numa reunião torna o tema regular
 * (trigger da 042).
 */
export function secoesDaBiblioteca<T extends TemaDaBibliotecaResumo>(
  temas: readonly T[],
  governanceBodyId: string | null | undefined
): { futuros: T[]; regulares: T[] } {
  const deste = (t: T) => (governanceBodyId && t.expectedGovernanceBodyId === governanceBodyId ? 0 : 1);
  const futuros = temas
    .filter((t) => t.isFuture === true)
    .sort((a, b) => deste(a) - deste(b) || (a.expectedMonth ?? "").localeCompare(b.expectedMonth ?? ""));
  return { futuros, regulares: temas.filter((t) => t.isFuture !== true) };
}

/** Busca simples por nome (sem acento/caixa), local — a lista já está carregada. */
export function filtrarBiblioteca<T extends { title: string }>(temas: readonly T[], busca: string): T[] {
  const norm = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
  const alvo = norm(busca);
  return alvo ? temas.filter((t) => norm(t.title).includes(alvo)) : [...temas];
}
