import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAuditIn } from "../audit/service.js";
import { transacaoAmbiente } from "../transacao-ambiente.js";
import { descreverLocalFisico } from "./locations.js";
import { descricaoComoHtml, textoDaDescricao } from "./rich-text.js";
import { findMeeting, type MeetingDetail } from "./service.js";
import {
  campos,
  dataHoraBrasilia,
  finalizar,
  limitar,
  nomeDeArquivo,
  noFuso,
  novoRelatorio,
  paragrafo,
  secao,
  tabela,
} from "../reports/report-pdf.js";

/**
 * VERSÕES DA REUNIÃO (034) — "fotografia" auditável a cada alteração relevante.
 *
 *   conteudo  o que DEFINE a versão: entra no hash. Igual ao da última versão =
 *             nenhuma versão nova (abrir e salvar sem mudar nada não gera foto).
 *   contexto  o que vale registrar naquele instante, mas que NÃO cria versão
 *             sozinho: nome do órgão, Presidente da Mesa, quem está no grupo do
 *             órgão, validação de pautas (opcional), última sincronização com
 *             o Outlook. Mudar o cadastro do órgão não pode gerar versão de
 *             todas as reuniões dele.
 *
 * QUANDO: `versionarReuniaoSeMudou` roda no FIM da transação da mutação
 * (criação, cabeçalho, participantes, pautas, temas, ordem, postergação,
 * convite criado). Mutação que falha faz ROLLBACK e leva a versão junto.
 *
 * O PDF é a representação visual, gerado deterministicamente do snapshot sob
 * demanda (mesmo desenho da Agenda Anual, 028): sem bytes no S3, versionar não
 * depende de armazenamento externo.
 */

export const FORMATO_DA_VERSAO = 1;

export interface TemaNaVersao {
  titulo: string;
  inicio: string | null;
  duracaoMin: number | null;
  responsavel: string | null;
  apresentador: string | null;
  tipo: string | null;
  natureza: string | null;
  circular: boolean;
  temaDeFup: boolean;
  postergado: boolean;
  participantes: string[];
}

export interface ParticipanteNaVersao {
  nome: string;
  email: string | null;
  externo: boolean;
  papel: string | null;
}

export interface ConteudoDaVersao {
  titulo: string;
  tipoDeSessao: string | null;
  status: string;
  descricao: string | null;
  inicio: string;
  fim: string;
  fuso: string;
  modalidade: string;
  local: string | null;
  orgaoId: string;
  organizador: string | null;
  recorrencia: string | null;
  pendencias: string | null;
  participantes: ParticipanteNaVersao[];
  pautas: Array<{ titulo: string; temas: TemaNaVersao[] }>;
  temasSemPauta: TemaNaVersao[];
  convite: { enviado: boolean; teams: boolean };
  /**
   * Só presente (`true`) na reunião cancelada (036). Ausente nas ativas, para
   * o hash das versões anteriores à 036 não mudar.
   */
  cancelada?: true;
}

export interface ContextoDaVersao {
  orgao: string;
  presidenteDaMesa: { nome: string; externo: boolean } | null;
  /** Nomes (como na lista de participantes) de quem pertence ao grupo do órgão. */
  membrosDoComite: string[];
  origem: string;
  agendaAnualId: string | null;
  validacaoDePautas: { status: string; enviadaA: string | null; enviadaEm: string | null; aprovadaEm: string | null };
  convite: { status: string | null; ultimaSincronizacao: string | null; linkDoOutlook: boolean };
}

export interface SnapshotDaVersao {
  formato: typeof FORMATO_DA_VERSAO;
  conteudo: ConteudoDaVersao;
  contexto: ContextoDaVersao;
}

// ---------------------------------------------------------------------------
// Regras puras
// ---------------------------------------------------------------------------

const nomeDoParticipante = (p: MeetingDetail["participants"][number]) =>
  (p.displayName ?? p.userName ?? p.email ?? "(sem nome)").trim();

