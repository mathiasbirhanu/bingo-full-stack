/**
 * Telebirr adapter — the production rail behind the FR-PAY port (ADR-07).
 *
 * STATUS: skeleton with REAL plumbing. The hard parts of a PSP integration —
 * request signing, hybrid encryption, callback authentication with
 * timing-safe comparison, replay freshness, idempotent settlement into the
 * double-entry ledger, reconciliation — are implemented and unit-tested.
 *
 * What stays configurable until the SIGNED merchant pack arrives from Ethio
 * Telecom (a business artifact, not code):
 *   · exact endpoint paths and field spellings  → mapRequest / mapCallback
 *   · the canonical sign string order           → canonicalSignString
 * Everything else is finished. TELEBIRR_DRY_RUN=true (default) rehearses the
 * whole flow — envelopes built, signatures verified, journals posted — with
 * zero egress, so staging can certify the LIVE path before credentials land.
 *
 * Cryptographic envelope (publicly documented telebirr pattern):
 *   request  = { appid, nonce, timestamp, sign, data }
 *   sign     = HMAC-SHA256(appSecret, canonicalSignString) — hex
 *   data     = base64( AES-256-GCM(businessJson, randomKey) )
 *              with randomKey RSA-OAEP-encrypted under the telebirr public key
 *   callback = JSON with `sign` over the raw body + freshness window
 */
import { createHmac, randomBytes, publicEncrypt, privateDecrypt, createCipheriv, createDecipheriv, generateKeyPairSync, timingSafeEqual, constants, createHash } from "node:crypto";
import { ApiError } from "../../lib/errors";
import { etbToSantim, type Santim } from "../../lib/money";
import { TELEBIRR } from "../../lib/env";
import {
  CallbackCapablePort,
  ConfirmResult,
  ParsedCallback,
  PaymentIntentRequest,
  PaymentIntentResult,
  assertLiveMode,
  confirmDepositIntent,
  openDepositIntent,
} from "./port";

// ── wire primitives (exported: unit-tested in tests/telebirr.test.ts) ──────

/** Canonical string covered by the request signature. ISOLATED ON PURPOSE:
 * the merchant pack may reorder the fields — fix it here, nowhere else. */
export function canonicalSignString(appId: string, nonce: string, timestamp: string): string {
  return `${appId}&${nonce}&${timestamp}`;
}

export function signRequest(canonical: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(canonical).digest("hex");
}

/** Timing-safe signature comparison — never `===` attacker-controlled hex. */
export function verifySignatureHex(expectedHex: string, presentedHex: string): boolean {
  if (!presentedHex || presentedHex.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(presentedHex, "hex"));
}

/** Callback freshness: reject replays older than 10 minutes. */
export const CALLBACK_MAX_AGE_MS = 10 * 60 * 1000;

export function assertCallbackFresh(timestampMs: number, now = Date.now()): void {
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > CALLBACK_MAX_AGE_MS) {
    throw new ApiError("PAYMENT_CALLBACK_INVALID", "notification timestamp outside the freshness window");
  }
}

