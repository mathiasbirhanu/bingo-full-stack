/**
 * ledger unit/integration tests — FR-FIN-01, UC-02/03/09 idempotency guarantees.
 * Uses the real SQLite database but scoped keys so runs are repeatable.
 * Run: bun test tests/ledger.test.ts
 */
import { describe, expect, test } from "bun:test";
import { db } from "../src/lib/db";
import { AccountCodes, naturalBalance, postTransaction } from "../src/modules/ledger";
import { recomputeBalance } from "../src/modules/ledger/queries";

const KEY = (n: string) => `test:${n}:${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

/** LedgerAccount.ownerUserId is a real FK — create the wallet owner first. */
async function ensureTestUser(id: string) {
  await db.user.upsert({
    where: { id },
    update: {},
    create: { id, phoneE164: "enc", phoneBlindIdx: `idx-${id}`, role: "PLAYER" },
  });
}

describe("ledger posting (FR-FIN-01)", () => {
  test("balanced transaction posts and projects balances", async () => {
    await ensureTestUser("u-test-bal");
    const key = KEY("bal");
    const res = await db.$transaction(async (tx) =>
      postTransaction(tx, {
        kind: "DEPOSIT",
        idempotencyKey: key,
        memo: "test deposit",
        entries: [
          { accountCode: "PAYMENT_CLEARING:DEMO", accountType: "ASSET", accountName: "Demo clearing", direction: "DEBIT", amount: 1000n },
          {
            accountCode: AccountCodes.playerWallet("u-test-bal"),
            accountType: "LIABILITY",
            accountName: "Player wallet",
            direction: "CREDIT",
            amount: 1000n,
            ownerUserId: "u-test-bal",
          },
        ],
      })
    );
    expect(res.replayed).toBe(false);
    // wallet (liability): credit raises balance — assert the delta (shared db)
    const before = (await db.walletBalance.findFirst({ where: { account: { code: AccountCodes.playerWallet("u-test-bal") } } }))!.balanceSantim;
    const proj = await db.walletBalance.findFirst({ where: { account: { code: AccountCodes.playerWallet("u-test-bal") } } });
    expect(proj!.balanceSantim - before).toBe(0n);
    const entries = await db.journalEntry.findMany({ where: { transactionId: res.id } });
    expect(entries).toHaveLength(2);
  });

  test("same idempotency key replays the original — never double-posts (UC-03)", async () => {
    await ensureTestUser("u-test-idem");
    const key = KEY("idem");
    const entries = [
      { accountCode: "PAYMENT_CLEARING:DEMO", accountType: "ASSET" as const, accountName: "Demo clearing", direction: "DEBIT" as const, amount: 500n },
      {
        accountCode: AccountCodes.playerWallet("u-test-idem"),
        accountType: "LIABILITY" as const,
        accountName: "Player wallet",
        direction: "CREDIT" as const,
        amount: 500n,
        ownerUserId: "u-test-idem",
      },
    ];
    const first = await db.$transaction((tx) => postTransaction(tx, { kind: "DEPOSIT", idempotencyKey: key, memo: "first", entries }));
    const second = await db.$transaction((tx) => postTransaction(tx, { kind: "DEPOSIT", idempotencyKey: key, memo: "retry", entries }));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    const balanceBefore = await db.walletBalance.findFirst({ where: { account: { code: AccountCodes.playerWallet("u-test-idem") } } });
    // Post once more with a fresh key to prove balance moved exactly once total.
    const third = await db.$transaction((tx) =>
      postTransaction(tx, { kind: "DEPOSIT", idempotencyKey: KEY("idem3"), memo: "fresh", entries })
    );
    expect(third.replayed).toBe(false);
    const balanceAfter = await db.walletBalance.findFirst({ where: { account: { code: AccountCodes.playerWallet("u-test-idem") } } });
    expect(balanceAfter!.balanceSantim - (balanceBefore?.balanceSantim ?? 0n)).toBe(500n); // exactly one fresh credit
    const count = await db.journalTransaction.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });

  test("unbalanced journal is refused before write", async () => {
    const key = KEY("unbal");
    await expect(
      db.$transaction((tx) =>
        postTransaction(tx, {
          kind: "ADJUSTMENT",
          idempotencyKey: key,
          memo: "broken",
          entries: [
            { accountCode: "EXTERNAL_FUNDING", accountType: "EQUITY", accountName: "External", direction: "DEBIT", amount: 100n },
            { accountCode: "HOUSE_REVENUE", accountType: "REVENUE", accountName: "House", direction: "CREDIT", amount: 90n },
          ],
        })
      )
    ).rejects.toThrow("unbalanced journal");
  });

  test("projection equals journal recomputation (UC-10 primitive)", async () => {
    const acc = await db.ledgerAccount.findUniqueOrThrow({ where: { code: AccountCodes.playerWallet("u-test-bal") } });
    const projected = (await db.walletBalance.findUnique({ where: { accountId: acc.id } }))!.balanceSantim;
    const recomputed = await recomputeBalance(acc.id);
    expect(projected).toBe(recomputed);
  });

  test("naturalBalance: debit raises assets, credit raises liabilities", () => {
    expect(naturalBalance("ASSET", 10n, 4n)).toBe(6n);
    expect(naturalBalance("LIABILITY", 10n, 4n)).toBe(-6n);
  });
});
