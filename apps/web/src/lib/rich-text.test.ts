import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "./rich-text";
import * as api from "../../../api/src/meetings/rich-text";

const VETORES = [
  "<p><strong>Pauta</strong> e <em>objetivo</em><br>linha 2</p><ul><li>um</li><li>dois</li></ul><ol><li>1</li></ol>",
  "<div><b>a</b> <i>b</i></div><span style='color:red'>c</span>",
  '<script>alert(1)</script><p onclick="x">ok</p><img src=x onerror=alert(1)><a href="javascript:1">l</a>',
  "<!-- c --><iframe src=//x></iframe><svg><script>1</script></svg><p>1 < 2 & 3</p>",
  "<p><strong>aberto<li>solto<ul><li>a<li>b</ul>",
  "texto puro\ncom quebra\n\noutro parágrafo",
  "&lt;b&gt; &amp; &#60;script&#62; &#x3C;i&#x3E;"
];

test("paridade: navegador e servidor saneiam IGUAL (o servidor é a autoridade)", () => {
  for (const v of VETORES) {
    assert.equal(web.sanitizarHtml(v), api.sanitizarHtml(v), v);
    assert.equal(web.descricaoComoHtml(v), api.descricaoComoHtml(v), v);
    assert.equal(web.textoDaDescricao(v), api.textoDaDescricao(v), v);
  }
});

test("exibição: nada executável sobrevive", () => {
  const seguro = web.descricaoComoHtml('<p onmouseover="x">a</p><script>b</script><a href="javascript:c">d</a>');
  assert.equal(seguro, "<p>a</p>d");
  assert.ok(!/<script|on\w+=|href=/i.test(seguro));
});

const dados = { titulo: "09:00 | Cielo | Reunião Ordinária do Comitê", data: "2026-10-20", inicio: "09:00", fim: "11:00", orgao: "Comitê Executivo" };

test("template inicial: dados da reunião, só marcação permitida (o servidor grava igual)", () => {
  const t = web.montarDescricaoInicial(dados);
  assert.equal(web.sanitizarHtml(t), t, "já canônico");
  assert.equal(api.sanitizarHtml(t), t, "servidor não muda nada");
  const texto = web.textoDaDescricao(t);
  for (const trecho of ["Reunião: 09:00 | Cielo", "Data: 20/10/2026", "Horário: 09:00 às 11:00", "Órgão de Governança: Comitê Executivo", "Pautas/Temas:", "A definir.", "Informações adicionais:"]) {
    assert.ok(texto.includes(trecho), trecho);
  }
  // Com temas, viram lista; nome com "<" é escapado.
  assert.match(web.montarDescricaoInicial({ ...dados, temas: ["Orçamento <2027>"] }), /<ul><li>Orçamento &lt;2027&gt;<\/li><\/ul>/);
});

test("template acompanha data/horário só enquanto não foi editado", () => {
  const original = web.montarDescricaoInicial(dados);
  const depois = { ...dados, data: "2026-10-21", inicio: "14:00", fim: "15:00" };
  const r = web.descricaoAposMudanca(original, dados, depois);
  assert.deepEqual(r, { descricao: web.montarDescricaoInicial(depois), atualizada: true });
  // Texto editado pela pessoa: nunca sobrescrito (null = a tela avisa).
  const editado = original.replace("A definir.", "Aprovar o orçamento.");
  assert.equal(web.descricaoAposMudanca(editado, dados, depois), null);
  // Mesmo HTML vindo do servidor (saneado) continua sendo reconhecido como template.
  assert.equal(web.descricaoAposMudanca(api.sanitizarHtml(original), dados, depois)?.atualizada, true);
});
