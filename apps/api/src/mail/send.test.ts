import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GraphError, graphRequest, type RespostaDoGraph } from "../graph/client.js";
import { corpoDoSendMail, falhaDeEnvio } from "./send.js";

/**
 * Envio delegado (`POST /me/sendMail`): payload, tradução das falhas e
 * correlação. Servidor HTTP local imita o Graph; nada sai da máquina e nenhum
 * token real é usado.
 */

test("payload: destinatário externo, texto puro, PDF em base64 e cópia em Itens Enviados", () => {
  const pdf = Buffer.from("%PDF-1.4 conteúdo de teste");
  const corpo = corpoDoSendMail({
    para: "aprovador@gmail.com",
    assunto: "Aprovação da Agenda Anual 2026 — Comitê",
    corpo: "<b>texto</b>",
    anexo: { nome: "agenda-anual-2026.pdf", tipo: "application/pdf", conteudo: pdf },
  });
  assert.equal(corpo.saveToSentItems, true, "o remetente vê o envio em Itens Enviados");
  const m = corpo.message as {
    toRecipients: Array<{ emailAddress: { address: string } }>;
    body: { contentType: string; content: string };
    attachments: Array<Record<string, string>>;
  };
  assert.deepEqual(m.toRecipients, [{ emailAddress: { address: "aprovador@gmail.com" } }], "externo é destinatário válido");
  assert.deepEqual(m.body, { contentType: "text", content: "<b>texto</b>" }, "texto puro, marcação literal");
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(m.attachments[0]!.contentType, "application/pdf");
  assert.equal(m.attachments[0]!.name, "agenda-anual-2026.pdf");
  assert.deepEqual(Buffer.from(m.attachments[0]!.contentBytes!, "base64"), pdf);
  assert.ok(!("attachments" in corpoDoSendMail({ para: "a@b.co", assunto: "x", corpo: "y" }).message));
});

test("falhas do envio delegado apontam a camada certa (não 'permissão de aplicação')", () => {
  const e401 = falhaDeEnvio(new GraphError("O Graph rejeitou o token da aplicação.", "unauthorized", 401)) as GraphError;
  assert.equal(e401.status, 401);
  assert.match(e401.message, /credencial/);
  const e403 = falhaDeEnvio(new GraphError("…aplicação…", "ErrorAccessDenied", 403)) as GraphError;
  assert.equal(e403.status, 403);
  assert.equal(e403.code, "ErrorAccessDenied", "código do Graph preservado");
  assert.match(e403.message, /Mail\.Send \(delegada\)/);
  assert.ok(!/Calendars|Resource Scope|User\.Read\.All/.test(e403.message));
  for (const status of [400, 429, 500, 503]) {
    const e = new GraphError("x", "c", status);
    assert.equal(falhaDeEnvio(e), e, `${status} segue como veio`);
  }
  const outro = new Error("rede");
  assert.equal(falhaDeEnvio(outro), outro);
});

// --- cliente Graph: status, erros e correlação ------------------------------------

const servidores: Array<() => Promise<void>> = [];
after(async () => {
  for (const fechar of servidores) await fechar();
});

async function graphFalso(status: number, corpo = "", cabecalhos: Record<string, string> = {}) {
  const recebido: { clientRequestId?: string; autorizacao?: string } = {};
  const servidor = http.createServer((req, res) => {
    recebido.clientRequestId = req.headers["client-request-id"] as string | undefined;
    recebido.autorizacao = req.headers.authorization;
    res.writeHead(status, { "request-id": "req-graph-123", ...cabecalhos });
    res.end(corpo);
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  servidores.push(() => new Promise<void>((r) => servidor.close(() => r())));
  const { port } = servidor.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, recebido };
}

const config = (baseUrl: string) => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "nao-usado",
  baseUrl,
});

const enviar = (baseUrl: string, extra: { aoResponder?: (i: RespostaDoGraph) => void } = {}) =>
  graphRequest<void>(config(baseUrl), "/me/sendMail", {
    method: "POST",
    body: { message: {} },
    accessToken: "token-delegado-falso",
    operacao: "annual_agenda_send_mail",
    ...extra,
  });

test("202 Accepted: sucesso com request-id e client-request-id (correlação), sem expor token no log", async () => {
  const falso = await graphFalso(202);
  const logs: string[] = [];
  const original = console.info;
  console.info = (...a: unknown[]) => void logs.push(a.join(" "));
  let info: RespostaDoGraph | null = null;
  try {
    await enviar(falso.baseUrl, { aoResponder: (i) => (info = i) });
  } finally {
    console.info = original;
  }
  assert.equal(falso.recebido.autorizacao, "Bearer token-delegado-falso");
  assert.match(falso.recebido.clientRequestId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(info, { status: 202, requestId: "req-graph-123", clientRequestId: falso.recebido.clientRequestId });
  const log = JSON.parse(logs.find((l) => l.includes("microsoft_graph"))!);
  assert.deepEqual(log, {
    kind: "integration", integration: "microsoft_graph", operation: "annual_agenda_send_mail",
    status: 202, requestId: "req-graph-123", clientRequestId: falso.recebido.clientRequestId,
  });
  assert.ok(!logs.join(" ").includes("token-delegado-falso"), "token nunca vai para log");
});

test("400 / 401 / 403 / 429 / 500 viram falha (nunca sucesso silencioso)", async () => {
  const erroDoGraph = (code: string) => JSON.stringify({ error: { code, message: "detalhe" } });
  const original = console.error;
  const avisos: string[] = [];
  console.error = (...a: unknown[]) => void avisos.push(a.join(" "));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [status, code, cabecalhos] of [
      [400, "ErrorInvalidRecipients", {}],
      [401, "InvalidAuthenticationToken", {}],
      [403, "ErrorAccessDenied", {}],
      [429, "TooManyRequests", { "retry-after": "120" }],
      [500, "generalException", {}],
    ] as const) {
      const falso = await graphFalso(status, erroDoGraph(code), { "Content-Type": "application/json", ...cabecalhos });
      await assert.rejects(enviar(falso.baseUrl), (e: unknown) => e instanceof GraphError && e.status === status, `${status}`);
    }
  } finally {
    console.error = original;
    console.warn = originalWarn;
  }
  // O log de falha traz status, código e request-id — não o corpo nem o token.
  assert.ok(avisos.some((l) => /respondeu 403 \(ErrorAccessDenied\) request-id=req-graph-123/.test(l)));
  assert.ok(!avisos.join(" ").includes("token-delegado-falso"));
});

test("rede indisponível vira falha", async () => {
  await assert.rejects(enviar("http://127.0.0.1:9"), (e: unknown) => e instanceof GraphError && e.code === "network_error");
});
