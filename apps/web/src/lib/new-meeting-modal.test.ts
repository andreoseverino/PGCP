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
  // Mesma caixa do modal de EDIÇÃO (largura, raio, sombra, altura).
  const caixa = "bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl max-h-[94vh] flex flex-col overflow-hidden animate-fade-in";
  assert.ok(modal.includes(caixa) && codigo("../components/EditMeetingModal.tsx").includes(caixa), "mesma caixa da edição");
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /e\.key === "Escape" && !salvando\) onClose\(\)/);
});

test("Nova reunião: mesmo layout da edição — dados e formato à esquerda, organizador e pessoas à direita; empilha em tela estreita", () => {
  const grade = "grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-x-8 gap-y-4";
  assert.ok(modal.includes(grade));
  assert.ok(codigo("../components/EditMeetingModal.tsx").includes(grade), "mesma grade da edição");
  const iDados = modal.indexOf('data-coluna="dados"');
  const iPessoas = modal.indexOf('data-coluna="pessoas"');
  assert.ok(iDados > 0 && iPessoas > iDados);
  const dados = modal.slice(iDados, iPessoas);
  for (const campo of ['id="nmType"', 'id="nmTitlePreview"', 'id="nmDate"', 'id="nmStart"', 'id="nmEnd"', 'id="nmBody"', "<ModalityFields", 'id="nmDescription"']) {
    assert.ok(dados.includes(campo), `${campo} na coluna de dados`);
  }
  // Ordem igual à da edição: tipo, título, data/horário, órgão, formato, descrição.
  const ordem = ['id="nmType"', 'id="nmTitlePreview"', 'id="nmDate"', 'id="nmBody"', "<ModalityFields", 'id="nmDescription"'].map((c) => dados.indexOf(c));
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem);
  const pessoas = modal.slice(iPessoas, modal.indexOf("</form>", iPessoas));
  assert.ok(pessoas.indexOf("<DirectoryUserPicker") >= 0 && pessoas.indexOf("<DirectoryUserPicker") < pessoas.indexOf("<ParticipantsField"), "organizador no topo da direita");
  assert.match(pessoas, /<ParticipantsField/);
  assert.match(pessoas, /<ModalityDisclaimer language=\{language\} \/>/, "aviso Teams na coluna de pessoas");
  // Organizador escolhido também entra como convidado (regra mantida).
  assert.match(modal, /setParticipants\(\(lista\) => addParticipantOnce\(lista, convidadoDoDiretorio\(u, language\)\)\)/);
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
