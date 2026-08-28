import { HttpError } from "../http-error.js";

/**
 * Traducao PGCP -> evento de calendario. PURO: nao fala com o banco nem com o
 * Graph, e por isso pode ser testado sem nenhum dos dois.
 *
 * A reuniao do PGCP e a fonte de verdade; o evento e a projecao dela. Este
 * modulo decide EXATAMENTE o que atravessa essa fronteira — e o que nao
 * atravessa: pauta, FUP, Anotacoes, Ata, execucao e assinatura sao conteudo de
 * governanca, nao do compromisso.
 */

// -----------------------------------------------------------------------------
// Timezone
// -----------------------------------------------------------------------------

/**
 * O PGCP guarda timezone IANA (`America/Sao_Paulo`). O Graph aceita IANA em
 * `dateTimeTimeZone.timeZone` desde que o valor seja um fuso que ele reconheca.
 *
 * NAO existe tabela IANA -> Windows aqui. Manter um mapa a mao envelheceria mal
 * e seria uma segunda verdade sobre um dado que o proprio runtime ja sabe
 * validar. O que fazemos e recusar antes de chamar: fuso invalido vira erro do
 * PGCP, com mensagem util, e nao um 400 opaco do Graph.
 */
export function assertTimezoneSuportado(timezone: string): string {
  const valor = timezone?.trim();
  if (!valor) {
    throw new HttpError(422, "A reunião não tem fuso horário definido.");
  }

  try {
    // Lanca RangeError quando o runtime nao conhece o identificador.
    new Intl.DateTimeFormat("en-US", { timeZone: valor });
  } catch {
    throw new HttpError(
      422,
      `Fuso horário '${valor}' não é um identificador IANA reconhecido e não pode ser enviado ao calendário.`,
    );
  }

  return valor;
}

/**
 * `YYYY-MM-DDTHH:mm:ss` no fuso da reuniao.
 *
 * O Graph espera a hora LOCAL do fuso informado, sem offset — o offset viria do
 * `timeZone` ao lado. Mandar o instante UTC com o fuso local faria o evento
 * aparecer deslocado no calendario.
 */
export function instanteParaHoraLocal(instante: Date, timezone: string): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instante);

  const parte = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "00";
  // `hourCycle` h23 pode devolver "24" na virada; normaliza para "00".
  const hora = parte("hour") === "24" ? "00" : parte("hour");

  return `${parte("year")}-${parte("month")}-${parte("day")}T${hora}:${parte("minute")}:${parte("second")}`;
}

// -----------------------------------------------------------------------------
// Participantes -> attendees
// -----------------------------------------------------------------------------

/** Participante como o banco o entrega, ja com o e-mail do usuario resolvido. */
export interface ParticipanteParaConvite {
  participantId: string;
  displayName: string | null;
  /** `users.email` quando ha conta no PGCP; senao o e-mail do proprio registro. */
  email: string | null;
  userId: string | null;
  entraObjectId: string | null;
}

export interface AttendeeGraph {
  emailAddress: { address: string; name?: string };
  type: "required";
}

export interface ResultadoAttendees {
  attendees: AttendeeGraph[];
  /** Quem nao tem endereco utilizavel. A sincronizacao NAO acontece com esta lista cheia. */
  semEndereco: Array<{ participantId: string; displayName: string }>;
}

/**
 * Endereco minimamente plausivel. Nao valida existencia — isso e trabalho do
 * servidor de e-mail, nao de uma regex.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function enderecoUtilizavel(email: string | null | undefined): boolean {
  return typeof email === "string" && EMAIL_PATTERN.test(email.trim());
}

/**
 * Converte participantes em attendees.
 *
 * NUNCA deriva endereco de nome. Quem nao tem e-mail utilizavel sai na lista
 * `semEndereco` e a decisao de bloquear e de quem chama — convite parcial em
 * silencio faria a tela dizer que todos foram convidados quando nao foram.
 */
export function montarAttendees(participantes: ParticipanteParaConvite[]): ResultadoAttendees {
  const attendees: AttendeeGraph[] = [];
  const semEndereco: ResultadoAttendees["semEndereco"] = [];
  const vistos = new Set<string>();

  for (const p of participantes) {
    const email = p.email?.trim();

    if (!enderecoUtilizavel(email)) {
      semEndereco.push({
        participantId: p.participantId,
        displayName: p.displayName?.trim() || "(sem nome)",
      });
      continue;
    }

    // O mesmo endereco convidado duas vezes e um convite so.
    const chave = email!.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    attendees.push({
      emailAddress: {
        address: email!,
        ...(p.displayName?.trim() ? { name: p.displayName.trim() } : {}),
      },
      // Todos como `required`: o PGCP nao modela participante opcional, e
      // inventar essa distincao aqui seria decidir governanca no mapper.
      type: "required",
    });
  }

  return { attendees, semEndereco };
}

