import { ConfidentialClientApplication } from "@azure/msal-node";
import { HttpError } from "../http-error.js";
import { GraphError, getGraphConfig, graphRequest, missingGraphConfig, type RespostaDoGraph } from "../graph/client.js";

/**
 * Envio de e-mail pela caixa do PROPRIO usuario autenticado.
 *
 *   navegador --access_as_user--> API PGCP --OBO--> Entra --token delegado--> Graph
 *                                                              |
 *                                              POST /me/sendMail
 *
 * DELEGADO, e nao app-only. A diferenca importa para seguranca:
 *
 *   Mail.Send APPLICATION  -> a aplicacao envia como QUALQUER caixa do tenant,
 *                             a menos que uma Application Access Policy do
 *                             Exchange a restrinja. E o mesmo padrao que o PGCP
 *                             ja recusou para `Calendars.ReadWrite`.
 *   Mail.Send DELEGADO     -> a pessoa envia como ELA MESMA, e so enquanto tem
 *                             sessao. Nao ha caixa alheia alcancavel.
 *
 * O e-mail de validacao de pauta e um pedido pessoal da Secretaria ao aprovador:
 * sair da caixa de quem pediu e o comportamento correto, e o aprovador responde
 * para a pessoa certa.
 *
 * Mesmo desenho do `calendar/my-calendar.ts`: a troca acontece aqui, o token
 * delegado nao sai deste modulo, nao vai para log e nao e persistido.
 *
 * PERMISSAO NECESSARIA: `Mail.Send` DELEGADA no App Registration da PGCP API,
 * com consentimento do administrador. Sem ela, a troca OBO falha com
 * AADSTS65001 e o usuario recebe uma mensagem dizendo exatamente isso.
 */

const MAIL_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";

/** Teto do anexo. O Graph aceita ate 3 MB em `sendMail` simples. */
export const ANEXO_MAX_BYTES = 3 * 1024 * 1024;

let oboClient: ConfidentialClientApplication | null = null;
let oboClientKey = "";

function getOboClient(config: { tenantId: string; clientId: string; clientSecret: string }) {
  const chave = `${config.tenantId}:${config.clientId}`;
  if (!oboClient || oboClientKey !== chave) {
    oboClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        clientSecret: config.clientSecret,
      },
    });
    oboClientKey = chave;
  }
  return oboClient;
}

/** Troca o token da API pelo token delegado do Graph com escopo de envio. */
async function adquirirTokenDeEnvio(userToken: string): Promise<string> {
  const config = getGraphConfig();
  if (!config) {
    throw new HttpError(
      503,
      `Integração com o Microsoft Graph não configurada. Faltam: ${missingGraphConfig().join(", ")}.`,
    );
  }

  try {
    const resultado = await getOboClient(config).acquireTokenOnBehalfOf({
      oboAssertion: userToken,
      scopes: [MAIL_SEND_SCOPE],
    });
    if (!resultado?.accessToken) {
      throw new GraphError("O Entra ID não devolveu token delegado.", "no_obo_token");
    }
    return resultado.accessToken;
  } catch (error) {
    if (error instanceof GraphError || error instanceof HttpError) throw error;

    const detalhe = error instanceof Error ? error.message : String(error);
    // Pode citar o client id; nunca o segredo nem o token.
    console.error("[mail] falha na troca On-Behalf-Of:", detalhe);

    if (/AADSTS65001|consent/i.test(detalhe)) {
      throw new GraphError(
        "A permissão delegada Mail.Send ainda não foi concedida para esta aplicação. " +
          "Peça ao administrador do Microsoft 365 para conceder Mail.Send (delegada) ao PGCP.",
        "consent_required",
        403,
      );
    }
    if (/AADSTS500131|AADSTS50013|assertion/i.test(detalhe)) {
      throw new GraphError("A credencial da sessão não foi aceita na troca de token.", "invalid_assertion", 401);
    }
    throw new GraphError("Não foi possível obter autorização para enviar o e-mail.", "obo_error", 502);
  }
}

export interface AnexoEmail {
  nome: string;
  /** MIME do anexo. */
  tipo: string;
  conteudo: Buffer;
}

export interface EmailParaEnviar {
  para: string;
  assunto: string;
  /** TEXTO PURO. Ver a justificativa em `contentType` abaixo. */
  corpo: string;
  anexo?: AnexoEmail;
}

