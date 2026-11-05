/**
 * Daily commission accrual (UC-15, FR-PRT-09, D-PRT-02 turnover basis).
 *
 *   commission = floor(turnoverSantim × rateBps / 10000)   — bigint exact.
 *   journal:   DR PLATFORM_COMMISSION:{tenantId} (expense)
 *              CR PARTNER_PAYABLE:{tenantId}      (liability)
 *
 * Idempotent per tenant-day (unique key). Re-runs RECOMPUTE the day's
 * turnover: if the number moved, one delta adjustment journal brings the
 * ledger to the true figure — the accrual row is the single source of truth.
 */
import { db } from "../../lib/db";
import { floorBps } from "../../lib/money";
import { dayKey } from "../../lib/json";
import { AccountCodes, postTransaction } from "../ledger";
import { activePlanAt } from "./plans";
import { audit } from "../../lib/write-path";
import { PLATFORM_TIMEZONE } from "../../lib/env";

export interface AccrualOutcome {
  tenantId: string;
  day: string;
  turnoverSantim: bigint;
  rateBps: number;
  commissionSantim: bigint;
  adjusted: boolean;
  skipped: boolean;
}

async function turnoverForDay(tenantId: string, dayStart: Date, dayEnd: Date): Promise<bigint> {
  // Turnover = confirmed purchase stakes for tenant-scoped rounds (D-PRT-02).
  const rows = await db.journalTransaction.findMany({
    where: { kind: "PURCHASE", tenantId, createdAt: { gte: dayStart, lt: dayEnd } },
    select: { entries: true },
  });
  let sum = 0n;
  for (const tx of rows) {
    for (const e of tx.entries) {
      // The CREDIT side of a purchase is the escrow leg — its amount is the stake.
      if (e.direction === "CREDIT") sum += e.amountSantim;
    }
  }
  return sum;
}

export async function runAccrualForTenantDay(tenantId: string, day: string): Promise<AccrualOutcome> {
  const dayStart = new Date(`${day}T00:00:00+03:00`); // Ethiopia is UTC+3, no DST
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);

  const turnover = await turnoverForDay(tenantId, dayStart, dayEnd);
  if (turnover === 0n) {
    // Nothing to accrue — but an existing row (from a prior run) must be
    // corrected down to zero via adjustment, never silently deleted.
    const existing = await db.dailyAccrual.findUnique({ where: { tenantId_day: { tenantId, day } } });
    if (existing && existing.commissionSantim > 0n) {
      await postTransaction(db, {
        kind: "COMMISSION_ACCRUAL",
        idempotencyKey: `accrual-adj:${tenantId}:${day}:rev`,
        memo: `Accrual reversal — no turnover for ${day}`,
        tenantId,
        entries: [
          { accountCode: AccountCodes.platformCommission(tenantId), accountType: "EXPENSE", accountName: "Platform commission", direction: "CREDIT", amount: existing.commissionSantim, tenantId },
          { accountCode: AccountCodes.partnerPayable(tenantId), accountType: "LIABILITY", accountName: "Partner payable", direction: "DEBIT", amount: existing.commissionSantim, tenantId },
        ],
      });
      await db.dailyAccrual.update({ where: { tenantId_day: { tenantId, day } }, data: { turnoverSantim: 0n, commissionSantim: 0n } });
      return { tenantId, day, turnoverSantim: 0n, rateBps: existing.rateBps, commissionSantim: 0n, adjusted: true, skipped: true };
    }
    return { tenantId, day, turnoverSantim: 0n, rateBps: 0, commissionSantim: 0n, adjusted: false, skipped: true };
  }

  const plan = await activePlanAt(tenantId, dayEnd);
  if (!plan) return { tenantId, day, turnoverSantim: turnover, rateBps: 0, commissionSantim: 0n, adjusted: false, skipped: true };

  const commission = floorBps(turnover, plan.rateBps);
  const existing = await db.dailyAccrual.findUnique({ where: { tenantId_day: { tenantId, day } } });

  if (!existing) {
    await db.$transaction(async (tx) => {
      const posted = await postTransaction(tx, {
        kind: "COMMISSION_ACCRUAL",
        idempotencyKey: `accrual:${tenantId}:${day}`,
        memo: `Commission ${plan.rateBps} bps × turnover ${turnover.toString()} snt (${day})`,
        tenantId,
        entries: [
          { accountCode: AccountCodes.platformCommission(tenantId), accountType: "EXPENSE", accountName: "Platform commission", direction: "DEBIT", amount: commission, tenantId },
          { accountCode: AccountCodes.partnerPayable(tenantId), accountType: "LIABILITY", accountName: "Partner payable", direction: "CREDIT", amount: commission, tenantId },
        ],
      });
      await tx.dailyAccrual.create({
        data: {
          tenantId,
          day,
          turnoverSantim: turnover,
          rateBps: plan.rateBps,
          planId: plan.id,
          commissionSantim: commission,
          journalTxId: posted.id,
        },
      });
    });
    return { tenantId, day, turnoverSantim: turnover, rateBps: plan.rateBps, commissionSantim: commission, adjusted: false, skipped: false };
  }

  // Recompute path — delta adjustment if the day's truth moved.
  const delta = commission - existing.commissionSantim;
  if (delta === 0n) {
    return { tenantId, day, turnoverSantim: turnover, rateBps: plan.rateBps, commissionSantim: commission, adjusted: false, skipped: false };
  }
  const isIncrease = delta > 0n;
  const abs = isIncrease ? delta : -delta;
  await postTransaction(db, {
    kind: "COMMISSION_ACCRUAL",
    idempotencyKey: `accrual-adj:${tenantId}:${day}:${existing.commissionSantim.toString()}`,
    memo: `Accrual adjustment (${isIncrease ? "+" : "-"}${abs.toString()} snt) for ${day}`,
    tenantId,
    entries: isIncrease
      ? [
          { accountCode: AccountCodes.platformCommission(tenantId), accountType: "EXPENSE", accountName: "Platform commission", direction: "DEBIT", amount: abs, tenantId },
          { accountCode: AccountCodes.partnerPayable(tenantId), accountType: "LIABILITY", accountName: "Partner payable", direction: "CREDIT", amount: abs, tenantId },
        ]
      : [
          { accountCode: AccountCodes.platformCommission(tenantId), accountType: "EXPENSE", accountName: "Platform commission", direction: "CREDIT", amount: abs, tenantId },
          { accountCode: AccountCodes.partnerPayable(tenantId), accountType: "LIABILITY", accountName: "Partner payable", direction: "DEBIT", amount: abs, tenantId },
        ],
  });
  await db.dailyAccrual.update({
    where: { tenantId_day: { tenantId, day } },
    data: { turnoverSantim: turnover, commissionSantim: commission, rateBps: plan.rateBps, planId: plan.id },
  });
  return { tenantId, day, turnoverSantim: turnover, rateBps: plan.rateBps, commissionSantim: commission, adjusted: true, skipped: false };
}

/** All tenants with the eligibility rule applied (APPROVED or SUSPENDED with history). */
export async function runAccrualsForDay(dayInput: Date = new Date()): Promise<AccrualOutcome[]> {
  const day = dayKey(dayInput, PLATFORM_TIMEZONE);
  const tenants = await db.tenant.findMany({ where: { status: { in: ["APPROVED", "SUSPENDED"] } } });
  const results: AccrualOutcome[] = [];
  for (const t of tenants) {
    results.push(await runAccrualForTenantDay(t.id, day));
  }
  return results;
}