// -----------------------------------------------------------------------------
// Evento
// -----------------------------------------------------------------------------

/** Campos da reuniao que a projecao no calendario carrega. */
export interface ReuniaoParaCalendario {
  id: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  meetingLink: string | null;
  /**
   * Provider da reuniao online, ou `null` quando nao ha.
   *
   * Guardar o PROVIDER, e nao um booleano: um dia pode haver outro, e "true"
   * nao saberia dizer qual reuniao online e aquela.
   */
  onlineMeetingProvider: "teamsForBusiness" | null;
}

export interface EventoGraph {
  subject: string;
  body: { contentType: "text"; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: AttendeeGraph[];
  transactionId?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: "teamsForBusiness";
}

/**
 * Monta o corpo do evento.
 *
 * `transactionId` e a chave de idempotencia da integracao, reenviada IGUAL em
 * toda tentativa de criacao. Timeout nao gera chave nova: e exatamente o caso em
 * que o evento pode ter sido criado sem a resposta ter voltado, e repetir com a
 * mesma chave e o que impede o segundo evento.
 *
 * REUNIAO ONLINE NO MESMO EVENTO. `isOnlineMeeting` e `onlineMeetingProvider`
 * fazem o Graph provisionar a reuniao DENTRO deste evento e devolver
 * `onlineMeeting.joinUrl`. Nunca um evento no Outlook e uma reuniao Teams
 * separada — e nunca `/communications/onlineMeetings`, que cria um recurso
 * independente do calendario.
 *
 * IRREVERSIVEL: uma vez habilitada, a reuniao online do evento permanece. Por
 * isso o PATCH so ENVIA o par quando ha provider; nunca manda desligar.
 */
export function montarEvento(
  reuniao: ReuniaoParaCalendario,
  attendees: AttendeeGraph[],
  opcoes: { idempotencyKey?: string } = {},
): EventoGraph {
  const timezone = assertTimezoneSuportado(reuniao.timezone);

  const corpo = [reuniao.description?.trim(), reuniao.meetingLink?.trim()]
    .filter((linha): linha is string => Boolean(linha))
    .join("\n\n");

  const evento: EventoGraph = {
    subject: reuniao.title,
    // `text`, nao HTML: a descricao da reuniao e texto puro no PGCP, e
    // converte-la para HTML aqui inventaria formatacao que ninguem escreveu.
    body: { contentType: "text", content: corpo },
    start: { dateTime: instanteParaHoraLocal(reuniao.startAt, timezone), timeZone: timezone },
    end: { dateTime: instanteParaHoraLocal(reuniao.endAt, timezone), timeZone: timezone },
    attendees,
  };

  if (opcoes.idempotencyKey) {
    evento.transactionId = opcoes.idempotencyKey;
  }
  /*
   * So AFIRMA quando ha reuniao online. Sem provider, o par sai do payload por
   * inteiro: mandar `isOnlineMeeting: false` num evento que ja e online seria
   * pedir ao Graph algo que ele nao faz, e num evento comum nao muda nada.
   */
  if (reuniao.onlineMeetingProvider) {
    evento.isOnlineMeeting = true;
    evento.onlineMeetingProvider = reuniao.onlineMeetingProvider;
  }

  return evento;
}

/**
 * Campos da reuniao cuja alteracao desatualiza o evento.
 *
 * Deliberadamente ausentes: `status`, `recurrence`, `pendingRequirements`,
 * pautas, execucao, FUP, Anotacoes, Ata e assinatura. Nada disso aparece no
 * convite, entao mudar qualquer um deles nao pode marcar o evento como `stale`.
 */
export const CAMPOS_QUE_DESATUALIZAM = [
  "title",
  "description",
  "startAt",
  "endAt",
  "timezone",
  "meetingLink",
  // Habilitar a reuniao online muda o evento: o Graph precisa provisiona-la.
  "onlineMeetingProvider",
] as const;

/** Alguma mudanca do PATCH exige atualizar o evento? */
export function exigeResincronizacao(camposAlterados: readonly string[]): boolean {
  return camposAlterados.some((campo) =>
    (CAMPOS_QUE_DESATUALIZAM as readonly string[]).includes(campo),
  );
}
