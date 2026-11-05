/**
 * Journal posting (FR-FIN-01) — the only door into the double-entry ledger.
 *
 * Guarantees:
 *  · idempotencyKey unique: a replayed key returns the ORIGINAL transaction —
 *    callers can retry a purchase/deposit/refund without ever double-posting.
 *  · balanced invariant: sum(DEBIT) == sum(CREDIT) per transaction, asserted
 *    before write (UC-09 acceptance: "journal entries balance").
 *  · projection beside journal: WalletBalance updated in the same transaction
 *    (ADR-04 — no monetary state outside the system of record).
 *  · SQLite interactive transaction serializes writers → the debit path gets
 *    the same strong isolation PostgreSQL SERIALIZABLE provides in production
 *    (Architecture ch. 4.2, Finance service).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Santim } from "../../lib/money";
import { ApiError } from "../../lib/errors";
import { ensureAccountTx, naturalBalance } from "./accounts";

export type EntryDirection = "DEBIT" | "CREDIT";

export interface EntryInput {
  accountCode: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  accountName: string;
  direction: EntryDirection;
  amount: Santim;
  tenantId?: string | null;
  ownerUserId?: string | null;
}

export interface PostTransactionInput {
  kind:
    | "DEPOSIT"
    | "PURCHASE"
    | "PRIZE"
    | "REFUND"
    | "PRIZE_ADJUSTMENT"
    | "COMMISSION_ACCRUAL"
    | "PARTNER_PAYOUT"
    | "ROUND_RESIDUAL"
    | "ADJUSTMENT";
  idempotencyKey: string;
  memo: string;
  roundId?: string | null;
  tenantId?: string | null;
  entries: EntryInput[];
  demo?: boolean;
}

export interface PostedTransaction {
  id: string;
  idempotencyKey: string;
  replayed: boolean;
}

/**
 * Post one balanced, idempotent transaction. `tx` MUST be an interactive
 * transaction client so the read-balance → write-journal → write-projection
 * sequence is atomic.
 */
export async function postTransaction(
  tx: Prisma.TransactionClient | PrismaClient,
  input: PostTransactionInput
): Promise<PostedTransaction> {
  if (input.entries.length < 2) throw new ApiError("VALIDATION_FAILED", "journal needs at least two entries");

  // 1. Idempotency: same key → replay the original result.
  const existing = await tx.journalTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, idempotencyKey: true },
  });
  if (existing) return { id: existing.id, idempotencyKey: existing.idempotencyKey, replayed: true };

  // 2. Validate: positive amounts, balanced sums.
  let debits = 0n;
  let credits = 0n;
  for (const e of input.entries) {
    if (e.amount <= 0n) throw new ApiError("VALIDATION_FAILED", "journal amounts must be positive");
    if (e.direction === "DEBIT") debits += e.amount;
    else credits += e.amount;
  }
  if (debits !== credits) {
    throw new ApiError("INTERNAL", `unbalanced journal ${debits} != ${credits} for ${input.kind}`);
  }

  // 3. Resolve accounts (get-or-create inside the same tx).
  const accounts = new Map<string, { id: string; type: string }>();
  for (const e of input.entries) {
    if (!accounts.has(e.accountCode)) {
      const acc = await ensureAccountTx(tx, {
        code: e.accountCode,
        type: e.accountType,
        displayName: e.accountName,
        tenantId: e.tenantId ?? null,
        ownerUserId: e.ownerUserId ?? null,
      });
      accounts.set(e.accountCode, { id: acc.id, type: acc.type });
    }
  }

  // 4. Create transaction + entries.
  const trx = await tx.journalTransaction.create({
    data: {
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      memo: input.memo,
      roundId: input.roundId ?? null,
      tenantId: input.tenantId ?? null,
      demo: input.demo ?? true,
      entries: {
        create: input.entries.map((e, idx) => ({
          accountId: accounts.get(e.accountCode)!.id,
          direction: e.direction,
          amountSantim: e.amount,
          seq: idx,
        })),
      },
    },
  });

  // 5. Update projections in the same transaction.
  for (const code of accounts.keys()) {
    const accountEntries = input.entries.filter((e) => e.accountCode === code);
    const acc = accounts.get(code)!;
    const type = acc.type;
    // Fetch the current projection inside the tx for a delta update.
    const current = await tx.walletBalance.findUnique({ where: { accountId: acc.id } });
    let delta = 0n;
    for (const e of accountEntries) {
      const isDebit = e.direction === "DEBIT";
      delta += naturalBalance(type, isDebit ? e.amount : 0n, isDebit ? 0n : e.amount);
    }
    if (current) {
      await tx.walletBalance.update({ where: { accountId: acc.id }, data: { balanceSantim: current.balanceSantim + delta } });
    } else {
      await tx.walletBalance.create({ data: { accountId: acc.id, balanceSantim: delta } });
    }
  }

  return { id: trx.id, idempotencyKey: input.idempotencyKey, replayed: false };
}
