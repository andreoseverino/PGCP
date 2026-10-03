import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { diferencasAposEnvio, lerSnapshot, montarSnapshot, totaisDoSnapshot } from "./snapshot.js";
import { conteudoDaReuniao, formatarTema, gerarPdfDaAgendaAnual, pessoaComEmail, rotuloDoDocumento, tipoDoDocumento } from "./pdf.js";
import {
  exigirEmElaboracao,
  motivoParaNaoAssociar,
  parseTemaPatchDaAgenda,
  reunioesDoPdf,
} from "./service.js";

/**
 * Agenda Anual como consolidação das reuniões (028) — regras puras.
 * O fluxo com banco (associação, bloqueio, snapshot imutável, Pipeline depois
 * da aprovação) foi validado em banco descartável; aqui ficam as regras.
 */

const AGENDA = { id: "ag", title: "Comitê Executivo", year: 2027, governanceBody: { id: "exec", name: "Comitê Executivo" } };
const reuniao = (id: string, startAt: string, title = `Reunião ${id}`) => ({
  id,
  title,
  startAt,
  endAt: startAt.replace("T12", "T14"),
  timezone: "America/Sao_Paulo",
});

const snapshot = montarSnapshot({
  agenda: AGENDA,
  reunioes: [reuniao("m2", "2027-02-17T12:00:00.000Z"), reuniao("m1", "2027-01-20T12:00:00.000Z")],
  pautas: [
    { id: "p2", meetingId: "m1", title: "Estratégia", position: 2 },
    { id: "p1", meetingId: "m1", title: "Finanças", position: 1 },
  ],
  temas: [
    { id: "t2", meetingId: "m1", agendaId: "p1", title: "Orçamento 2027", position: 2 },
    { id: "t1", meetingId: "m1", agendaId: "p1", title: "Resultado Financeiro", position: 1 },
    { id: "t3", meetingId: "m1", agendaId: "p2", title: "Planejamento Estratégico", position: 3 },
    { id: "t4", meetingId: "m2", agendaId: null, title: "Tema antigo", position: 1 },
  ],
  datasSemReuniao: [{ title: "Março (planejada)", startAt: "2027-03-17T12:00:00.000Z", endAt: "2027-03-17T14:00:00.000Z", timezone: "America/Sao_Paulo" }],
  agora: new Date("2026-10-01T12:00:00Z"),
});

test("snapshot: Reunião -> Pauta -> Tema na ordem real; temas sem pauta e datas planejadas preservados", () => {
  assert.equal(snapshot.formato, 1);
  assert.deepEqual(snapshot.reunioes.map((r) => r.meetingId), ["m1", "m2", null]);
  const [jan, fev] = snapshot.reunioes;
  assert.deepEqual(jan!.pautas.map((p) => p.title), ["Finanças", "Estratégia"]);
  assert.deepEqual(jan!.pautas[0]!.temas.map((t) => t.title), ["Resultado Financeiro", "Orçamento 2027"]);
  assert.deepEqual(fev!.temasSemPauta.map((t) => t.title), ["Tema antigo"]);
  assert.deepEqual(totaisDoSnapshot(snapshot), { reunioes: 3, pautas: 2, temas: 4 });
  // Não guarda nada além do necessário (sem participantes, e-mails etc.).
  assert.deepEqual(Object.keys(jan!).sort(), ["endAt", "meetingId", "pautas", "startAt", "temasSemPauta", "timezone", "title"]);
});

