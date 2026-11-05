import { z } from "zod";
import { jsonOk, route } from "@/lib/api";
import { paymentPort } from "@/modules/payment";
import { walletBalanceOf, walletHistory } from "@/modules/ledger";
import { santimToEtb, etbToSantim } from "@/lib/money";
import { PAYMENT_MODE, PLATFORM_PHASE } from "@/lib/env";

/** Wallet endpoints — UC-02 deposit through the payment port + balance/history (FR-FIN). */
const depositSchema = z.object({
  amountEtb: z.string().min(1), // "50.00"
  idempotencyKey: z.string().min(8).max(128),
});

export const GET = route(async ({ user }) => {
  const balance = await walletBalanceOf(user!.id);
  const history = await walletHistory(user!.id, 30);
  return jsonOk({
    balanceSantim: balance.toString(),
    balanceDisplay: santimToEtb(balance),
    currency: "ETB",
    mode: PAYMENT_MODE,
    phase: PLATFORM_PHASE,
    history: history.map((h) => ({
      ...h,
      amountSantim: h.amount.toString(),
      amountDisplay: santimToEtb(h.amount),
      amount: undefined,
      createdAt: h.createdAt.toISOString(),
      demo: h.demo,
    })),
  });
});

export const POST = route(
  async ({ body, user }) => {
    const { amountEtb, idempotencyKey } = body as z.infer<typeof depositSchema>;

    // Phase 1 (every rail): open the idempotent intent through the port.
    const intent = await paymentPort.createIntent({
      idempotencyKey,
      userId: user!.id,
      amountSantim: etbToSantim(amountEtb),
    });

    if (PAYMENT_MODE === "LIVE") {
      // Real rail: settlement arrives out of band — telebirr confirms via the
      // signed callback (api/v1/payments/callback). Never auto-confirm here:
      // money enters the wallet ONLY through a verified PSP notification.
      return jsonOk({
        intentId: intent.intentId,
        replayed: intent.replayed,
        providerRef: intent.providerRef,
        checkoutRef: intent.checkoutRef,
        pending: true,
        phase: PLATFORM_PHASE,
      });
    }

    // Demo rail: the simulated checkout confirms instantly through the same
    // journal path a verified telebirr callback takes — one money path.
    const confirmed = await paymentPort.confirm(intent.intentId);
    return jsonOk({
      intentId: intent.intentId,
      replayed: intent.replayed,
      providerRef: intent.providerRef,
      checkoutRef: intent.checkoutRef,
      balanceSantim: confirmed.balance.toString(),
      balanceDisplay: santimToEtb(confirmed.balance),
      pending: false,
      phase: PLATFORM_PHASE,
      demo: true, // every deposit screen and response is DEMO-labelled (UC-02)
    });
  },
  { schema: depositSchema }
);
