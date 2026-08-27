import type { PoolClient } from "pg";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { recordAudit, recordAuditIn } from "../audit/service.js";
import {
  PDF_CONTENT_TYPE,
  formatarQuando,
  gerarPdfDePautas,
  nomeDoArquivo,
  type PautaDoDocumento,
} from "../agenda-pdf/document.js";
import { enviarEmail } from "../mail/send.js";
import {
  getTemplateDeValidacao,
  renderizarTemplate,
  type VariaveisDoTemplate,
} from "../mail/templates.js";

/**
 * Validacao de pautas — o passo entre preparar a reuniao e convidar as pessoas.
 *
 * CICLO DA PAUTA, em `meetings.agenda_validation_status`:
 *
 *   draft     em preparacao no PGCP; nada saiu daqui
 *   sent      PDF enviado ao aprovador; aguardando a validacao dele
 *   approved  a Secretaria registrou que o aprovador validou
 *
 * Eixo SEPARADO de `meetings.status` (ciclo da reuniao) e de
 * `meeting_calendar_integrations.sync_status` (convite). Ver migration 016.
 *
 * A APROVACAO ACONTECE FORA DO SISTEMA. Nao ha portal, nao ha link magico e nao
 * ha leitura de resposta de e-mail: o aprovador responde por e-mail e alguem da
 * Secretaria registra isso aqui. Fingir aprovacao automatica por resposta seria
 * afirmar sem evidencia — o mesmo erro que a assinatura ficticia da Ata cometia.
 */

export type AgendaValidationStatus = "draft" | "sent" | "approved";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Teto do endereco. RFC 5321 limita o caminho de retorno a 256 octetos. */
export const EMAIL_MAX = 254;

/**
 * Valida o endereco do aprovador.
 *
 * Deliberadamente PRAGMATICA, nao uma implementacao da RFC 5322: aquela
 * gramatica aceita coisas que nenhum servidor corporativo entrega e a regex
 * completa e famosa por ser inauditavel. O que precisa ser garantido aqui e
 * outra coisa — que o valor tenha forma de endereco e NAO carregue caractere de
 * controle, virgula ou ponto e virgula, que poderiam virar segundo destinatario
 * ou injecao de cabecalho num consumidor futuro.
 */
