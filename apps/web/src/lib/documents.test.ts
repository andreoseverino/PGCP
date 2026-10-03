import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  consultaDosFiltros,
  dataNoFuso,
  destinoDoContexto,
  FILTROS_INICIAIS,
  filtrosDaPasta,
  idDoAnexo,
  mensagemDeVazio,
  problemaNoArquivo,
  rotuloDaOrigem,
  rotuloDaReuniaoNaArvore,
  rotuloDoTipo,
  secoesDaReuniao,
  tamanhoLegivel,
  trilhaDaPasta,
  type ArvoreDeDocumentos,
  type DocumentoDoPgcp
} from "./documents-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";

test("Documentos: filtros viram query só com o que foi preenchido; padrão = mais recentes", () => {
  assert.equal(consultaDosFiltros(FILTROS_INICIAIS, { limit: 50, offset: 0 }), "limit=50");
  const q = new URLSearchParams(
    consultaDosFiltros(
      {
        busca: " Promoção outubro pptx ", orgao: ID, reuniao: M, tema: T, agenda: "", ano: "2026", mes: "10", pessoa: ID,
        tipo: "anexo", origem: "user", de: "2026-01-01", ate: "2026-12-31", ordem: "nome"
      },
      { limit: 50, offset: 100 }
    )
  );
  assert.deepEqual(Object.fromEntries(q), {
    q: "Promoção outubro pptx", governanceBodyId: ID, meetingId: M, agendaItemId: T, year: "2026", month: "10",
    authorUserId: ID, type: "anexo", source: "user", dateFrom: "2026-01-01", dateTo: "2026-12-31", sort: "nome", limit: "50", offset: "100"
  });
});

test("Documentos: pasta da árvore vira filtro de contexto (ano/mês DA REUNIÃO, sem nível Dia)", () => {
  const base = { ...FILTROS_INICIAIS, busca: "ata", tipo: "anexo" as const, tema: T, reuniao: M };
  assert.deepEqual(filtrosDaPasta({ tipo: "todos" }, base), { ...base, reuniao: "", tema: "" });
  const mes = filtrosDaPasta({ tipo: "mes", orgaoId: ID, ano: 2026, mes: 10 }, base);
  assert.deepEqual([mes.orgao, mes.ano, mes.mes, mes.reuniao, mes.tema, mes.busca, mes.tipo, mes.de], [ID, "2026", "10", "", "", "ata", "anexo", ""]);
  const reuniao = filtrosDaPasta({ tipo: "reuniao", orgaoId: ID, ano: 2026, mes: 10, reuniaoId: M }, base);
  assert.deepEqual([reuniao.reuniao, reuniao.tema, reuniao.ano], [M, T, ""], "tema vale dentro da própria reunião");
  const outra = filtrosDaPasta({ tipo: "reuniao", orgaoId: ID, ano: 2026, mes: 10, reuniaoId: ID }, base);
  assert.equal(outra.tema, "", "tema de outra reunião é descartado");
  const agenda = filtrosDaPasta({ tipo: "agenda", orgaoId: ID, ano: 2027, agendaId: T }, base);
  assert.deepEqual([agenda.agenda, agenda.ano, agenda.reuniao], [T, "", ""]);

  const arvore: ArvoreDeDocumentos = {
    bodies: [{
      id: ID, name: "Comitê de Pessoas", total: 3,
      years: [{
        year: 2026, annualAgendas: [{ id: T, title: "Plano 2026", total: 1 }],
        months: [{ month: 10, meetings: [{ id: M, title: "Reunião Ordinária", startAt: "2026-10-15T13:00:00Z", timezone: "America/Sao_Paulo", releasedToPipeline: true, total: 2 }] }]
      }]
    }]
  };
  assert.deepEqual(trilhaDaPasta({ tipo: "reuniao", orgaoId: ID, ano: 2026, mes: 10, reuniaoId: M }, arvore, "pt"), [
    "Comitê de Pessoas", "2026", "Outubro", "15/10 — Reunião Ordinária"
  ]);
  assert.deepEqual(trilhaDaPasta({ tipo: "agenda", orgaoId: ID, ano: 2026, agendaId: T }, arvore, "pt"), ["Comitê de Pessoas", "2026", "Plano 2026"]);
  assert.deepEqual(trilhaDaPasta({ tipo: "todos" }, arvore, "pt"), ["Todos os documentos"]);
  assert.equal(rotuloDaReuniaoNaArvore({ title: "R", startAt: "2026-11-01T01:00:00Z", timezone: "America/Sao_Paulo" }), "31/10 — R", "fuso da reunião");
});

