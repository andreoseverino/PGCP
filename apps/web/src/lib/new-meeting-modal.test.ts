import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Layout do modal Nova reunião — inspeção de fonte (sem renderização React). */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const modal = codigo("../components/NewMeetingModal.tsx");
const tema = codigo("../components/UnlinkedAgendasView.tsx");

test("Nova reunião: centralizado via portal, fundo só desfocado (mesmo padrão do modal de Tema)", () => {
  assert.match(modal, /return createPortal\([\s\S]*document\.body\s*\);\s*\}\s*$/);
  const overlay = 'fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6';
  assert.ok(modal.includes(overlay));
  assert.ok(tema.includes(overlay), "mesmo overlay do modal de Tema");
  assert.ok(!/bg-slate-900\/|bg-black/.test(modal), "sem blackout");
  const caixa = "bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in";
  assert.ok(modal.includes(caixa) && tema.includes(caixa), "mesma caixa (largura, raio, sombra, altura)");
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /e\.key === "Escape" && !salvando\) onClose\(\)/);
});

test("Nova reunião: dados à esquerda, pessoas à direita (md+), empilha abaixo de md", () => {
  assert.match(modal, /md:grid md:grid-cols-\[minmax\(0,1fr\)_minmax\(0,360px\)\]/);
  const iDados = modal.indexOf('aria-labelledby="nova-reuniao-dados"');
  const iPessoas = modal.indexOf('aria-labelledby="nova-reuniao-pessoas"');
  assert.ok(iDados > 0 && iPessoas > iDados);
  const dados = modal.slice(iDados, iPessoas);
  for (const campo of ['id="nmType"', 'id="nmTitlePreview"', 'id="nmDate"', 'id="nmStart"', 'id="nmEnd"', 'id="nmBody"', "<ModalityFields"]) {
    assert.ok(dados.includes(campo), `${campo} na coluna de dados`);
  }
  const pessoas = modal.slice(iPessoas, modal.indexOf("</aside>", iPessoas));
  assert.match(pessoas, /"Pessoas da reunião"/);
  assert.match(pessoas, /<OrganizerAndParticipants/);
  assert.match(pessoas, /<ModalityDisclaimer language=\{language\} \/>/, "aviso Teams na coluna de pessoas");
  assert.match(pessoas, /md:border-l/);
});

test("Nova reunião: rodapé fixo com Cancelar/Revisar; etapa de revisão preservada", () => {
  const rodape = modal.slice(modal.lastIndexOf("shrink-0", modal.indexOf('form="nova-reuniao"')));
  assert.match(rodape, /"Cancelar"/);
  assert.match(rodape, /type="submit" form="nova-reuniao"/);
  assert.match(modal, /"Revisar"/);
  assert.match(modal, /if \(!problema\) setEtapa\("review"\)/);
  assert.match(modal, /"Confira antes de agendar"/);
  assert.match(modal, /"Agendar e enviar convite"/);
  // Formulário rola dentro do corpo; header e rodapé ficam fora da rolagem.
  assert.match(modal, /id="nova-reuniao"[\s\S]*?className="flex-1 min-h-0 overflow-y-auto/);
});