export function parseEmailDoAprovador(valor: unknown): string {
  if (typeof valor !== "string") {
    throw new HttpError(400, "Informe o e-mail de quem vai validar as pautas.");
  }

  const email = valor.trim();

  if (email.length === 0) throw new HttpError(400, "Informe o e-mail de quem vai validar as pautas.");
  if (email.length > EMAIL_MAX) throw new HttpError(400, "O e-mail informado é longo demais.");

  // Um destinatario por vez: separador viraria envio para varias pessoas.
  if (/[,;\s<>"()[\]\\]/.test(email)) {
    throw new HttpError(400, "Informe um único endereço de e-mail, sem separadores.");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(email)) {
    throw new HttpError(400, "O e-mail informado contém caracteres inválidos.");
  }

  // local@dominio.tld — um arroba, dominio com ponto, sem ponto nas pontas.
  if (!/^[^@]+@[^@]+\.[a-zA-Z]{2,}$/.test(email)) {
    throw new HttpError(400, "O e-mail informado não é válido.");
  }
  if (/\.\./.test(email) || /^\./.test(email) || /@\./.test(email) || /\.$/.test(email)) {
    throw new HttpError(400, "O e-mail informado não é válido.");
  }

  return email;
}

// ---------------------------------------------------------------------------
// Leitura dos dados do documento
// ---------------------------------------------------------------------------

interface ReuniaoRow {
  id: string;
  title: string;
  description: string | null;
  start_at: Date;
  end_at: Date;
  timezone: string;
  location: string | null;
  governance_body: string;
  organizer_name: string | null;
  agenda_validation_status: AgendaValidationStatus;
}

/**
 * Carrega tudo o que o documento consome, em tres consultas.
 *
 * A descricao da pauta vem de `agenda_topics.description` por LEFT JOIN:
 * `meeting_agenda_items` NAO tem coluna de descricao, entao pauta digitada
 * livre simplesmente nao tem uma — e o slide dela sai sem a linha, em vez de
 * exibir texto inventado.
 */
async function carregarReuniao(meetingId: string) {
  const { rows } = await pool.query<ReuniaoRow>(
    `SELECT m.id, m.title, m.description, m.start_at, m.end_at, m.timezone, m.location,
            gb.name AS governance_body,
            u.name  AS organizer_name,
            m.agenda_validation_status
       FROM meetings m
       JOIN governance_bodies gb ON gb.id = m.governance_body_id
       LEFT JOIN users u ON u.id = m.organizer_user_id
      WHERE m.id = $1`,
    [meetingId],
  );
  const reuniao = rows[0];
  if (!reuniao) throw new HttpError(404, "Reunião não encontrada.");

  const { rows: pautas } = await pool.query<{
    position: number;
    title: string;
    description: string | null;
    responsible_label: string | null;
    presenter_label: string | null;
    scheduled_start_time: string | null;
    duration_minutes: number | null;
    is_circular_theme: boolean;
  }>(
    `SELECT ai.position, ai.title, t.description,
            ai.responsible_label, ai.presenter_label,
            to_char(ai.scheduled_start_time, 'HH24:MI') AS scheduled_start_time,
            ai.duration_minutes, ai.is_circular_theme
       FROM meeting_agenda_items ai
       LEFT JOIN agenda_topics t ON t.id = ai.agenda_topic_id
      WHERE ai.meeting_id = $1
      ORDER BY ai.position`,
    [meetingId],
  );

  const { rows: participantes } = await pool.query<{ nome: string }>(
    `SELECT coalesce(mp.display_name, u.name, mp.email) AS nome
       FROM meeting_participants mp
       LEFT JOIN users u ON u.id = mp.user_id
      WHERE mp.meeting_id = $1
      ORDER BY coalesce(mp.display_name, u.name), mp.id`,
    [meetingId],
  );

  return {
    reuniao,
    pautas: pautas.map(
      (p): PautaDoDocumento => ({
        posicao: p.position,
        titulo: p.title,
        descricao: p.description,
        responsavel: p.responsible_label,
        apresentador: p.presenter_label,
        horaInicio: p.scheduled_start_time,
        duracaoMinutos: p.duration_minutes,
        temaCircular: p.is_circular_theme,
      }),
    ),
    participantes: participantes.map((p) => p.nome).filter((n): n is string => Boolean(n)),
  };
}

// ---------------------------------------------------------------------------
// Enviar para validacao
// ---------------------------------------------------------------------------

export interface Ator {
  userId: string;
  name: string;
}

export interface ResultadoValidacao {
  agendaValidationStatus: AgendaValidationStatus;
  sentAt: string;
  sentTo: string;
}

/**
 * Gera o PDF, envia ao aprovador e registra o pedido.
 *
 * ORDEM DELIBERADA: o e-mail sai ANTES de o estado virar `sent`.
 *
 * Marcar primeiro e enviar depois deixaria a tela dizendo "enviado para
 * validacao" quando nada chegou ao aprovador — exatamente a mentira que o
 * modulo de calendario evita ao gravar `failed`. Aqui a operacao e curta e sem
 * side effect no banco antes do envio, entao a ordem honesta e possivel: se o
 * envio falha, nada muda e a pessoa tenta de novo.
 *
 * REENVIO E PERMITIDO. Pedir validacao de novo (pauta corrigida, aprovador
 * errado) e legitimo e apenas atualiza a marca. O que NAO se refaz e a
 * aprovacao: para voltar atras, ver `aprovarPautas`.
 */
export async function enviarPautasParaValidacao(
  meetingId: string,
  emailAprovador: string,
  ator: Ator,
  userToken: string,
): Promise<ResultadoValidacao> {
  if (!UUID_PATTERN.test(meetingId)) throw new HttpError(400, "Identificador da reunião inválido.");

  const { reuniao, pautas, participantes } = await carregarReuniao(meetingId);

  if (reuniao.agenda_validation_status === "approved") {
    throw new HttpError(
      409,
      "As pautas desta reunião já foram aprovadas. Reabrir a validação não está previsto neste fluxo.",
    );
  }

  const quando = formatarQuando(
    reuniao.start_at.toISOString(),
    reuniao.end_at.toISOString(),
    reuniao.timezone,
  );

  const pdf = await gerarPdfDePautas({
    titulo: reuniao.title,
    descricao: reuniao.description,
    orgao: reuniao.governance_body,
    organizador: reuniao.organizer_name,
    inicioEm: reuniao.start_at.toISOString(),
    fimEm: reuniao.end_at.toISOString(),
    fuso: reuniao.timezone,
    local: reuniao.location,
    participantes,
    pautas,
  });

  const template = await getTemplateDeValidacao();
  const variaveis: VariaveisDoTemplate = {
    nome_reuniao: reuniao.title,
    data_reuniao: quando,
    solicitante: ator.name,
    quantidade_pautas: String(pautas.length),
  };

  try {
    await enviarEmail(userToken, {
      para: emailAprovador,
      assunto: renderizarTemplate(template.subject, variaveis),
      corpo: renderizarTemplate(template.body, variaveis),
      anexo: {
        nome: nomeDoArquivo(reuniao.title),
        tipo: PDF_CONTENT_TYPE,
        conteudo: pdf,
      },
    });
  } catch (error) {
    // A falha do envio tambem e fato de governanca: alguem TENTOU pedir
    // validacao e nao conseguiu. Sem stack e sem detalhe do Graph na trilha.
    await recordAudit({
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Falha ao enviar pautas para validação",
      entityType: "Reunião",
      entityId: meetingId,
      entityLabel: reuniao.title,
      status: "failure",
    });
    throw error;
  }

  // Envio confirmado: agora o estado pode afirmar que saiu.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ agenda_validation_sent_at: Date }>(
      `UPDATE meetings
          SET agenda_validation_status = 'sent',
              agenda_validation_sent_at = now(),
              agenda_validation_sent_to = $2
        WHERE id = $1
        RETURNING agenda_validation_sent_at`,
      [meetingId, emailAprovador],
    );

    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Pautas enviadas para validação",
      entityType: "Reunião",
      entityId: meetingId,
      // O destinatario e o fato central do ato: sem ele a trilha nao responde
      // "validacao pedida a quem?". Mesma pratica de `/me`, que grava o e-mail
      // de quem autenticou.
      entityLabel: `${reuniao.title} — validação solicitada a ${emailAprovador} (${pautas.length} pauta(s))`,
      status: "success",
    });

    await client.query("COMMIT");

    return {
      agendaValidationStatus: "sent",
      sentAt: rows[0]!.agenda_validation_sent_at.toISOString(),
      sentTo: emailAprovador,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    /*
     * O E-MAIL JA SAIU, E O ESTADO NAO GRAVOU.
     *
     * Unica janela em que o PGCP fica atras da realidade: a Microsoft aceitou a
     * mensagem e o `UPDATE` falhou depois (banco fora, conexao caida,
     * constraint). Deixar subir como erro generico foi o que aconteceu no
     * primeiro teste corporativo: a tela disse "Erro interno", a pessoa clicou
     * de novo, e o aprovador recebeu DOIS e-mails.
     *
     * A mensagem diz explicitamente que o envio ocorreu e pede para NAO
     * reenviar. A trilha registra o descompasso — sem ela o incidente seria
     * invisivel, ja que a reuniao continua em `draft`.
     */
    console.error(
      `[agenda-validation] e-mail enviado mas estado nao gravado (reuniao ${meetingId}):`,
      error instanceof Error ? error.message : error,
    );

    await recordAudit({
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "E-mail de validação enviado, mas o estado não foi gravado",
      entityType: "Reunião",
      entityId: meetingId,
      entityLabel: `${reuniao.title} — enviado a ${emailAprovador}; a reunião permanece em preparação`,
      status: "failure",
    });

    throw new HttpError(
      500,
      "O e-mail com as pautas FOI ENVIADO, mas não foi possível registrar o envio no PGCP. " +
        "Não reenvie: o aprovador já recebeu a mensagem. Avise a Secretaria de Governança " +
        "para registrar a aprovação quando ela chegar.",
    );
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Marcar como aprovadas
// ---------------------------------------------------------------------------

export interface ResultadoAprovacao {
  agendaValidationStatus: AgendaValidationStatus;
  approvedAt: string;
}

/**
 * Registra que o aprovador validou as pautas.
 *
 * EXIGE ter passado por `sent`. Aprovar direto do rascunho pularia o pedido de
 * validacao e tornaria o registro de aprovacao uma afirmacao sem lastro — nao
 * haveria a quem, nem quando, a validacao foi pedida.
 *
 * IDEMPOTENTE: reaprovar nao muda nada e nao gera segunda entrada na trilha.
 * O `UPDATE` condicionado a `'sent'` e o que garante isso, sem SELECT antes —
 * dois cliques simultaneos nao produzem duas aprovacoes.
 */
export async function aprovarPautas(meetingId: string, ator: Ator): Promise<ResultadoAprovacao> {
  if (!UUID_PATTERN.test(meetingId)) throw new HttpError(400, "Identificador da reunião inválido.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: atual } = await client.query<{
      title: string;
      agenda_validation_status: AgendaValidationStatus;
      agenda_approved_at: Date | null;
    }>(
      `SELECT title, agenda_validation_status, agenda_approved_at
         FROM meetings WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );

    const reuniao = atual[0];
    if (!reuniao) throw new HttpError(404, "Reunião não encontrada.");

    // Ja aprovada: devolve o estado atual sem gravar de novo.
    if (reuniao.agenda_validation_status === "approved") {
      await client.query("COMMIT");
      return {
        agendaValidationStatus: "approved",
        approvedAt: reuniao.agenda_approved_at!.toISOString(),
      };
    }

    if (reuniao.agenda_validation_status !== "sent") {
      throw new HttpError(
        409,
        "As pautas ainda não foram enviadas para validação. Envie-as antes de marcar como aprovadas.",
      );
    }

    const { rows } = await client.query<{ agenda_approved_at: Date }>(
      `UPDATE meetings
          SET agenda_validation_status = 'approved',
              agenda_approved_at = now(),
              agenda_approved_by_user_id = $2
        WHERE id = $1
        RETURNING agenda_approved_at`,
      [meetingId, ator.userId],
    );

    await recordAuditIn(client, {
      actorUserId: ator.userId,
      actorName: ator.name,
      action: "Pautas marcadas como aprovadas",
      entityType: "Reunião",
      entityId: meetingId,
      entityLabel: reuniao.title,
      status: "success",
    });

    await client.query("COMMIT");

    return {
      agendaValidationStatus: "approved",
      approvedAt: rows[0]!.agenda_approved_at.toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reabertura automatica da validacao por ALTERACAO ESTRUTURAL nas pautas.
 *
 * Regra de integridade (decisao de produto, opcao B): se as pautas mudam depois
 * de a validacao ter saido (`sent`) ou sido registrada como aprovada
 * (`approved`), o PDF que o aprovador viu deixou de refletir a reuniao. Em vez de
 * travar a edicao, a validacao VOLTA para `draft` e a Secretaria reenvia.
 *
 * SO VALE ANTES DA REUNIAO COMECAR. A validacao e do PLANEJAMENTO pre-reuniao;
 * durante (`in_progress`) e depois (`done`/`closed`) as pautas mudam por conducao
 * — pauta extraordinaria, adiar, concluir, resetar — e NADA disso reabre a
 * aprovacao. Por isso o gate abaixo, alem de os chamadores so invocarem esta
 * funcao em mutacoes estruturais.
 *
 * Respeita o CHECK de coerencia da migration 016: `draft` exige `sent_at` e
 * `approved_at` nulos. Zera tambem `sent_to` e `approved_by_user_id` — metadados
 * de uma validacao que deixou de valer.
 *
 * Roda DENTRO da transacao do chamador (recebe o `client`). Devolve `true`
 * quando reabriu, para a UI poder avisar o usuario.
 */
export async function reabrirValidacaoSePreReuniao(
  client: PoolClient,
  meetingId: string,
  ator: Ator,
): Promise<boolean> {
  const { rows } = await client.query<{
    title: string;
    status: string;
    agenda_validation_status: AgendaValidationStatus;
  }>(
    `SELECT title, status, agenda_validation_status
       FROM meetings WHERE id = $1 FOR UPDATE`,
    [meetingId],
  );
  const reuniao = rows[0];
  if (!reuniao) return false;

  // Durante/depois da reuniao a validacao nao reabre: conducao nao e planejamento.
  if (["in_progress", "done", "closed"].includes(reuniao.status)) return false;
  // So reabre o que estava em curso: rascunho ja e o estado de destino.
  if (
    reuniao.agenda_validation_status !== "sent" &&
    reuniao.agenda_validation_status !== "approved"
  ) {
    return false;
  }

  await client.query(
    `UPDATE meetings
        SET agenda_validation_status = 'draft',
            agenda_validation_sent_at = NULL,
            agenda_validation_sent_to = NULL,
            agenda_approved_at = NULL,
            agenda_approved_by_user_id = NULL
      WHERE id = $1`,
    [meetingId],
  );

  await recordAuditIn(client, {
    actorUserId: ator.userId,
    actorName: ator.name,
    action: "Validação de pautas reaberta por alteração nas pautas",
    entityType: "Reunião",
    entityId: meetingId,
    entityLabel: `${reuniao.title} — validação anterior invalidada; reenviar para aprovação`,
    status: "success",
  });

  return true;
}

/** Estado da validacao, para a rota do convite conferir a pre-condicao. */
export async function lerStatusDeValidacao(meetingId: string): Promise<AgendaValidationStatus> {
  const { rows } = await pool.query<{ agenda_validation_status: AgendaValidationStatus }>(
    `SELECT agenda_validation_status FROM meetings WHERE id = $1`,
    [meetingId],
  );
  if (!rows[0]) throw new HttpError(404, "Reunião não encontrada.");
  return rows[0].agenda_validation_status;
}
