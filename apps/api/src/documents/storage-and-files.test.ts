import assert from "node:assert/strict";
import { test } from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { HttpError } from "../http-error.js";
import {
  chaveDoObjeto,
  contentDisposition,
  descricaoOpcional,
  nomeOriginalSeguro,
  tamanhoMaximo,
  TAMANHO_MAXIMO_PADRAO,
  validarArquivo,
} from "./file-rules.js";
import { armazenamentoS3, configuracaoDoArmazenamento } from "./storage.js";

const PDF = Buffer.from("%PDF-1.7\n...conteúdo");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);

test("arquivo: allowlist (PDF, PowerPoint, Word, Excel) com MIME decidido pelo servidor", () => {
  assert.deepEqual(validarArquivo("Relatório Financeiro.pdf", PDF), { nome: "Relatório Financeiro.pdf", extensao: "pdf", mime: "application/pdf" });
  assert.equal(validarArquivo("Apresentação.PPTX", ZIP).mime, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(validarArquivo("antigo.ppt", OLE).mime, "application/vnd.ms-powerpoint");
  assert.equal(validarArquivo("planilha.xlsx", ZIP).extensao, "xlsx");
  assert.equal(validarArquivo("ata.docx", ZIP).extensao, "docx");
});

test("arquivo: recusa tipo perigoso, extensão dupla, conteúdo que não bate, vazio e grande demais", () => {
  const recusa = (nome: string, conteudo: Buffer, status: number, max?: number) =>
    assert.throws(() => validarArquivo(nome, conteudo, max), (e: unknown) => e instanceof HttpError && e.status === status, nome);
  for (const nome of ["virus.exe", "script.js", "pagina.html", "logo.svg", "macro.pptm", "dados.csv", "sem-extensao"]) recusa(nome, PDF, 400);
  recusa("relatorio.exe.pdf", PDF, 400); // extensão dupla perigosa
  recusa("relatorio.html.pdf", PDF, 400);
  recusa("falso.pdf", Buffer.from("<html>"), 400); // conteúdo não é PDF
  recusa("falso.pptx", PDF, 400); // PDF disfarçado de PowerPoint
  recusa("vazio.pdf", Buffer.alloc(0), 400);
  recusa("grande.pdf", Buffer.concat([PDF, Buffer.alloc(100)]), 413, 50);
});

test("nome: sem caminho, sem controle, sem arquivo oculto; descrição curta", () => {
  assert.equal(nomeOriginalSeguro("..\\..\\C:\\temp\\Relatório.pdf"), "Relatório.pdf");
  assert.equal(nomeOriginalSeguro("../../etc/proposta.pdf"), "proposta.pdf");
  for (const ruim of ["", "..", ".env", "a\u0000.pdf", "x".repeat(256) + ".pdf", 42]) {
    assert.throws(() => nomeOriginalSeguro(ruim), HttpError, String(ruim).slice(0, 20));
  }
  assert.equal(descricaoOpcional("  Proposta   final "), "Proposta final");
  assert.equal(descricaoOpcional(""), null);
  assert.throws(() => descricaoOpcional("x".repeat(501)), HttpError);
});

test("tamanho máximo: configuração central (padrão 20 MB; valor inválido cai no padrão)", () => {
  assert.equal(tamanhoMaximo({}), TAMANHO_MAXIMO_PADRAO);
  assert.equal(tamanhoMaximo({ DOCUMENT_MAX_SIZE_BYTES: "1048576" }), 1048576);
  for (const ruim of ["0", "-5", "abc", "999999999999"]) assert.equal(tamanhoMaximo({ DOCUMENT_MAX_SIZE_BYTES: ruim }), TAMANHO_MAXIMO_PADRAO);
});

test("chave do objeto: só ids estáveis; nome original e pessoas fora; Content-Disposition seguro", () => {
  const m = "11111111-1111-4111-8111-111111111111", i = "22222222-2222-4222-8222-222222222222", d = "33333333-3333-4333-8333-333333333333";
  assert.equal(chaveDoObjeto({ meetingId: m, agendaItemId: null, documentId: d, extensao: "pdf" }), `meetings/${m}/documents/${d}/arquivo.pdf`);
  assert.equal(chaveDoObjeto({ meetingId: m, agendaItemId: i, documentId: d, extensao: "pptx" }), `meetings/${m}/topics/${i}/${d}/arquivo.pptx`);
  const cd = contentDisposition('Apresentação "Final"; x/y.pptx');
  assert.match(cd, /^attachment; filename="Apresentacao _Final__ x_y\.pptx"; filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(contentDisposition("a\r\nb.pdf")));
});

test("S3: configuração por ambiente (sem valores inventados)", () => {
  assert.equal(configuracaoDoArmazenamento({}), null);
  assert.equal(configuracaoDoArmazenamento({ PGCP_DOCUMENTS_BUCKET: "b" }), null, "sem região");
  assert.deepEqual(configuracaoDoArmazenamento({ PGCP_DOCUMENTS_BUCKET: " b ", AWS_REGION: "r" }), { bucket: "b", region: "r" });
  assert.deepEqual(configuracaoDoArmazenamento({ PGCP_DOCUMENTS_BUCKET: "b", AWS_REGION: "r", PGCP_DOCUMENTS_KMS_KEY_ID: "k" }), { bucket: "b", region: "r", kmsKeyId: "k" });
});

/** Cliente S3 falso: registra os comandos e responde/falha como pedido. */
function s3Falso(responder: (nome: string, input: Record<string, unknown>) => unknown) {
  const comandos: Array<{ nome: string; input: Record<string, unknown> }> = [];
  const cliente = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      comandos.push({ nome: cmd.constructor.name, input: cmd.input });
      return responder(cmd.constructor.name, cmd.input);
    },
  } as unknown as S3Client;
  return { cliente, comandos };
}

