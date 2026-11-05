import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { callbackPortFor, failDepositIntent, confirmDepositIntent } from "@/modules/payment";
import { db } from "@/lib/db";
import { audit } from "@/lib/write-path";

/**
 * PSP callback endpoint — the real-rail settlement gate (FR-PAY, UC-02).
 *
 *   POST /api/v1/payments/callback?rail=TELEBIRR
 *
 * Contract: verify the notification's signature FIRST (timing-safe, over the
 * raw bytes), translate the rail's dialect, then settle through the shared
 * journal path. Money can enter a wallet from a real rail ONLY through this
 * verified path — in LIVE mode the wallet route leaves the intent PENDING and
 * there is no other confirm surface.
 *
 * Response convention: a 200 with the PSP success envelope stops retries;
 * error statuses make the PSP retry with backoff — which is what we want
 * while a transient error heals (settlement itself is idempotent forever).
 */
export const POST = route(
  async ({ rawBody, headers, query }) => {
    const rail = String(query.get("rail") ?? "");
    const port = callbackPortFor(rail); // mode-gated: DEMO builds refuse here

    const parsed = await port.parseCallback(Object.fromEntries(headers.entries()), rawBody ?? "");

    // Locate the intent this notification settles. The providerRef we handed
    // the rail at pre-order time is the join key (dry-run refs match by
    // construction; a live pack joins preOrderNo the same way).
    const intent = await db.depositIntent.findFirst({ where: { providerRef: parsed.providerRef } });
    if (!intent) {
      await audit({
        actorRole: "SYSTEM",
        action: "PAYMENT_CALLBACK_UNKNOWN_REF",
        entityType: "DepositIntent",
        entityId: parsed.providerRef,
        meta: { rail: parsed.rail },
      });
      throw new ApiError("UNKNOWN_DEPOSIT_REF", `no deposit intent for ${parsed.rail} ref ${parsed.providerRef}`);
    }

    if (parsed.status === "SUCCESS") {
      // Amount assertion: when the rail echoes the amount it must match the
      // intent to the santim — a mismatch is an incident, never a settlement.
      if (parsed.amountSantim != null && parsed.amountSantim !== intent.amountSantim) {
        await audit({
          actorRole: "SYSTEM",
          action: "PAYMENT_CALLBACK_AMOUNT_MISMATCH",
          entityType: "DepositIntent",
          entityId: intent.id,
          meta: { expected: intent.amountSantim.toString(), received: parsed.amountSantim.toString(), rail: parsed.rail },
        });
        throw new ApiError("AMOUNT_MISMATCH", "notification amount differs from the deposit intent");
      }
      const result = await confirmDepositIntent(intent.id, `${parsed.rail} deposit`);
      return NextResponse.json({ code: "0", message: "Success", journalTxId: result.journalTxId });
    }

    if (parsed.status === "FAILED") {
      await failDepositIntent(intent.id, `${parsed.rail} reported the transaction failed/closed`);
      return NextResponse.json({ code: "0", message: "Failure recorded" });
    }

    // PENDING: ack without settling — the rail notifies again on a terminal
    // state (or reconciliation's queryIntent picks it up on the ops cron).
    return NextResponse.json({ code: "0", message: "Pending" });
  },
  { anon: true }
);
