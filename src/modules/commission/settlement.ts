/**
 * Monthly statements and the payout path (UC-15, FR-PRT-17..19).
 *
 * Statements are immutable: issuing twice returns the existing row untouched;
 * content hash binds confirmation/dispute/payout to the exact figures.
 * Payouts require a CONFIRMED statement; the demo settles through the demo
 * clearing path only — any real-rail attempt is DEMO_PAYOUT_BLOCKED.
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { hashPayload } from "../../lib/crypto";
import { monthKey, startOfDay } from "../../lib/json";
import { AccountCodes, postTransaction } from "../ledger";
import { audit } from "../../lib/write-path";
import { STATEMENT_DISPUTE_WINDOW_DAYS, PLATFORM_TIMEZONE } from "../../lib/env";
import type { Santim } from "../../lib/money";

export interface StatementTotals {
  turnoverSantim: bigint;
  prizesSantim: bigint;
  commissionSantim: bigint;
  payableSantim: bigint;
  residualSantim: bigint;
}

async function totalsForMonth(tenantId: string, month: string): Promise<StatementTotals> {
  const accruals = await db.dailyAccrual.findMany({ where: { tenantId, day: { startsWith: month } } });
  const turnover = accruals.reduce((a, r) => a + r.turnoverSantim, 0n);
  const commission = accruals.reduce((a, r) => a + r.commissionSantim, 0n);

  // Prizes paid from tenant rooms that month: PRIZE journals credited wallets.
  const prizeTx = await db.journalTransaction.findMany({
    where: { kind: "PRIZE", tenantId, createdAt: { gte: new Date(`${month}-01T00:00:00+03:00`), lt: new Date(`${month}-31T23:59:59+03:00`) } },
    select: { entries: true },
  });
  let prizes = 0n;
  for (const t of prizeTx) for (const e of t.entries) if (e.direction === "CREDIT") prizes += e.amountSantim;

  // Residual moved to house from tenant rounds that month.
  const residualTx = await db.journalTransaction.findMany({
    where: { kind: "ROUND_RESIDUAL", tenantId, createdAt: { gte: new Date(`${month}-01T00:00:00+03:00`), lt: new Date(`${month}-31T23:59:59+03:00`) } },
    select: { entries: true },
  });
  let residual = 0n;
  for (const t of residualTx) for (const e of t.entries) if (e.direction === "CREDIT") residual += e.amountSantim;

  // Partner payable balance (credit-natural liability) minus settled payouts.
  const payableAcc = await db.ledgerAccount.findUnique({ where: { code: AccountCodes.partnerPayable(tenantId) } });
  const payableProj = payableAcc ? await db.walletBalance.findUnique({ where: { accountId: payableAcc.id } }) : null;
  const payable = payableProj?.balanceSantim ?? 0n;

  return { turnoverSantim: turnover, prizesSantim: prizes, commissionSantim: commission, payableSantim: payable, residualSantim: residual };
}

/** Issue (or return the immutable) monthly statement for a tenant. */
export async function issueStatement(tenantId: string, monthInput: Date = new Date()) {
  const month = monthKey(monthInput, PLATFORM_TIMEZONE);
  const existing = await db.statement.findUnique({ where: { tenantId_periodMonth: { tenantId, periodMonth: month } } });
  if (existing) return { statement: existing, alreadyIssued: true };

  const totals = await totalsForMonth(tenantId, month);
  const contentHash = hashPayload({
    tenantId,
    month,
    turnover: totals.turnoverSantim.toString(),
    prizes: totals.prizesSantim.toString(),
    commission: totals.commissionSantim.toString(),
    payable: totals.payableSantim.toString(),
    residual: totals.residualSantim.toString(),
  });
  const statement = await db.statement.create({
    data: {
      tenantId,
      periodMonth: month,
      turnoverSantim: totals.turnoverSantim,
      prizesSantim: totals.prizesSantim,
      commissionSantim: totals.commissionSantim,
      payableSantim: totals.payableSantim,
      residualSantim: totals.residualSantim,
      contentHash,
    },
  });
  await audit({
    actorId: null,
    actorRole: "SYSTEM",
    tenantId,
    action: "STATEMENT_ISSUED",
    entityType: "Statement",
    entityId: statement.id,
    payloadHash: contentHash,
    meta: { month },
  });
  return { statement, alreadyIssued: false };
}

