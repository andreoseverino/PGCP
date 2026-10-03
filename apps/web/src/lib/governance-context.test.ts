import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contextoValido, opcoesDoContexto, orgaoInicialParaCriacao, TODOS } from "./governance-context";
import type { GovernanceBody } from "../types";

const orgao = (id: string, name: string, isActive = true): GovernanceBody => ({
  id, name, icon: null, isActive, chairEntraObjectId: null, chairName: null, createdAt: "", updatedAt: ""
});
const orgaos = [orgao("exec", "Comitê Executivo"), orgao("aud", "Comitê de Auditoria"), orgao("antigo", "Conselho Extinto", false)];

test("estado inicial Todos; órgão salvo válido é mantido; inexistente volta para Todos", () => {
  assert.equal(contextoValido(null, orgaos), TODOS);
  assert.equal(contextoValido("", orgaos), TODOS);
  assert.equal(contextoValido("exec", orgaos), "exec");
  assert.equal(contextoValido("removido", orgaos), TODOS);
  // Antes de carregar os órgãos, não descarta a preferência salva.
  assert.equal(contextoValido("exec", []), "exec");
});

test("opções do contexto (ativos primeiro, inativo acessível)", () => {
  assert.deepEqual(opcoesDoContexto(orgaos).map((o) => o.id), ["aud", "exec", "antigo"]);
});

test("criação recebe o órgão do contexto; Todos (ou inativo) não pré-seleciona", () => {
  assert.equal(orgaoInicialParaCriacao("exec", orgaos), "exec");
  assert.equal(orgaoInicialParaCriacao(TODOS, orgaos), "");
  assert.equal(orgaoInicialParaCriacao("antigo", orgaos), "");
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("persistência: contexto vive no App (não por aba) e é salvo no navegador", () => {
  const app = codigo("../App.tsx");
  assert.match(app, /localStorage\.getItem\(CHAVE_CONTEXTO_ORGAO\)/);
  assert.match(app, /localStorage\.setItem\(CHAVE_CONTEXTO_ORGAO, id\)/);
  // Trocar de aba (setActiveTab) não mexe no contexto.
  assert.ok(!/setActiveTab\([^)]*\);\s*setOrgaoContexto/.test(app));
  assert.match(app, /initialGovernanceBodyId=\{orgaoInicialParaCriacao\(orgaoContexto, governanceBodies\)\}/);
});

test("troca de contexto limpa o dia selecionado no Calendário", () => {
  assert.match(codigo("../components/CalendarView.tsx"), /useEffect\(\(\) => setDestacado\(null\), \[orgaoContexto\]\)/);
});

test("contexto não é autorização: nenhum header/parâmetro vai à API", () => {
  for (const arq of ["../App.tsx", "./api.ts", "./meetings.ts"]) {
    assert.ok(!/orgaoContexto.*(fetch|apiRequest|headers)|X-Governance/.test(codigo(arq)), arq);
  }
});
