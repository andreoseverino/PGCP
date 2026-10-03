import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { confirmacaoRemoverDaReuniao, confirmacaoRemoverDoTema, temasDoParticipante } from "./participant-removal";

const vinculo = (participantId: string) => ({ participantId, name: "João da Silva" });
const agenda = [
  { title: "Tema A", participants: [vinculo("p1"), vinculo("p2")] },
  { title: "Tema B", participants: [vinculo("p1")] },
  { title: "Tema C", participants: [vinculo("p1")] },
  { title: "Tema D", participants: [vinculo("p2")] }
];

test("remover do Tema A: participante, tema, impacto só no tema, permanece na reunião", () => {
  const c = confirmacaoRemoverDoTema("João da Silva", "Tema A", "pt");
  assert.equal(c.titulo, "Remover participante deste tema?");
  assert.match(c.paragrafos[0]!, /João da Silva será removido\(a\) somente do tema "Tema A"/);
  assert.match(c.paragrafos[1]!, /Continuará como participante da reunião/);
  assert.match(c.paragrafos[1]!, /demais temas/);
  assert.deepEqual(c.temas, []);
  assert.equal(c.acao, "Remover do tema");
});

test("remover da reunião: lista os três temas afetados, vindos da relação carregada", () => {
  const temas = temasDoParticipante(agenda, "p1");
  assert.deepEqual(temas, ["Tema A", "Tema B", "Tema C"]);
  const c = confirmacaoRemoverDaReuniao("João da Silva", temas, "pt");
  assert.equal(c.titulo, "Remover João da Silva desta reunião?");
  assert.deepEqual(c.temas, ["Tema A", "Tema B", "Tema C"]);
  assert.match(c.paragrafos[0]!, /removido\(a\) desta reunião e também deixará de participar dos seguintes temas/);
  assert.equal(c.paragrafos[1], "O cadastro da pessoa no PGCP e os grupos de participação não serão alterados.");
  assert.equal(c.acao, "Remover desta reunião");
});

test("veio do grupo do órgão: continua no grupo e volta nas próximas reuniões, não nesta", () => {
  const c = confirmacaoRemoverDaReuniao("Maria", [], "pt", "Comitê de Pessoas");
  assert.equal(c.titulo, "Remover Maria desta reunião?");
  assert.equal(
    c.paragrafos[1],
    "Maria continuará no grupo “Comitê de Pessoas” e poderá ser incluído(a) automaticamente nas próximas reuniões. Nesta reunião, não volta automaticamente."
  );
  assert.equal(c.acao, "Remover desta reunião");
  // Na tela: o órgão da reunião entra no texto só quando a pessoa integra o grupo.
  const tela = readFileSync(new URL("../components/MeetingDetailView.tsx", import.meta.url), "utf8");
  assert.match(tela, /inGovernanceBodyGroup\s*\?\s*meeting\.category\s*:\s*null/);
  assert.match(tela, /Grupo: \$\{meeting\.category\}/);
});

test("sem temas: sem lista vazia e sem texto enganoso", () => {
  const c = confirmacaoRemoverDaReuniao("João da Silva", temasDoParticipante(agenda, "p9"), "pt");
  assert.deepEqual(c.temas, []);
  assert.match(c.paragrafos[0]!, /Atualmente não está vinculado\(a\) a nenhum tema/);
  assert.doesNotMatch(c.paragrafos[0]!, /seguintes temas/);
  assert.equal(c.paragrafos[1], "O cadastro da pessoa no PGCP e os grupos de participação não serão alterados.");
});

/** Sem DOM no projeto: a garantia de "cancelar não remove" é estrutural. */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("cancelar não executa: chamadas destrutivas só no handler de confirmação", () => {
  const tela = codigo("../components/MeetingDetailView.tsx");
  for (const chamada of ["apiRemoveAgendaItemParticipant(", "apiRemoveParticipant("]) {
    const usos = tela.split(chamada).length - 1;
    assert.equal(usos, 1, `${chamada} deve aparecer uma única vez`);
    const inicio = tela.indexOf("const confirmarRemocao = async");
    const fim = tela.indexOf("\n  };", inicio);
    const pos = tela.indexOf(chamada);
    assert.ok(pos > inicio && pos < fim, `${chamada} só dentro de confirmarRemocao`);
  }
  // Os botões só abrem a confirmação.
  assert.match(tela, /onClick=\{\(\) => pedirRemocaoDoTema\(/);
  assert.match(tela, /onClick=\{\(\) => pedirRemocaoDaReuniao\(/);
  // O modal: cancelar só limpa o estado.
  assert.match(tela, /onCancel=\{\(\) => setRemocaoPendente\(null\)\}/);
  const dialogo = codigo("../components/ConfirmRemovalDialog.tsx");
  assert.equal((dialogo.match(/onConfirm/g) ?? []).length, 3, "onConfirm: prop, desestruturação e botão de ação");
  assert.ok(!/window\.confirm/.test(dialogo));
});

test("textos antigos 'Remover da pauta e da reunião' não existem mais", () => {
  const tela = codigo("../components/MeetingDetailView.tsx");
  assert.ok(!tela.includes("Remover da pauta e da reunião"));
  assert.ok(!tela.includes("removida dos participantes da reunião"));
});
