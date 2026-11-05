/**
 * telebirr adapter tests — FR-PAY port isolation, ADR-07.
 * Covers: hybrid envelope roundtrip, HMAC sign/verify (timing-safe), callback
 * freshness, wire-dialect mapping, mode guards, and the shared settlement
 * path's idempotency (a double callback NEVER double-credits).
 * Run: bun test tests/telebirr.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalSignString,
  signRequest,
  verifySignatureHex,
  assertCallbackFresh,
  encryptBusinessData,
  decryptBusinessData,
  generateRsaPemPair,
  mapCallback,
  TelebirrAdapter,
} from "../src/modules/payment/telebirr";
import { callbackPortFor, confirmDepositIntent, openDepositIntent } from "../src/modules/payment/port";
import { ApiError } from "../src/lib/errors";
import { db } from "../src/lib/db";

describe("telebirr wire primitives", () => {
  test("hybrid envelope roundtrips: RSA-OAEP sealed AES key opens the payload", () => {
    const { publicKeyPem, privateKeyPem } = generateRsaPemPair();
    const secret = JSON.stringify({ outTradeNo: "tb-abc123", totalAmount: "25.00", subject: "top-up" });
    const envelope = encryptBusinessData(secret, publicKeyPem);
    expect(decryptBusinessData(envelope, privateKeyPem)).toBe(secret);
  });

  test("envelope tampering fails AES-GCM auth, not silently corrupts", () => {
    const { publicKeyPem, privateKeyPem } = generateRsaPemPair();
    const envelope = encryptBusinessData('{"a":1}', publicKeyPem);
    const raw = Buffer.from(envelope, "base64");
    raw[raw.length - 1] ^= 0xff; // flip one ciphertext bit
    expect(() => decryptBusinessData(raw.toString("base64"), privateKeyPem)).toThrow();
  });

  test("HMAC signature verifies; any tamper fails; comparison is timing-safe", () => {
    const body = '{"tradeNo":"T-1","tradeStatus":"SUCCESS"}';
    const sig = signRequest(canonicalSignString("app-1", "nonce-1", "123"), "sekrit");
    expect(sig).toHaveLength(64); // sha256 hex
    expect(verifySignatureHex(sig, sig)).toBe(true);
    expect(verifySignatureHex(sig, signRequest(canonicalSignString("app-1", "nonce-1", "124"), "sekrit"))).toBe(false);
    expect(verifySignatureHex(sig, "f".repeat(64))).toBe(false);
  });

  test("callback freshness window rejects stale replays", () => {
    const now = Date.now();
    assertCallbackFresh(now - 60_000, now); // 1 min old: fine
    expect(() => assertCallbackFresh(now - 11 * 60_000, now)).toThrow(ApiError); // 11 min: rejected
    expect(() => assertCallbackFresh(NaN, now)).toThrow(ApiError);
  });

  test("mapCallback accepts both documented dialects and parses ETB to santim", () => {
    const camel = mapCallback({ tradeNo: "T-9", tradeStatus: "SUCCESS", totalAmount: "10.00" });
    expect(camel.status).toBe("SUCCESS");
    expect(camel.amountSantim).toBe(1000n);
    const snake = mapCallback({ out_trade_no: "T-9", trade_status: "TRADE_CLOSED" });
    expect(snake.status).toBe("FAILED");
    const pending = mapCallback({ tradeNo: "T-9", tradeStatus: "PROCESSING" });
    expect(pending.status).toBe("PENDING");
    expect(() => mapCallback({ tradeStatus: "SUCCESS" })).toThrow(ApiError); // no reference
  });
});

describe("parseCallback verification", () => {
  const adapter = new TelebirrAdapter();

  test("signed notification verifies; one flipped bit is FORGERY", async () => {
    const payload = JSON.stringify({ tradeNo: "tb-dry-1", tradeStatus: "SUCCESS", totalAmount: "25.00", timestamp: Date.now() });
    const sig = signRequest(payload, "dryrun-secret");
    const parsed = await adapter.parseCallback({ "x-sign": sig }, payload);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.amountSantim).toBe(2500n);

    const forged = JSON.stringify({ tradeNo: "tb-dry-1", tradeStatus: "SUCCESS", totalAmount: "2500.00", timestamp: Date.now() });
    await expect(adapter.parseCallback({ "x-sign": sig }, forged)).rejects.toThrow(ApiError);
  });

  test("non-JSON bodies are rejected before any crypto work", async () => {
    await expect(adapter.parseCallback({}, "not json at all")).rejects.toThrow(ApiError);
  });
});

describe("mode guards (FR-PAY-04 and its LIVE mirror)", () => {
  test("the telebirr rail refuses to open intents while the build is DEMO", async () => {
    const adapter = new TelebirrAdapter();
    await expect(
      adapter.createIntent({ idempotencyKey: "tb-guard-key-0001", userId: "u-x", amountSantim: 1000n })
    ).rejects.toThrow(ApiError);
  });

  test("PSP callbacks are a LIVE surface: DEMO builds refuse at the route gate", () => {
    expect(() => callbackPortFor("TELEBIRR")).toThrow(ApiError);
  });
});

describe("shared settlement path (demo and telebirr converge here)", () => {
  test("openDepositIntent replay semantics: same payload replays, different payload conflicts", async () => {
    const userId = "u-tb-shared";
    await db.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, phoneE164: "enc", phoneBlindIdx: `idx-${userId}`, role: "PLAYER" },
    });
    const key = `tb-shared-${Date.now()}`;
    const first = await openDepositIntent({ idempotencyKey: key, userId, amountSantim: 500n }, "TEST", () => `tb-test-${key}`);
    expect(first.replayed).toBe(false);
    const replay = await openDepositIntent({ idempotencyKey: key, userId, amountSantim: 500n }, "TEST", () => `tb-test-${key}`);
    expect(replay.replayed).toBe(true);
    expect(replay.intentId).toBe(first.intentId);
    await expect(
      openDepositIntent({ idempotencyKey: key, userId, amountSantim: 999n }, "TEST", () => `tb-test-${key}`)
    ).rejects.toThrow(ApiError);
  });

  test("confirm is idempotent: double notification → one journal, same tx id", async () => {
    const userId = "u-tb-confirm";
    await db.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, phoneE164: "enc", phoneBlindIdx: `idx-${userId}`, role: "PLAYER" },
    });
    const key = `tb-confirm-${Date.now()}`;
    const intent = await openDepositIntent({ idempotencyKey: key, userId, amountSantim: 750n }, "TEST", () => `tb-c-${key}`);

    const first = await confirmDepositIntent(intent.intentId, "Telebirr deposit");
    expect(first.journalTxId).toBeTruthy();
    const second = await confirmDepositIntent(intent.intentId, "Telebirr deposit");
    expect(second.journalTxId).toBe(first.journalTxId); // settled once, forever

    const entries = await db.journalEntry.findMany({ where: { transactionId: first.journalTxId } });
    expect(entries).toHaveLength(2);
    const debits = entries.filter((e) => e.direction === "DEBIT").reduce((a, e) => a + e.amountSantim, 0n);
    const credits = entries.filter((e) => e.direction === "CREDIT").reduce((a, e) => a + e.amountSantim, 0n);
    expect(debits).toBe(credits); // balanced double-entry, exactly 7.50 ETB
    expect(debits).toBe(750n);
  });
});
