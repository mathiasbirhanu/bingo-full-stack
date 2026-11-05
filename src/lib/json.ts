/**
 * JSON payload helpers — SQLite stores JSON as TEXT; these typed accessors are
 * the only sanctioned way in/out so malformed payloads fail loudly.
 */
export function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`MALFORMED_JSON:${what}`);
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Day key (YYYY-MM-DD) in the platform timezone (accruals, recon). */
export function dayKey(d: Date, tz = "Africa/Addis_Ababa"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // en-CA yields YYYY-MM-DD
}

/** Month key (YYYY-MM) in the platform timezone (statements). */
export function monthKey(d: Date, tz = "Africa/Addis_Ababa"): string {
  return dayKey(d, tz).slice(0, 7);
}

/** Local (timezone) start-of-day as an absolute Date. */
export function startOfDay(d: Date, tz = "Africa/Addis_Ababa"): Date {
  const key = dayKey(d, tz);
  // Ethiopia is UTC+3 with no DST — construct from the key directly.
  return new Date(`${key}T00:00:00+03:00`);
}
