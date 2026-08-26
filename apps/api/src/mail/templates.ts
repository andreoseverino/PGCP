import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";

/**
 * Modelos de e-mail editaveis pela administracao.
 *
 * TEXTO PURO, nunca HTML. O corpo e escrito por uma pessoa e enviado a outra;
 * aceitar HTML transformaria o campo numa superficie de injecao no cliente de
 * e-mail de quem recebe. `mail/send.ts` envia com `contentType: "text"`, entao
 * marcacao aqui e apenas texto literal la.
 *
 * SEM EDITOR RICO. Assunto e corpo sao dois campos de texto. Um editor HTML
 * traria sanitizacao, colagem de estilo e um vetor novo — sem necessidade real.
 */

/** Unico modelo existente. Novo modelo entra no CHECK da migration junto. */
export const CHAVE_VALIDACAO_PAUTAS = "agenda_validation";

export const ASSUNTO_MAX = 200;
export const CORPO_MAX = 20000;

export interface EmailTemplate {
  key: string;
  subject: string;
  body: string;
  updatedAt: string;
  updatedByUserId: string | null;
}

interface TemplateRow {
  key: string;
  subject: string;
  body: string;
  updated_at: Date;
  updated_by_user_id: string | null;
}

const montar = (row: TemplateRow): EmailTemplate => ({
  key: row.key,
  subject: row.subject,
  body: row.body,
  updatedAt: row.updated_at.toISOString(),
  updatedByUserId: row.updated_by_user_id,
});

type Executor = Pick<PoolClient, "query">;

export async function findTemplate(
  key: string,
  executor: Executor = pool,
): Promise<EmailTemplate | null> {
  const { rows } = await executor.query<TemplateRow>(
    `SELECT key, subject, body, updated_at, updated_by_user_id FROM email_templates WHERE key = $1`,
    [key],
  );
  return rows[0] ? montar(rows[0]) : null;
}

/**
 * Modelo de validacao de pautas. A migration 016 semeia a linha, entao a
 * ausencia e defeito de instalacao — nao um caso normal a contornar com texto
 * inventado em tempo de execucao.
 */
export async function getTemplateDeValidacao(executor: Executor = pool): Promise<EmailTemplate> {
  const template = await findTemplate(CHAVE_VALIDACAO_PAUTAS, executor);
  if (!template) {
    throw new HttpError(
      500,
      "Modelo de e-mail de validação não encontrado. Verifique se as migrations foram aplicadas.",
    );
  }
  return template;
}

// ---------------------------------------------------------------------------
// Validacao da entrada
// ---------------------------------------------------------------------------

export interface TemplateInput {
  subject: string;
  body: string;
}

/**
 * Le e valida o corpo do PATCH.
 *
 * Recusa caractere de controle: assunto com CR ou LF permitiria injecao de
 * cabecalho de e-mail em qualquer cliente que monte MIME por concatenacao.
 * O Graph monta a mensagem por JSON e nao seria vulneravel, mas o dado fica
 * salvo e pode alimentar outro caminho depois — barrar na entrada e mais barato
 * que confiar em todos os consumidores futuros.
 */
export function parseTemplateInput(corpo: unknown): TemplateInput {
  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    throw new HttpError(400, "Corpo da requisição inválido.");
  }

  const bruto = corpo as Record<string, unknown>;

  const permitidos = new Set(["subject", "body"]);
  for (const chave of Object.keys(bruto)) {
    if (!permitidos.has(chave)) {
      throw new HttpError(400, `O campo '${chave}' não é aceito por este endpoint.`);
    }
  }

  const texto = (valor: unknown, campo: string, maximo: number, permiteQuebra: boolean): string => {
    if (typeof valor !== "string") throw new HttpError(400, `'${campo}' é obrigatório.`);
    const limpo = valor.trim();
    if (limpo.length === 0) throw new HttpError(400, `'${campo}' não pode ficar vazio.`);
    if (limpo.length > maximo) {
      throw new HttpError(400, `'${campo}' deve ter no máximo ${maximo} caracteres.`);
    }
    const proibidos = permiteQuebra
      ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
      : /[\u0000-\u001F\u007F]/;
    if (proibidos.test(limpo)) {
      throw new HttpError(400, `'${campo}' contém caracteres não permitidos.`);
    }
    return limpo;
  };

  return {
    // Assunto e uma linha: sem CR/LF.
    subject: texto(bruto.subject, "subject", ASSUNTO_MAX, false),
    // Corpo aceita quebra de linha, mas nenhum outro controle.
    body: texto(bruto.body, "body", CORPO_MAX, true),
  };
}

/** Grava o modelo e registra quem mudou. */
export async function salvarTemplate(
  key: string,
  input: TemplateInput,
  usuarioId: string,
  executor: Executor = pool,
): Promise<EmailTemplate> {
  const { rows } = await executor.query<TemplateRow>(
    `UPDATE email_templates
        SET subject = $2, body = $3, updated_by_user_id = $4
      WHERE key = $1
      RETURNING key, subject, body, updated_at, updated_by_user_id`,
    [key, input.subject, input.body, usuarioId],
  );
  if (!rows[0]) throw new HttpError(404, "Modelo de e-mail não encontrado.");
  return montar(rows[0]);
}

// ---------------------------------------------------------------------------
// Variaveis
// ---------------------------------------------------------------------------

/** Variaveis reconhecidas. Qualquer outra fica literal no texto. */
export const VARIAVEIS_SUPORTADAS = [
  "nome_reuniao",
  "data_reuniao",
  "solicitante",
  "quantidade_pautas",
] as const;

export type VariaveisDoTemplate = Record<(typeof VARIAVEIS_SUPORTADAS)[number], string>;

/**
 * Substitui `{{variavel}}` pelos valores informados.
 *
 * SUBSTITUICAO EM UMA PASSADA, e nao um `replace` por variavel: se um valor
 * contiver `{{outra}}`, uma segunda passada o expandiria. Um titulo de reuniao
 * digitado como `{{solicitante}}` nao pode virar o nome de quem enviou.
 *
 * Variavel desconhecida permanece literal, de proposito: some-la em silencio
 * esconderia o erro de digitacao de quem editou o modelo.
 */
export function renderizarTemplate(texto: string, variaveis: VariaveisDoTemplate): string {
  return texto.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (original, nome: string) => {
    const conhecida = (VARIAVEIS_SUPORTADAS as readonly string[]).includes(nome);
    return conhecida ? variaveis[nome as keyof VariaveisDoTemplate] : original;
  });
}