function temaDaVersao(t: MeetingDetail["agendaItems"][number]): TemaNaVersao {
  return {
    titulo: t.title,
    inicio: t.scheduledStartTime ? t.scheduledStartTime.slice(0, 5) : null,
    duracaoMin: t.durationMinutes,
    responsavel: t.responsible?.label ?? null,
    apresentador: t.presenterLabel,
    tipo: t.type?.name ?? null,
    natureza: t.nature?.name ?? null,
    circular: t.isCircularTheme,
    // Só quando há recorrência: não muda o hash das versões existentes.
    ...(t.recurrence ? { recorrencia: t.recurrence } : {}),
    temaDeFup: t.generatesActionItem,
    // Execução (apresentando/concluído) é estado da sessão, não configuração;
    // postergar tira o tema desta reunião, e isso é configuração.
    postergado: t.executionStatus === "postponed",
    participantes: t.participants.map((p) => p.name).sort((a, b) => a.localeCompare(b, "pt-BR")),
  };
}

/** Detalhe da reunião -> snapshot. PURO: testável sem banco. */
export function montarSnapshotDaReuniao(d: MeetingDetail): SnapshotDaVersao {
  const participantes = d.participants
    .map((p) => ({
      nome: nomeDoParticipante(p),
      email: p.email?.trim().toLowerCase() || null,
      externo: p.participantType === "external",
      papel: p.roleInMeeting,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR") || (a.email ?? "").localeCompare(b.email ?? ""));

  const pautas = [...d.agendas]
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      titulo: p.title,
      temas: d.agendaItems.filter((t) => t.agendaId === p.id).sort((a, b) => a.position - b.position).map(temaDaVersao),
    }));

  return {
    formato: FORMATO_DA_VERSAO,
    conteudo: {
      titulo: d.title,
      tipoDeSessao: d.sessionType,
      status: d.status,
      descricao: d.description ? descricaoComoHtml(d.description) : null,
      inicio: d.startAt,
      fim: d.endAt,
      fuso: d.timezone,
      modalidade: d.modality,
      local: d.physicalLocation ? descreverLocalFisico(d.physicalLocation) : null,
      orgaoId: d.governanceBody.id,
      organizador: d.organizer?.name ?? null,
      recorrencia: d.recurrence,
      pendencias: d.pendingRequirements,
      participantes,
      pautas,
      temasSemPauta: d.agendaItems.filter((t) => !t.agendaId).sort((a, b) => a.position - b.position).map(temaDaVersao),
      convite: { enviado: Boolean(d.calendar?.providerEventId), teams: Boolean(d.calendar?.joinUrl) },
      ...(d.cancelledAt ? { cancelada: true as const } : {}),
    },
    contexto: {
      orgao: d.governanceBody.name,
      presidenteDaMesa: d.governanceBody.chairName
        ? { nome: d.governanceBody.chairName, externo: Boolean(d.governanceBody.chairExternalParticipantId) }
        : null,
      membrosDoComite: d.participants.filter((p) => p.inGovernanceBodyGroup).map(nomeDoParticipante).sort(),
      origem: d.origin,
      agendaAnualId: d.annualAgendaId,
      validacaoDePautas: {
        status: d.agendaValidation.status,
        enviadaA: d.agendaValidation.sentTo,
        enviadaEm: d.agendaValidation.sentAt,
        aprovadaEm: d.agendaValidation.approvedAt,
      },
      convite: {
        status: d.calendar?.syncStatus ?? null,
        ultimaSincronizacao: d.calendar?.lastSyncedAt ?? null,
        linkDoOutlook: Boolean(d.calendar?.webLink),
      },
    },
  };
}

