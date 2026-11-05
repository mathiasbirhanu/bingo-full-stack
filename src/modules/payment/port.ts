/**
 * Payment port (FR-PAY) — the seam between the platform and any PSP.
 *
 * Architecture ch. 4.2 + ADR-07: the finance service talks to a payment PORT;
 * adapters are mode-gated and exactly one is wired at the composition root:
 *   PAYMENT_MODE=DEMO → DemoPspAdapter  (simulated checkout, instant confirm)
 *   PAYMENT_MODE=LIVE → TelebirrAdapter (real rail; confirm arrives by callback)
 *
 * The lifecycle is two-phase for real rails: createIntent opens a PENDING
 * DepositIntent and hands back a checkout reference; the PSP confirms out of
 * band and the callback route (api/v1/payments/callback) verifies and posts
 * the balanced journal. The demo rail compresses both phases into one call —
 * the ledger semantics are IDENTICAL (shared confirmDepositIntent below).
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { hashPayload } from "../../lib/crypto";
import { assertPositive, type Santim } from "../../lib/money";
import { AccountCodes, postTransaction } from "../ledger";
import { audit } from "../../lib/write-path";
import { PAYMENT_MODE } from "../../lib/env";
import { TelebirrAdapter } from "./telebirr";

export interface PaymentIntentRequest {
  idempotencyKey: string;
  userId: string;
  amountSantim: Santim;
}

export interface PaymentIntentResult {
  intentId: string;
  providerRef: string;
  status: "PENDING" | "CONFIRMED";
  replayed: boolean;
  checkoutRef: string; // demo checkout page token / telebirr preOrder ref
}

export interface ConfirmResult {
  balance: Santim;
  journalTxId: string;
}

/**
 * A verified PSP notification. `status === "SUCCESS"` is the ONLY value that
 * may trigger a wallet credit; everything else is recorded and acked.
 */
export interface ParsedCallback {
  rail: string;
  providerRef: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  amountSantim: Santim | null;
  raw: unknown;
}

/** The port every adapter implements (production: TEBIRR/CBE/MPESA adapters). */
export interface PaymentPort {
  readonly name: string;
  createIntent(req: PaymentIntentRequest): Promise<PaymentIntentResult>;
  /** Post the balanced DEPOSIT journal for this intent. Idempotent forever. */
  confirm(intentId: string): Promise<ConfirmResult>;
}

/** Ports whose PSP calls back out of band must also verify notifications. */
export interface CallbackCapablePort extends PaymentPort {
  /** Throws PAYMENT_CALLBACK_INVALID on any signature/timestamp failure. */
  parseCallback(headers: Record<string, string>, rawBody: string): Promise<ParsedCallback>;
}

/** Mode guard — called before ANY demo-rail usage (FR-PAY-04). */
export function assertDemoMode(): void {
  if (PAYMENT_MODE !== "DEMO") {
    throw new ApiError("PAYMENT_MODE_GUARD", `payment mode ${PAYMENT_MODE} is not enabled in this build`);
  }
}

/** Mode guard for real rails: the mirror image of assertDemoMode. */
export function assertLiveMode(): void {
  if (PAYMENT_MODE !== "LIVE") {
    throw new ApiError("PAYMENT_MODE_GUARD", "real rails refuse to move demo money — flip PAYMENT_MODE to activate");
  }
}

/**
 * Shared core: open a PENDING DepositIntent with full idempotency semantics
 * (UC-02 failure flows): same key + same payload → replay the original
 * result; same key + different payload → IDEMPOTENCY_CONFLICT.
 */
export async function openDepositIntent(
  req: PaymentIntentRequest,
  adapterName: string,
  providerRefFor: (idempotencyKey: string) => string
): Promise<PaymentIntentResult> {
  assertPositive(req.amountSantim);
  const payloadHash = hashPayload({ userId: req.userId, amount: req.amountSantim.toString(), key: req.idempotencyKey });

  const existing = await db.depositIntent.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "same key used with a different payload");
    }
    return {
      intentId: existing.id,
      providerRef: existing.providerRef ?? existing.id,
      status: existing.status === "CONFIRMED" ? "CONFIRMED" : "PENDING",
      replayed: true,
      checkoutRef: existing.providerRef ?? existing.id,
    };
  }

  const intent = await db.depositIntent.create({
    data: {
      idempotencyKey: req.idempotencyKey,
      userId: req.userId,
      amountSantim: req.amountSantim,
      payloadHash,
      providerRef: providerRefFor(req.idempotencyKey),
    },
  });
  await audit({
    actorId: req.userId,
    actorRole: "PLAYER",
    action: "DEPOSIT_INTENT_CREATED",
    entityType: "DepositIntent",
    entityId: intent.id,
    meta: { amount: req.amountSantim.toString(), adapter: adapterName },
  });
  return { intentId: intent.id, providerRef: intent.providerRef!, status: "PENDING", replayed: false, checkoutRef: intent.providerRef! };
}

