/**
 * Money — int64 santim arithmetic (SRS §1.4: "ETB with santim minor unit,
 * int64"). All monetary math in this codebase flows through here: no floats,
 * no doubles, floor-only division. BigInt serializes to string across the API.
 */

export type Santim = bigint;

/** Parse a decimal ETB string like "12.50" into 1250 santim. */
export function etbToSantim(etb: string | number): Santim {
  const s = typeof etb === "number" ? etb.toFixed(2) : etb.trim();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole, frac = ""] = body.split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(frac)) throw new Error(`INVALID_MONEY:${s}`);
  const padded = (frac + "00").slice(0, 2);
  const v = BigInt(whole) * 100n + BigInt(padded);
  return neg ? -v : v;
}

/** Format santim as an ETB display string "1,234.56". */
export function santimToEtb(s: Santim): string {
  const neg = s < 0n;
  const abs = neg ? -s : s;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}.${frac}`;
}

/** floor(a × bps / 10000) in exact bigint arithmetic — commission core (UC-15). */
export function floorBps(amount: Santim, bps: number): Santim {
  if (!Number.isInteger(bps) || bps < 0) throw new Error("INVALID_BPS");
  return (amount * BigInt(bps)) / 10000n; // bigint division truncates toward zero; amounts are non-negative here
}

/** Sum a list of santim values. */
export function sumSantim(values: Santim[]): Santim {
  return values.reduce((a, b) => a + b, 0n);
}

/** Assert a non-negative santim amount (guard at every boundary). */
export function assertPositive(amount: Santim, what = "amount"): void {
  if (amount <= 0n) throw new Error(`NON_POSITIVE_${what.toUpperCase()}`);
}

/** JSON-safe serialization for bigint fields. */
export function santimJson(s: Santim): string {
  return s.toString();
}