/** JSON com chaves ORDENADAS: o mesmo conteúdo produz sempre o mesmo texto. */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`;
  const chaves = Object.keys(valor as Record<string, unknown>)
    .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico((valor as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function hashDoConteudo(conteudo: ConteudoDaVersao): string {
  return createHash("sha256").update(jsonCanonico(conteudo), "utf8").digest("hex");
}

/** Seções que mudaram entre duas versões, em linguagem de negócio. */
export function resumoDaMudanca(
  anterior: ConteudoDaVersao | null,
  atual: ConteudoDaVersao,
  primeira: "criacao" | "legado" = "criacao",
): string {
  if (!anterior) {
    return primeira === "criacao" ? "Versão inicial (criação da reunião)" : "Primeira versão registrada (reunião anterior ao versionamento)";
  }
  const mudou = (...chaves: Array<keyof ConteudoDaVersao>) =>
    chaves.some((k) => jsonCanonico(anterior[k]) !== jsonCanonico(atual[k]));
  const secoes: string[] = [];
  if (mudou("titulo", "tipoDeSessao")) secoes.push("Título/tipo");
  if (mudou("inicio", "fim", "fuso")) secoes.push("Data e horário");
  if (mudou("orgaoId")) secoes.push("Órgão de governança");
  if (mudou("modalidade", "local")) secoes.push("Modalidade/local");
  if (mudou("cancelada")) return "Reunião cancelada (exclusão lógica)";
  if (mudou("status")) secoes.push("Situação");
  if (mudou("descricao")) secoes.push("Descrição");
  if (mudou("organizador", "recorrencia", "pendencias")) secoes.push("Outros dados");
  if (mudou("participantes")) secoes.push("Participantes");
  if (mudou("pautas", "temasSemPauta")) secoes.push("Pautas e temas");
  if (mudou("convite")) secoes.push("Convite Outlook/Teams");
  return `Alterado: ${secoes.join(", ") || "dados da reunião"}`;
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

export interface AtorDaVersao {
  userId: string;
  name: string;
}

/**
 * Trava a linha da reunião no INÍCIO da mutação versionada. Reunião
 * inexistente não trava nada: a operação responde o 404 dela.
 */
export async function travarReuniaoParaVersao(client: PoolClient, meetingId: string): Promise<void> {
  await client.query("SELECT 1 FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
}

/**
 * Registra uma nova versão SE o conteúdo mudou desde a última. Roda no
 * `client` da transação da mutação, depois de tudo gravado.
 *
 * DENTRO DE TRANSAÇÃO AMBIENTE (Agenda Anual): não versiona aqui — quem abriu
 * a transação chama ao final, uma vez, depois de recalcular os horários. Assim
 * uma operação da Agenda gera no máximo UMA versão.
 *
 * Trava a reunião (`FOR UPDATE`) para duas mutações concorrentes não
 * disputarem o mesmo número de versão.
 */
export async function versionarReuniaoSeMudou(
  client: PoolClient,
  meetingId: string,
  ator: AtorDaVersao,
  opcoes: { criacao?: boolean } = {},
): Promise<number | null> {
  // Dentro da operação delegada pela Agenda Anual: quem abriu a transação
  // versiona ao final (fora do contexto ambiente), uma vez só.
  if (transacaoAmbiente() === client) return null;

  const { rows: existe } = await client.query("SELECT 1 FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
  if (existe.length === 0) return null;

  const detalhe = await findMeeting(meetingId, client);
  const snapshot = montarSnapshotDaReuniao(detalhe);
  const hash = hashDoConteudo(snapshot.conteudo);

  const { rows: ultimas } = await client.query<{ version: number; content_hash: string; conteudo: ConteudoDaVersao }>(
    `SELECT version, content_hash, snapshot -> 'conteudo' AS conteudo
       FROM meeting_versions WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1`,
    [meetingId],
  );
  const ultima = ultimas[0];
  if (ultima && ultima.content_hash === hash) return null;

  const numero = (ultima?.version ?? 0) + 1;
  const resumo = resumoDaMudanca(ultima?.conteudo ?? null, snapshot.conteudo, opcoes.criacao ? "criacao" : "legado");

  await client.query(
    `INSERT INTO meeting_versions (meeting_id, version, snapshot, content_hash, change_summary, created_by_user_id)
          VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [meetingId, numero, JSON.stringify(snapshot), hash, resumo, ator.userId],
  );
  await recordAuditIn(client, {
    actorUserId: ator.userId,
    actorName: ator.name,
    action: "Versão da reunião registrada",
    entityType: "meeting",
    entityId: meetingId,
    // Rótulo curto: título, número e seções alteradas — nunca o conteúdo.
    entityLabel: limitar(`${detalhe.title} — versão ${numero} (${resumo})`, 480),
    status: "success",
  });
  return numero;
}

/**
 * Versiona numa transação PRÓPRIA. Só para quem age depois de um ato externo
 * já consumado (convite criado no Exchange): ali a versão não pode viver na
 * mesma transação do registro do ato.
 */
export async function versionarEmTransacaoPropria(meetingId: string, ator: AtorDaVersao): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const numero = await versionarReuniaoSeMudou(client, meetingId, ator);
    await client.query("COMMIT");
    return numero;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VersaoDaReuniaoResumo {
  id: string;
  number: number;
  changeSummary: string;
  createdAt: string;
  createdBy: { id: string; name: string };
}

