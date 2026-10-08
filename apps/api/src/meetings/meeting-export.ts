import pool from "../database.js";
import {
  campos,
  dataHoraBrasilia,
  finalizar,
  limitar,
  noFuso,
  nomeDeArquivo,
  novoRelatorio,
  paragrafo,
  secao,
  tabela,
} from "../reports/report-pdf.js";
import { textoDaDescricao } from "./rich-text.js";
import { findMeeting, type MeetingDetail } from "./service.js";
import { listarVersoesDaReuniao, montarSnapshotDaReuniao, type TemaNaVersao } from "./versions.js";

/**
 * DOSSIÊ DA REUNIÃO (PDF) — "Exportar" do detalhe da reunião. Tudo o que a
 * reunião tem, num documento corporativo: resumo executivo, descrição, Mesa,
 * participantes, pautas e temas (cronograma), documentos, FUP, Ata, validação
 * das pautas, convite e histórico de versões.
 *
 * ESTADO ATUAL, gerado sob demanda (não é versão imutável — para isso existem
 * os PDFs das versões, 034). Mesma leitura do detalhe (`findMeeting`): quem lê
 * a reunião lê o dossiê. Sem e-mail de participante fora da lista que a tela
 * já mostra; sem conteúdo da Ata (só a situação dela — o texto tem PDF próprio).
 */

const STATUS: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  needs_approval: "Agendada",
  approved: "Agendada",
  in_progress: "Em andamento",
  done: "Realizada",
  closed: "Encerrada",
};
const CONVITE: Record<string, string> = {
  pending: "Pendente de envio",
  synced: "Enviado e atualizado",
  stale: "Enviado; atualização pendente",
  failed: "Falha no último envio",
};
const ATA: Record<string, string> = {
  draft: "Em elaboração",
  under_review: "Em revisão",
  approved: "Aprovada",
  closed: "Encerrada",
};
const FUP: Record<string, string> = {
  open: "Em aberto",
  in_progress: "Em andamento",
  done: "Concluído",
  completed: "Concluído",
  cancelled: "Cancelado",
};
const VALIDACAO: Record<string, string> = {
  draft: "Não aprovadas (opcional)",
  sent: "Enviadas para validação",
  approved: "Aprovadas",
};

const minutos = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}min` : ""}` : `${n} min`);
const dataBr = (iso: string | Date) => {
  const d = typeof iso === "string" ? iso.slice(0, 10) : iso.toISOString().slice(0, 10);
  return d.split("-").reverse().join("/");
};

interface Extras {
  documentos: Array<{ nome: string; tema: string | null; autor: string | null; em: Date }>;
  fups: Array<{ titulo: string; responsavel: string | null; prazo: Date | null; status: string; tema: string | null }>;
  ata: { status: string; revisao: number; atualizadaEm: Date; por: string | null } | null;
}

async function carregarExtras(meetingId: string): Promise<Extras> {
  const [docs, fups, ata] = await Promise.all([
    pool.query<{ nome: string; tema: string | null; autor: string | null; em: Date }>(
      `SELECT d.original_filename AS nome, i.title AS tema, u.name AS autor, d.created_at AS em
         FROM documents d
         LEFT JOIN meeting_agenda_items i ON i.id = d.meeting_agenda_item_id
         LEFT JOIN users u ON u.id = d.uploaded_by_user_id
        WHERE d.meeting_id = $1
        ORDER BY d.created_at`,
      [meetingId],
    ),
    pool.query<{ titulo: string; responsavel: string | null; prazo: Date | null; status: string; tema: string | null }>(
      `SELECT a.title AS titulo, coalesce(a.assignee_name, u.name) AS responsavel, a.due_date AS prazo, a.status,
              i.title AS tema
         FROM action_items a
         LEFT JOIN users u ON u.id = a.assigned_user_id
         LEFT JOIN meeting_agenda_items i ON i.id = a.origin_agenda_item_id
        WHERE a.origin_meeting_id = $1
        ORDER BY a.due_date NULLS LAST, a.created_at`,
      [meetingId],
    ),
    pool.query<{ status: string; revision: number; updated_at: Date; por: string | null }>(
      `SELECT mm.status, mm.revision, mm.updated_at, u.name AS por
         FROM meeting_minutes mm LEFT JOIN users u ON u.id = mm.updated_by_user_id
        WHERE mm.meeting_id = $1 AND btrim(mm.content) <> ''`,
      [meetingId],
    ),
  ]);
  const a = ata.rows[0];
  return {
    documentos: docs.rows,
    fups: fups.rows,
    ata: a ? { status: a.status, revisao: a.revision, atualizadaEm: a.updated_at, por: a.por } : null,
  };
}

