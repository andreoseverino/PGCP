import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import {
  DESCRICAO_HTML_MAX,
  descricaoComoHtml,
  parseDescricao,
  sanitizarHtml,
  textoDaDescricao,
  textoParaHtml,
} from "./rich-text.js";
import { montarEvento } from "../calendar/mapper.js";

test("formatação permitida sobrevive: negrito, itálico, listas, parágrafos e quebras", () => {
  const html =
    "<p><strong>Pauta</strong> e <em>objetivo</em><br>linha 2</p>" +
    "<ul><li>um</li><li>dois</li></ul><ol><li>primeiro</li></ol>";
  assert.equal(sanitizarHtml(html), html);
  // Sinônimos do contentEditable viram a forma canônica.
  assert.equal(sanitizarHtml("<div><b>a</b> <i>b</i></div>"), "<p><strong>a</strong> <em>b</em></p>");
  assert.equal(sanitizarHtml("<p>x<br/>y<br />z</p>"), "<p>x<br>y<br>z</p>");
});

test("XSS: script, eventos, javascript:, estilo, iframe, svg e comentários não passam", () => {
  const vetores = [
    '<script>alert(1)</script><p>ok</p>',
    '<p onclick="alert(1)">ok</p>',
    '<img src=x onerror="alert(1)">ok',
    '<a href="javascript:alert(1)">ok</a>',
    '<p style="background:url(javascript:alert(1))">ok</p>',
    '<iframe src="https://evil"></iframe>ok',
    '<svg><script>alert(1)</script></svg>ok',
    '<!-- <script>alert(1)</script> -->ok',
    '<scr<script>ipt>alert(1)</script>ok',
    '<p>ok</p><style>p{}</style>',
    '<math><mtext></p><img src=x onerror=alert(1)></mtext></math>ok',
  ];
  for (const v of vetores) {
    const saida = sanitizarHtml(v);
    assert.ok(!/<(script|img|a|iframe|svg|style|math)\b/i.test(saida), `${v} -> ${saida}`);
    assert.ok(!/\son\w+=|javascript:|style=|href=|src=/i.test(saida), `${v} -> ${saida}`);
    assert.match(textoDaDescricao(saida), /ok/);
  }
});

test("nenhum atributo sobrevive, nem em tag permitida; texto é reescapado", () => {
  assert.equal(sanitizarHtml('<p class="x" data-a="1" id="y">a</p>'), "<p>a</p>");
  assert.equal(sanitizarHtml("<p>1 < 2 & 3 > 2</p>"), "<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
  assert.equal(sanitizarHtml("<p>&lt;script&gt;</p>"), "<p>&lt;script&gt;</p>", "entidade não vira tag");
  assert.equal(sanitizarHtml('<p title="a>b">x</p>'), "<p>x</p>");
});

test("estrutura sempre bem formada: fecha abertas, ignora fechamento solto, li solto vira parágrafo", () => {
  assert.equal(sanitizarHtml("<p><strong>a"), "<p><strong>a</strong></p>");
  assert.equal(sanitizarHtml("a</em></p>b"), "ab");
  assert.equal(sanitizarHtml("<li>solto</li>"), "<p>solto</p>");
  assert.equal(sanitizarHtml("<ul><li>a<li>b</ul>"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(sanitizarHtml("<p>a<ul><li>b</li></ul>"), "<p>a</p><ul><li>b</li></ul>");
});

test("texto puro legado vira parágrafos (e é escapado); HTML é reconhecido", () => {
  assert.equal(textoParaHtml("Linha 1\nLinha 2\n\nOutro <b>parágrafo</b>"), "<p>Linha 1<br>Linha 2</p><p>Outro &lt;b&gt;parágrafo&lt;/b&gt;</p>");
  assert.equal(descricaoComoHtml("Reunião antiga"), "<p>Reunião antiga</p>");
  assert.equal(descricaoComoHtml("<p><strong>x</strong></p>"), "<p><strong>x</strong></p>");
  assert.equal(descricaoComoHtml(null), "");
});

test("parseDescricao: limpa, converte, saneia e respeita o tamanho máximo", () => {
  assert.equal(parseDescricao(undefined), undefined);
  assert.equal(parseDescricao(null), null);
  assert.equal(parseDescricao("   "), null);
  assert.equal(parseDescricao("<p><br></p>"), null, "só marcação vazia = sem descrição");
  assert.equal(parseDescricao('<p onclick="x">Oi</p><script>1</script>'), "<p>Oi</p>");
  assert.throws(() => parseDescricao(42), HttpError);
  assert.throws(() => parseDescricao(`<p>${"a".repeat(DESCRICAO_HTML_MAX)}</p>`), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.throws(() => parseDescricao("a".repeat(70_000)), HttpError);
});

test("textoDaDescricao: listas e parágrafos viram texto legível (PDF/Excel)", () => {
  assert.equal(
    textoDaDescricao("<p><strong>Reunião:</strong> X</p><ul><li>a</li><li>b</li></ul>"),
    "Reunião: X\n\n• a\n• b",
  );
});

test("Graph: corpo do convite em HTML, só com a descrição saneada e texto escapado", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Reunião",
    startAt: new Date("2026-10-20T12:00:00Z"),
    endAt: new Date("2026-10-20T13:00:00Z"),
    timezone: "America/Sao_Paulo",
    meetingLink: null,
    onlineMeetingProvider: "teamsForBusiness" as const,
  };
  const evento = montarEvento(
    { ...base, description: '<p><strong>Pauta</strong></p><script>alert(1)</script><ul><li onclick="x">item</li></ul>' },
    [],
  );
  assert.equal(evento.body.contentType, "html");
  assert.equal(evento.body.content, "<p><strong>Pauta</strong></p><ul><li>item</li></ul>");
  // Descrição antiga em texto puro: parágrafos, com o "<" escapado.
  const legado = montarEvento({ ...base, description: "a < b\nlinha" }, []);
  assert.equal(legado.body.content, "<p>a &lt; b<br>linha</p>");
  // Link digitado continua como texto escapado, nunca atributo.
  const comLink = montarEvento({ ...base, description: null, meetingLink: "https://x.test/?a=1&b=<2>" }, []);
  assert.equal(comLink.body.content, "<p>https://x.test/?a=1&amp;b=&lt;2&gt;</p>");
});
