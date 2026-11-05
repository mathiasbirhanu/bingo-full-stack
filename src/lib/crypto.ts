/**
 * Crypto primitives — phone encryption + blind index (FR-SEC-01), AES sealing
 * for fairness seeds (UC-06) and the KYB document vault (UC-11), canonical
 * JSON hashing for maker-checker payload binding (UC-08).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { AES_KEY, BLIND_IDX_KEY } from "./env";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical JSON: sorted keys, stable separators — the hash-able form. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** Constant-time string equality (hashes only — never on secrets' raw form). */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── AES-256-GCM envelope (key from APP_SECRET derivation) ───────────────────

export function aesEncrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function aesDecrypt(envelope: string): string {
  const [ivB64, tagB64, dataB64] = envelope.split(".");
  const decipher = createDecipheriv("aes-256-gcm", AES_KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

// ── Phone handling (UC-01) ──────────────────────────────────────────────────

/** Normalize Ethiopian phone input to E.164 +251. Accepts +2519…, 09…, 9…, 2519…. */
export function normalizeEthiopianPhone(raw: string): string | null {
  const digits = raw.replace(/[\s-()]/g, "");
  let n: string;
  if (digits.startsWith("+251")) n = digits.slice(4);
  else if (digits.startsWith("251")) n = digits.slice(3);
  else if (digits.startsWith("0")) n = digits.slice(1);
  else n = digits;
  if (!/^9\d{8}$/.test(n) && !/^7\d{8}$/.test(n)) return null; // Ethiopian mobile prefixes
  return `+251${n}`;
}

export function phoneBlindIndex(e164: string): string {
  return createHmac("sha256", BLIND_IDX_KEY).update(e164).digest("hex");
}

export function encryptPhone(e164: string): string {
  return aesEncrypt(e164);
}

export function decryptPhone(envelope: string): string {
  return aesDecrypt(envelope);
}

// ── CSPRNG helpers (FR-GAME-02) ─────────────────────────────────────────────

/** Cryptographically secure random integer in [0, maxExclusive). */
export function secureRandomInt(maxExclusive: number): number {
  return randomInt(0, maxExclusive);
}

/** Cryptographically secure hex string of nBytes*2 characters. */
export function secureHex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}