const doc = (extra: Partial<DocumentoDoPgcp>): DocumentoDoPgcp => ({
  id: `doc:${T}`, type: "anexo", source: "user", name: "Proposta.pptx", extension: "pptx", sizeBytes: 1_500_000, description: null,
  status: "Enviado por usuário", governanceBody: { id: ID, name: "Comitê" },
  meeting: { id: M, title: "R", startAt: "2026-10-15T13:00:00Z", timezone: "America/Sao_Paulo", annualAgendaId: null, releasedToPipeline: true },
  topic: null, annualAgenda: null, author: { id: ID, name: "Ana" }, documentAt: "2026-10-01T12:00:00Z", ...extra
});

test("Documentos: seções da reunião (inteira / por tema / Ata); id do anexo; rótulos", () => {
  const geral = doc({ id: "doc:a" });
  const doTema1 = doc({ id: "doc:b", topic: { id: "t1", title: "Promoção" } });
  const doTema1b = doc({ id: "doc:c", topic: { id: "t1", title: "Promoção" } });
  const doTema2 = doc({ id: "doc:d", topic: { id: "t2", title: "Orçamento" } });
  const ata = doc({ id: `ata:${M}`, type: "ata", source: "pgcp", extension: "pdf", sizeBytes: null });
  const s = secoesDaReuniao([geral, doTema1, ata, doTema2, doTema1b]);
  assert.deepEqual(s.gerais.map((d) => d.id), ["doc:a"]);
  assert.deepEqual(s.temas.map((t) => [t.tema.title, t.docs.map((d) => d.id)]), [["Promoção", ["doc:b", "doc:c"]], ["Orçamento", ["doc:d"]]]);
  assert.deepEqual(s.atas.map((d) => d.id), [`ata:${M}`]);
  assert.equal(idDoAnexo(geral), "a");
  assert.equal(idDoAnexo(ata), null, "Ata baixa pela rota de origem");
  assert.equal(tamanhoLegivel(1_500_000), "1,4 MB");
  assert.equal(tamanhoLegivel(2048), "2 KB");
  assert.equal(tamanhoLegivel(null), "—");
  assert.equal(rotuloDoTipo("anexo", "pt"), "Anexo");
  assert.equal(rotuloDaOrigem("pgcp", "pt"), "Gerado pelo PGCP");
  assert.equal(rotuloDaOrigem("user", "pt"), "Enviado por usuário");
});

test("Documentos: pré-validação do envio (a decisão final é do servidor)", () => {
  assert.equal(problemaNoArquivo({ name: "Proposta.pptx", size: 10 }, "pt"), null);
  assert.equal(problemaNoArquivo({ name: "ata.PDF", size: 10 }, "pt"), null);
  assert.equal(problemaNoArquivo({ name: "vazio.pdf", size: 0 }, "pt"), "O arquivo está vazio.");
  for (const nome of ["virus.exe", "pagina.html", "macro.pptm", "sem-extensao", "relatorio.pdf.exe"]) {
    assert.match(problemaNoArquivo({ name: nome, size: 10 }, "pt") ?? "", /não permitido/, nome);
  }
});

