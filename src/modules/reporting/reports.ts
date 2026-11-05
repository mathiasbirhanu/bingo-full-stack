/**
 * Reporting (UC-10, FR-ADM-08/09, FR-FIN-07).
 *
 * Round report: generated at completion from confirmed data — tickets,
 * players, gross, margin, net pool, per-pattern awards, residual, claim
 * outcomes with rejections, commitment + reveal values, DEMO label.
 * Reconciliation: every wallet projection must equal its journal sum; every
 * round's escrow must equal gross − prizes − refunds. Any variance is
 * Severity 1 with the named account.
 */
import { db } from "../../lib/db";
import { parseJson } from "../../lib/json";
import { dayKey } from "../../lib/json";
import { PLATFORM_TIMEZONE } from "../../lib/env";
import { recomputeBalance } from "../ledger/queries";
import { AccountCodes } from "../ledger/accounts";

export interface RoundReportPayload {
  roomId: string;
  title: string;
  variantId: string;
  tenantId: string | null;
  demo: true;
  status: string;
  confirmedTickets: number;
  players: number;
  grossSantim: string;
  prizesSantim: string;
  netPoolSantim: string;
  residualSantim: string;
  perPattern: Array<{ pattern: string; winners: number; awardedSantim: string }>;
  claims: { total: number; confirmed: number; rejected: number; rejectionsByReason: Record<string, number> };
  fairness: { commitment: string; revealedSeed?: string; salt?: string; clientSeedContribution?: string } | null;
  generatedAt: string;
}

export async function buildRoundReport(roomId: string): Promise<RoundReportPayload> {
  const room = await db.room.findUnique({
    where: { id: roomId },
    include: {
      tickets: true,
      claims: { include: { player: true } },
      seal: true,
      purchases: true,
    },
  });
  if (!room) throw new Error("ROOM_NOT_FOUND");

  const tickets = room.tickets;
  const players = new Set(tickets.map((t) => t.playerId)).size;

  const prizeTx = await db.journalTransaction.findMany({
    where: { roundId: roomId, kind: { in: ["PRIZE", "PRIZE_ADJUSTMENT"] } },
    include: { entries: true },
  });
  let prizes = 0n;
  for (const t of prizeTx) for (const e of t.entries) if (e.direction === "CREDIT") prizes += e.amountSantim;

  const residualTx = await db.journalTransaction.findFirst({
    where: { roundId: roomId, kind: "ROUND_RESIDUAL" },
    include: { entries: true },
  });
  let residual = 0n;
  if (residualTx) for (const e of residualTx.entries) if (e.direction === "CREDIT") residual += e.amountSantim;

  // Per-pattern award rollup from confirmed claims.
  const confirmedClaims = room.claims.filter((c) => c.status === "CONFIRMED");
  const byPattern = new Map<string, { winners: number; awarded: bigint }>();
  for (const c of confirmedClaims) {
    const pv = await db.configVersion.findUnique({ where: { id: c.patternVersionId }, include: { entity: true } });
    const label = pv?.entity.name ?? c.patternVersionId;
    const cur = byPattern.get(label) ?? { winners: 0, awarded: 0n };
    cur.winners += 1;
    cur.awarded += c.awardSantim ?? 0n;
    byPattern.set(label, cur);
  }

  const rejectionsByReason: Record<string, number> = {};
  for (const c of room.claims.filter((x) => x.status === "REJECTED")) {
    const k = c.reasonCode ?? "UNKNOWN";
    rejectionsByReason[k] = (rejectionsByReason[k] ?? 0) + 1;
  }

  const report: RoundReportPayload = {
    roomId,
    title: room.title,
    variantId: room.variantId,
    tenantId: room.tenantId,
    demo: true,
    status: room.status,
    confirmedTickets: room.purchases.filter((p) => p.status === "CONFIRMED").reduce((a, p) => a + p.quantity, 0),
    players,
    grossSantim: room.grossSantim.toString(),
    prizesSantim: prizes.toString(),
    netPoolSantim: room.netPoolSantim.toString(),
    residualSantim: residual.toString(),
    perPattern: [...byPattern.entries()].map(([pattern, v]) => ({ pattern, winners: v.winners, awardedSantim: v.awarded.toString() })),
    claims: {
      total: room.claims.length,
      confirmed: confirmedClaims.length,
      rejected: room.claims.length - confirmedClaims.length,
      rejectionsByReason,
    },
    fairness: room.seal
      ? {
          commitment: room.seal.commitment,
          revealedSeed: room.seal.revealedSeed ?? undefined,
          salt: room.seal.salt,
          clientSeedContribution: room.seal.clientSeedContribution,
        }
      : null,
    generatedAt: new Date().toISOString(),
  };
  return report;
}

