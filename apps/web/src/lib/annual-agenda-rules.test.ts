import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AnnualAgendaDetail, AnnualAgendaMeeting } from "./annual-agendas";
import { candidatasAssociaveis, pautasComTemas, podeEditarAgenda, resumoDaAgenda } from "./annual-agenda-rules";

const reuniao = (id: string, extra: Partial<AnnualAgendaMeeting> = {}): AnnualAgendaMeeting => ({
  id, title: id, startAt: "2027-01-20T12:00:00Z", endAt: "2027-01-20T14:00:00Z", timezone: "America/Sao_Paulo",
  status: "scheduled", origin: "manual", calendarSyncStatus: "synced", plannedItemId: null,
  agendas: [], items: [], participants: [],
  tempo: { reuniaoMin: 120, temasMin: 0, semDuracao: 0, excessoMin: 0, disponivelMin: 120 }, ...extra
});
const tema = (id: string, position: number, agendaId: string | null, extra: Record<string, unknown> = {}) => ({
  id, title: id, position, agendaId, agendaTopicId: null as string | null, durationMinutes: 10 as number | null,
  responsibleLabel: null as string | null, responsibleEntraObjectId: null as string | null, typeId: null as string | null,
  natureId: null as string | null, isCircularTheme: false, description: null as string | null,
  inicio: "09:00", fim: "09:10" as string | null, participants: [] as Array<{ id: string; name: string }>, ...extra
});

test("edição pela Agenda Anual: permissão + em elaboração (aprovada trava, editable=false)", () => {
  assert.equal(podeEditarAgenda({ editable: true }, true), true);
  assert.equal(podeEditarAgenda({ editable: true }, false), false);
  // Aprovada: o servidor devolve editable=false e recusa toda mutação (409).
  assert.equal(podeEditarAgenda({ editable: false }, true), false);
});

test("Reunião -> Pauta -> Tema na ordem; temas sem pauta à parte; resumo dos dados reais", () => {
  const m = reuniao("m1", {
    agendas: [{ id: "p2", title: "Estratégia", position: 2 }, { id: "p1", title: "Finanças", position: 1 }],
    items: [
      tema("t2", 2, "p1", { title: "Orçamento 2027" }),
      tema("t1", 1, "p1", { title: "Resultado Financeiro", agendaTopicId: "lib" }),
      tema("t3", 3, null, { title: "Antigo" })
    ]
  });
  const { pautas, semPauta } = pautasComTemas(m);
  assert.deepEqual(pautas.map((p) => [p.title, p.temas.map((t) => t.title)]), [
    ["Finanças", ["Resultado Financeiro", "Orçamento 2027"]],
    ["Estratégia", []]
  ]);
  assert.deepEqual(semPauta.map((t) => t.id), ["t3"]);
  assert.deepEqual(resumoDaAgenda({ meetings: [m, reuniao("m2")] }), { reunioes: 2, pautas: 2, temas: 3 });
});

