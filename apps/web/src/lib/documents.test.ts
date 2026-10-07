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
        tipo: "anexo", formato: "planilha", favoritos: true, origem: "user", de: "2026-01-01", ate: "2026-12-31", ordem: "nome"
      },
      { limit: 50, offset: 100 }
    )
  );
  assert.deepEqual(Object.fromEntries(q), {
    q: "Promoção outubro pptx", governanceBodyId: ID, meetingId: M, agendaItemId: T, year: "2026", month: "10",
    authorUserId: ID, type: "anexo", format: "planilha", favorites: "true", source: "user", dateFrom: "2026-01-01", dateTo: "2026-12-31", sort: "nome", limit: "50", offset: "100"
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

test("Documentos (tela): lateral + pastas, busca, filtros em chips, Carregar mais; envio só na pasta de reunião", () => {
  const sidebar = codigo("../components/Sidebar.tsx");
  const pipeline = sidebar.indexOf('id: "pipeline"');
  const documentos = sidebar.indexOf('id: "documents"');
  const biblioteca = sidebar.indexOf('id: "unlinked-agendas"');
  assert.ok(pipeline < documentos && documentos < biblioteca, "Pipeline → Documentos → Biblioteca de Temas");
  const tela = codigo("../components/DocumentsView.tsx");
  for (const texto of [
    "Encontre os arquivos relacionados às reuniões, temas e órgãos colegiados do PGCP.",
    '"Pesquisar na Biblioteca"', '"Órgão colegiado"', '"Tipo"', '"Reunião"', '"Tema da reunião"', '"Origem"', '"Emitido/enviado por"',
    '"Pessoas"', '"Modificado"', '"Data do documento"', '"Mais recentes"', '"Nome Z–A"', '"Carregar mais"', '"Pastas"',
    '"Arquivos"', '"Documentos da reunião"', '"Temas"', '"Ata"', '"Novo"', '"Recentes"', '"Favoritos"', '"Armazenamento"',
    '"Blocos"', '"Lista"'
  ]) {
    assert.ok(tela.includes(texto), texto);
  }
  assert.match(tela, /getDocumentsTree\(orgaoContexto/);
  assert.match(tela, /orgao: orgaoContexto \|\| f\.orgao/, "órgão do contexto global tem precedência");
  assert.match(tela, /disabled: Boolean\(orgaoContexto\)/, "órgão travado pelo contexto global");
  assert.match(tela, /lg:hidden/, "árvore vira gaveta no celular");
  // Envio: reaproveita o MESMO diálogo do Pipeline, só na pasta de uma reunião ATIVA e com permissão.
  assert.ok(!/type="file"|uploadMeetingDocument/.test(tela), "sem mecanismo de upload próprio");
  assert.match(tela, /<UploadDocumentModal/);
  assert.match(tela, /const podeEnviar = canUpload && reuniaoParaEnvio !== null;/);
  assert.match(tela, /pasta\.tipo === "reuniao" && meetings\.some\(\(m\) => m\.id === pasta\.reuniaoId\)/);
  // Sem conceito no banco: nada de Nova pasta nem Lixeira (decisão pendente).
  assert.ok(!/Nova pasta|Lixeira|Trash/.test(tela));
  // Nome de arquivo é TEXTO (sem HTML cru) e não há preview carregando arquivo.
  assert.ok(!/dangerouslySetInnerHTML|<iframe|<img/.test(tela));
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

test("Drive: subpastas do local atual vêm da MESMA árvore derivada", async () => {
  const { pastasFilhas } = await import("./documents-rules");
  const arvore = {
    bodies: [{
      id: "b1", name: "Comitê de Pessoas", total: 5,
      years: [{
        year: 2026,
        annualAgendas: [{ id: "a1", title: "Plano", total: 1 }],
        months: [{ month: 10, meetings: [{ id: "r1", title: "Reunião", startAt: "2026-10-15T12:00:00Z", timezone: "America/Sao_Paulo", releasedToPipeline: true, total: 4 }] }]
      }]
    }]
  };
  assert.deepEqual(pastasFilhas({ tipo: "todos" }, arvore, "pt").map((p) => [p.nome, p.total]), [["Comitê de Pessoas", 5]]);
  assert.deepEqual(pastasFilhas({ tipo: "orgao", orgaoId: "b1" }, arvore, "pt").map((p) => [p.nome, p.total]), [["2026", 5]]);
  assert.deepEqual(pastasFilhas({ tipo: "ano", orgaoId: "b1", ano: 2026 }, arvore, "pt").map((p) => p.nome), ["Agenda Anual — Plano", "Outubro"]);
  assert.deepEqual(pastasFilhas({ tipo: "mes", orgaoId: "b1", ano: 2026, mes: 10 }, arvore, "pt").map((p) => p.nome), ["15/10 — Reunião"]);
  assert.deepEqual(pastasFilhas({ tipo: "reuniao", orgaoId: "b1", ano: 2026, mes: 10, reuniaoId: "r1" }, arvore, "pt"), []);
  assert.deepEqual(pastasFilhas({ tipo: "orgao", orgaoId: "outro" }, arvore, "pt"), [], "pasta fora da árvore visível: nada");
  assert.deepEqual(pastasFilhas({ tipo: "todos" }, null, "pt"), []);
});

test("Drive: breadcrumb clicável leva a cada nível anterior", async () => {
  const { trilhaNavegavel } = await import("./documents-rules");
  const arvore = { bodies: [{ id: "b1", name: "Comitê de Pessoas", total: 1, years: [{ year: 2026, annualAgendas: [], months: [{ month: 10, meetings: [{ id: "r1", title: "Reunião", startAt: "2026-10-15T12:00:00Z", timezone: "America/Sao_Paulo", releasedToPipeline: true, total: 1 }] }] }] }] };
  const t = trilhaNavegavel({ tipo: "reuniao", orgaoId: "b1", ano: 2026, mes: 10, reuniaoId: "r1" }, arvore, "pt");
  assert.deepEqual(t.map((x) => x.rotulo), ["Biblioteca", "Comitê de Pessoas", "2026", "Outubro", "15/10 — Reunião"]);
  assert.deepEqual(t.map((x) => x.pasta.tipo), ["todos", "orgao", "ano", "mes", "reuniao"]);
  assert.deepEqual(trilhaNavegavel({ tipo: "todos" }, arvore, "pt").map((x) => x.rotulo), ["Biblioteca"]);
});

test("Drive: Modificado vira intervalo (dia de Brasília); Recentes/Favoritos ignoram a pasta", async () => {
  const { periodoDoModificado, filtrosDaVisao, FILTROS_INICIAIS } = await import("./documents-rules");
  assert.deepEqual(periodoDoModificado("hoje", "2026-10-06"), { de: "2026-10-06", ate: "2026-10-06" });
  assert.deepEqual(periodoDoModificado("7d", "2026-10-06"), { de: "2026-09-30", ate: "2026-10-06" });
  assert.deepEqual(periodoDoModificado("30d", "2026-03-01"), { de: "2026-01-31", ate: "2026-03-01" });
  assert.deepEqual(periodoDoModificado("ano", "2026-10-06"), { de: "2026-01-01", ate: "2026-10-06" });
  assert.equal(periodoDoModificado("personalizado", "2026-10-06"), null);
  assert.equal(periodoDoModificado("", "2026-10-06"), null);
  const naPasta = { ...FILTROS_INICIAIS, reuniao: "r1", ano: "2026", mes: "10", ordem: "nome" as const, formato: "pdf" as const };
  const recentes = filtrosDaVisao("recentes", naPasta);
  assert.deepEqual([recentes.reuniao, recentes.ano, recentes.ordem, recentes.favoritos, recentes.formato], ["", "", "recentes", false, "pdf"]);
  const favoritos = filtrosDaVisao("favoritos", naPasta);
  assert.deepEqual([favoritos.reuniao, favoritos.favoritos, favoritos.ordem], ["", true, "nome"]);
  assert.equal(filtrosDaVisao("biblioteca", { ...naPasta, favoritos: true }).favoritos, false);
});

test("Drive: armazenamento e favoritos pelo servidor; preferência Blocos/Lista só em estado local", () => {
  const cliente = codigo("./documents.ts");
  assert.match(cliente, /`\/documents\/\$\{encodeURIComponent\(id\)\}\/favorite`, \{ auth: true, method: favorito \? "PUT" : "DELETE" \}/);
  assert.match(cliente, /`\/documents\/storage\$\{q\}`/);
  const tela = codigo("../components/DocumentsView.tsx");
  assert.match(tela, /useState<"blocos" \| "lista">\("blocos"\)/);
  assert.ok(!/localStorage/.test(tela));
  // Sem capacidade inventada (nenhum "100 GB", "de 15 GB usados" etc.).
  assert.ok(!/\b\d+(?:[.,]\d+)?\s?(GB|TB)\b/i.test(tela));
});
