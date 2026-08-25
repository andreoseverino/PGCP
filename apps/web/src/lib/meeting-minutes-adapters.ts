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

const STATUS_PAUTA: Record<string, { pt: string; en: string }> = {
  pending: { pt: "PENDENTE", en: "PENDING" },
  completed: { pt: "CONCLUÍDA", en: "COMPLETED" },
  postponed: { pt: "ADIADA", en: "POSTPONED" },
};

/**
 * Monta o esqueleto da Ata com FATOS REAIS já registrados — e só com eles.
 *
 * O que entra: título, data, horário, fuso, local, órgão colegiado, presidência
 * e secretaria quando houver participante com esse papel, os participantes
 * cadastrados e as pautas com o status de execução PERSISTIDO.
 *
 * O que NÃO entra, em nenhuma hipótese: deliberação, decisão, votação,
 * aprovação, responsável, prazo, conclusão ou qualquer síntese do que teria
 * sido discutido. Essas linhas ficam como cabeçalho vazio para quem participou
 * da sessão preencher. Antes deste ponto a tela fabricava esse conteúdo — texto
 * fixo com deliberações "aprovadas por unanimidade" e responsáveis inexistentes
 * — e nada disso sobreviveu.
 *
 * Presidência e secretaria saem dos PARTICIPANTES, nunca de quem clicou no
 * botão. Sem participante com o papel, a linha é omitida: melhor calar do que
 * afirmar algo falso numa ata.
 */
export function buildMinutesTemplate(meeting: Meeting, language: "pt" | "en"): string {
  const en = language === "en";
  const participants = meeting.participants ?? [];
  const agenda = meeting.agenda ?? [];

  const chair = participants.find((p) => /chair|president/i.test(p.role));
  const secretary = participants.find((p) => /secret/i.test(p.role));

  const regua = "-".repeat(80);
  const linhas: string[] = [
    regua,
    en ? "   MEETING MINUTES" : "   ATA DE REUNIÃO",
    regua,
    "",
    `${en ? "MEETING" : "REUNIÃO"}: ${meeting.title.toUpperCase()}`,
    `${en ? "DATE" : "DATA"}: ${formatarData(meeting.date, language)} | ${
      en ? "TIME" : "HORÁRIO"
    }: ${meeting.startTime} - ${meeting.endTime} ${meeting.timeZone}`,
    `${en ? "LOCATION" : "LOCALIZAÇÃO"}: ${meeting.location}`,
    `${en ? "GOVERNANCE BODY" : "ÓRGÃO COLEGIADO"}: ${meeting.category}`,
  ];

  if (chair) linhas.push(`${en ? "CHAIR" : "PRESIDENTE"}: ${chair.name} (${chair.role})`);
  if (secretary) linhas.push(`${en ? "SECRETARY" : "SECRETÁRIA(O)"}: ${secretary.name}`);

  linhas.push("", `I. ${en ? "PARTICIPANTS" : "PARTICIPANTES"}:`);
  if (participants.length === 0) {
    linhas.push(en ? " - (no participant registered)" : " - (nenhum participante registrado)");
  } else {
    // Sem "PRESENÇA CONFIRMADA": presença não é registrada em lugar nenhum, e
    // afirmá-la seria inventar fato. O papel cadastrado é o que se sabe.
    for (const p of participants) linhas.push(` - ${p.name} (${p.role})`);
  }

  linhas.push("", `II. ${en ? "AGENDA" : "PAUTAS"}:`);
  if (agenda.length === 0) {
    linhas.push(en ? " - (no agenda item registered)" : " - (nenhuma pauta registrada)");
  } else {
    agenda.forEach((item, indice) => {
      const estado = item.executionStatus ? STATUS_PAUTA[item.executionStatus] : undefined;
      const sufixo = estado ? ` [${en ? estado.en : estado.pt}]` : "";
      linhas.push(` ${indice + 1}. ${item.title}${sufixo}`);
    });
  }

  linhas.push(
    "",
    `III. ${en ? "DISCUSSION" : "REGISTRO DOS ASSUNTOS DISCUTIDOS"}:`,
    "",
    "",
    `IV. ${en ? "RESOLUTIONS" : "DELIBERAÇÕES"}:`,
    "",
    "",
    `V. ${en ? "FOLLOW-UPS" : "ENCAMINHAMENTOS"}:`,
    "",
    "",
    regua,
  );

  return linhas.join("\n");
}
