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
  const ok = { fullName: "Maria Souza", email: "maria@parceiro.com.br", phone: "(11) 3333-4444", governanceBodyId: null };
  assert.equal(validateExternalParticipant(ok, "pt"), null);
  assert.ok(validateExternalParticipant({ ...ok, fullName: "" }, "pt"));
  assert.ok(validateExternalParticipant({ ...ok, email: "maria" }, "pt"));
  assert.ok(validateExternalParticipant({ ...ok, phone: "" }, "pt"));
  assert.ok(validateExternalParticipant({ ...ok, phone: "abc12345678" }, "pt"));
});

test("Administração → Participantes trabalha só com cadastros locais: sem Entra", () => {
  const painel = codigo("../components/ParticipantsPanel.tsx");
  assert.ok(!/searchDirectoryUsers|DirectoryUserPicker|ParticipantPicker|\/directory/.test(painel), "não busca o diretório");
  assert.ok(!/Microsoft|Entra|Origem/.test(painel.replace(/"[^"]*n[aã]o pertencem[^"]*"/g, "")), "não lista origem Microsoft");
  assert.match(painel, /listExternalParticipants\(\)/);
});

test("cliente administrativo só fala com /external-participants", () => {
  const cliente = codigo("./external-participants.ts");
  assert.ok(!/\/directory|searchDirectoryUsers/.test(cliente));
});
