/**
 * HORÁRIOS em passos de 5 minutos — regra pura do seletor de Início/Término.
 *
 * Formato sempre "HH:mm" (o mesmo que o formulário já enviava ao converter
 * para instante no fuso da reunião). Nada aqui conhece fuso: só o relógio.
 */

export const PASSO_MINUTOS = 5;
const ULTIMO = 24 * 60 - PASSO_MINUTOS; // 23:55

const paraMinutos = (hhmm: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const paraHorario = (minutos: number): string =>
  `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;

/** "HH:mm" válido e em múltiplo de 5 minutos. */
export function ehHorarioValido(hhmm: string): boolean {
  const m = paraMinutos(hhmm);
  return m !== null && m % PASSO_MINUTOS === 0;
}

/** 00:00, 00:05, ..., 23:55 — ou só os horários DEPOIS de `depoisDe` (exclusivo). */
export function opcoesDeHorario(depoisDe?: string): string[] {
  const limite = depoisDe ? paraMinutos(depoisDe) : null;
  const opcoes: string[] = [];
  for (let m = 0; m <= ULTIMO; m += PASSO_MINUTOS) {
    if (limite === null || m > limite) opcoes.push(paraHorario(m));
  }
  return opcoes;
}

/**
 * Término depois de trocar o Início. Só mexe se o término ficou inválido
 * (igual ou antes do novo início):
 *   1. mantém a duração anterior, se couber no dia;
 *   2. senão, o próximo horário válido depois do início;
 *   3. início 23:55 (sem término possível no dia) -> "" (o formulário acusa).
 */
export function ajustarTermino(inicioAnterior: string, terminoAtual: string, novoInicio: string): string {
  const novo = paraMinutos(novoInicio);
  const fim = paraMinutos(terminoAtual);
  if (novo === null) return terminoAtual;
  if (fim !== null && fim > novo) return terminoAtual;

  const antes = paraMinutos(inicioAnterior);
  const duracao = antes !== null && fim !== null && fim > antes ? fim - antes : null;
  if (duracao !== null && novo + duracao <= ULTIMO) return paraHorario(novo + duracao);
  const proximo = novo + PASSO_MINUTOS;
  return proximo <= ULTIMO ? paraHorario(proximo) : "";
}

// --- Hora + Minuto (apresentação do seletor) ---------------------------------

/** "00".."23". */
export const HORAS: readonly string[] = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
/** "00","05",..,"55" — só o passo permitido. */
export const MINUTOS: readonly string[] = Array.from({ length: 60 / PASSO_MINUTOS }, (_, i) =>
  String(i * PASSO_MINUTOS).padStart(2, "0")
);

/** "09:35" -> { hora: "09", minuto: "35" }; `null` se vazio/inválido. */
export function decomporHorario(hhmm: string): { hora: string; minuto: string } | null {
  return ehHorarioValido(hhmm) ? { hora: hhmm.slice(0, 2), minuto: hhmm.slice(3, 5) } : null;
}

export const combinarHorario = (hora: string, minuto: string): string => `${hora}:${minuto}`;

/** A hora tem ao menos um minuto permitido? (ex.: Término antes do Início não tem.) */
export function horaDisponivel(hora: string, permitidos: readonly string[]): boolean {
  return MINUTOS.some((m) => permitidos.includes(combinarHorario(hora, m)));
}

/**
 * Troca a HORA mantendo o minuto atual; se a combinação não for permitida,
 * usa o primeiro minuto permitido daquela hora. `null` = hora sem opção.
 */
export function aoTrocarHora(atual: string, hora: string, permitidos: readonly string[]): string | null {
  const minuto = decomporHorario(atual)?.minuto ?? MINUTOS[0]!;
  const desejado = combinarHorario(hora, minuto);
  if (permitidos.includes(desejado)) return desejado;
  const primeiro = MINUTOS.map((m) => combinarHorario(hora, m)).find((h) => permitidos.includes(h));
  return primeiro ?? null;
}

/** Troca o MINUTO mantendo a hora atual (ou a primeira hora permitida). `null` = combinação não permitida. */
export function aoTrocarMinuto(atual: string, minuto: string, permitidos: readonly string[]): string | null {
  const hora = decomporHorario(atual)?.hora ?? HORAS.find((h) => horaDisponivel(h, permitidos));
  if (!hora) return null;
  const desejado = combinarHorario(hora, minuto);
  return permitidos.includes(desejado) ? desejado : null;
}
