/**
 * Ledger accounts (FR-FIN-01). Account codes are the contract between every
 * money-moving module — they appear verbatim in journal entries and reports.
 *
 * Natural-balance rule: DEBIT raises ASSET/EXPENSE; CREDIT raises
 * LIABILITY/REVENUE/EQUITY. The projection stores the natural balance.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "../../lib/db";
import type { Santim } from "../../lib/money";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export const AccountCodes = {
  playerWallet: (userId: string) => `PLAYER_WALLET:${userId}`,
  roundEscrow: (roundId: string) => `ROUND_ESCROW:${roundId}`,
  paymentClearing: () => "PAYMENT_CLEARING:DEMO",
  payoutClearing: () => "PAYOUT_CLEARING:DEMO",
  externalFunding: () => "EXTERNAL_FUNDING",
  houseRevenue: () => "HOUSE_REVENUE",
  platformCommission: (tenantId: string) => `PLATFORM_COMMISSION:${tenantId}`,
  partnerPayable: (tenantId: string) => `PARTNER_PAYABLE:${tenantId}`,
} as const;

const NATURAL_DEBIT: Set<AccountType> = new Set(["ASSET", "EXPENSE"]);

export interface EnsureAccountInput {
  code: string;
  type: AccountType;
  displayName: string;
  tenantId?: string | null;
  ownerUserId?: string | null;
}

/** Get-or-create an account (idempotent by unique code). */
export async function ensureAccount(input: EnsureAccountInput) {
  const existing = await db.ledgerAccount.findUnique({ where: { code: input.code } });
  if (existing) return existing;
  try {
    return await db.ledgerAccount.create({
      data: {
        code: input.code,
        type: input.type,
        displayName: input.displayName,
        tenantId: input.tenantId ?? null,
        ownerUserId: input.ownerUserId ?? null,
      },
    });
  } catch {
    // concurrent creation — read the winner
    return db.ledgerAccount.findUniqueOrThrow({ where: { code: input.code } });
  }
}

/** Same as ensureAccount but inside an open transaction. */
export async function ensureAccountTx(tx: Prisma.TransactionClient | PrismaClient, input: EnsureAccountInput) {
  const existing = await tx.ledgerAccount.findUnique({ where: { code: input.code } });
  if (existing) return existing;
  try {
    return await tx.ledgerAccount.create({
      data: {
        code: input.code,
        type: input.type,
        displayName: input.displayName,
        tenantId: input.tenantId ?? null,
        ownerUserId: input.ownerUserId ?? null,
      },
    });
  } catch {
    return tx.ledgerAccount.findUniqueOrThrow({ where: { code: input.code } });
  }
}

/** The wallet projection uses the account's natural balance. */
export function naturalBalance(type: string, debits: Santim, credits: Santim): Santim {
  return NATURAL_DEBIT.has(type as AccountType) ? debits - credits : credits - debits;
}

export type { Santim };