/** Lista as versões (sem o snapshot). 404 se a reunião não existe. */
export async function listarVersoesDaReuniao(meetingId: string): Promise<VersaoDaReuniaoResumo[]> {
  if (!UUID.test(meetingId)) throw new HttpError(400, "Identificador inválido.");
  const { rows: reuniao } = await pool.query("SELECT 1 FROM meetings WHERE id = $1", [meetingId]);
  if (reuniao.length === 0) throw new HttpError(404, "Reunião não encontrada.");
  const { rows } = await pool.query<{
    id: string;
    version: number;
    change_summary: string;
    created_at: Date;
    user_id: string;
    user_name: string;
  }>(
    `SELECT v.id, v.version, v.change_summary, v.created_at, u.id AS user_id, u.name AS user_name
       FROM meeting_versions v JOIN users u ON u.id = v.created_by_user_id
      WHERE v.meeting_id = $1
      ORDER BY v.version DESC
      LIMIT 500`,
    [meetingId],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.version,
    changeSummary: r.change_summary,
    createdAt: r.created_at.toISOString(),
    createdBy: { id: r.user_id, name: r.user_name },
  }));
}

export function lerSnapshotDaVersao(valor: unknown): SnapshotDaVersao {
  const s = valor as Partial<SnapshotDaVersao> | null;
  if (!s || s.formato !== FORMATO_DA_VERSAO || !s.conteudo || !s.contexto) {
    throw new Error("Formato de versão da reunião não reconhecido.");
  }
  return s as SnapshotDaVersao;
}

/**
 * PDF de UMA versão. A versão é buscada pelo par (reunião, versão): trocar o
 * id da versão por um de outra reunião dá 404 — sem IDOR.
 */
export async function gerarPdfDaVersao(meetingId: string, versionId: string): Promise<{ pdf: Buffer; nome: string }> {
  if (!UUID.test(meetingId) || !UUID.test(versionId)) throw new HttpError(400, "Identificador inválido.");
  const { rows } = await pool.query<{
    version: number;
    snapshot: unknown;
    change_summary: string;
    created_at: Date;
    user_name: string;
  }>(
    `SELECT v.version, v.snapshot, v.change_summary, v.created_at, u.name AS user_name
       FROM meeting_versions v JOIN users u ON u.id = v.created_by_user_id
      WHERE v.id = $2 AND v.meeting_id = $1`,
    [meetingId, versionId],
  );
  const v = rows[0];
  if (!v) throw new HttpError(404, "Versão não encontrada para esta reunião.");
  const snapshot = lerSnapshotDaVersao(v.snapshot);
  const pdf = await desenharPdfDaVersao(snapshot, {
    numero: v.version,
    resumo: v.change_summary,
    geradaEm: v.created_at.toISOString(),
    responsavel: v.user_name,
  });
  const dia = noFuso(snapshot.conteudo.inicio, snapshot.conteudo.fuso, { year: "numeric", month: "2-digit", day: "2-digit" })
    .split("/")
    .reverse()
    .join("-");
  return { pdf, nome: nomeDeArquivo(["reuniao", dia, snapshot.contexto.orgao, `v${v.version}`], "pdf") };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const ROTULO_DO_STATUS: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  needs_approval: "Agendada",
  approved: "Agendada",
  in_progress: "Em andamento",
  done: "Realizada",
  closed: "Encerrada",
};
const ROTULO_DO_CONVITE: Record<string, string> = {
  pending: "Pendente de envio",
  synced: "Enviado e atualizado",
  stale: "Enviado; atualização pendente",
  failed: "Falha no último envio",
};
const sim = (b: boolean) => (b ? "Sim" : "Não");

function linhaDoTema(t: TemaNaVersao, indice: number): string[] {
  const ficha = [t.tipo, t.natureza, t.circular ? "Circular" : null, t.temaDeFup ? "Tema de FUP" : null, t.postergado ? "Postergado" : null]
    .filter(Boolean)
    .join(" · ");
  return [
    String(indice + 1).padStart(2, "0"),
    t.inicio ?? "—",
    t.duracaoMin ? `${t.duracaoMin} min` : "—",
    [t.titulo, ficha].filter(Boolean).join("\n"),
    [t.responsavel, t.apresentador ? `Apresenta: ${t.apresentador}` : null].filter(Boolean).join("\n"),
    t.participantes.join(", "),
  ];
}