/**
 * Corpo de `POST /me/sendMail`. Puro, para ser testado sem rede.
 *
 * `saveToSentItems: true` de proposito: a pessoa precisa ver na propria caixa de
 * Itens Enviados o que o PGCP mandou em nome dela. Um envio invisivel para o
 * remetente seria indefensavel numa auditoria — e e por la que se confirma o
 * envio quando o destinatario diz que nao recebeu.
 *
 * Destinatario: o endereco informado, sem filtro de dominio (externo e valido).
 */
export function corpoDoSendMail(email: EmailParaEnviar): { message: Record<string, unknown>; saveToSentItems: true } {
  const mensagem: Record<string, unknown> = {
    subject: email.assunto,
    body: {
      /*
       * TEXTO PURO, nunca HTML.
       *
       * O corpo e montado a partir de um modelo editavel pela administracao
       * mais dados da reuniao. Enviar como HTML transformaria qualquer titulo
       * de reuniao numa superficie de injecao no cliente de e-mail do
       * aprovador. Como texto, marcacao e apenas marcacao literal.
       */
      contentType: "text",
      content: email.corpo,
    },
    toRecipients: [{ emailAddress: { address: email.para } }],
  };

  if (email.anexo) {
    mensagem.attachments = [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: email.anexo.nome,
        contentType: email.anexo.tipo,
        contentBytes: email.anexo.conteudo.toString("base64"),
      },
    ];
  }
  return { message: mensagem, saveToSentItems: true };
}

/**
 * Falha do Graph no ENVIO DELEGADO -> mensagem que aponta a camada certa.
 *
 * O tradutor generico do cliente fala de permissao de APLICACAO e de calendario
 * (o caso dele); aqui o token e delegado: 401 e sessao/credencial, 403 e a
 * caixa do usuario ou a permissao Mail.Send delegada.
 */
export function falhaDeEnvio(error: unknown): unknown {
  if (!(error instanceof GraphError)) return error;
  if (error.status === 401) {
    return new GraphError(
      "O Microsoft 365 não aceitou a sua credencial para enviar o e-mail. Saia e entre de novo no PGCP e tente outra vez.",
      error.code,
      401,
    );
  }
  if (error.status === 403) {
    return new GraphError(
      "O Microsoft 365 recusou o envio pela sua caixa de e-mail. Confirme com o administrador a permissão " +
        "Mail.Send (delegada) do PGCP e se a sua conta tem caixa do Exchange Online habilitada.",
      error.code,
      403,
    );
  }
  return error;
}

/** Envia o e-mail a partir da caixa de quem esta na sessao. */
export async function enviarEmail(
  userToken: string,
  email: EmailParaEnviar,
  /** Nome da operação no log estruturado (ex.: `annual_agenda_send_mail`). */
  operacao = "send_mail",
): Promise<RespostaDoGraph> {
  const config = getGraphConfig();
  if (!config) {
    throw new HttpError(
      503,
      `Integração com o Microsoft Graph não configurada. Faltam: ${missingGraphConfig().join(", ")}.`,
    );
  }

  if (email.anexo && email.anexo.conteudo.length > ANEXO_MAX_BYTES) {
    throw new HttpError(
      413,
      "O documento gerado ficou grande demais para ser enviado por e-mail. Reduza a quantidade de pautas.",
    );
  }

  const token = await adquirirTokenDeEnvio(userToken);

  /*
   * `/me/sendMail` — resolve pela identidade DO TOKEN. Nao existe id de caixa
   * nesta chamada, entao nao ha como o PGCP enviar como outra pessoa nem por
   * engano nem por parametro manipulado.
   *
   * O corpo NAO vai para log: carrega o texto do e-mail e o anexo em base64.
   */
  /*
   * 202 Accepted = o Microsoft 365 ACEITOU a mensagem para envio, não que ela
   * chegou ao destinatário (spam, quarentena, política do domínio de destino,
   * autenticação SPF/DKIM do remetente ficam depois daqui). A prova de envio é
   * a cópia em Itens Enviados; a de entrega, o message trace do Exchange.
   */
  let resposta: RespostaDoGraph | null = null;
  try {
    await graphRequest<void>(config, "/me/sendMail", {
      method: "POST",
      body: corpoDoSendMail(email),
      accessToken: token,
      // Anexo torna a requisicao maior; o padrao de 10s e curto para 3 MB.
      timeoutMs: 30000,
      operacao,
      aoResponder: (info) => {
        resposta = info;
      },
    });
  } catch (error) {
    throw falhaDeEnvio(error);
  }
  return resposta ?? { status: 202, requestId: null, clientRequestId: "" };
}
