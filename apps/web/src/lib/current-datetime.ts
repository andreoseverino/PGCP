/**
 * Data e hora "de agora" para exibição.
 *
 * REGRA DE FUSO ÚNICA: o momento é resolvido pelo MESMO caminho que as
 * reuniões — `instantToLocal` com `DEFAULT_TIMEZONE` (`meeting-adapters.ts`).
 * Sem isso, o relógio do cabeçalho poderia dizer "29 de agosto" enquanto a
 * reunião das 22h de 28 aparece um dia antes, só porque o navegador está em
 * outro fuso. Nenhuma segunda regra de timezone é introduzida aqui.
 */

import { DEFAULT_TIMEZONE, instantToLocal } from "./meeting-adapters";

/**
 * Ex.: "Sexta-feira, 28 de agosto de 2026 • 10:16".
 *
 * `now` é parâmetro para a função ser pura e testável; o componente passa
 * `new Date()`.
 */
export function formatCurrentDateTime(now: Date, language: "en" | "pt" = "pt"): string {
  const { date, time } = instantToLocal(now.toISOString(), DEFAULT_TIMEZONE);
  const locale = language === "pt" ? "pt-BR" : "en-US";

  /*
   * A data civil já foi decidida acima. O `timeZone: "UTC"` abaixo não é outra
   * regra de fuso: é o modo neutro de renderizar por extenso um dia que já não
   * depende mais de fuso nenhum. Meio-dia evita qualquer arredondamento de
   * borda.
   */
  const diaCivil = new Date(`${date}T12:00:00.000Z`);
  const extenso = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(diaCivil);

  return `${capitalizar(extenso)} • ${time}`;
}

/**
 * Milissegundos até o próximo minuto cheio, em `(0, 60000]`.
 *
 * O relógio só muda de minuto em minuto: alinhar o primeiro disparo à virada
 * evita tanto o `setInterval` de 1s quanto o atraso de até 59s de um intervalo
 * de 1min começado em qualquer ponto.
 */
export function millisecondsUntilNextMinute(now: Date): number {
  const restante = 60_000 - (now.getTime() % 60_000);
  return restante === 0 ? 60_000 : restante;
}

/** "sexta-feira, ..." -> "Sexta-feira, ...". Só a primeira letra. */
function capitalizar(texto: string): string {
  return texto.charAt(0).toLocaleUpperCase() + texto.slice(1);
}
