import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  corpoDoMembroDoOrgao,
  corpoDoParticipantePadrao,
  filtrarPorNome,
  avisoDeInclusaoNoGrupo,
  jaNoGrupo,
  membroDoTema,
  rotuloDaOrigem,
  rotuloDePessoas
} from "./participation-groups-rules";
import type { ParticipanteSelecionado } from "./participant-search";

const entra: ParticipanteSelecionado = {
  origem: "entra",
  user: { id: "oid-andre", displayName: "André Android", mail: "andre@cielo.com.br", userPrincipalName: "andre@cielo.com.br" } as never
};
const externo: ParticipanteSelecionado = {
  origem: "pgcp",
  participante: { id: "ext-joao", fullName: "João Santos", email: "joao@parceiro.com" } as never
};

test("grupo do órgão: corpo só com a identidade escolhida (nome/e-mail resolvidos no servidor)", () => {
  assert.deepEqual(corpoDoMembroDoOrgao(entra), { entraObjectId: "oid-andre" });
  assert.deepEqual(corpoDoMembroDoOrgao(externo), { externalParticipantId: "ext-joao" });
});

test("participante padrão do tema: Cielo pela identidade; externo por nome + e-mail (sem identidade inventada)", () => {
  assert.deepEqual(corpoDoParticipantePadrao(entra), { entraObjectId: "oid-andre", displayName: "André Android", email: "andre@cielo.com.br" });
  const ext = corpoDoParticipantePadrao(externo);
  assert.deepEqual(ext, { displayName: "João Santos", email: "joao@parceiro.com" });
  assert.ok(!("entraObjectId" in ext) && !("userId" in ext));
});

test("entrar no grupo: aviso diz quantas reuniões abertas receberam a pessoa e quantas ficaram de fora por exceção", () => {
  assert.equal(avisoDeInclusaoNoGrupo("Maria", 2, 0, "pt"), "Maria adicionado(a) ao grupo e incluído(a) em 2 reuniões abertas.");
  assert.equal(avisoDeInclusaoNoGrupo("Maria", 0, 0, "pt"), "Maria adicionado(a) ao grupo. Nenhuma reunião aberta precisou ser atualizada.");
  assert.equal(
    avisoDeInclusaoNoGrupo("Maria", 1, 1, "pt"),
    "Maria adicionado(a) ao grupo e incluído(a) em 1 reunião aberta. 1 reunião continua sem a pessoa, porque ela foi removida antes."
  );
  const painel = readFileSync(new URL("../components/ParticipantsPanel.tsx", import.meta.url), "utf8");
  assert.match(painel, /setAviso\(avisoDeInclusaoNoGrupo\(nome, r\.reunioesAtualizadas, r\.reunioesComExcecao, language\)\)/);
});

test("origem Cielo/Externo, contagem e quem já está no grupo", () => {
  const base = { userName: null, entraTenantId: null };
  assert.equal(membroDoTema({ ...base, id: "1", userId: null, displayName: "Maria", email: "m@cielo.com.br", entraObjectId: "oid" }).origem, "cielo");
  assert.equal(membroDoTema({ ...base, id: "2", userId: "u1", displayName: null, email: "x@cielo.com.br", entraObjectId: null }).origem, "cielo");
  assert.equal(membroDoTema({ ...base, id: "3", userId: null, displayName: "João", email: "j@p.com", entraObjectId: null }).origem, "externo");
  assert.equal(rotuloDaOrigem("cielo", "pt"), "Cielo");
  assert.equal(rotuloDaOrigem("externo", "pt"), "Externo");
  assert.equal(rotuloDePessoas(1, "pt"), "1 pessoa");
  assert.equal(rotuloDePessoas(8, "pt"), "8 pessoas");
  assert.deepEqual(jaNoGrupo([{ id: "a", nome: "A", email: "a@x.com", origem: "cielo" }, { id: "b", nome: "B", email: null, origem: "externo" }]), { emails: ["a@x.com"] });
  assert.deepEqual(filtrarPorNome([{ name: "Comitê de Pessoas" }, { name: "Diretoria" }], "comite").map((o) => o.name), ["Comitê de Pessoas"]);
  assert.deepEqual(filtrarPorNome([{ title: "Orçamento" }], "orcamento").length, 1);
});

/** Sem comentários: a varredura enxerga código, não prosa. */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("tela: Pessoas externas separada de Grupos; Órgãos/Temas; master/detail; adicionar e remover", () => {
  const painel = codigo("../components/ParticipantsPanel.tsx");
  for (const texto of [
    '"Pessoas externas"', '"Grupos de participação"', '"Órgãos colegiados"', '"Temas"',
    '"Nova pessoa externa"', '"Buscar pessoa"', '"Adicionar participantes"', '"Participantes do grupo"',
    '"Participantes padrão do Tema"',
    "Cadastre convidados externos à Cielo. Eles poderão receber convites e participar de reuniões, mas não terão acesso ao PGCP.",
    "Defina quem normalmente participa de cada Órgão colegiado e de cada Tema."
  ]) {
    assert.ok(painel.includes(texto), texto);
  }
  // Pessoas externas: só nome, e-mail, telefone — nada de órgão/tema ali.
  const externos = painel.slice(painel.indexOf("function PessoasExternas("), painel.indexOf("function GruposDeParticipacao("));
  assert.ok(!/governanceBodyIds|topicIds|Órgãos colegiados|Temas \(Biblioteca\)/.test(externos));
  // Grupos: órgão pelo endpoint de grupos; tema pela lista da Biblioteca (um mecanismo só).
  const grupos = painel.slice(painel.indexOf("function GruposDeParticipacao("));
  assert.match(grupos, /addGovernanceBodyGroupMember\(id, sel\)/);
  assert.match(grupos, /removeGovernanceBodyGroupMember\(id, m\.id\)/);
  assert.match(grupos, /addAgendaTopicParticipant\(id, corpoDoParticipantePadrao\(sel\)\)/);
  assert.match(grupos, /removeAgendaTopicParticipant\(id, m\.id\)/);
  assert.match(grupos, /md:grid-cols-\[minmax\(0,280px\)_minmax\(0,1fr\)\]/, "master/detail");
  assert.match(grupos, /rotuloDaOrigem\(m\.origem, language\)/, "origem Cielo/Externo");
  assert.match(grupos, /jaNoGrupo\(membros\)/, "quem já está não é oferecido");
  // Remover do grupo: confirmação e texto de efeito só para o futuro.
  assert.match(grupos, /Reuniões já criadas não mudam\./);
  assert.ok(!/window\.(confirm|prompt)/.test(painel));
});

test("tela: linguagem não técnica (sem classificação, vínculo N:N, Entra Object ID, tenant, diretório local)", () => {
  const visivel = codigo("../components/ParticipantsPanel.tsx")
    .match(/"[^"\n]*"|`[^`\n]*`|>[^<>{}\n]+</g)!
    .join(" ");
  for (const termo of [/classifica/i, /N:N/, /Object ID/i, /tenant/i, /diretório local/i, /entidade/i, /\bvínculos?\b/i]) {
    assert.ok(!termo.test(visivel), String(termo));
  }
});

test("grupo não é autorização: cliente não fala em papel/App Role", () => {
  const cliente = codigo("./participation-groups.ts") + codigo("./participation-groups-rules.ts");
  assert.ok(!/appRole|App Role|PGCP\.Admin|PGCP\.Assessoria/.test(cliente));
  assert.match(cliente, /"\/participation-groups\/governance-bodies"/);
});
