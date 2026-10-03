import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  consultaDosFiltros,
  dataNoFuso,
  destinoDoContexto,
  FILTROS_INICIAIS,
  mensagemDeVazio,
  rotuloDoTipo
} from "./documents-rules";

const ID = "11111111-1111-4111-8111-111111111111";

test("Documentos: filtros viram query só com o que foi preenchido; padrão = mais recentes", () => {
  assert.equal(consultaDosFiltros(FILTROS_INICIAIS, { limit: 50, offset: 0 }), "limit=50");
  const q = new URLSearchParams(
    consultaDosFiltros(
      { busca: " Promoção ", orgao: ID, reuniao: ID, tema: ID, pessoa: ID, tipo: "ata", de: "2026-01-01", ate: "2026-12-31", ordem: "nome" },
      { limit: 50, offset: 100 }
    )
  );
  assert.deepEqual(Object.fromEntries(q), {
    q: "Promoção", governanceBodyId: ID, meetingId: ID, topicId: ID, authorUserId: ID, type: "ata",
    dateFrom: "2026-01-01", dateTo: "2026-12-31", sort: "nome", limit: "50", offset: "100"
  });
});

test("Documentos: contexto respeita a liberação do Pipeline; vazio distingue filtro de 'nada ainda'", () => {
  const reuniao = (releasedToPipeline: boolean) => ({ id: "m", title: "R", startAt: "2027-01-20T12:00:00Z", timezone: "America/Sao_Paulo", annualAgendaId: "a", releasedToPipeline });
  assert.equal(destinoDoContexto({ meeting: reuniao(true), annualAgenda: null }), "pipeline");
  assert.equal(destinoDoContexto({ meeting: reuniao(false), annualAgenda: null }), "annual-agenda", "Agenda não aprovada: vai à Agenda Anual");
  assert.equal(destinoDoContexto({ meeting: null, annualAgenda: { id: "a", year: 2027, version: 1 } }), "annual-agenda");
  assert.equal(mensagemDeVazio(FILTROS_INICIAIS, "", "pt"), "Nenhum documento foi adicionado ao PGCP ainda.");
  assert.equal(mensagemDeVazio({ ...FILTROS_INICIAIS, tipo: "ata" }, "", "pt"), "Nenhum documento encontrado com estes filtros.");
  assert.equal(mensagemDeVazio(FILTROS_INICIAIS, ID, "pt"), "Nenhum documento encontrado com estes filtros.", "órgão do contexto conta como filtro");
  assert.equal(rotuloDoTipo("ata", "pt"), "Ata");
  assert.equal(rotuloDoTipo("agenda_anual", "pt"), "Agenda Anual");
  assert.equal(dataNoFuso("2027-01-01T01:00:00Z", "America/Sao_Paulo"), "31/12/2026", "fuso da reunião, não da máquina");
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("Documentos (tela): sidebar, cabeçalho, filtros, tabela; download pela rota de origem; sem upload", () => {
  const sidebar = codigo("../components/Sidebar.tsx");
  const pipeline = sidebar.indexOf('id: "pipeline"');
  const documentos = sidebar.indexOf('id: "documents"');
  const biblioteca = sidebar.indexOf('id: "unlinked-agendas"');
  assert.ok(pipeline < documentos && documentos < biblioteca, "Pipeline → Documentos → Biblioteca de Temas");
  const tela = codigo("../components/DocumentsView.tsx");
  for (const texto of [
    "Encontre os arquivos relacionados às reuniões, temas e órgãos colegiados do PGCP.",
    '"Buscar documento"', '"Órgão colegiado"', '"Tipo"', '"Reunião"', '"Tema da reunião"', '"Emitido por"', '"Gerado pelo PGCP"', '"Data do documento"',
    '"Documento"', '"Mais recentes"', '"Carregar mais"'
  ]) {
    assert.ok(tela.includes(texto), texto);
  }
  // Órgão do contexto global filtra (não autoriza): tem precedência e trava o seletor local.
  assert.match(tela, /orgao: orgaoContexto \|\| filtros\.orgao/);
  assert.match(tela, /disabled=\{Boolean\(orgaoContexto\)\}/);
  assert.match(tela, /downloadDocument\(d\)/);
  assert.ok(!/type="file"|FormData|multipart/i.test(tela), "sem envio de arquivo nesta versão");
  const cliente = codigo("./documents.ts");
  assert.match(cliente, /downloadMeetingMinutesPdf\(d\.meeting\.id\)/);
  assert.match(cliente, /downloadAnnualAgendaDocument\(d\.annualAgenda\.id\)/);
  const app = codigo("../App.tsx");
  assert.match(app, /case "documents":/);
  assert.match(app, /onOpenMeeting=\{\(meetingId\) => void openMeetingById\(meetingId\)\}/);
});