test("Documentos: contexto respeita a liberação do Pipeline; vazio distingue filtro de 'nada ainda'", () => {
  const reuniao = (releasedToPipeline: boolean) => ({ id: "m", title: "R", startAt: "2027-01-20T12:00:00Z", timezone: "America/Sao_Paulo", annualAgendaId: "a", releasedToPipeline });
  assert.equal(destinoDoContexto({ meeting: reuniao(true), annualAgenda: null }), "pipeline");
  assert.equal(destinoDoContexto({ meeting: reuniao(false), annualAgenda: null }), "annual-agenda", "Agenda não aprovada: vai à Agenda Anual");
  assert.equal(destinoDoContexto({ meeting: null, annualAgenda: { id: "a", year: 2027, version: 1 } }), "annual-agenda");
  assert.equal(mensagemDeVazio(FILTROS_INICIAIS, "", "pt"), "Nenhum documento foi adicionado ao PGCP ainda.");
  assert.equal(mensagemDeVazio({ ...FILTROS_INICIAIS, tipo: "ata" }, "", "pt"), "Nenhum documento encontrado com estes filtros.");
  assert.equal(mensagemDeVazio(FILTROS_INICIAIS, ID, "pt"), "Nenhum documento encontrado com estes filtros.", "órgão do contexto conta como filtro");
  assert.equal(dataNoFuso("2027-01-01T01:00:00Z", "America/Sao_Paulo"), "31/12/2026", "fuso da reunião, não da máquina");
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("Documentos (tela): árvore + painel, busca global, filtros, Carregar mais; sem upload na biblioteca", () => {
  const sidebar = codigo("../components/Sidebar.tsx");
  const pipeline = sidebar.indexOf('id: "pipeline"');
  const documentos = sidebar.indexOf('id: "documents"');
  const biblioteca = sidebar.indexOf('id: "unlinked-agendas"');
  assert.ok(pipeline < documentos && documentos < biblioteca, "Pipeline → Documentos → Biblioteca de Temas");
  const tela = codigo("../components/DocumentsView.tsx");
  for (const texto of [
    "Encontre os arquivos relacionados às reuniões, temas e órgãos colegiados do PGCP.",
    '"Buscar documento"', '"Órgão colegiado"', '"Tipo"', '"Reunião"', '"Tema da reunião"', '"Origem"', '"Emitido/enviado por"',
    '"Data do documento"', '"Mais recentes"', '"Carregar mais"', '"Pastas"', '"Documentos da reunião"', '"Temas"', '"Ata"'
  ]) {
    assert.ok(tela.includes(texto), texto);
  }
  assert.match(tela, /getDocumentsTree\(orgaoContexto/);
  assert.match(tela, /orgao: orgaoContexto \|\| f\.orgao/, "órgão do contexto global tem precedência");
  assert.match(tela, /disabled=\{Boolean\(orgaoContexto\)\}/);
  assert.match(tela, /lg:hidden/, "árvore vira gaveta no celular");
  assert.ok(!/type="file"|uploadMeetingDocument/.test(tela), "enviar é no Pipeline, não na biblioteca");
  const cliente = codigo("./documents.ts");
  assert.match(cliente, /`\/documents\/\$\{encodeURIComponent\(anexo\)\}\/download`/, "anexo baixa pela API (sem URL do S3)");
  assert.match(cliente, /downloadMeetingMinutesPdf\(d\.meeting\.id\)/);
  assert.match(cliente, /downloadAnnualAgendaDocument\(d\.annualAgenda\.id\)/);
  assert.match(cliente, /"Content-Type": "application\/octet-stream"/);
  assert.match(cliente, /"X-Document-Filename": encodeURIComponent\(arquivo\.name\)/);
  assert.ok(!/objectKey|object_key|amazonaws|s3:\/\//i.test(cliente + tela), "nenhuma chave/URL do bucket no navegador");
  const app = codigo("../App.tsx");
  assert.match(app, /case "documents":/);
  assert.match(app, /onOpenMeeting=\{\(meetingId\) => void openMeetingById\(meetingId\)\}/);
});

test("Pipeline → Documentos: aba Documentos e botão do tema abrem o MESMO diálogo", () => {
  const detalhe = codigo("../components/MeetingDetailView.tsx");
  const abas = ["\"Overview\"", "\"Agendas\"", "\"Participants\"", "\"Documents\"", "\"Minutes\"", "\"Fup\""].map((a) => detalhe.indexOf(`{ id: ${a}`));
  assert.ok(abas.every((p, i) => p > 0 && (i === 0 || p > abas[i - 1]!)), "Resumo / Temas / Participantes / Documentos / Ata / FUP");
  assert.match(detalhe, /onAdd=\{\(\) => setEnvioDeDocumento\(null\)\}/, "reunião inteira");
  assert.match(detalhe, /setEnvioDeDocumento\(ag\.id\)/, "tema DESTA reunião (meeting_agenda_item)");
  assert.equal(detalhe.match(/<UploadDocumentModal/g)?.length, 1, "um diálogo só");
  assert.match(detalhe, /canSchedule && meeting\.releasedToPipeline !== false/);
  const modal = codigo("../components/UploadDocumentModal.tsx");
  assert.match(modal, /agendaItemId: contexto === "tema" \? tema : null/);
  assert.match(modal, /accept=\{ACCEPT_DO_INPUT\}/);
});
