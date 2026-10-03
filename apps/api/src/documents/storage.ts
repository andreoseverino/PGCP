import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { HttpError } from "../http-error.js";

/**
 * ARMAZENAMENTO DE DOCUMENTOS — AWS S3 (bucket PRIVADO).
 *
 * Só bytes. Metadados, contexto e autorização ficam no PostgreSQL; nada aqui
 * lista o bucket nem interpreta a chave. Credenciais pela CADEIA PADRÃO do AWS
 * SDK (variáveis do ambiente local de desenvolvimento, perfil, ou IAM Role em
 * produção) — nenhuma chave no código nem no `.env.example`.
 *
 * Sem configuração (`PGCP_DOCUMENTS_BUCKET` + `AWS_REGION`), só as operações de
 * arquivo respondem 503 com mensagem clara; o resto da aplicação segue. Em
 * produção o production guard exige a configuração (não há armazenamento local).
 *
 * Download é feito PELO BACKEND (o objeto passa pela API, que autorizou):
 * nenhuma URL do S3, assinada ou não, chega ao navegador.
 */

export interface ArmazenamentoDeDocumentos {
  gravar(chave: string, conteudo: Buffer, mime: string): Promise<void>;
  ler(chave: string): Promise<Buffer>;
  /** Só para COMPENSAÇÃO (metadado não gravou depois do upload). */
  remover(chave: string): Promise<void>;
}

export interface ConfiguracaoDoArmazenamento {
  bucket: string;
  region: string;
  /** Opcional: chave KMS gerenciada pelo cliente (senão, SSE-S3). */
  kmsKeyId?: string;
}

export function configuracaoDoArmazenamento(env: NodeJS.ProcessEnv = process.env): ConfiguracaoDoArmazenamento | null {
  const bucket = env.PGCP_DOCUMENTS_BUCKET?.trim();
  const region = env.AWS_REGION?.trim();
  if (!bucket || !region) return null;
  const kmsKeyId = env.PGCP_DOCUMENTS_KMS_KEY_ID?.trim() || undefined;
  return { bucket, region, ...(kmsKeyId ? { kmsKeyId } : {}) };
}

export const MSG_ARMAZENAMENTO_NAO_CONFIGURADO =
  "O armazenamento de documentos ainda não está configurado neste ambiente (AWS S3). Contate o administrador.";

const TIMEOUT_MS = 30_000;

/** Erro do S3 → resposta legível, sem detalhe técnico do provedor. */
function traduzir(error: unknown, operacao: "gravar" | "ler" | "remover"): HttpError {
  const nome = (error as { name?: string; Code?: string } | null)?.name ?? (error as { Code?: string } | null)?.Code;
  // Diagnóstico no servidor: tipo do erro, nunca credencial, chave ou conteúdo.
  console.error(`[documents] S3 ${operacao} falhou: ${nome ?? "erro desconhecido"}`);
  if (nome === "NoSuchKey" || nome === "NotFound") {
    return new HttpError(404, "O arquivo deste documento não foi encontrado no armazenamento.");
  }
  if (nome === "AbortError" || nome === "TimeoutError") {
    return new HttpError(504, "O armazenamento de documentos não respondeu a tempo. Tente novamente.");
  }
  if (nome === "AccessDenied" || nome === "CredentialsProviderError" || nome === "InvalidAccessKeyId") {
    return new HttpError(503, "O PGCP não tem acesso ao armazenamento de documentos. Contate o administrador.");
  }
  return new HttpError(502, "Não foi possível acessar o armazenamento de documentos. Tente novamente em instantes.");
}

export function armazenamentoS3(config: ConfiguracaoDoArmazenamento, cliente?: S3Client): ArmazenamentoDeDocumentos {
  const s3 = cliente ?? new S3Client({ region: config.region });
  const comTempo = () => ({ abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  return {
    async gravar(chave, conteudo, mime) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: chave,
            Body: conteudo,
            ContentType: mime,
            ContentLength: conteudo.length,
            // Criptografia em repouso sempre; KMS quando configurado.
            ...(config.kmsKeyId
              ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: config.kmsKeyId }
              : { ServerSideEncryption: "AES256" as const }),
          }),
          comTempo(),
        );
      } catch (error) {
        throw traduzir(error, "gravar");
      }
    },
    async ler(chave) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: chave }), comTempo());
        if (!r.Body) throw Object.assign(new Error("corpo vazio"), { name: "NoSuchKey" });
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (error) {
        throw traduzir(error, "ler");
      }
    },
    async remover(chave) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: chave }), comTempo());
      } catch (error) {
        throw traduzir(error, "remover");
      }
    },
  };
}

let substituto: ArmazenamentoDeDocumentos | null | undefined;
let padrao: { chave: string; armazenamento: ArmazenamentoDeDocumentos } | null = null;

/** Armazenamento em uso; `null` = não configurado (operações de arquivo → 503). */
export function armazenamentoDeDocumentos(): ArmazenamentoDeDocumentos | null {
  if (substituto !== undefined) return substituto;
  const config = configuracaoDoArmazenamento();
  if (!config) return null;
  const chave = `${config.region}/${config.bucket}/${config.kmsKeyId ?? ""}`;
  if (padrao?.chave !== chave) padrao = { chave, armazenamento: armazenamentoS3(config) };
  return padrao.armazenamento;
}

/** Testes e smokes: injeta um armazenamento falso (`undefined` volta ao real). */
export function definirArmazenamentoDeDocumentos(a: ArmazenamentoDeDocumentos | null | undefined): void {
  substituto = a;
}

export function exigirArmazenamento(): ArmazenamentoDeDocumentos {
  const a = armazenamentoDeDocumentos();
  if (!a) throw new HttpError(503, MSG_ARMAZENAMENTO_NAO_CONFIGURADO);
  return a;
}
