/**
 * Ledger queries — balances (projections) and journal-derived history.
 * Reports always cite the journals; projections are the fast path.
 */
import { db } from "../../lib/db";
import { AccountCodes, ensureAccount, naturalBalance } from "./accounts";
import type { Santim } from "../../lib/money";

export async function walletBalanceOf(userId: string): Promise<Santim> {
  const acc = await ensureAccount({
    code: AccountCodes.playerWallet(userId),
    type: "LIABILITY",
    displayName: "Player wallet",
    ownerUserId: userId,
  });
  const proj = await db.walletBalance.findUnique({ where: { accountId: acc.id } });
  return proj?.balanceSantim ?? 0n;
}

export async function accountBalanceOf(code: string): Promise<Santim> {
  const acc = await db.ledgerAccount.findUnique({ where: { code } });
  if (!acc) return 0n;
  const proj = await db.walletBalance.findUnique({ where: { accountId: acc.id } });
  return proj?.balanceSantim ?? 0n;
}

/** Recompute a projection from journals (UC-10 reconciliation primitive). */
export async function recomputeBalance(accountId: string): Promise<Santim> {
  const entries = await db.journalEntry.findMany({ where: { accountId } });
  const acc = await db.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  let debits = 0n;
  let credits = 0n;
  for (const e of entries) {
    if (e.direction === "DEBIT") debits += e.amountSantim;
    else credits += e.amountSantim;
  }
  return naturalBalance(acc.type, debits, credits);
}

export interface WalletHistoryItem {
  txId: string;
  kind: string;
  memo: string;
  amount: Santim; // signed, from the wallet's perspective
  createdAt: Date;
  demo: boolean;
}

/** Recent transactions touching a player's wallet (wallet UI + support). */
export async function walletHistory(userId: string, limit = 25): Promise<WalletHistoryItem[]> {
  const acc = await db.ledgerAccount.findUnique({
    where: { code: AccountCodes.playerWallet(userId) },
    include: { entries: { orderBy: { id: "desc" }, take: limit, include: { transaction: true } } },
  });
  if (!acc) return [];
  return acc.entries.map((e) => {
    const amount = e.direction === "DEBIT" ? -e.amountSantim : e.amountSantim;
    // Debit on a liability wallet = money out.
    return {
      txId: e.transaction.id,
      kind: e.transaction.kind,
      memo: e.transaction.memo,
      amount,
      createdAt: e.transaction.createdAt,
      demo: e.transaction.demo,
    };
  });
}