test("snapshot é JSON estável e lido de volta; formato desconhecido é recusado", () => {
  assert.deepEqual(lerSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  assert.throws(() => lerSnapshot({ formato: 99, reunioes: [], agenda: AGENDA }));
  assert.throws(() => lerSnapshot(null));
});

test("alteração depois do envio é detectada sem tocar o snapshot (data aprovada x atual)", () => {
  const aprovada = snapshot.reunioes[0]!;
  assert.deepEqual(diferencasAposEnvio(aprovada, { title: aprovada.title, startAt: aprovada.startAt, endAt: aprovada.endAt }), { data: false, titulo: false });
  assert.deepEqual(
    diferencasAposEnvio(aprovada, { title: aprovada.title, startAt: "2027-01-27T12:00:00.000Z", endAt: "2027-01-27T14:00:00.000Z" }),
    { data: true, titulo: false },
  );
  // Mesmo instante em outra grafia ISO não é "alteração".
  assert.equal(diferencasAposEnvio(aprovada, { ...aprovada, startAt: "2027-01-20T12:00:00Z" }).data, false);
  assert.equal(snapshot.reunioes[0]!.startAt, "2027-01-20T12:00:00.000Z");
});

test("associação: mesmo órgão, mesmo ano, fora de outra agenda — origem não importa", () => {
  const agenda = { id: "ag", governanceBodyId: "exec", year: 2027 };
  assert.equal(motivoParaNaoAssociar(agenda, { governanceBodyId: "exec", anoLocal: 2027, annualAgendaId: null }), null);
  assert.equal(motivoParaNaoAssociar(agenda, { governanceBodyId: "exec", anoLocal: 2027, annualAgendaId: "ag" }), null);
  assert.match(motivoParaNaoAssociar(agenda, { governanceBodyId: "aud", anoLocal: 2027, annualAgendaId: null })!, /outro órgão/);
  assert.match(motivoParaNaoAssociar(agenda, { governanceBodyId: "exec", anoLocal: 2026, annualAgendaId: null })!, /2027/);
  assert.match(motivoParaNaoAssociar(agenda, { governanceBodyId: "exec", anoLocal: 2027, annualAgendaId: "outra" })!, /outra Agenda/);
});

test("conteúdo só muda em elaboração; enviada pede retirada; aprovada bloqueia de vez", () => {
  assert.doesNotThrow(() => exigirEmElaboracao("draft"));
  assert.throws(() => exigirEmElaboracao("pending_approval"), (e: unknown) => e instanceof HttpError && e.status === 409 && /Retire-a da aprovação/.test(e.message));
  assert.throws(
    () => exigirEmElaboracao("approved"),
    (e: unknown) => e instanceof HttpError && /Esta versão não pode mais ser alterada\. A gestão operacional das reuniões continua disponível no Pipeline\./.test(e.message),
  );
});

test("tema pela Agenda Anual: só renomear e mover entre pautas (mass assignment recusado)", () => {
  assert.deepEqual(parseTemaPatchDaAgenda({ title: " Novo " , agendaId: "11111111-1111-4111-8111-111111111111" }).title, "Novo");
  for (const campo of ["executionStatus", "responsibleEntraObjectId", "generatesActionItem", "meetingId"]) {
    assert.throws(() => parseTemaPatchDaAgenda({ [campo]: "x" }), HttpError, campo);
  }
});

test("PDF: múltiplas pautas viram grupos (sem 'Pauta:'); ordem do snapshot; numeração contínua", async () => {
  const linhas = reunioesDoPdf(snapshot);
  const c0 = conteudoDaReuniao(linhas[0]!);
  assert.deepEqual(
    c0.grupos.map((g) => [g.titulo, g.temas.map((t) => `${t.numero} ${t.titulo} | ${t.horario}`)]),
    [
      ["Finanças", ["01 Resultado Financeiro | 09:00 · sem duração", "02 Orçamento 2027 | 09:00 · sem duração"]],
      ["Estratégia", ["03 Planejamento Estratégico | 09:00 · sem duração"]],
    ],
  );
  // Só temas sem pauta (legado): um grupo, sem título técnico.
  assert.deepEqual(conteudoDaReuniao(linhas[1]!).grupos.map((g) => g.titulo), [null]);
  // Snapshot muito antigo (tema = só o título): continua funcionando.
  const antigo = conteudoDaReuniao({ ...linhas[1]!, temasSemPauta: ["Tema antigo"] }).grupos[0]!.temas[0]!;
  assert.deepEqual(antigo, { numero: "01", titulo: "Tema antigo", horario: null, responsavel: null, classificacao: null, objetivo: null, participantes: [] });
  assert.equal(linhas[2]!.reservada, false, "data planejada sem reunião");
  const texto = JSON.stringify(c0);
  assert.ok(!/Pauta:/.test(texto));
  assert.match(rotuloDoDocumento({ tipo: "previa" }), /^PRÉVIA — Este documento reflete o estado atual e não representa a versão aprovada\.$/);
  assert.match(
    rotuloDoDocumento({ tipo: "versao", numero: 2, enviadaEm: "2026-10-01T12:00:00Z", enviadaA: "a@b.c", aprovadaEm: "2026-10-02T12:00:00Z", aprovadaPor: "Ana Secretaria" }),
    /^Versão 2 — aprovada em 02\/10\/2026,? 09:00 \(registrada por Ana Secretaria\); enviada em 01\/10\/2026,? 09:00 a a@b\.c\.$/,
  );
  assert.match(rotuloDoDocumento({ tipo: "versao", numero: 1, enviadaEm: "2026-10-01T12:00:00Z", enviadaA: "a@b.c", aprovadaEm: null }), /aguardando aprovação\.$/);
  assert.equal(tipoDoDocumento({ tipo: "previa" }), "AGENDA ANUAL — PRÉVIA");
  assert.equal(tipoDoDocumento({ tipo: "versao", numero: 1, enviadaEm: "x", enviadaA: "y", aprovadaEm: "2026-10-02T12:00:00Z" }), "AGENDA ANUAL — APROVADA");
  assert.ok(!/PRÉVIA/.test(rotuloDoDocumento({ tipo: "versao", numero: 1, enviadaEm: "2026-10-01T12:00:00Z", enviadaA: "a@b.c", aprovadaEm: "2026-10-02T12:00:00Z" })));
  for (const documento of [{ tipo: "previa" as const }, { tipo: "versao" as const, numero: 1, enviadaEm: "2026-10-01T12:00:00Z", enviadaA: "a@b.c", aprovadaEm: null }]) {
    const pdf = await gerarPdfDaAgendaAnual({
      titulo: AGENDA.title, ano: 2027, orgao: AGENDA.governanceBody.name, status: "approved",
      emitidoEm: "2026-10-01T12:00:00Z", reunioes: linhas, documento,
    });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }
});

test("documento da versão sai do snapshot gravado, nunca do estado atual", () => {
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const doc = fonte.slice(fonte.indexOf("export async function gerarDocumentoDaVersao"), fonte.indexOf("export async function solicitarAprovacao"));
  assert.match(doc, /lerSnapshot\(versao\.snapshot\)/);
  assert.ok(!/carregarConteudo|findAnnualAgenda/.test(doc));
  // Aprovar marca a versão ENVIADA; não tira foto nova.
  const aprovar = fonte.slice(fonte.indexOf("export async function registrarAprovacao"), fonte.indexOf("export async function retirarDaAprovacao"));
  assert.ok(!/INSERT INTO annual_agenda_versions|snapshotDoConteudo/.test(aprovar));
  // Associar não chama Outlook.
  const associar = fonte.slice(fonte.indexOf("export async function associarReuniao"), fonte.indexOf("export async function desassociarReuniao"));
  assert.ok(!/syncMeetingCalendar|calendar/i.test(associar.replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("concorrência: conteúdo pela Agenda trava a agenda e executa na MESMA transação", async () => {
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const editar = fonte.slice(fonte.indexOf("export async function editarConteudoPelaAgenda"), fonte.indexOf("export {"));
  // lock -> pertença -> status -> operação, tudo dentro de emTransacao.
  const ordem = ["await emTransacao(", "travarAgenda(client, id)", "exigirReuniaoDaAgenda(client", "exigirEmElaboracao(agenda.status)", "dentroDaTransacao(client"];
  const posicoes = ordem.map((trecho) => editar.indexOf(trecho));
  assert.ok(posicoes.every((p) => p >= 0), "todos os passos presentes");
  assert.deepEqual([...posicoes].sort((a, b) => a - b), posicoes, "na ordem certa");
  // Envio: lock e captura do snapshot na transação; e-mail antes de gravar.
  const enviar = fonte.slice(fonte.indexOf("export async function solicitarAprovacao"), fonte.indexOf("export async function registrarAprovacao"));
  const passos = ["await emTransacao(", "travarAgenda(client, id)", "carregarConteudo(client, id)", "await enviar(", "INSERT INTO annual_agenda_versions", "SET status = 'pending_approval'"];
  const p2 = passos.map((trecho) => enviar.indexOf(trecho));
  assert.ok(p2.every((p) => p >= 0));
  assert.deepEqual([...p2].sort((a, b) => a - b), p2);
  assert.ok(!/carregarConteudo\(pool/.test(enviar), "snapshot não é lido fora da transação");
  // Os módulos de reunião reaproveitam a transação ambiente.
  for (const arq of ["../meetings/agendas.ts", "../meetings/update.ts"]) {
    assert.match(readFileSync(new URL(arq, import.meta.url), "utf8"), /const ambienteAtual = transacaoAmbiente\(\);\s*if \(ambienteAtual\)/);
  }
});

test("transação ambiente: visível só dentro de dentroDaTransacao (inclusive após await)", async () => {
  const { dentroDaTransacao, transacaoAmbiente } = await import("../transacao-ambiente.js");
  const cliente = { marca: "tx" } as unknown as import("pg").PoolClient;
  assert.equal(transacaoAmbiente(), undefined);
  const visto = await dentroDaTransacao(cliente, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return transacaoAmbiente();
  });
  assert.equal(visto, cliente);
  assert.equal(transacaoAmbiente(), undefined);
});

test("visão anual: agrupa reuniões do Calendário por órgão, com ou sem agenda formal", async () => {
  const { agruparVisaoAnual, parseAnoDaVisao } = await import("./service.js");
  const exec = { id: "exec", name: "Comitê Executivo", isActive: true };
  const ag = { id: "ag", name: "Assembleia Geral", isActive: true };
  const reuniao = (id: string, startAt: string, gb: typeof exec, annualAgendaId: string | null = null) => ({
    id, title: id, startAt, endAt: startAt, timezone: "America/Sao_Paulo", status: "scheduled",
    origin: "manual" as const, annualAgendaId, governanceBody: gb,
  });
  const grupos = agruparVisaoAnual(
    [reuniao("m2", "2026-09-24T13:00:00.000Z", exec), reuniao("m1", "2026-08-18T12:00:00.000Z", exec), reuniao("m3", "2026-08-25T18:00:00.000Z", ag)],
    [{ id: "a1", title: "Comitê Executivo", status: "draft", meetingsCount: 0, governanceBody: exec }],
  );
  assert.deepEqual(grupos.map((g) => g.governanceBody.name), ["Assembleia Geral", "Comitê Executivo"]);
  assert.equal(grupos[0]!.agenda, null, "sem agenda formal, mas com reuniões");
  assert.deepEqual(grupos[1]!.meetings.map((m) => m.id), ["m1", "m2"]);
  assert.equal(grupos[1]!.agenda!.id, "a1");
  assert.equal(parseAnoDaVisao("2026"), 2026);
  for (const ruim of [undefined, "", "26", "1999", "2026;DROP", ["2026"]]) assert.throws(() => parseAnoDaVisao(ruim), HttpError);
});

test("órgão + ano: formalizar associa reuniões existentes; Calendário associa as novas; abrir a visão não grava", () => {
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const criar = fonte.slice(fonte.indexOf("export async function createAnnualAgenda"), fonte.indexOf("export async function updateAnnualAgenda"));
  assert.match(criar, /throw new HttpError\(409, MSG_AGENDA_DUPLICADA\)/);
  assert.match(criar, /UPDATE meetings m SET annual_agenda_id = \$1[\s\S]*?m\.annual_agenda_id IS NULL[\s\S]*?AT TIME ZONE m\.timezone/);
  assert.ok(!/syncMeetingCalendar|INSERT INTO meetings/.test(criar), "sem reunião nova nem Outlook");
  const visao = fonte.slice(fonte.indexOf("export async function visaoAnual"), fonte.indexOf("type Executor"));
  assert.ok(!/INSERT|UPDATE|DELETE/.test(visao), "visão somente leitura");
  const rotas = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.ok(rotas.indexOf('get("/overview"') < rotas.indexOf('get<{ id: string }>("/:id"'), "/overview antes de /:id");
  const criarReuniao = readFileSync(new URL("../meetings/create.ts", import.meta.url), "utf8");
  assert.match(criarReuniao, /inserirReuniao\(client, input, actor, \{ origin: "manual", annualAgendaId: null \}\);\s*await associarAAgendaAnualDoOrgaoEAno\(client, meetingId, actor\);/);
  const auto = criarReuniao.slice(criarReuniao.indexOf("export async function associarAAgendaAnualDoOrgaoEAno"));
  assert.match(auto, /a\.governance_body_id = m\.governance_body_id/);
  assert.match(auto, /FOR UPDATE OF a/);
  assert.match(auto, /agenda\.status !== "draft"\) return null/);
  const mig = readFileSync(new URL("../../migrations/029_annual_agenda_body_year_unique.sql", import.meta.url), "utf8");
  assert.match(mig, /CREATE UNIQUE INDEX annual_agendas_body_year_uk ON annual_agendas \(governance_body_id, year\)/);
  assert.match(mig, /RAISE EXCEPTION 'Agendas Anuais duplicadas/);
});

test("novo tema pela Agenda: duração obrigatória; campos fechados; pauta padrão transacional", async () => {
  const { parseNovoTemaDaAgenda, PAUTA_PADRAO } = await import("./service.js");
  const RESP = "11111111-1111-4111-8111-111111111111";
  // NOVO TEMA: cadastro completo, validado pelo mesmo parser do Pipeline.
  const novo = parseNovoTemaDaAgenda({
    title: " Resultado ", durationMinutes: 20, responsibleLabel: "Maria", responsibleEntraObjectId: RESP,
    isCircularTheme: true, description: "Objetivo", participants: [{ displayName: "Ana", email: "ana@exemplo.invalid", participantType: "external" }],
  });
  assert.equal(novo.origem, "novo");
  if (novo.origem === "novo") {
    assert.equal(novo.tema.title, "Resultado");
    assert.equal(novo.tema.durationMinutes, 20);
    assert.equal(novo.tema.responsibleEntraObjectId, RESP);
    assert.equal(novo.tema.isCircularTheme, true);
    assert.equal(novo.participantes.length, 1);
    assert.equal(novo.tema.agendaTopicId, undefined, "o cliente não informa origem: o servidor cria o tema-mestre");
  }
  for (const corpo of [
    { title: "x" }, { title: "x", durationMinutes: 0 }, { title: "x", durationMinutes: 1441 },
    { title: "x", durationMinutes: 20, position: 1 }, { title: "x", durationMinutes: 20, meetingId: "y" },
    { title: "x", durationMinutes: 20, executionStatus: "done" }, { title: "x", durationMinutes: 20, participants: "Ana" },
  ]) {
    assert.throws(() => parseNovoTemaDaAgenda(corpo), HttpError, JSON.stringify(corpo));
  }
  // DA BIBLIOTECA: só o id (+ duração/pauta); o servidor resolve o resto.
  assert.deepEqual(parseNovoTemaDaAgenda({ agendaTopicId: RESP, durationMinutes: 30 }), { origem: "biblioteca", agendaTopicId: RESP, durationMinutes: 30 });
  for (const forjado of ["title", "responsibleEntraObjectId", "agendaTopicTypeId", "participants", "description"]) {
    assert.throws(() => parseNovoTemaDaAgenda({ agendaTopicId: RESP, [forjado]: "x" }), HttpError, forjado);
  }
  assert.ok(PAUTA_PADRAO.length > 0 && PAUTA_PADRAO.length <= 200);
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const criar = fonte.slice(fonte.indexOf("export async function criarTemaNaReuniao"), fonte.indexOf("/** Reordenar pela Agenda"));
  assert.match(criar, /transacaoAmbiente\(\)/, "só dentro da transação da Agenda (lock + status)");
  assert.match(criar, /ORDER BY position, id LIMIT 1/, "reutiliza a primeira pauta");
  // Tema NOVO nasce também na Biblioteca (mesma função da Biblioteca) e a instância
  // é vinculada a ele; participantes do formulário viram participantes padrão.
  assert.match(criar, /const agendaTopicId = await inserirTemaNaBiblioteca\(/);
  assert.match(criar, /addAgendaItem\(meetingId, \{ \.\.\.t, agendaId: pautaId, agendaTopicId \}, actor\)/);
  assert.match(criar, /participants: input\.participantes\.map\(/);
  const rotas = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.match(rotas, /post\("\/:id\/meetings\/:meetingId\/temas", requirePgcpAssessoria, conteudo\(/);
});

test("PDF: pauta padrão escondida; tema com ficha completa; pessoa 'Nome (e-mail)' ou só o nome", async () => {
  const reuniao = {
    titulo: "Reunião Ordinária do Comitê de Pessoas",
    inicioEm: "2026-10-03T11:00:00Z",
    fimEm: "2026-10-03T20:15:00Z",
    fuso: "America/Sao_Paulo",
    reservada: true,
    pautas: [{
      titulo: "Pauta da reunião",
      temas: [
        {
          titulo: "Resultado de finanças", inicio: "08:00", fim: "09:30", duracao: 90,
          responsavel: "André Android", responsavelEmail: "andre@empresa.com",
          tipo: "Pauta Excepcional", natureza: "Deliberativa", circular: false,
          descricao: "Análise dos resultados financeiros\ne principais variações do período.",
          pessoas: [
            { nome: "Adele Vance", email: "adele@empresa.com" },
            { nome: "João Externo", email: "joao@fornecedor.com" },
            { nome: "Sem Email", email: null },
            { nome: "André Android", email: "andre@empresa.com" },
          ],
          participantes: ["Adele Vance", "João Externo", "Sem Email", "André Android"],
        },
        { titulo: "Promoção", inicio: "09:30", fim: "10:00", duracao: 30, responsavel: "Diego", responsavelEmail: null, participantes: ["Diego"] },
      ],
    }],
  };
  const c = conteudoDaReuniao(reuniao);
  assert.equal(c.grupos.length, 1);
  assert.equal(c.grupos[0]!.titulo, null, "pauta padrão (única) não aparece");
  assert.ok(!JSON.stringify(c).includes("Pauta da reunião"));
  const [t1, t2] = c.grupos[0]!.temas;
  assert.deepEqual(t1, {
    numero: "01",
    titulo: "Resultado de finanças",
    horario: "08:00–09:30 · 90 min",
    responsavel: "André Android (andre@empresa.com)",
    classificacao: "Tipo: Pauta Excepcional · Natureza: Deliberativa · Circular: Não",
    objetivo: "Análise dos resultados financeiros\ne principais variações do período.",
    participantes: ["Adele Vance (adele@empresa.com)", "João Externo (joao@fornecedor.com)", "Sem Email", "André Android (andre@empresa.com)"],
  });
  // Snapshot sem e-mail/ficha (anterior a esta versão): só nomes; nada de undefined/null.
  assert.deepEqual([t2!.numero, t2!.responsavel, t2!.classificacao, t2!.objetivo, t2!.participantes], ["02", "Diego", null, null, ["Diego"]]);
  for (const t of [t1, t2]) assert.ok(!/undefined|null/.test(JSON.stringify(Object.values(t!).filter((v) => typeof v === "string"))));
  assert.equal(pessoaComEmail("Ana", "  "), "Ana");
  assert.equal(pessoaComEmail(null, "x@y.com"), "x@y.com");
  assert.equal(pessoaComEmail("x@y.com", "x@y.com"), "x@y.com", "e-mail como nome não duplica");
  assert.equal(formatarTema({ titulo: "Sem horário" }, 9).numero, "10");

  // Muitos temas e participantes: gera sem erro, com quebra de página.
  const muitos = {
    ...reuniao,
    pautas: [{ titulo: "Pauta da reunião", temas: Array.from({ length: 14 }, (_, i) => ({
      ...reuniao.pautas[0]!.temas[0]!, titulo: `Tema ${i + 1}`,
      pessoas: Array.from({ length: 9 }, (_, j) => ({ nome: `Pessoa ${j}`, email: `p${j}@empresa.com` })),
    })) }],
  };
  for (const documento of [undefined, { tipo: "versao" as const, numero: 3, enviadaEm: "2026-10-01T12:00:00Z", enviadaA: "a@b.c", aprovadaEm: "2026-10-02T12:00:00Z", aprovadaPor: null }]) {
    const pdf = await gerarPdfDaAgendaAnual({
      titulo: "Comitê de Pessoas", ano: 2026, orgao: "Comitê de Pessoas", status: "approved",
      emitidoEm: "2026-10-02T12:00:00Z", reunioes: [muitos, reuniao], documento,
    });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length >= 3, "várias páginas");
  }
});

test("snapshot: e-mails dos participantes e do responsável entram como campos OPCIONAIS", () => {
  const s = montarSnapshot({
    agenda: AGENDA,
    reunioes: [{ id: "m1", title: "R", startAt: "2027-01-20T12:00:00Z", endAt: "2027-01-20T14:00:00Z", timezone: "America/Sao_Paulo" }],
    pautas: [],
    temas: [
      { id: "t1", meetingId: "m1", agendaId: null, title: "Novo", position: 1, durationMinutes: 10,
        participantes: ["Ana"], pessoas: [{ nome: "Ana", email: "ana@x.com" }], responsavel: "Ana", responsavelEmail: "ana@x.com" },
      { id: "t2", meetingId: "m1", agendaId: null, title: "Antigo", position: 2 },
    ],
  });
  const [novo, antigo] = s.reunioes[0]!.temasSemPauta;
  assert.deepEqual([novo!.pessoas, novo!.responsavelEmail], [[{ nome: "Ana", email: "ana@x.com" }], "ana@x.com"]);
  assert.ok(!("pessoas" in antigo!) && !("responsavelEmail" in antigo!), "ausente continua ausente");
  assert.equal(s.formato, 1, "mesmo formato: leitores antigos seguem válidos");
  // PDF da versão: só snapshot (sem Graph, sem estado atual).
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const temaDoPdf = fonte.slice(fonte.indexOf("function temaDoPdf"), fonte.indexOf("export function reunioesDoPdf"));
  assert.match(temaDoPdf, /pessoas: t\.pessoas/);
  assert.ok(!/graph|query|pool/i.test(temaDoPdf));
});
