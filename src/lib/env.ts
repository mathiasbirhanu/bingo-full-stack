/**
 * Environment & normative constants — Build 1 (demo phase).
 *
 * Every tunable that the SRS names as a decision point lives here so there is
 * exactly one source of truth. Demo-phase values mirror SRS v5.0 defaults.
 */
import path from "node:path";

/** Payment rail mode. DEMO is compiled for Build 1; LIVE activates real rails. */
export const PAYMENT_MODE = (process.env.PAYMENT_MODE ?? "DEMO").toUpperCase();

/** Platform phase is DERIVED, never set independently: flipping the payment
 * rail to LIVE flips every player-facing surface in one move (D-PRT-06).
 * "demo-first, launch-ready" is a single env change plus the merchant pack. */
export type PlatformPhase = "DEMO" | "LIVE";
export const PLATFORM_PHASE: PlatformPhase = PAYMENT_MODE === "LIVE" ? "LIVE" : "DEMO";

/** Telebirr rail configuration (FR-PAY, ADR-07 port isolation).
 *
 * Credentials arrive with the SIGNED merchant pack from Ethio Telecom — they
 * are business artifacts, not code. Until then the adapter runs DRY_RUN: the
 * full crypto envelope (RSA-OAEP + AES-GCM hybrid), HMAC request signing and
 * callback verification execute for real, but no packet leaves the box. That
 * lets staging rehearse the LIVE flow end-to-end before the pack arrives.
 * Exact wire spellings (paths, field names) are isolated in the adapter's
 * mapRequest/mapCallback translators — one small diff when the pack lands. */
export const TELEBIRR = {
  baseUrl: process.env.TELEBIRR_BASE_URL ?? "https://app.ethiomobilemoney.et:2121",
  appId: process.env.TELEBIRR_APP_ID ?? "",
  appSecret: process.env.TELEBIRR_APP_SECRET ?? "",
  publicKey: process.env.TELEBIRR_PUBLIC_KEY ?? "",
  dryRun: (process.env.TELEBIRR_DRY_RUN ?? "true").toLowerCase() !== "false",
  timeoutMs: Number(process.env.TELEBIRR_TIMEOUT_MS ?? 10_000),
} as const;

/** Currency — Ethiopian Birr, minor unit santim (SRS §1.4). */
export const CURRENCY = "ETB";
export const CURRENCY_MINOR = "santim";

/** Auth lifetimes (UC-01): 10 min access, 14 day rotating refresh. */
export const ACCESS_TOKEN_TTL_SEC = 10 * 60;
export const REFRESH_TOKEN_TTL_SEC = 14 * 24 * 60 * 60;
/** OTP validity window (UC-01). */
export const OTP_TTL_SEC = 5 * 60;
/** OTP request rate limit (UC-01 failure flow): 5 per minute. */
export const OTP_RATE_LIMIT = { windowMs: 60_000, max: 5 };

/** Ticket cap per player per round — MVP constant (FR-PLY-03). */
export const MAX_CARDS_PER_ROUND = 6;

/** State-recovery replay window (UC-05): gaps larger than this get a snapshot. */
export const RECOVERY_GAP_LIMIT = 2048;

/** Commission market bounds in bps (OD-12): 0% .. 35%. */
export const COMMISSION_RATE_BPS_BOUNDS = { min: 0, max: 3500 } as const;

/** Statement dispute window in days (OD-14). */
export const STATEMENT_DISPUTE_WINDOW_DAYS = 7;

/** Server-side signing / encryption material. Demo-static but isolated. */
const SECRET = process.env.APP_SECRET ?? "bingo-build1-demo-secret-do-not-use-in-prod";
export const APP_SECRET = SECRET;
export const JWT_ISSUER = "bingo-platform";
export const JWT_AUDIENCE = "bingo-app";

/** Token encryption key (32 bytes derived) for fairness seed sealing + vault. */
export const AES_KEY = Buffer.from(
  (await import("node:crypto")).createHash("sha256").update(`${SECRET}::aes`).digest()
);

/** Blind-index key for phone lookup (FR-SEC-01). */
export const BLIND_IDX_KEY = Buffer.from(
  (await import("node:crypto")).createHash("sha256").update(`${SECRET}::blindidx`).digest()
);

/** Encrypted document vault root (KYB, UC-11). */
export const VAULT_ROOT = path.join(process.cwd(), "db", "vault");

/** Timezone for day/month bucketing (accruals, statements). */
export const PLATFORM_TIMEZONE = "Africa/Addis_Ababa";