export function desenharPdfDaVersao(
  s: SnapshotDaVersao,
  meta: { numero: number; resumo: string; geradaEm: string; responsavel: string },
): Promise<Buffer> {
  const c = s.conteudo;
  const x = s.contexto;
  const { doc, bytes } = novoRelatorio({
    tipo: `VERSÃO ${meta.numero} DA REUNIÃO`,
    sobretitulo: x.orgao,
    titulo: c.titulo,
    emitidoEm: new Date().toISOString(),
  });

  const data = noFuso(c.inicio, c.fuso, { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  const horario = `${noFuso(c.inicio, c.fuso, { hour: "2-digit", minute: "2-digit" })} às ${noFuso(c.fim, c.fuso, { hour: "2-digit", minute: "2-digit" })} (${c.fuso})`;

  secao(doc, "Identificação da versão");
  campos(doc, [
    ["Versão", String(meta.numero)],
    ["Gerada em", `${dataHoraBrasilia(meta.geradaEm)} (horário de Brasília)`],
    ["Responsável pela alteração", meta.responsavel],
    ["O que mudou", meta.resumo],
  ]);

  secao(doc, "Reunião");
  campos(doc, [
    ["Título", c.titulo],
    ["Órgão de governança", x.orgao],
    ["Data", data],
    ["Horário", horario],
    ["Situação", c.cancelada ? "Cancelada" : ROTULO_DO_STATUS[c.status] ?? c.status],
    ["Tipo", c.tipoDeSessao === "ordinary" ? "Ordinária" : c.tipoDeSessao === "extraordinary" ? "Extraordinária" : null],
    ["Modalidade", c.modalidade === "in_person" ? `Presencial${c.local ? ` — ${c.local}` : ""}` : "Online (Microsoft Teams)"],
    ["Organizador", c.organizador],
    ["Recorrência", c.recorrencia],
  ]);

  secao(doc, "Descrição");
  paragrafo(doc, textoDaDescricao(c.descricao), "Sem descrição.");

  secao(doc, "Comitê / Mesa");
  campos(doc, [
    [
      "Presidente da Mesa",
      x.presidenteDaMesa ? `${x.presidenteDaMesa.nome}${x.presidenteDaMesa.externo ? " (externo)" : ""}` : "Não cadastrado no órgão",
    ],
    ["Membros do órgão nesta reunião", x.membrosDoComite.join(", ") || null],
  ]);

  secao(doc, `Participantes (${c.participantes.length})`);
  tabela(
    doc,
    [
      { titulo: "Nome", largura: 0.34 },
      { titulo: "E-mail", largura: 0.36 },
      { titulo: "Tipo", largura: 0.12 },
      { titulo: "Papel", largura: 0.18 },
    ],
    c.participantes.map((p) => [p.nome, p.email ?? "—", p.externo ? "Externo" : "Interno", p.papel ?? "—"]),
    "Nenhum participante.",
  );

  const colunasDosTemas = [
    { titulo: "#", largura: 0.05 },
    { titulo: "Início", largura: 0.08 },
    { titulo: "Tempo", largura: 0.09 },
    { titulo: "Tema", largura: 0.34 },
    { titulo: "Responsável", largura: 0.2 },
    { titulo: "Participantes", largura: 0.24 },
  ];
  let indice = 0;
  if (c.pautas.length === 0 && c.temasSemPauta.length === 0) {
    secao(doc, "Pautas e temas");
    paragrafo(doc, "", "Nenhuma pauta cadastrada.");
  }
  for (const pauta of c.pautas) {
    secao(doc, `Pauta: ${limitar(pauta.titulo, 120)}`);
    tabela(doc, colunasDosTemas, pauta.temas.map((t) => linhaDoTema(t, indice++)), "Nenhum tema nesta pauta.");
  }
  if (c.temasSemPauta.length > 0) {
    secao(doc, "Temas sem pauta");
    tabela(doc, colunasDosTemas, c.temasSemPauta.map((t) => linhaDoTema(t, indice++)));
  }

  secao(doc, "Convite Outlook / Teams");
  campos(doc, [
    ["Convite enviado", sim(c.convite.enviado)],
    ["Reunião no Teams", sim(c.convite.teams)],
    ["Situação da sincronização", x.convite.status ? ROTULO_DO_CONVITE[x.convite.status] ?? x.convite.status : "Sem integração"],
    ["Última sincronização", x.convite.ultimaSincronizacao ? dataHoraBrasilia(x.convite.ultimaSincronizacao) : null],
  ]);

  finalizar(doc, `Versão ${meta.numero} — ${c.titulo}`);
  return bytes;
}
