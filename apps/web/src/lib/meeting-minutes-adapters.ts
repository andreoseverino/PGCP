import type { Meeting } from "../types";

/**
 * Ata da reunião — adaptação pura, sem HTTP.
 *
 * Separado de `meeting-minutes.ts` porque o cliente HTTP importa `api.ts`, que
 * lê `import.meta.env` na carga do módulo e só existe sob o Vite. Este arquivo
 * roda em teste com `node --test` sem bundler.
 */

/** Ata como a API devolve. Espelho de `MeetingMinutes` do backend. */
export interface MeetingMinutes {
  meetingId: string;
  /** Texto PURO. A Ata não é HTML. */
  content: string;
  /** `0` quando a reunião ainda não tem Ata. */
  revision: number;
  status: string;
  updatedByUserId: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  secretariatClearedAt: string | null;
  secretariatClearedByUserId: string | null;
  secretariatClearedByName: string | null;
  secretariatClearedRevision: number | null;
  /** A revisão ATUAL está saneada. Deriva de `clearedRevision === revision`. */
  clearedForCurrentRevision: boolean;
}

/**
 * Rótulo do estado da Ata para exibição.
 *
 * `approved` e `closed` continuam mapeados porque existem no CHECK do banco,
 * mas nenhuma operação desta onda os produz: aprovar depende da assinatura
 * real, que ainda não existe.
 */
export function minutesStatusLabel(status: string, language: "pt" | "en"): string {
  const rotulos: Record<string, { pt: string; en: string }> = {
    draft: { pt: "Rascunho", en: "Draft" },
    under_review: { pt: "Em Revisão", en: "Under Review" },
    approved: { pt: "Aprovada", en: "Approved" },
    closed: { pt: "Encerrada", en: "Closed" },
  };
  return rotulos[status]?.[language] ?? status;
}