/** Generate-or-refresh the stored round report (per completion). */
export async function persistRoundReport(roomId: string) {
  const payload = await buildRoundReport(roomId);
  const existing = await db.roundReport.findUnique({ where: { roomId } });
  if (existing) {
    await db.roundReport.update({ where: { roomId }, data: { payloadJson: JSON.stringify(payload) } });
  } else {
    await db.roundReport.create({ data: { roomId, payloadJson: JSON.stringify(payload) } });
  }
  return payload;
}

export interface ReconCheck {
  accountCode: string;
  projected: string;
  recomputed: string;
  ok: boolean;
}

export interface ReconReportPayload {
  day: string;
  demo: true;
  checkedAccounts: number;
  variances: ReconCheck[];
  escrowChecks: Array<{ roomId: string; escrow: string; expected: string; ok: boolean }>;
  severity1: boolean;
  generatedAt: string;
}

/**
 * Nightly (and on-demand) reconciliation. Severity 1 if ANY variance exists.
 */
export async function runReconciliation(): Promise<ReconReportPayload> {
  const day = dayKey(new Date(), PLATFORM_TIMEZONE);
  const accounts = await db.ledgerAccount.findMany();
  const variances: ReconCheck[] = [];
  for (const acc of accounts) {
    const proj = await db.walletBalance.findUnique({ where: { accountId: acc.id } });
    const projected = proj?.balanceSantim ?? 0n;
    const recomputed = await recomputeBalance(acc.id);
    if (projected !== recomputed) {
      variances.push({ accountCode: acc.code, projected: projected.toString(), recomputed: recomputed.toString(), ok: false });
    }
  }

  // Escrow checks: ROUND_ESCROW balance should equal gross − prizes − refunds.
  const rooms = await db.room.findMany({ where: { status: { in: ["LOCKED", "DRAWING", "RESOLVING", "COMPLETED"] } } });
  const escrowChecks: ReconReportPayload["escrowChecks"] = [];
  for (const room of rooms) {
    const escrow = await recomputeBalance((await db.ledgerAccount.findUniqueOrThrow({ where: { code: AccountCodes.roundEscrow(room.id) } })).id);
    const prizeTx = await db.journalTransaction.findMany({ where: { roundId: room.id, kind: { in: ["PRIZE", "PRIZE_ADJUSTMENT"] } }, select: { entries: true } });
    let prizes = 0n;
    for (const t of prizeTx) for (const e of t.entries) if (e.direction === "CREDIT") prizes += e.amountSantim;
    // Refunds reverse escrow via journal; the recomputed balance already
    // reflects them — nothing to subtract again here.
    const refunded = 0n;
    const expected = room.grossSantim - prizes - (room.status === "VOIDED" ? room.grossSantim : refunded);
    escrowChecks.push({ roomId: room.id, escrow: escrow.toString(), expected: expected.toString(), ok: escrow === expected });
  }

  const severity1 = variances.length > 0 || escrowChecks.some((c) => !c.ok);
  const payload: ReconReportPayload = {
    day,
    demo: true,
    checkedAccounts: accounts.length,
    variances,
    escrowChecks,
    severity1,
    generatedAt: new Date().toISOString(),
  };
  await db.reconReport.create({ data: { day, payloadJson: JSON.stringify(payload), varianceCount: variances.length + escrowChecks.filter((c) => !c.ok).length, status: severity1 ? "VARIANCE" : "OK" } });
  return payload;
}
