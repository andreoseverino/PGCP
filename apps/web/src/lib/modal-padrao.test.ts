import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * REGRA DE MODAL (10/2026): todo modal do sistema segue o modelo da Nova
 * reunião / Novo tema — portal, fundo só desfocado, caixa branca com borda.
 * O jeito certo de fazer um modal novo é usar `ModalShell`.
 */
const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const OVERLAY = "bg-white/10 backdrop-blur-md";
/** Painéis laterais de celular (não são modais): menu e pastas. */
const PAINEIS_MOVEIS = ["fixed inset-0 bg-black/20 z-40 md:hidden", "fixed inset-0 z-50 lg:hidden"];

test("regra de modal: toda sobreposição usa o fundo padrão (sem escurecer); nada de window.confirm/alert", () => {
  const arquivos = [
    "../App.tsx",
    ...readdirSync(new URL("../components/", import.meta.url)).filter((f) => f.endsWith(".tsx")).map((f) => `../components/${f}`)
  ];
  const fora: string[] = [];
  for (const arq of arquivos) {
    const fonte = codigo(arq);
    for (const m of fonte.matchAll(/"([^"]*\bfixed inset-0\b[^"]*)"/g)) {
      const classes = m[1]!;
      if (PAINEIS_MOVEIS.includes(classes)) continue;
      if (!classes.includes(OVERLAY) || /bg-(black|slate-900)\//.test(classes)) fora.push(`${arq}: ${classes}`);
    }
    // Caixa do navegador também é modal — e fora do padrão.
    if (/window\.(confirm|alert|prompt)\(/.test(fonte)) fora.push(`${arq}: window.confirm/alert/prompt`);
  }
  assert.deepEqual(fora, [], "modal fora do padrão — use ModalShell");
});

test("ModalShell: portal no body, fundo desfocado, caixa padrão, cabeçalho e rodapé fixos", () => {
  const casca = codigo("../components/ModalShell.tsx");
  assert.match(casca, /return createPortal\([\s\S]*document\.body\s*\);/);
  assert.ok(casca.includes("fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6"));
  assert.ok(casca.includes("bg-white rounded-2xl shadow-2xl border border-slate-200 w-full"));
  assert.ok(casca.includes("px-6 py-4 border-b border-slate-100 shrink-0"));
  assert.ok(casca.includes("bg-slate-50 px-6 py-4 flex items-center justify-end gap-2 border-t border-slate-100 shrink-0"));
  // Mesmo fundo e mesma caixa da Nova reunião (o modelo).
  const nova = codigo("../components/NewMeetingModal.tsx");
  assert.ok(nova.includes("fixed inset-0 bg-white/10 backdrop-blur-md z-[100] flex items-center justify-center p-4 sm:p-6"));
  // Confirmações e diálogos migrados usam a casca.
  for (const arq of ["../components/ConfirmRemovalDialog.tsx", "../components/UploadDocumentModal.tsx", "../components/MeetingDetailView.tsx"]) {
    assert.match(codigo(arq), /<ModalShell/, arq);
  }
});