export async function confirmStatement(statementId: string, actorId: string) {
  const statement = await db.statement.findUnique({ where: { id: statementId } });
  if (!statement) throw new ApiError("NOT_FOUND", "statement");
  if (statement.status === "CONFIRMED") return statement;
  if (statement.status === "DISPUTED") throw new ApiError("VALIDATION_FAILED", "resolve disputes before confirming");
  const updated = await db.statement.update({
    where: { id: statementId },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
  await audit({ actorId, actorRole: "TENANT_OWNER", tenantId: statement.tenantId, action: "STATEMENT_CONFIRMED", entityType: "Statement", entityId: statementId, payloadHash: statement.contentHash });
  return updated;
}

export async function raiseDispute(statementId: string, reasonCode: string, note: string, actorId: string) {
  const statement = await db.statement.findUnique({ where: { id: statementId } });
  if (!statement) throw new ApiError("NOT_FOUND", "statement");
  // Dispute window (OD-14): N days from issue.
  const windowEnd = statement.issuedAt.getTime() + STATEMENT_DISPUTE_WINDOW_DAYS * 24 * 3600_000;
  if (Date.now() > windowEnd) throw new ApiError("DISPUTE_WINDOW_CLOSED");
  const dispute = await db.statementDispute.create({
    data: { statementId, reasonCode, note, raisedById: actorId },
  });
  await db.statement.update({ where: { id: statementId }, data: { status: "DISPUTED" } });
  await audit({ actorId, actorRole: "TENANT_OWNER", tenantId: statement.tenantId, action: "STATEMENT_DISPUTED", entityType: "Statement", entityId: statementId, meta: { reasonCode, disputeId: dispute.id } });
  return dispute;
}

export async function resolveDispute(disputeId: string, reviewerNote: string, actorId: string) {
  const dispute = await db.statementDispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new ApiError("NOT_FOUND", "dispute");
  if (dispute.resolvedAt) throw new ApiError("VALIDATION_FAILED", "already resolved");
  await db.statementDispute.update({ where: { id: disputeId }, data: { reviewerNote, resolvedAt: new Date() } });
  const remaining = await db.statementDispute.count({ where: { statementId: dispute.statementId, resolvedAt: null } });
  if (remaining === 0) {
    await db.statement.update({ where: { id: dispute.statementId }, data: { status: "ISSUED" } });
  }
  await audit({ actorId, actorRole: "PLATFORM_FINANCE", action: "DISPUTE_RESOLVED", entityType: "StatementDispute", entityId: disputeId, meta: { note: reviewerNote } });
  return { ok: true };
}

// ── Payouts ─────────────────────────────────────────────────────────────────

export async function requestPayout(statementId: string, amountSantim: Santim, actorId: string) {
  const statement = await db.statement.findUnique({ where: { id: statementId } });
  if (!statement) throw new ApiError("NOT_FOUND", "statement");
  if (statement.status !== "CONFIRMED") {
    // UC-15 failure flow: a payout without a confirmed statement is refused.
    throw new ApiError("STATEMENT_NOT_CONFIRMED", `statement is ${statement.status}`);
  }
  if (amountSantim <= 0n) throw new ApiError("VALIDATION_FAILED", "amount must be positive");
  const openRequests = await db.payoutRequest.aggregate({
    where: { tenantId: statement.tenantId, status: { in: ["REQUESTED", "APPROVED", "SETTLED"] } },
    _sum: { amountSantim: true },
  });
  const alreadyCommitted = openRequests._sum.amountSantim ?? 0n;
  if (alreadyCommitted + amountSantim > statement.payableSantim) {
    throw new ApiError("VALIDATION_FAILED", "payout exceeds payable balance");
  }
  const req = await db.payoutRequest.create({
    data: { statementId, tenantId: statement.tenantId, amountSantim, requestedById: actorId },
  });
  await audit({ actorId, actorRole: "TENANT_OWNER", tenantId: statement.tenantId, action: "PAYOUT_REQUESTED", entityType: "PayoutRequest", entityId: req.id, meta: { amount: amountSantim.toString() } });
  return req;
}

export async function decidePayout(payoutId: string, approve: boolean, note: string, actorId: string) {
  const payout = await db.payoutRequest.findUnique({ where: { id: payoutId } });
  if (!payout) throw new ApiError("NOT_FOUND", "payout request");
  if (payout.status !== "REQUESTED") throw new ApiError("VALIDATION_FAILED", `payout is ${payout.status}`);
  if (payout.requestedById === actorId) {
    // Maker-checker: the approver must differ from the requester.
    throw new ApiError("SELF_APPROVAL_REJECTED");
  }
  const updated = await db.payoutRequest.update({
    where: { id: payoutId },
    data: { status: approve ? "APPROVED" : "REJECTED", decidedById: actorId, decisionNote: note, decidedAt: new Date() },
  });
  await audit({ actorId, actorRole: "PLATFORM_FINANCE", tenantId: payout.tenantId, action: approve ? "PAYOUT_APPROVED" : "PAYOUT_REJECTED", entityType: "PayoutRequest", entityId: payoutId, meta: { note } });
  return updated;
}

/** Demo settlement — payout clearing path only (FR-PRT-19, D-PRT-06). */
export async function settlePayout(payoutId: string, actorId: string, rail: "DEMO" | string = "DEMO") {
  if (rail !== "DEMO") {
    throw new ApiError("DEMO_PAYOUT_BLOCKED", `rail ${rail} is not enabled in the demo phase`);
  }
  const payout = await db.payoutRequest.findUnique({ where: { id: payoutId } });
  if (!payout) throw new ApiError("NOT_FOUND", "payout request");
  if (payout.status !== "APPROVED") throw new ApiError("VALIDATION_FAILED", `payout is ${payout.status}`);

  const journalTxId = await db.$transaction(async (tx) => {
    const posted = await postTransaction(tx, {
      kind: "PARTNER_PAYOUT",
      idempotencyKey: `payout:${payout.id}`,
      memo: `Partner payout settled (DEMO rail) — statement ${payout.statementId}`,
      tenantId: payout.tenantId,
      entries: [
        { accountCode: AccountCodes.partnerPayable(payout.tenantId), accountType: "LIABILITY", accountName: "Partner payable", direction: "DEBIT", amount: payout.amountSantim, tenantId: payout.tenantId },
        { accountCode: AccountCodes.payoutClearing(), accountType: "ASSET", accountName: "Demo payout clearing", direction: "CREDIT", amount: payout.amountSantim },
      ],
    });
    await tx.payoutRequest.update({ where: { id: payout.id }, data: { status: "SETTLED", settledAt: new Date(), journalTxId: posted.id } });
    return posted.id;
  });
  await audit({ actorId, actorRole: "PLATFORM_FINANCE", tenantId: payout.tenantId, action: "PAYOUT_SETTLED_DEMO", entityType: "PayoutRequest", entityId: payoutId, meta: { journalTxId } });
  const settled = await db.payoutRequest.findUniqueOrThrow({ where: { id: payoutId } });
  return { ...settled, journalTxId };
}
