import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateExternalParticipant } from "./external-participants-rules";

/** Sem comentários: a varredura enxerga código, não prosa. */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("validação: nome, e-mail e telefone obrigatórios; órgão colegiado opcional", () => {
  const ok = { fullName: "Maria Souza", email: "maria@parceiro.com.br", phone: "(11) 3333-4444", governanceBodyIds: [], topicIds: [] };
  assert.equal(validateExternalParticipant(ok, "pt"), null);
  assert.ok(validateExternalParticipant({ ...ok, fullName: "" }, "pt"));
  assert.ok(validateExternalParticipant({ ...ok, email: "maria" }, "pt"));
  assert.ok(validateExternalParticipant({ ...ok, phone: "" }, "pt"));
  assert.ok(validateExternalParticipant({ ...ok, phone: "abc12345678" }, "pt"));
});

test("Administração → Participantes não navega o tenant: Entra só pela busca explícita de quem adiciona", () => {
  const painel = codigo("../components/ParticipantsPanel.tsx");
  // Nenhuma listagem do diretório: o painel lista externos e membros de grupo.
  assert.ok(!/searchDirectoryUsers|\/directory\/users/.test(painel), "não lista o diretório");
  assert.match(painel, /listExternalParticipants\(\)/);
  // Adicionar ao grupo usa a busca única (Entra a partir de 3 letras + externos).
  assert.equal((painel.match(/<ParticipantPicker/g) ?? []).length, 1);
});

test("cliente administrativo: externos e pessoas JÁ vinculadas — nunca busca no diretório", () => {
  const cliente = codigo("./external-participants.ts");
  assert.ok(!/\/directory\/users|searchDirectoryUsers/.test(cliente));
  assert.match(cliente, /"\/directory-people"/);
});