/**
 * Shared core: post the balanced DEPOSIT journal (clearing DEBIT → wallet
 * CREDIT) and stamp the intent CONFIRMED — atomically, replay-safe at both
 * the intent level (status check) and the journal level (idempotency key).
 * Every rail, demo or real, converges here: one money path, audited once.
 */
export async function confirmDepositIntent(intentId: string, memo: string): Promise<ConfirmResult> {
  const intent = await db.depositIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new ApiError("NOT_FOUND", "deposit intent");
  if (intent.status === "CONFIRMED" && intent.journalTxId) {
    // Replay of an already-settled notification: return the settled state.
    const acc = await db.ledgerAccount.findUnique({ where: { code: AccountCodes.playerWallet(intent.userId) } });
    const proj = acc ? await db.walletBalance.findUnique({ where: { accountId: acc.id } }) : null;
    return { balance: proj?.balanceSantim ?? 0n, journalTxId: intent.journalTxId };
  }
  if (intent.status === "FAILED") {
    throw new ApiError("DEPOSIT_FAILED", "intent was terminal-failed by the rail; open a new deposit");
  }

  const walletCode = AccountCodes.playerWallet(intent.userId);
  const result = await db.$transaction(async (tx) => {
    const posted = await postTransaction(tx, {
      kind: "DEPOSIT",
      idempotencyKey: `deposit:${intent.idempotencyKey}`, // journal-level replay safety
      memo,
      entries: [
        {
          accountCode: AccountCodes.paymentClearing(),
          accountType: "ASSET",
          accountName: "Payment clearing",
          direction: "DEBIT",
          amount: intent.amountSantim,
        },
        {
          accountCode: walletCode,
          accountType: "LIABILITY",
          accountName: "Player wallet",
          direction: "CREDIT",
          amount: intent.amountSantim,
          ownerUserId: intent.userId,
        },
      ],
    });
    await tx.depositIntent.update({
      where: { id: intent.id },
      data: { status: "CONFIRMED", confirmedAt: new Date(), journalTxId: posted.id },
    });
    return posted;
  });

  await audit({
    actorId: intent.userId,
    actorRole: "PLAYER",
    action: "DEPOSIT_CONFIRMED",
    entityType: "DepositIntent",
    entityId: intent.id,
    meta: { journalTxId: result.id, memo },
  });

  const acc = await db.ledgerAccount.findUniqueOrThrow({ where: { code: walletCode } });
  const proj = await db.walletBalance.findUniqueOrThrow({ where: { accountId: acc.id } });
  return { balance: proj.balanceSantim, journalTxId: result.id };
}

/** Mark a rail-rejected intent terminal (FAILED callbacks land here). */
export async function failDepositIntent(intentId: string, reason: string): Promise<void> {
  const intent = await db.depositIntent.findUnique({ where: { id: intentId } });
  if (!intent || intent.status !== "PENDING") return;
  await db.depositIntent.update({ where: { id: intent.id }, data: { status: "FAILED" } });
  await audit({
    actorId: intent.userId,
    actorRole: "PLAYER",
    action: "DEPOSIT_FAILED",
    entityType: "DepositIntent",
    entityId: intent.id,
    meta: { reason },
  });
}

/**
 * Demo adapter: no external calls, simulated checkout reference. Confirmation
 * credits PLAYER_WALLET from PAYMENT_CLEARING through the shared journal path
 * (UC-02 main flow). Demo money exists in the ledger like real money.
 */
export class DemoPspAdapter implements PaymentPort {
  readonly name = "DEMO_PSP";

  async createIntent(req: PaymentIntentRequest): Promise<PaymentIntentResult> {
    assertDemoMode();
    return openDepositIntent(req, this.name, (key) => `demo-${key.slice(0, 18)}`);
  }

  /** Simulated PSP callback → post the balanced DEPOSIT journal. Idempotent. */
  async confirm(intentId: string): Promise<ConfirmResult> {
    assertDemoMode();
    return confirmDepositIntent(intentId, "Demo deposit (simulated checkout)");
  }
}

/** The single port instance wired into the app (composition root). */
export const paymentPort: PaymentPort = PAYMENT_MODE === "LIVE" ? new TelebirrAdapter() : new DemoPspAdapter();

/** Callback routing — PSP notifications name their rail; we pick the verifier. */
export function callbackPortFor(rail: string): CallbackCapablePort {
  const normalized = rail.toUpperCase();
  if (PAYMENT_MODE !== "LIVE") {
    throw new ApiError("PAYMENT_MODE_GUARD", "PSP callbacks are a real-rail surface; none is active in this build");
  }
  if (normalized === "TELEBIRR") return new TelebirrAdapter();
  throw new ApiError("NOT_FOUND", `no callback verifier for rail ${rail}`);
}
