/**
 * Interpretação de duração e horário das pautas.
 *
 * Fonte ÚNICA de parsing. Antes existiam duas implementações incompatíveis:
 * uma testava `/\d+/` antes de `HH:mm` — e como qualquer string com dígito
 * casa nesse regex, "00:45" virava 0 minutos e "01:00" virava 1 minuto.
 * A outra fazia o split por ":" corretamente, mas falhava em "15 mins".
 */

/**
 * Converte a duração para minutos.
 *
 *   "00:15" -> 15      "01:00" -> 60      "15 mins" -> 15
 *   "00:45" -> 45      "01:30" -> 90      "1h"      -> 60
 *
 * `HH:mm` é avaliado PRIMEIRO; o formato textual existe só por compatibilidade
 * com dados legados. Valor não reconhecido cai em `fallback`.
 */
export function parseDurationMinutes(duration: string | undefined, fallback = 15): number {
  if (!duration) return fallback;

  const raw = duration.trim().toLowerCase();

  // Formato HH:mm — o canônico.
  const hhmm = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (hhmm) {
    const hours = parseInt(hhmm[1]!, 10);
    const minutes = parseInt(hhmm[2]!, 10);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) return hours * 60 + minutes;
  }

  // Legado: "90 min", "30 mins", "45 minutos".
  const mins = raw.match(/^(\d+)\s*(m|min|mins|minuto|minutos)?$/);
  if (mins) {
    const value = parseInt(mins[1]!, 10);
    if (Number.isFinite(value)) return value;
  }

  // Legado: "1h", "2 h", "1h30".
  const hours = raw.match(/^(\d+)\s*h(?:\s*(\d+))?$/);
  if (hours) {
    const h = parseInt(hours[1]!, 10);
    const m = hours[2] ? parseInt(hours[2], 10) : 0;
    if (Number.isFinite(h)) return h * 60 + (Number.isFinite(m) ? m : 0);
  }

  return fallback;
}

/** Converte "HH:mm" (aceitando AM/PM) para minutos desde a meia-noite. */
export function parseTimeToMinutes(time: string | undefined, fallback = 600): number {
  if (!time) return fallback;

  const raw = time.trim().toUpperCase();
  const period = raw.match(/(AM|PM)/)?.[0];
  const [hPart, mPart] = raw.replace(/[^0-9:]/g, "").split(":");

  let hour = parseInt(hPart ?? "", 10);
  const minute = parseInt(mPart ?? "0", 10);
  if (!Number.isFinite(hour)) return fallback;

  if (period === "PM" && hour < 12) hour += 12;
  else if (period === "AM" && hour === 12) hour = 0;

  return hour * 60 + (Number.isFinite(minute) ? minute : 0);
}

/** Formata minutos desde a meia-noite como "HH:mm", com volta em 24h. */
export function formatMinutesAsTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Soma uma duração a um horário. Ex.: ("10:00", "00:45") -> "10:45". */
export function addDurationToTime(time: string, duration: string): string {
  return formatMinutesAsTime(parseTimeToMinutes(time) + parseDurationMinutes(duration));
}
