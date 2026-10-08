import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  abrirEdicaoTema,
  abrirNovoTema,
  confirmacaoExclusaoTema,
  idEmEdicao,
  MODAL_FECHADO,
  modalAberto,
  tituloDoModalTema
} from "./topic-library-modal";

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("modal só abre com tema selecionado; fechado não tem tema em edição", () => {
  assert.equal(modalAberto(MODAL_FECHADO), false);
  assert.equal(idEmEdicao(MODAL_FECHADO), null);
  assert.equal(modalAberto(abrirEdicaoTema(null)), false);
  assert.equal(modalAberto(abrirEdicaoTema("")), false);
  const editar = abrirEdicaoTema("t1");
  assert.equal(modalAberto(editar), true);
  assert.equal(idEmEdicao(editar), "t1");
  assert.equal(idEmEdicao(abrirNovoTema()), null);
});

test("título do modal: Novo tema / Editar tema", () => {
  assert.equal(tituloDoModalTema(abrirNovoTema(), "pt"), "Novo tema");
  assert.equal(tituloDoModalTema(abrirEdicaoTema("t1"), "pt"), "Editar tema");
});

test("Biblioteca: formulário existe só dentro do modal; cancelar/salvar fecham e limpam", () => {
  const tela = codigo("../components/UnlinkedAgendasView.tsx");
  // Um único <form> de cadastro, renderizado apenas com o modal aberto.
  assert.equal((tela.match(/<form onSubmit=\{handleSubmit\}/g) ?? []).length, 1);
  const iModal = tela.indexOf("{modalAberto(modal) && createPortal(");
  assert.ok(iModal > 0 && tela.indexOf("<form onSubmit={handleSubmit}") > iModal);
  assert.match(tela, /role="dialog"/);
  assert.match(tela, /max-h-\[90vh\]/);
  // Layout: portal no <body>, fundo só desfocado (sem escurecer), duas colunas.
  assert.match(tela, /createPortal\([\s\S]*?document\.body/);
  const overlay = tela.slice(iModal, tela.indexOf('role="dialog"', iModal));
  assert.match(overlay, /backdrop-blur/);
  assert.ok(!/bg-(black|slate-900)/.test(overlay), "sem fundo escuro");
  assert.match(tela, /md:grid-cols-\[minmax\(0,1fr\)_minmax\(0,320px\)\]/);
  // Participantes na coluna direita, dentro do form (antes do rodapé).
  const iAside = tela.indexOf('aria-labelledby="tema-participantes-titulo"');
  assert.ok(iAside > tela.indexOf('id="agendaDescInput"'), "depois do formulário principal");
  assert.ok(iAside < tela.indexOf("{t.btnCancel}"), "antes do rodapé");
  assert.match(tela, /"Participantes do tema"/);
  assert.ok(!/Participantes da pauta/i.test(tela));
  // Cancelar/fechar: estado limpo.
  assert.match(tela, /const fecharModal = \(\) => \{\s*setModal\(MODAL_FECHADO\);[\s\S]*?limparFormulario\(\);/);
  // Salvar: usa o fluxo atual (callbacks de App) e fecha.
  assert.match(tela, /onUpdateStandaloneAgenda\(editingId, input\);[\s\S]*?onAddStandaloneAgenda\(input\);\s*\}\s*fecharModal\(\);/);
  // Editar só abre depois de carregar o detalhe do tema.
  assert.match(tela, /await getAgendaTopic\(agenda\.id\)[\s\S]*?setModal\(abrirEdicaoTema\(agenda\.id\)\)/);
  assert.ok(!/window\.prompt/.test(tela));
});

test("Biblioteca fala Tema: nenhum texto visível com Pauta/Pautas fora do conceito da reunião", () => {
  const tela = codigo("../components/UnlinkedAgendasView.tsx");
  const literais = [...tela.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
  const comPauta = literais.filter((l) => /\bpautas?\b/i.test(l) && !/pauta de uma reunião/.test(l));
  assert.deepEqual(comPauta, []);
  for (const esperado of ["Novo tema", "Editar tema", "Excluir tema", "Nome do tema", "Temas cadastrados", "Biblioteca de Temas"]) {
    assert.ok(tela.includes(`"${esperado}"`), esperado);
  }
  const app = codigo("../App.tsx");
  assert.match(app, /Tema "\$\{criada\.title\}" registrado na Biblioteca\./);
  assert.match(app, /"Tema removido da Biblioteca\."/);
});

test("contexto global: sem badge nas páginas; seletor no cabeçalho (desktop e mobile)", () => {
  const app = codigo("../App.tsx");
  assert.ok(!/GovernanceContextBar|Órgão colegiado atual/.test(app));
  assert.match(app, /id="contexto-orgao"/);
  assert.match(app, /mobileHeaderExtra=\{[\s\S]*?id="contexto-orgao-mobile"/);
  assert.match(codigo("../components/Sidebar.tsx"), /\{mobileHeaderExtra\}/);
});

test("excluir tema: confirmação com o nome do tema e botão descritivo", () => {
  const c = confirmacaoExclusaoTema("Resultado Financeiro", "pt");
  assert.equal(c.titulo, "Excluir tema da Biblioteca?");
  assert.match(c.paragrafos[0], /O tema “Resultado Financeiro” será removido da Biblioteca de Temas\./);
  assert.match(c.paragrafos[1], /não poderá ser desfeita/);
  assert.equal(c.acao, "Excluir tema");
  assert.ok(![c.titulo, ...c.paragrafos, c.acao].some((t) => /pauta/i.test(t)));
});

test("excluir tema: clique só abre a confirmação; Cancelar não exclui; Confirmar exclui", () => {
  const tela = codigo("../components/UnlinkedAgendasView.tsx");
  // O botão da lista prepara a confirmação, não chama a exclusão.
  assert.match(tela, /onClick=\{\(\) => setTemaParaExcluir\(agenda\)\}/);
  assert.equal((tela.match(/onDeleteStandaloneAgenda\(/g) ?? []).length, 1, "um único ponto de exclusão");
  assert.match(tela, /const confirmarExclusao = async \(\) => \{[\s\S]*?await onDeleteStandaloneAgenda\(temaParaExcluir\.id\)/);
  assert.match(tela, /confirmacao=\{confirmacaoExclusaoTema\(temaParaExcluir\.title, language\)\}/);
  assert.match(tela, /onCancel=\{\(\) => setTemaParaExcluir\(null\)\}/);
  assert.match(tela, /onConfirm=\{\(\) => void confirmarExclusao\(\)\}/);
  assert.ok(!/window\.confirm/.test(tela));
  // Diálogo: Cancelar, X e Esc só chamam onCancel (X e Esc pela casca padrão).
  const dialogo = codigo("../components/ConfirmRemovalDialog.tsx");
  assert.match(dialogo, /<ModalShell[\s\S]*?onClose=\{onCancel\}/);
  assert.equal((dialogo.match(/onClick=\{onCancel\}/g) ?? []).length, 1, "Cancelar");
  const casca = codigo("../components/ModalShell.tsx");
  assert.match(casca, /e\.key === "Escape" && !ocupado\) onClose\(\)/);
  assert.match(casca, /onClick=\{onClose\}/, "X");
  assert.equal((dialogo.match(/onConfirm/g) ?? []).length, 3, "prop, desestruturação e botão de confirmar");
});

test("tema vinculado: regra continua no backend (409 vira toast no App)", () => {
  const app = codigo("../App.tsx");
  const bloco = app.slice(app.indexOf("const handleDeleteStandaloneAgenda"), app.indexOf("const startSession"));
  assert.match(bloco, /await apiDeleteAgendaTopic\(id\)/);
  assert.match(bloco, /catch \(error\) \{\s*triggerToast\(describeTopicError\(error, language\)\)/);
  assert.match(bloco, /triggerToast\("Tema removido da Biblioteca\."\)/);
  const api = readFileSync(new URL("../../../api/src/agenda-topics/write.ts", import.meta.url), "utf8");
  assert.match(api, /Este tema está vinculado a \$\{rows\[0\]!\.vinculos\} reunião\(ões\) e não pode ser excluído\./);
});

test("excluir reunião: a Biblioteca guarda temas, não pautas", () => {
  const app = codigo("../App.tsx");
  assert.match(app, /"Os temas utilizados na reunião continuam disponíveis na Biblioteca de Temas\."/);
  assert.ok(!/pautas continuam disponíveis na Biblioteca/i.test(app));
});

test("Biblioteca: sem 'Tema de FUP' no cadastro; demais campos mantidos; edição preserva FUP gravado", () => {
  const tela = codigo("../components/UnlinkedAgendasView.tsx");
  assert.ok(!/Classificar como Tema de FUP|acompanhamento contínuo da secretaria|isFupForm|isFupCheckbox/.test(tela));
  for (const id of ["agendaTitleInput", "agendaPautaTypeInput", "agendaPautaNatureInput", "agendaCircularInput", "agendaDescInput"]) {
    assert.ok(tela.includes(`id="${id}"`), id);
  }
  // O submit não envia FUP; o botão de FUP da lista continua (outro fluxo).
  const submit = tela.slice(tela.indexOf("const handleSubmit"), tela.indexOf("const limparFormulario"));
  assert.ok(!/generatesActionItem/.test(submit));
  // Bandeira da lista: handler próprio, PATCH parcial (buildTopicFupPatch).
  assert.match(tela, /onToggleTopicFup\(agenda\.id, !agenda\.isFUP\)/);
  assert.ok(!/onUpdateStandaloneAgenda\(agenda\.id/.test(tela), "bandeira não usa o update do formulário");
  const app = codigo("../App.tsx");
  assert.match(app, /updateAgendaTopic\(id, buildTopicFupPatch\(marcado\)\)/);
  assert.match(app, /onToggleTopicFup=\{handleToggleTopicFup\}/);
  // Formulário: buildTopicPayload não emite FUP.
  const adapter = codigo("./agenda-topic-adapters.ts");
  const montador = adapter.slice(adapter.indexOf("export function buildTopicPayload"));
  assert.ok(!/generatesActionItem/.test(montador));
});

test("header global: único, sticky, com busca, órgão colegiado e usuário", () => {
  const app = codigo("../App.tsx");
  assert.equal((app.match(/sticky top-0 z-40/g) ?? []).length, 1, "um único header sticky");
  const ini = app.indexOf("sticky top-0 z-40");
  const header = app.slice(ini, app.indexOf("{renderTabContent()}", ini));
  assert.match(header, /rounded-2xl/);
  assert.match(header, /placeholder=\{language === "en" \? "Search meetings\.\.\." : "Buscar reuniões\.\.\."\}/);
  assert.match(header, /id="contexto-orgao"/);
  assert.match(header, /getInitials\(currentUser\.name\)/);
  // Sair pede confirmação no modal padrão (não window.confirm).
  assert.match(header, /onClick=\{\(\) => setConfirmandoSaida\(true\)\}/);
  assert.equal((app.match(/placeholder=\{language === "en" \? "Search meetings\.\.\."/g) ?? []).length, 1, "sem busca duplicada");
});