const erro = (name: string) => Object.assign(new Error(name), { name });

test("S3 PutObject: bucket privado, chave, MIME e criptografia em repouso (SSE-S3 ou KMS)", async () => {
  const { cliente, comandos } = s3Falso(() => ({}));
  await armazenamentoS3({ bucket: "b", region: "r" }, cliente).gravar("k/1/arquivo.pdf", PDF, "application/pdf");
  assert.equal(comandos[0]!.nome, "PutObjectCommand");
  assert.deepEqual(
    [comandos[0]!.input.Bucket, comandos[0]!.input.Key, comandos[0]!.input.ContentType, comandos[0]!.input.ServerSideEncryption, comandos[0]!.input.ACL],
    ["b", "k/1/arquivo.pdf", "application/pdf", "AES256", undefined],
  );
  const kms = s3Falso(() => ({}));
  await armazenamentoS3({ bucket: "b", region: "r", kmsKeyId: "chave" }, kms.cliente).gravar("k", PDF, "application/pdf");
  assert.deepEqual([kms.comandos[0]!.input.ServerSideEncryption, kms.comandos[0]!.input.SSEKMSKeyId], ["aws:kms", "chave"]);
});

test("S3 GetObject e falhas: inexistente 404, tempo 504, sem acesso 503, outra 502", async () => {
  const { cliente } = s3Falso(() => ({ Body: { transformToByteArray: async () => new Uint8Array(PDF) } }));
  assert.deepEqual(await armazenamentoS3({ bucket: "b", region: "r" }, cliente).ler("k"), PDF);
  const original = console.error;
  console.error = () => {};
  try {
    for (const [nome, status] of [["NoSuchKey", 404], ["TimeoutError", 504], ["AccessDenied", 503], ["InternalError", 502]] as const) {
      const falho = s3Falso(() => {
        throw erro(nome);
      });
      const s3 = armazenamentoS3({ bucket: "b", region: "r" }, falho.cliente);
      await assert.rejects(s3.ler("k"), (e: unknown) => e instanceof HttpError && e.status === status, nome);
      await assert.rejects(s3.gravar("k", PDF, "application/pdf"), (e: unknown) => e instanceof HttpError, nome);
    }
  } finally {
    console.error = original;
  }
});