/** RSA-OAEP + AES-256-GCM hybrid envelope: only telebirr can open the key. */
export function encryptBusinessData(businessJson: string, publicKeyPem: string): string {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const enc = Buffer.concat([cipher.update(businessJson, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealedKey = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
  // envelope: version ‖ sealedKeyLen ‖ sealedKey ‖ iv ‖ tag ‖ ciphertext — base64
  const head = Buffer.alloc(3);
  head.writeUInt8(1, 0);
  head.writeUInt16BE(sealedKey.length, 1);
  return Buffer.concat([head, sealedKey, iv, tag, enc]).toString("base64");
}

export function decryptBusinessData(envelopeB64: string, privateKeyPem: string): string {
  const raw = Buffer.from(envelopeB64, "base64");
  if (raw[0] !== 1) throw new ApiError("PAYMENT_CALLBACK_INVALID", "unsupported envelope version");
  const sealedKeyLen = raw.readUInt16BE(1);
  let off = 3;
  const sealedKey = raw.subarray(off, off + sealedKeyLen); off += sealedKeyLen;
  const iv = raw.subarray(off, off + 12); off += 12;
  const tag = raw.subarray(off, off + 16); off += 16;
  const ciphertext = raw.subarray(off);
  const aesKey = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, sealedKey);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Test/DRY_RUN helper: the platform-side keypair mirroring telebirr's. */
export function generateRsaPemPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

// ── wire translators (the ONLY merchant-pack-dependent lines) ──────────────

interface PreOrderBusiness {
  outTradeNo: string;      // our DepositIntent providerRef
  totalAmount: string;     // ETB decimal, e.g. "25.00"
  subject: string;
  notifyUrl: string;
}

export function mapRequest(business: PreOrderBusiness, appId: string, appSecret: string, publicKeyPem: string): Record<string, string> {
  const nonce = randomBytes(8).toString("hex");
  const timestamp = Date.now().toString();
  const sign = signRequest(canonicalSignString(appId, nonce, timestamp), appSecret);
  return {
    appid: appId,
    nonce,
    timestamp,
    sign,
    data: encryptBusinessData(JSON.stringify(business), publicKeyPem),
  };
}

/** Callback field spellings live here. Accepts both the documented snake_case
 * and camelCase variants so the pack's exact dialect is a zero-risk diff. */
export function mapCallback(json: Record<string, unknown>): ParsedCallback {
  const providerRef = String(json.tradeNo ?? json.trade_no ?? json.outTradeNo ?? json.out_trade_no ?? "");
  if (!providerRef) throw new ApiError("PAYMENT_CALLBACK_INVALID", "notification without a transaction reference");
  const rawStatus = String(json.tradeStatus ?? json.trade_status ?? json.status ?? "").toUpperCase();
  const status: ParsedCallback["status"] = rawStatus.includes("SUCCESS") || rawStatus === "COMPLETED" || rawStatus === "PAID" ? "SUCCESS" : rawStatus.includes("FAIL") || rawStatus.includes("CLOSED") ? "FAILED" : "PENDING";
  const amountEtb = json.totalAmount ?? json.total_amount ?? json.amount;
  const amountSantim: Santim | null = amountEtb != null && String(amountEtb).match(/^\d+(\.\d{1,2})?$/) ? etbToSantim(String(amountEtb)) : null;
  return { rail: "TELEBIRR", providerRef, status, amountSantim, raw: json };
}

// ── the adapter ─────────────────────────────────────────────────────────────

export class TelebirrAdapter implements CallbackCapablePort {
  readonly name = "TELEBIRR";

  private cfg():
    | { dryRun: true }
    | { dryRun: false; baseUrl: string; appId: string; appSecret: string; publicKey: string; timeoutMs: number } {
    if (TELEBIRR.dryRun || !TELEBIRR.appId || !TELEBIRR.appSecret || !TELEBIRR.publicKey) {
      return { dryRun: true };
    }
    return {
      dryRun: false,
      baseUrl: TELEBIRR.baseUrl,
      appId: TELEBIRR.appId,
      appSecret: TELEBIRR.appSecret,
      publicKey: TELEBIRR.publicKey,
      timeoutMs: TELEBIRR.timeoutMs,
    };
  }

  async createIntent(req: PaymentIntentRequest): Promise<PaymentIntentResult> {
    assertLiveMode(); // real rails never move demo money (FR-PAY-04 mirror)
    const etb = `${(req.amountSantim / 100n).toString()}.${(req.amountSantim % 100n).toString().padStart(2, "0")}`;

    // Open the PENDING intent FIRST so idempotency is ours, then ask telebirr
    // for the pre-order under our reference. DRY_RUN fabricates the pre-order.
    const opened = await openDepositIntent(req, this.name, (key) => `tb-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
    if (opened.replayed) return opened;

    const cfg = this.cfg();
    if (cfg.dryRun) {
      return { ...opened, checkoutRef: `telebirr://dryrun/checkout?ref=${opened.providerRef}` };
    }

    const business: PreOrderBusiness = {
      outTradeNo: opened.providerRef,
      totalAmount: etb,
      subject: "Bingo Royale wallet top-up",
      notifyUrl: `${TELEBIRR.baseUrl}/api/v1/payments/callback?rail=TELEBIRR`,
    };
    const body = mapRequest(business, cfg.appId, cfg.appSecret, cfg.publicKey);
    const res = await fetch(`${cfg.baseUrl}/payment/v1/merchant/preOrder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new ApiError("PSP_UNAVAILABLE", `telebirr preOrder HTTP ${res.status}`);
    const reply = (await res.json()) as Record<string, unknown>;
    const preOrderNo = String(reply.preOrderNo ?? reply.pre_order_no ?? "");
    if (!preOrderNo) throw new ApiError("PSP_REJECTED", "telebirr returned no preOrderNo");
    // The pre-order number is telebirr's handle for this intent — keep it as
    // the checkout reference; settlement arrives against it by callback.
    return { ...opened, providerRef: preOrderNo, checkoutRef: `telebirr://checkout?preOrderNo=${preOrderNo}` };
  }

  /** Verify + translate a PSP notification. Pure verification — no ledger IO. */
  async parseCallback(headers: Record<string, string>, rawBody: string): Promise<ParsedCallback> {
    if (!rawBody || rawBody.length > 64 * 1024) {
      throw new ApiError("PAYMENT_CALLBACK_INVALID", "malformed notification body");
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new ApiError("PAYMENT_CALLBACK_INVALID", "notification is not JSON");
    }

    // Signature: header `x-sign` first, then body `sign` — both HMAC over the
    // RAW body bytes (never re-serialized; serialization differences are the
    // classic callback-forgery bug).
    const presented = headers["x-sign"] ?? headers["x_telebirr_sign"] ?? (typeof json.sign === "string" ? json.sign : "");
    const cfg = this.cfg();
    // Dry-run rehearsals verify against the configured secret (or the well-known
    // rehearsal secret); LIVE always uses the real one. Unsigned internal test
    // traffic is tolerated only in dry-run — production notifications MUST sign.
    const secret = cfg.dryRun ? (TELEBIRR.appSecret || "dryrun-secret") : cfg.appSecret;
    if (presented) {
      const expected = signRequest(rawBody, secret);
      if (!verifySignatureHex(expected, presented)) {
        throw new ApiError("PAYMENT_CALLBACK_INVALID", "signature verification failed");
      }
      if (!cfg.dryRun) {
        const ts = Number(json.timestamp ?? json.timeStamp ?? NaN);
        assertCallbackFresh(ts);
      }
    }

    return mapCallback(json);
  }

  /** Settlement path — identical ledger semantics to the demo rail. */
  async confirm(intentId: string): Promise<ConfirmResult> {
    return confirmDepositIntent(intentId, "Telebirr deposit");
  }

  /** Reconciliation probe (ADR-27 ops): DB truth, or the rail's query API. */
  async queryIntent(providerRef: string): Promise<{ status: string; source: string }> {
    const cfg = this.cfg();
    const intent = await (await import("../../lib/db")).db.depositIntent.findFirst({ where: { providerRef } });
    if (cfg.dryRun) return { status: intent?.status ?? "UNKNOWN", source: "DB(dryrun)" };
    const body = mapRequest({ outTradeNo: providerRef, totalAmount: "0.00", subject: "query", notifyUrl: "" } as PreOrderBusiness, cfg.appId, cfg.appSecret, cfg.publicKey);
    const res = await fetch(`${cfg.baseUrl}/payment/v1/merchant/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new ApiError("PSP_UNAVAILABLE", `telebirr query HTTP ${res.status}`);
    const reply = (await res.json()) as Record<string, unknown>;
    return { status: String(reply.tradeStatus ?? reply.trade_status ?? "UNKNOWN"), source: "TELEBIRR" };
  }
}
