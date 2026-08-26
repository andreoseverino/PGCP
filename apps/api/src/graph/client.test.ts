import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GraphError, graphRequest } from "./client.js";

/**
 * Testes do cliente do Microsoft Graph — foco nas RESPOSTAS DE SUCESSO.
 *
 * REGRESSAO REAL (primeiro teste corporativo de `Mail.Send`):
 *
 *   `/me/sendMail` responde **202 Accepted com corpo vazio**. O cliente tratava
 *   apenas o 204 como "sem corpo" e chamava `response.json()` no resto, entao o
 *   202 virava `SyntaxError: Unexpected end of JSON input` — DEPOIS de a
 *   Microsoft ja ter aceitado a mensagem.
 *
 *   Efeito: o e-mail chegava ao destinatario e a tela dizia "Erro interno ao
 *   processar a solicitação". A pessoa reenviava, e o aprovador recebia dois
 *   e-mails. A trilha registrou duas falhas e a reuniao ficou em `draft`.
 *
 * Um servidor HTTP local imita o Graph. `accessToken` e passado explicitamente
 * para que o cliente NAO tente a troca On-Behalf-Of — estes testes nao tocam o
 * Entra, nao usam credencial real e nao alcancam a rede externa.
 */

/** Sobe um servidor que responde sempre o mesmo status/corpo. */
async function comGraphFalso(
  status: number,
  corpo: string,
  contentType?: string,
): Promise<{ baseUrl: string; fechar: () => Promise<void>; chamadas: number }> {
  const estado = { chamadas: 0 };

  const servidor = http.createServer((_req, res) => {
    estado.chamadas += 1;
    if (contentType) res.writeHead(status, { "Content-Type": contentType });
    else res.writeHead(status);
    res.end(corpo);
  });

  await new Promise<void>((resolver) => servidor.listen(0, "127.0.0.1", resolver));
  const { port } = servidor.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fechar: () => new Promise<void>((resolver) => servidor.close(() => resolver())),
    get chamadas() {
      return estado.chamadas;
    },
  };
}

const config = (baseUrl: string) => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "nao-usado-porque-o-token-e-passado",
  baseUrl,
});

const servidores: Array<() => Promise<void>> = [];
after(async () => {
  for (const fechar of servidores) await fechar();
});

async function chamar(status: number, corpo: string, contentType?: string): Promise<unknown> {
  const falso = await comGraphFalso(status, corpo, contentType);
  servidores.push(falso.fechar);
  return graphRequest<unknown>(config(falso.baseUrl), "/me/sendMail", {
    method: "POST",
    body: { message: {} },
    accessToken: "token-delegado-falso",
  });
}

// --- a regressao -------------------------------------------------------------

test("202 Accepted sem corpo é SUCESSO — /me/sendMail", async () => {
  // O caso exato do incidente. Antes: SyntaxError com o e-mail já enviado.
  const resultado = await chamar(202, "");
  assert.equal(resultado, undefined, "sucesso sem corpo devolve undefined, não lança");
});

test("202 Accepted com Content-Length 0 explícito é sucesso", async () => {
  const resultado = await chamar(202, "", "application/json");
  assert.equal(resultado, undefined);
});

// --- demais respostas de sucesso ---------------------------------------------

test("204 No Content continua sendo sucesso — DELETE de evento", async () => {
  assert.equal(await chamar(204, ""), undefined);
});

test("200 com corpo vazio não quebra", async () => {
  // Nenhum endpoint conhecido faz isso, mas o cliente não pode transformar uma
  // resposta BOA em exceção só porque o corpo veio vazio.
  assert.equal(await chamar(200, ""), undefined);
});

test("200 com JSON continua devolvendo o objeto", async () => {
  const resultado = await chamar(200, '{"id":"abc","value":[1,2]}', "application/json");
  assert.deepEqual(resultado, { id: "abc", value: [1, 2] });
});

test("201 com JSON continua devolvendo o objeto — criação de evento", async () => {
  const resultado = await chamar(201, '{"id":"evt-1"}', "application/json");
  assert.deepEqual(resultado, { id: "evt-1" });
});

test("sucesso com corpo NÃO-JSON não vira exceção", async () => {
  // A operação deu certo; não há o que entregar. Transformar em erro repetiria
  // exatamente o defeito que o 202 causou.
  assert.equal(await chamar(200, "OK", "text/plain"), undefined);
});

// --- o erro continua sendo erro ----------------------------------------------

test("erro do Graph continua propagando como GraphError", async () => {
  // A correção não pode ter transformado falha em sucesso silencioso.
  await assert.rejects(
    () => chamar(403, '{"error":{"code":"ErrorAccessDenied","message":"negado"}}', "application/json"),
    (erro: unknown) => {
      assert.ok(erro instanceof GraphError, "deveria ser GraphError");
      assert.equal(erro.status, 403);
      return true;
    },
  );
});

test("erro 5xx do Graph continua propagando", async () => {
  await assert.rejects(
    () => chamar(503, ""),
    (erro: unknown) => {
      assert.ok(erro instanceof GraphError);
      assert.equal(erro.status, 503);
      return true;
    },
  );
});

test("erro sem corpo JSON continua sendo erro, não sucesso vazio", async () => {
  // Corpo vazio em resposta de ERRO não pode cair no caminho de "sucesso sem
  // corpo": o status é quem decide.
  await assert.rejects(() => chamar(400, ""), GraphError);
});