function formatarData(data: string, language: "pt" | "en"): string {
  // Meio-dia local evita que o fuso empurre a data um dia para trás.
  const d = new Date(`${data}T12:00:00`);
  if (Number.isNaN(d.getTime())) return data;
  return d.toLocaleDateString(language === "en" ? "en-US" : "pt-BR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Dia do mês (1-31) por extenso, em português — só o que a fórmula da Ata usa. */
const DIA_POR_EXTENSO: Record<number, string> = {
  1: "um", 2: "dois", 3: "três", 4: "quatro", 5: "cinco", 6: "seis", 7: "sete", 8: "oito", 9: "nove", 10: "dez",
  11: "onze", 12: "doze", 13: "treze", 14: "quatorze", 15: "quinze", 16: "dezesseis", 17: "dezessete", 18: "dezoito",
  19: "dezenove", 20: "vinte", 21: "vinte e um", 22: "vinte e dois", 23: "vinte e três", 24: "vinte e quatro",
  25: "vinte e cinco", 26: "vinte e seis", 27: "vinte e sete", 28: "vinte e oito", 29: "vinte e nove", 30: "trinta",
  31: "trinta e um",
};

const MESES_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** "14:30" -> "14h30"; "14:00" -> "14h" (sem minuto redundante). */
function formatarHoraPorExtenso(hora: string): string {
  const [h, m] = hora.split(":");
  return m === "00" ? `${h}h` : `${h}h${m}`;
}

/**
 * Fórmula fixa de abertura de ata: "aos 23 (vinte e três) dias do mês de
 * fevereiro de 2026, às 14h30 na ". Termina em aberto de propósito — o local
 * não existe mais como campo da reunião (ver comentário de `buildMinutesTemplate`)
 * e é preenchido à mão logo em seguida, na mesma linha.
 */
function formatarDataHoraLocal(meeting: Meeting, language: "pt" | "en"): string {
  if (language === "en") {
    return `On ${formatarData(meeting.date, language)}, at ${meeting.startTime}, at `;
  }
  const d = new Date(`${meeting.date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return `aos ${meeting.date}, às ${meeting.startTime} na `;
  const dia = d.getDate();
  const mes = MESES_PT[d.getMonth()];
  const ano = d.getFullYear();
  return `aos ${dia} (${DIA_POR_EXTENSO[dia] ?? dia}) dias do mês de ${mes} de ${ano}, ` +
    `às ${formatarHoraPorExtenso(meeting.startTime)} na `;
}

/**
 * Títulos de seção da Ata — negrito e sublinhado no PDF (`meeting-minutes/pdf.ts`,
 * no backend, mantém a MESMA lista; os dois lados são o contrato declarado
 * duas vezes, como o resto do projeto já faz entre front e back).
 *
 * Ordem e nomes vêm do modelo padrão já usado pela Secretaria — não foram
 * inventados aqui.
 */
export const MINUTES_TEMPLATE_HEADERS: Record<string, { pt: string; en: string }> = {
  dataHoraLocal: { pt: "DATA, HORA E LOCAL:", en: "DATE, TIME AND LOCATION:" },
  mesa: { pt: "MESA:", en: "BOARD:" },
  presenca: { pt: "PRESENÇA:", en: "ATTENDANCE:" },
  ordemDoDia: { pt: "ORDEM DO DIA:", en: "AGENDA:" },
  deliberacoes: { pt: "DELIBERAÇÕES:", en: "RESOLUTIONS:" },
  documentosAnexos: { pt: "DOCUMENTOS ANEXOS:", en: "ATTACHED DOCUMENTS:" },
  aprovacaoAssinatura: { pt: "APROVAÇÃO E ASSINATURA DA ATA:", en: "MINUTES APPROVAL AND SIGNATURE:" },
};

/**
 * Honorífico genérico — "Sr(a)." na frente do nome, em vez de "Sr."/"Sra.".
 * Nada no sistema (nem o diretório da Microsoft, nem o cadastro do PGCP)
 * guarda o gênero de ninguém; afirmar um seria inventar dado.
 */
function comHonorifico(nome: string, language: "pt" | "en"): string {
  return language === "en" ? nome : `Sr(a). ${nome}`;
}

/**
 * Monta o esqueleto da Ata com FATOS REAIS já registrados — e só com eles.
 *
 * O que entra: data e horário de início, na fórmula fixa "aos 23 (vinte e
 * três) dias do mês de fevereiro de 2026, às 14h30 na " (ver
 * `formatarDataHoraLocal`); presidência (do órgão) e secretaria (dos
 * participantes) na seção MESA — ver detalhe abaixo; a lista de
 * participantes (PRESENÇA); e as pautas (ORDEM DO DIA).
 *
 * O que NÃO entra, em nenhuma hipótese: local (a reunião não tem mais esse
 * campo — a frase termina em aberto, "na ", para preenchimento manual na
 * mesma linha), deliberação,
 * decisão, votação, aprovação, responsável, prazo, conclusão ou qualquer
 * síntese do que teria sido discutido. Essas seções ficam com o título e
 * espaço vazio para quem participou da sessão preencher. Antes deste ponto a
 * tela fabricava esse conteúdo — texto fixo com deliberações "aprovadas por
 * unanimidade" e responsáveis inexistentes — e nada disso sobreviveu.
 *
 * Presidência: sai do PRESIDENTE DA MESA cadastrado no órgão de governança
 * (`meeting.governanceBodyChairName` — cadastro em Administração, não desta
 * reunião). É um fato do órgão, não de quem participou desta sessão
 * especificamente. Sem presidente cadastrado no órgão, cai no fallback
 * antigo: procura um participante com papel "chair/president" — mantém
 * atas antigas e órgãos ainda não atualizados funcionando.
 *
 * Secretaria continua saindo dos PARTICIPANTES, nunca de quem clicou no
 * botão. Sem participante com o papel, o nome fica em branco na mesma linha
 * (não a linha inteira omitida): a Secretaria completa à mão sem precisar
 * adivinhar o formato.
 */
export function buildMinutesTemplate(meeting: Meeting, language: "pt" | "en"): string {
  const en = language === "en";
  const rotulo = (chave: keyof typeof MINUTES_TEMPLATE_HEADERS) =>
    MINUTES_TEMPLATE_HEADERS[chave][language];
  const participants = meeting.participants ?? [];
  const agenda = meeting.agenda ?? [];

  const chairName =
    meeting.governanceBodyChairName ??
    participants.find((p) => /chair|president/i.test(p.role))?.name ??
    null;
  const secretary = participants.find((p) => /secret/i.test(p.role));

  const rotuloPresidente = en ? "Chair" : "Presidente da Mesa";
  const rotuloSecretaria = en ? "Secretary" : "Secretária(o)";
  const textoPresidente = chairName ? comHonorifico(chairName, language) : "";
  const textoSecretaria = secretary ? comHonorifico(secretary.name, language) : "";

  const presencaConteudo =
    participants.length === 0
      ? en
        ? "(no participant registered)"
        : "(nenhum participante registrado)"
      : // Sem "PRESENÇA CONFIRMADA": presença não é registrada em lugar nenhum,
        // e afirmá-la seria inventar fato. O papel cadastrado é o que se sabe.
        participants.map((p) => `${p.name} (${p.role});`).join(" ");

  const ordemDoDiaConteudo =
    agenda.length === 0
      ? en
        ? "(no agenda item registered)"
        : "(nenhuma pauta registrada)"
      : // "(01) título; (02) título;" — o "(NN)" sai em negrito no PDF
        // (`meeting-minutes/pdf.ts`), o resto da linha em peso normal.
        agenda
          .map((item, indice) => `(${String(indice + 1).padStart(2, "0")}) ${item.title};`)
          .join(" ");

  /*
   * DELIBERAÇÕES: frase fixa de abertura — "Dando início aos trabalhos, os
   * membros da <órgão> examinaram..." — seguida de um bloco por pauta, com a
   * MESMA numeração da ORDEM DO DIA: "(01) <título da pauta 1>:", espaço em
   * branco para o texto, "(02) <título da pauta 2>:", e assim por diante.
   *
   * <órgão> é `meeting.category` — fato já registrado, não inventado. O
   * texto de cada deliberação continua em branco: só o título de cada pauta
   * já registrada e espaço para quem participou da sessão escrever.
   *
   * Sem pauta nenhuma, cai no formato antigo: só o título da seção, aberto
   * para preenchimento manual.
   */
  const abertura = en
    ? `Opening the session, the members of ${meeting.category} reviewed the items on the Agenda and discussed the main aspects of the topics listed below:`
    : `Dando início aos trabalhos, os membros da ${meeting.category} examinaram os itens constantes da Ordem do Dia e discutiram os principais aspectos dos temas abaixo indicados:`;

  const deliberacoesLinhas: string[] =
    agenda.length === 0
      ? [`${rotulo("deliberacoes")} `]
      : [
          `${rotulo("deliberacoes")} ${abertura}`,
          "",
          ...agenda.flatMap((item, indice) => {
            const cabecalhoItem = `(${String(indice + 1).padStart(2, "0")}) ${item.title}:`;
            return [cabecalhoItem, "", ""];
          }),
        ];

  /*
   * TÍTULO E CONTEÚDO NA MESMA LINHA, sempre — "MESA: Presidente da Mesa:
   * ...", nunca "MESA:" numa linha e o texto na seguinte. O PDF (`pdf.ts`)
   * reconhece o título pelo INÍCIO da linha, não pela linha inteira, e só o
   * prefixo sai em negrito/sublinhado; o resto acompanha em peso normal.
   *
   * DOCUMENTOS ANEXOS e APROVAÇÃO E ASSINATURA DA ATA: frase fixa nas duas —
   * são declarações padrão da Ata, não um fato desta reunião específica,
   * então não há o que a sessão "preencher" (a assinatura real em si ainda é
   * ato futuro, fora deste texto — ver `docs` sobre a etapa de assinatura).
   */
  const documentosAnexosTexto = en
    ? "All supporting documents used in the meeting have been attached to this Minutes."
    : "Todos os documentos de suporte utilizados na reunião foram anexados à presente Ata.";

  const aprovacaoAssinaturaTexto = en
    ? "There being no further business, the session was suspended for the drafting of these Minutes. Upon resuming, these Minutes were read and approved, and signed by all present."
    : "Nada mais havendo a tratar, foram os trabalhos suspensos para a lavratura desta Ata. Reabertos os trabalhos, foi a presente Ata lida e aprovada, tendo sido assinada por todos os presentes.";

  const linhas: string[] = [
    `${rotulo("dataHoraLocal")} ${formatarDataHoraLocal(meeting, language)}`,
    "",
    `${rotulo("mesa")} ${rotuloPresidente}: ${textoPresidente}; ${rotuloSecretaria}: ${textoSecretaria};`,
    "",
    `${rotulo("presenca")} ${presencaConteudo}`,
    "",
    `${rotulo("ordemDoDia")} ${ordemDoDiaConteudo}`,
    "",
    ...deliberacoesLinhas,
    `${rotulo("documentosAnexos")} ${documentosAnexosTexto}`,
    "",
    `${rotulo("aprovacaoAssinatura")} ${aprovacaoAssinaturaTexto}`,
  ];

  return linhas.join("\n");
}