test("candidatas de outra agenda só informam", () => {
  const agenda = {
    candidates: [
      { id: "a", title: "A", startAt: "", endAt: "", timezone: "", origin: "manual" as const, linkedToOtherAgenda: false },
      { id: "b", title: "B", startAt: "", endAt: "", timezone: "", origin: "manual" as const, linkedToOtherAgenda: true }
    ]
  } as Pick<AnnualAgendaDetail, "candidates">;
  assert.deepEqual(candidatasAssociaveis(agenda).map((c) => c.id), ["a"]);
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("tela: conteúdo pelas rotas da Agenda (mesmas entidades); edição condicionada ao estado", () => {
  const cliente = codigo("./annual-agendas.ts");
  for (const rota of ["/agendas/${agendaId}`", "/agenda-items/${itemId}`", "/temas`", "/document`", "/meetings`"]) {
    assert.ok(cliente.includes(rota), rota);
  }
  // Aprovação DIRETA (sem e-mail): só /approval; envio, retirada e Calendário congelado não voltam.
  assert.ok(cliente.includes("/approval`"));
  for (const rota of ["/withdraw`", "/approval-request`", "frozen-calendar"]) {
    assert.ok(!cliente.includes(rota), rota);
  }
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  assert.ok(!/window\.(prompt|confirm)/.test(card));
  assert.match(card, /<ConfirmRemovalDialog/);
  // Ações de edição só aparecem com `editable`.
  assert.ok((card.match(/\{editable &&/g) ?? []).length >= 4);
  const view = codigo("../components/AnnualAgendaView.tsx");
  assert.match(view, /const editavel = podeEditarAgenda\(agenda, canManage\)/);
  assert.match(view, /"Gerar documento"/);
  // Ponte histórica pro documento aprovado (pré-remoção): confundia mais do
  // que ajudava — sumia o conteúdo mas o botão continuava ali. Removida.
  for (const removido of [
    "Retirar da aprovação", "Enviar para aprovação", "Registrar aprovação", "E-mail de quem aprova",
    "Visualizar documento aprovado", "Documento enviado (histórico)"
  ]) {
    assert.ok(!view.includes(removido), removido);
  }
  // Sem filtro local de órgão: o contexto global continua sendo a fonte.
  assert.ok(!view.slice(view.indexOf("function AgendaDetail(")).includes("orgaoContexto"));
});

test("visão anual: contexto global, anos, estados vazios distintos", async () => {
  const { anoInicial, estadoDaVisao, gruposDoContexto, reunioesAAssociar } = await import("./annual-agenda-rules");
  const grupo = (id: string, agenda: boolean, agendas: Array<string | null> = [null]) => ({
    governanceBody: { id, name: id, isActive: true },
    agenda: agenda ? { id: `a-${id}`, title: id, status: "draft" as const, meetingsCount: 0 } : null,
    meetings: agendas.map((annualAgendaId, i) => ({
      id: `${id}-${i}`, title: "", startAt: "", endAt: "", timezone: "", status: "scheduled", origin: "manual" as const, annualAgendaId
    }))
  });
  const grupos = [grupo("exec", false), grupo("ag", true)];
  assert.equal(gruposDoContexto(grupos, "").length, 2, "Todos os órgãos");
  assert.deepEqual(gruposDoContexto(grupos, "ag").map((g) => g.governanceBody.id), ["ag"], "órgão específico");
  // Anos só dos dados (servidor); inicial = atual, senão o mais próximo; vazio = null.
  assert.equal(anoInicial([2026], 2026), 2026);
  assert.equal(anoInicial([2027, 2026], 2026), 2026);
  assert.equal(anoInicial([2027, 2025], 2026), 2027, "empate: o mais recente");
  assert.equal(anoInicial([2030], 2026), 2030);
  assert.equal(anoInicial([], 2026), null);
  assert.equal(estadoDaVisao([]), "sem_reunioes");
  assert.equal(estadoDaVisao(grupos), "a_formalizar");
  assert.equal(estadoDaVisao([grupo("ag", true)]), "formalizado");
  assert.equal(reunioesAAssociar(grupo("x", false, [null, "outra"])).length, 1);
});

test("tela: ano padrão = atual; sem 'Todos'; reuniões sem agenda ≠ nenhuma reunião; Preparar explícito", () => {
  const view = codigo("../components/AnnualAgendaView.tsx");
  assert.match(view, /const \[ano, setAno\] = useState<number>\(anoAtual\)/);
  assert.match(view, /instantToLocal\(new Date\(\)\.toISOString\(\), DEFAULT_TIMEZONE\)/);
  const seletor = view.slice(view.indexOf('id="agenda-ano"'), view.indexOf("</select>", view.indexOf('id="agenda-ano"')));
  assert.ok(!/"Todos"/.test(seletor), "sem opção Todos no ano");
  assert.match(view, /getAnnualOverview\(anoAlvo\)/);
  assert.match(view, /"Estas reuniões já estão no Calendário e podem ser preparadas para a Agenda Anual\."/);
  assert.match(view, /"Nenhuma reunião encontrada para este ano\. Crie a reunião no Calendário para preparar sua Agenda Anual\."/);
  assert.match(view, /"Ir para Calendário"/);
  assert.match(view, /"Preparar Agenda Anual"/);
  // Abrir/trocar de ano só LÊ: criar agenda só no clique de Preparar/Criar.
  const efeitos = view.slice(view.indexOf("useEffect(() => {"), view.indexOf("const abrirGrupo"));
  assert.ok(!/createAnnualAgenda/.test(efeitos));
});

test("arrastar ordena DENTRO da pauta; a ordem global dos demais não muda", async () => {
  const { ordemComDestino, indiceNaPauta, destinoSobre } = await import("./annual-agenda-rules");
  const globais = [
    { id: "A", agendaId: "p1" }, { id: "X", agendaId: "p2" }, { id: "B", agendaId: "p1" }, { id: "C", agendaId: "p1" }
  ];
  // Destino = índice entre os temas da pauta SEM o arrastado (p1 sem C = [A, B]).
  assert.deepEqual(ordemComDestino(globais, "C", 0), ["C", "X", "A", "B"], "C antes de A, nas posições da pauta");
  assert.deepEqual(ordemComDestino(globais, "C", 1), ["A", "X", "C", "B"], "C entre A e B");
  assert.deepEqual(ordemComDestino(globais, "A", 2), ["B", "X", "C", "A"], "A depois de C");
  assert.deepEqual(ordemComDestino(globais, "A", 0), ["A", "X", "B", "C"], "mesmo lugar: nada muda");
  assert.deepEqual(ordemComDestino(globais, "A", 99), ["B", "X", "C", "A"], "destino além do fim: último");
  assert.deepEqual(ordemComDestino(globais, "X", 0), ["A", "X", "B", "C"], "outra pauta intacta");
  // Partida e destino enquanto o ponteiro passa sobre outro tema.
  assert.equal(indiceNaPauta(globais, "C"), 2);
  assert.equal(destinoSobre(globais, "C", "B", false), 1, "metade de cima de B: antes de B");
  assert.equal(destinoSobre(globais, "C", "B", true), 2, "metade de baixo de B: depois de B");
  assert.equal(destinoSobre(globais, "C", "A", true), 1, "metade de baixo de A: entre A e B");
  assert.equal(destinoSobre(globais, "C", "C", true), null, "sobre o próprio espaço: não muda");
  assert.equal(destinoSobre(globais, "C", "X", false), null, "outra pauta: não é destino");
});

test("arrastar (tela): só a alça inicia; a imagem é a linha inteira; o espaço de destino anda; soltar persiste a prévia", () => {
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  // Só a alça é `draggable` (editar/excluir/participantes não iniciam arraste).
  assert.equal((card.match(/\bdraggable\b/g) ?? []).length, 1, "um único elemento arrastável");
  const alca = card.slice(card.indexOf("draggable"), card.indexOf("<GripVertical"));
  assert.match(alca, /onDragStart=\{\(e\) => iniciarArraste\(e, tema\)\}/);
  assert.match(alca, /cursor-grab active:cursor-grabbing/);
  // Imagem do arraste = a linha (<li>) inteira, mesma largura, sombra discreta.
  const inicio = card.slice(card.indexOf("const iniciarArraste"), card.indexOf("const encerrarArraste"));
  assert.match(inicio, /closest\("li"\)/);
  assert.match(inicio, /setDragImage\(fantasma/);
  assert.match(inicio, /width: `\$\{r\.width\}px`/);
  assert.match(inicio, /boxShadow/);
  // Espaço de destino: a ordem visível é a prévia; a linha de origem mantém a altura sem conteúdo.
  assert.match(card, /ordemComDestino\(meeting\.items, arrastando, destino\)/);
  assert.match(card, /destinoSobre\(meeting\.items, arrastando, tema\.id, e\.clientY > r\.top \+ r\.height \/ 2\)/);
  assert.match(card, /ehEspaco \? "border-dashed/);
  assert.match(card, /ehEspaco \? "opacity-0" : "opacity-100"/);
  assert.match(card, /\{naOrdem\(meeting\.items\)\.map\(linhaDeTema\)\}/);
  assert.match(card, /\{naOrdem\(pauta\.temas\)\.map\(linhaDeTema\)\}/);
  // Animação curta e discreta (reposicionar + assentar), respeitando movimento reduzido.
  assert.match(card, /const ANIMACAO_MS = 180;/);
  assert.match(card, /prefers-reduced-motion: reduce/);
  assert.match(card, /duration-200/);
  // Soltar: a MESMA ordem da prévia vai para a mesma persistência; o servidor recalcula os horários.
  const soltar = card.slice(card.indexOf("const soltar = async"), card.indexOf("const soltavel"));
  assert.match(soltar, /const ordem = ordemComDestino\(meeting\.items, origem, alvo\)/);
  assert.match(soltar, /reorderAnnualTemas\(agendaId, meeting\.id, ordem\)/);
  assert.match(soltar, /horários recalculados/);
  // Horários da prévia pela mesma regra do cronograma (só exibição).
  assert.match(card, /cronogramaDosTemas\(\s*inicio\.time/);
});

test("participantes do tema: resumo compacto", async () => {
  const { resumoDeParticipantes } = await import("./annual-agenda-rules");
  assert.equal(resumoDeParticipantes(["André Severino", "Maria Silva", "João", "Ana"]), "André, Maria +2");
  assert.equal(resumoDeParticipantes(["André Severino"]), "André");
  assert.equal(resumoDeParticipantes([]), "");
});

test("tela: esquerda compacta; tema com horário, duração, participantes, Biblioteca; arrastar", () => {
  const view = codigo("../components/AnnualAgendaView.tsx");
  assert.match(view, /lg:grid-cols-\[260px_minmax\(0,1fr\)\]/);
  assert.match(view, /setAnos\(visao\.years\)/);
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  for (const trecho of [
    "tema.inicio", "tema.fim", "tema.durationMinutes", "ficha.participantes", '"Biblioteca"', "draggable",
    "reorderAnnualTemas", '"Mover para..."', "A pauta ultrapassa a duração da reunião em"
  ]) {
    assert.ok(card.includes(trecho), trecho);
  }
});

test("Agenda Anual orientada a temas: sem 'Datas planejadas', sem 'Agenda sem reuniões', sem '+ Pauta' principal", () => {
  const view = codigo("../components/AnnualAgendaView.tsx");
  for (const removido of ["Datas planejadas sem reunião", "Agenda sem reuniões", "reserveAnnualAgenda", "addAnnualAgendaItem"]) {
    assert.ok(!view.includes(removido), removido);
  }
  // Cliente web de Datas planejadas/Reserva saiu (as rotas do backend ficam, por compatibilidade).
  const cliente = codigo("./annual-agendas.ts");
  for (const removido of ["reserveAnnualAgenda", "addAnnualAgendaItem", "updateAnnualAgendaItem", "deleteAnnualAgendaItem", "/reserve`", "/items`"]) {
    assert.ok(!cliente.includes(removido), removido);
  }
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  for (const removido of ["Nova pauta (ex.: Finanças)", "addAnnualPauta", "Nenhuma pauta ainda."]) {
    assert.ok(!card.includes(removido), removido);
  }
  for (const presente of ['"Temas da reunião"', '"Novo tema"', '"Adicionar da Biblioteca"', "createAnnualTema", "<AnnualTemaModal"]) {
    assert.ok(card.includes(presente), presente);
  }
  // Uma pauta (ou nenhuma): temas direto; duas ou mais: agrupamento e "Mover para...".
  assert.match(card, /pautas\.length <= 1 \?/);
  assert.match(card, /"Mover para\.\.\."/);
});

test("Novo tema: cadastro completo no mesmo padrão do formulário de Tema da Biblioteca", () => {
  const modal = codigo("../components/AnnualTemaModal.tsx");
  const biblioteca = codigo("../components/UnlinkedAgendasView.tsx");
  // Mesmo modal: portal, fundo desfocado, caixa larga de duas colunas.
  for (const classe of [
    "fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6",
    "bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in",
    "md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]"
  ]) {
    assert.ok(modal.includes(classe) && biblioteca.includes(classe), classe);
  }
  // Mesmos componentes de campo da Biblioteca.
  for (const componente of ["<DirectoryUserPicker", "<DurationHoursMinutesSelect", "<ParticipantPicker"]) {
    assert.ok(modal.includes(componente), componente);
  }
  for (const campo of ['id="annualTemaNome"', 'id="annualTemaTipo"', 'id="annualTemaNatureza"', 'id="annualTemaCircular"', 'id="annualTemaDescricao"', '"Participantes do tema"']) {
    assert.ok(modal.includes(campo), campo);
  }
  // Tipo/natureza vêm das taxonomias (sem opções fixas); pauta só com 2+.
  assert.match(modal, /opcoesDe\(pautaTypes/);
  assert.match(modal, /pautas\.length > 1 &&/);
  assert.ok(!/type="time"|createAgendaTopic|agendaTopicId/.test(modal), "quem cadastra o tema-mestre é o servidor; o modal não pede horário");
  // O usuário sabe o efeito: novo tema vai para a Biblioteca; editar vale só para a reunião.
  assert.ok(modal.includes("O tema também é cadastrado na Biblioteca, com estes participantes como padrão."));
  assert.ok(modal.includes("A edição vale só para esta reunião (a Biblioteca não muda)."));
  // A lista da Biblioteca (e Grupos → Temas, que usa a mesma) recarrega depois das ações da Agenda.
  const app = codigo("../App.tsx");
  const bloco = app.slice(app.indexOf("<AnnualAgendaView"), app.indexOf("/>", app.indexOf("<AnnualAgendaView")));
  assert.match(bloco, /onMeetingsChanged=\{\(\) => \{\s*void loadMeetings\(\);\s*void loadAgendaTopics\(\);/);
});

test("Adicionar da Biblioteca: só seleção (busca, lista, vazio); não cria/edita/exclui o tema-mestre", async () => {
  const { filtrarBiblioteca } = await import("./annual-agenda-rules");
  const temas = [{ id: "1", title: "Resultado Financeiro" }, { id: "2", title: "Sustentabilidade ESG" }, { id: "3", title: "Orçamento Anual" }];
  assert.deepEqual(filtrarBiblioteca(temas, "orcamento").map((t) => t.id), ["3"], "sem acento/caixa");
  assert.deepEqual(filtrarBiblioteca(temas, "  ").length, 3);
  // Temas futuros numa seção no topo: os do comitê da reunião primeiro, depois por mês.
  const { secoesDaBiblioteca } = await import("./annual-agenda-rules");
  const mistos = [
    { id: "r1", title: "Regular" },
    { id: "f1", title: "Outro comitê", isFuture: true, expectedMonth: "2027-01", expectedGovernanceBodyId: "B" },
    { id: "f2", title: "Deste, tarde", isFuture: true, expectedMonth: "2027-06", expectedGovernanceBodyId: "A" },
    { id: "f3", title: "Deste, cedo", isFuture: true, expectedMonth: "2027-02", expectedGovernanceBodyId: "A" }
  ];
  const secoes = secoesDaBiblioteca(mistos, "A");
  assert.deepEqual(secoes.futuros.map((t) => t.id), ["f3", "f2", "f1"]);
  assert.deepEqual(secoes.regulares.map((t) => t.id), ["r1"]);
  const modal = codigo("../components/AnnualBibliotecaModal.tsx");
  assert.match(modal, /Nenhum Tema cadastrado na Biblioteca/);
  assert.match(modal, /onAdd\(\{ agendaTopicId: escolhido\.id, durationMinutes: minutos/);
  assert.ok(!/createAgendaTopic|updateAgendaTopic|deleteAgendaTopic/.test(modal), "não mexe na Biblioteca");
  const envio = modal.slice(modal.indexOf("onAdd({"), modal.indexOf("})", modal.indexOf("onAdd({")));
  assert.ok(!/title|responsible|participants/.test(envio), "só id, duração e pauta: o servidor resolve o resto");
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  assert.match(card, /modalTema\?\.modo === "biblioteca" && \(\s*<AnnualBibliotecaModal/);
  assert.match(card, /modalTema && modalTema\.modo !== "biblioteca" && \(\s*<AnnualTemaModal/);
});

test("linha do tema: responsável, tipo, natureza, circular, descrição curta, participantes, Biblioteca", async () => {
  const { fichaDaLinha } = await import("./annual-agenda-rules");
  const tipos = [{ id: "t1", name: "Deliberativa" }];
  const naturezas = [{ id: "n1", name: "Financeira" }];
  const base = {
    responsibleLabel: "André Severino",
    typeId: "t1",
    natureId: "n1",
    isCircularTheme: false,
    description: "Análise dos resultados\nfinanceiros  e principais variações",
    agendaTopicId: "bib-1",
    participants: [
      { id: "p1", name: "André Severino" },
      { id: "p2", name: "Adele Vance" },
      { id: "p3", name: "Agent Smith" },
      { id: "p4", name: "Maria Silva" }
    ]
  };
  const f = fichaDaLinha(base, tipos, naturezas, "pt");
  assert.equal(f.responsavel, "André Severino");
  assert.equal(f.participantes, "André, Adele +2");
  assert.equal(f.totalParticipantes, 4);
  assert.match(f.participantesTitulo, /^André Severino \(responsável\), Adele Vance/, "responsável identificado no tooltip");
  assert.deepEqual(f.classificacao, ["Deliberativa", "Financeira", "Circular: Não"]);
  assert.equal(f.descricao, "Análise dos resultados financeiros e principais variações", "uma linha só");
  assert.equal(f.biblioteca, true);

  const longa = fichaDaLinha({ ...base, description: "x".repeat(400) }, tipos, naturezas, "pt");
  assert.ok(longa.descricao!.length <= 140 && longa.descricao!.endsWith("…"), "descrição truncada");
  assert.equal(longa.descricaoCompleta!.length, 400, "texto completo só no tooltip/modal");

  // Dados ausentes: nada quebra e nada de "—" repetido.
  const vazio = fichaDaLinha(
    { responsibleLabel: null, typeId: null, natureId: null, isCircularTheme: false, description: null, agendaTopicId: null, participants: [] },
    tipos, naturezas, "pt"
  );
  assert.deepEqual(
    [vazio.responsavel, vazio.participantes, vazio.classificacao, vazio.descricao, vazio.biblioteca],
    [null, "", [], null, false]
  );
  // Só circular: a linha terciária aparece com ele; tipo apagado da Administração é omitido.
  assert.deepEqual(fichaDaLinha({ ...base, typeId: "removido", natureId: null, description: null, isCircularTheme: true }, tipos, naturezas, "pt").classificacao, ["Circular: Sim"]);

  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  assert.match(card, /fichaDaLinha\(tema, pautaTypes, pautaNatures, language\)/);
  assert.match(card, /Responsável pelo tema: \$\{ficha\.responsavel\}/);
  assert.match(card, /hidden sm:block truncate/, "descrição: uma linha truncada; some em tela estreita");
});

test("mutação de tema: sucesso recarrega as reuniões UMA vez; falha não recarrega", async () => {
  const { rodarMutacao } = await import("./annual-agenda-rules");
  let recargas = 0;
  let aplicado: unknown = null;
  let erro: unknown = null;
  const ok = await rodarMutacao(async () => "detalhe", {
    aplicar: (r) => { aplicado = r; },
    falhar: (e) => { erro = e; },
    reunioesMudaram: () => { recargas++; }
  });
  assert.deepEqual([ok, aplicado, erro, recargas], [true, "detalhe", null, 1]);
  const falhou = await rodarMutacao(async () => { throw new Error("409"); }, {
    aplicar: () => { aplicado = "não"; },
    falhar: (e) => { erro = e; },
    reunioesMudaram: () => { recargas++; }
  });
  assert.equal(falhou, false);
  assert.equal(recargas, 1, "falha não recarrega");
  assert.equal(aplicado, "detalhe");
  // Sem `reunioesMudaram` (ex.: aprovação), nada é recarregado.
  assert.equal(await rodarMutacao(async () => 1, { aplicar: () => {}, falhar: () => {} }), true);

  // Toda ação do card passa pelo mesmo `executar`, ligado a onMeetingsChanged.
  const view = codigo("../components/AnnualAgendaView.tsx");
  assert.match(view, /executar=\{\(acao, sucesso\) => executar\(acao, sucesso, onMeetingsChanged\)\}/);
  assert.match(view, /await rodarMutacao\(acao, \{/);
  assert.ok(!/location\.reload/.test(view), "sem recarregar a página");
  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  for (const mutacao of [
    "createAnnualTema", "updateAnnualTema", "deleteAnnualTema", "reorderAnnualTemas",
    "linkAnnualTemaParticipant", "unlinkAnnualTemaParticipant"
  ]) {
    assert.match(card, new RegExp(`executar\\([^;]*${mutacao}|${mutacao}\\(agendaId`), mutacao);
  }
  assert.ok(!/onMeetingsChanged/.test(card), "o card não recarrega por conta própria (sem chamada duplicada)");
});

test("participantes da reunião na Agenda: resumo tipo e-mail, contador, origem, sem duplicar", async () => {
  const { resumoDosParticipantes, origensDoParticipante } = await import("./annual-agenda-rules");
  const pessoas = ["André Android", "Maria Silva", "João Santos", "Carlos Lima", "Ana", "Bia", "Caio", "Davi"].map((name, i) => ({
    id: `p${i}`, name, email: i === 3 ? null : `p${i}@empresa.com`, external: name === "João Santos", inGovernanceBodyGroup: i < 2
  }));
  assert.deepEqual(resumoDosParticipantes(pessoas), { nomes: ["André Android", "Maria Silva", "João Santos"], restantes: 5 });
  assert.deepEqual(resumoDosParticipantes(pessoas.slice(0, 2)), { nomes: ["André Android", "Maria Silva"], restantes: 0 });
  assert.deepEqual(resumoDosParticipantes([]), { nomes: [], restantes: 0 });

  // Maria está no grupo e em DOIS temas: aparece uma vez, com as duas origens.
  const r = reuniao("m", {
    participants: pessoas,
    items: [
      tema("Orçamento", 1, "p", { participants: [{ id: "p1", name: "Maria Silva" }, { id: "p2", name: "João Santos" }] }),
      tema("Riscos", 2, "p", { participants: [{ id: "p1", name: "Maria Silva" }] })
    ]
  });
  assert.equal(r.participants.filter((p) => p.name === "Maria Silva").length, 1);
  assert.deepEqual(origensDoParticipante(r, "p1", "Comitê de Pessoas", "pt"), ["Grupo: Comitê de Pessoas", "Temas: Orçamento, Riscos"]);
  assert.deepEqual(origensDoParticipante(r, "p2", "Comitê de Pessoas", "pt"), ["Tema: Orçamento"]);
  assert.deepEqual(origensDoParticipante(r, "p7", "Comitê de Pessoas", "pt"), [], "sem origem conhecida: nada inventado");

  const { linhaDoParticipante } = await import("./annual-agenda-rules");
  // Linha expandida: e-mail quando houver; contexto sem nada técnico.
  assert.deepEqual(linhaDoParticipante(r, pessoas[1]!, "Comitê de Pessoas", "pt"), {
    email: "p1@empresa.com",
    contexto: "Cielo · Grupo: Comitê de Pessoas · Temas: Orçamento, Riscos"
  });
  assert.deepEqual(linhaDoParticipante(r, pessoas[2]!, "Comitê de Pessoas", "pt"), { email: "p2@empresa.com", contexto: "Externo · Tema: Orçamento" });
  assert.deepEqual(linhaDoParticipante(r, pessoas[3]!, "Comitê de Pessoas", "pt"), { email: null, contexto: "Cielo" }, "sem e-mail: só o nome");
  for (const p of pessoas) assert.ok(!/null|undefined/.test(JSON.stringify(linhaDoParticipante(r, p, "X", "pt").contexto)));

  const card = codigo("../components/AnnualAgendaMeetingCard.tsx");
  // Recolhida por padrão, acima de "Temas da reunião", base meeting.participants.
  assert.match(card, /const \[participantesAbertos, setParticipantesAbertos\] = useState\(false\)/);
  assert.ok(card.indexOf('"Todos os participantes da reunião"') < card.indexOf('"Temas da reunião"'));
  assert.match(card, /\(\{meeting\.participants\.length\}\)/, "contador");
  assert.match(card, /resumo\.nomes\.join\("; "\)/, "nomes como destinatários de e-mail");
  assert.match(card, /\+\{resumo\.restantes\}/, "+N quando há muitos");
  assert.match(card, /aria-expanded=\{participantesAbertos\}/);
  assert.ok(card.includes("Esta lista reúne todos os participantes da reunião, independentemente do órgão colegiado, dos temas ou de inclusão manual."));
  const secao = card.slice(card.indexOf('"Todos os participantes da reunião"'), card.indexOf('"Temas da reunião"'));
  // Disclaimer só no expandido.
  assert.ok(secao.indexOf("Esta lista reúne") > secao.indexOf("{participantesAbertos && ("));
  // Em elaboração: gerenciar pelo MESMO seletor e pelas mesmas regras (rotas da Agenda).
  assert.match(secao, /\{editable \? \(/);
  assert.match(secao, /<ParticipantPicker/);
  assert.match(secao, /addAnnualMeetingParticipant\(agendaId, meeting\.id, selecionadoParaPayload\(sel\)\)/);
  assert.match(secao, /confirmacaoRemoverDaReuniao\(/, "mesmo texto de remoção (grupo permanece, exceção)");
  assert.match(secao, /removeAnnualMeetingParticipant\(agendaId, meeting\.id, p\.id\)/);
  // Sem permissão: só leitura (nenhuma menção a aprovação).
  assert.ok(secao.includes('"Somente leitura."'));
  assert.ok(!/aprova/i.test(secao));
  // "Abrir no Pipeline" só com a Agenda aprovada; desassociar saiu do cartão.
  assert.match(card, /\{agendaAprovada &&[\s\S]*?<button type="button" onClick=\{\(\) => onOpenMeeting\(meeting\.id\)\}/);
  assert.ok(!/dissociateAnnualMeeting|Desassociar da Agenda Anual/.test(card));
  assert.ok(!/approved/.test(card));
  const cliente = codigo("./annual-agendas.ts");
  assert.match(cliente, /`\$\{conteudo\(id, meetingId\)\}\/participants`/);
});

test("sem aprovação da Agenda Anual: toda reunião opera no Pipeline; Calendário mostra a reunião ao vivo", () => {
  const pipeline = codigo("../components/PipelineView.tsx");
  assert.match(pipeline, /filtrarPorOrgao\(meetings, orgaoContexto\)/);
  assert.ok(!/em preparação na Agenda Anual|após a aprovação/.test(pipeline));
  const app = codigo("../App.tsx");
  assert.ok(!/aindaNaAgendaAnual|frozen|Frozen|calendarMeetings/.test(app));
  assert.match(app, /<CalendarView[\s\S]*?meetings=\{meetings\}/);
});