function linhaDoTema(t: TemaNaVersao, i: number): string[] {
  const ficha = [t.tipo, t.natureza, t.circular ? "Circular" : null, t.temaDeFup ? "Tema de FUP" : null, t.postergado ? "Postergado" : null]
    .filter(Boolean)
    .join(" · ");
  return [
    String(i + 1).padStart(2, "0"),
    t.inicio ?? "—",
    t.duracaoMin ? `${t.duracaoMin} min` : "—",
    [t.titulo, ficha].filter(Boolean).join("\n"),
    [t.responsavel, t.apresentador ? `Apresenta: ${t.apresentador}` : null].filter(Boolean).join("\n") || "—",
    t.participantes.join(", ") || "—",
  ];
}

/** Monta o PDF (puro sobre os dados já carregados). */
export function desenharDossieDaReuniao(
  d: MeetingDetail,
  extras: Extras,
  versoes: Array<{ number: number; changeSummary: string; createdAt: string; createdBy: { name: string } }>,
): Promise<Buffer> {
  const s = montarSnapshotDaReuniao(d);
  const c = s.conteudo;
  const x = s.contexto;
  const { doc, bytes } = novoRelatorio({
    tipo: "DOSSIÊ DA REUNIÃO",
    sobretitulo: x.orgao,
    titulo: c.titulo,
    emitidoEm: new Date().toISOString(),
  });

  const data = noFuso(c.inicio, c.fuso, { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  const hora = (iso: string) => noFuso(iso, c.fuso, { hour: "2-digit", minute: "2-digit" });
  const janelaMin = Math.max(0, Math.round((new Date(c.fim).getTime() - new Date(c.inicio).getTime()) / 60000));
  const temas = [...c.pautas.flatMap((p) => p.temas), ...c.temasSemPauta];
  const planejadoMin = temas.reduce((soma, t) => soma + (t.duracaoMin ?? 0), 0);
  const externos = c.participantes.filter((p) => p.externo).length;
  const confirmados = d.participants.filter((p) => p.isConfirmed).length;

  // 1. Resumo executivo
  secao(doc, "Resumo executivo");
  campos(doc, [
    ["Órgão de governança", x.orgao],
    ["Data", data],
    ["Horário", `${hora(c.inicio)} às ${hora(c.fim)} (${minutos(janelaMin)})`],
    ["Situação", c.cancelada ? "Cancelada" : STATUS[c.status] ?? c.status],
    ["Tipo", c.tipoDeSessao === "ordinary" ? "Ordinária" : c.tipoDeSessao === "extraordinary" ? "Extraordinária" : null],
    ["Modalidade", c.modalidade === "in_person" ? `Presencial${c.local ? ` — ${c.local}` : ""}` : "Online (Microsoft Teams)"],
    ["Organizador", c.organizador],
    ["Presidente da Mesa", x.presidenteDaMesa ? `${x.presidenteDaMesa.nome}${x.presidenteDaMesa.externo ? " (externo)" : ""}` : "Não cadastrado no órgão"],
    ["Participantes", `${c.participantes.length}${externos ? ` (${externos} externo${externos > 1 ? "s" : ""})` : ""} · ${confirmados} confirmado(s)`],
    ["Pautas e temas", `${c.pautas.length} pauta(s) · ${temas.length} tema(s)`],
    ["Tempo dos temas", `${minutos(planejadoMin)} de ${minutos(janelaMin)}${planejadoMin > janelaMin ? " — excede o horário" : ` · ${minutos(janelaMin - planejadoMin)} disponíveis`}`],
    ["Pautas", VALIDACAO[x.validacaoDePautas.status] ?? x.validacaoDePautas.status],
    ["Convite Outlook/Teams", x.convite.status ? CONVITE[x.convite.status] ?? x.convite.status : "Sem integração"],
    ["Ata", extras.ata ? ATA[extras.ata.status] ?? extras.ata.status : "Não registrada"],
    ["FUP", `${extras.fups.length} item(ns)`],
    ["Documentos anexados", String(extras.documentos.length)],
    ["Origem", x.origem === "annual_agenda" ? "Agenda Anual" : "Calendário"],
  ]);

  // 2. Descrição
  secao(doc, "Descrição");
  paragrafo(doc, textoDaDescricao(c.descricao), "Sem descrição.");

  // 3. Participantes
  secao(doc, `Participantes (${c.participantes.length})`);
  const confirmado = new Map(d.participants.map((p) => [(p.email ?? p.displayName ?? "").toLowerCase(), p.isConfirmed]));
  tabela(
    doc,
    [
      { titulo: "Nome", largura: 0.3 },
      { titulo: "E-mail", largura: 0.32 },
      { titulo: "Tipo", largura: 0.11 },
      { titulo: "Papel", largura: 0.15 },
      { titulo: "Confirmado", largura: 0.12 },
    ],
    c.participantes.map((p) => [
      p.nome,
      p.email ?? "—",
      p.externo ? "Externo" : "Interno",
      p.papel ?? "—",
      confirmado.get((p.email ?? p.nome).toLowerCase()) ? "Sim" : "Não",
    ]),
    "Nenhum participante.",
  );
  if (x.membrosDoComite.length > 0) {
    campos(doc, [["Membros do órgão", x.membrosDoComite.join(", ")]]);
  }

  // 4. Pautas e temas
  const colunas = [
    { titulo: "#", largura: 0.05 },
    { titulo: "Início", largura: 0.08 },
    { titulo: "Tempo", largura: 0.09 },
    { titulo: "Tema", largura: 0.34 },
    { titulo: "Responsável", largura: 0.2 },
    { titulo: "Participantes", largura: 0.24 },
  ];
  let i = 0;
  if (temas.length === 0) {
    secao(doc, "Pautas e temas");
    paragrafo(doc, "", "Nenhum tema cadastrado.");
  }
  for (const pauta of c.pautas) {
    secao(doc, `Pauta: ${limitar(pauta.titulo, 120)}`);
    tabela(doc, colunas, pauta.temas.map((t) => linhaDoTema(t, i++)), "Nenhum tema nesta pauta.");
  }
  if (c.temasSemPauta.length > 0) {
    secao(doc, c.pautas.length > 0 ? "Temas sem pauta" : "Temas");
    tabela(doc, colunas, c.temasSemPauta.map((t) => linhaDoTema(t, i++)));
  }

  // 5. Documentos
  secao(doc, `Documentos anexados (${extras.documentos.length})`);
  tabela(
    doc,
    [
      { titulo: "Arquivo", largura: 0.44 },
      { titulo: "Tema", largura: 0.26 },
      { titulo: "Enviado por", largura: 0.18 },
      { titulo: "Em", largura: 0.12 },
    ],
    extras.documentos.map((dd) => [dd.nome, dd.tema ?? "Reunião inteira", dd.autor ?? "—", dataBr(dd.em)]),
    "Nenhum documento anexado.",
  );

  // 6. FUP
  secao(doc, `FUP — acompanhamentos (${extras.fups.length})`);
  tabela(
    doc,
    [
      { titulo: "Item", largura: 0.38 },
      { titulo: "Tema", largura: 0.2 },
      { titulo: "Responsável", largura: 0.18 },
      { titulo: "Prazo", largura: 0.11 },
      { titulo: "Situação", largura: 0.13 },
    ],
    extras.fups.map((f) => [f.titulo, f.tema ?? "—", f.responsavel ?? "—", f.prazo ? dataBr(f.prazo) : "—", FUP[f.status] ?? f.status]),
    "Nenhum FUP registrado.",
  );

  // 7. Ata, pautas e convite
  secao(doc, "Ata, aprovação das pautas e convite");
  campos(doc, [
    ["Ata", extras.ata ? `${ATA[extras.ata.status] ?? extras.ata.status} · revisão ${extras.ata.revisao}` : "Não registrada"],
    ["Ata atualizada em", extras.ata ? `${dataHoraBrasilia(extras.ata.atualizadaEm.toISOString())}${extras.ata.por ? ` por ${extras.ata.por}` : ""}` : null],
    ["Pautas", VALIDACAO[x.validacaoDePautas.status] ?? x.validacaoDePautas.status],
    ["Pautas aprovadas em", x.validacaoDePautas.aprovadaEm ? dataHoraBrasilia(x.validacaoDePautas.aprovadaEm) : null],
    ["Convite enviado", c.convite.enviado ? "Sim" : "Não"],
    ["Reunião no Teams", c.convite.teams ? "Sim" : "Não"],
    ["Última sincronização", x.convite.ultimaSincronizacao ? dataHoraBrasilia(x.convite.ultimaSincronizacao) : null],
  ]);

  // 8. Histórico
  secao(doc, `Histórico de versões (${versoes.length})`);
  tabela(
    doc,
    [
      { titulo: "Versão", largura: 0.1 },
      { titulo: "Data", largura: 0.2 },
      { titulo: "Responsável", largura: 0.2 },
      { titulo: "O que mudou", largura: 0.5 },
    ],
    versoes.map((v) => [String(v.number), dataHoraBrasilia(v.createdAt), v.createdBy.name, v.changeSummary]),
    "Nenhuma versão registrada.",
  );

  finalizar(doc, `Dossiê — ${c.titulo}`);
  return bytes;
}

export async function exportarDossieDaReuniao(meetingId: string): Promise<{ pdf: Buffer; nome: string }> {
  const d = await findMeeting(meetingId);
  const [extras, versoes] = await Promise.all([carregarExtras(meetingId), listarVersoesDaReuniao(meetingId)]);
  const pdf = await desenharDossieDaReuniao(d, extras, versoes);
  const dia = noFuso(d.startAt, d.timezone, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("-");
  return { pdf, nome: nomeDeArquivo(["dossie-reuniao", dia, d.governanceBody.name], "pdf") };
}
