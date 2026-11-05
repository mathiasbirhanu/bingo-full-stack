import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { issueStatement, decidePayout, settlePayout } from "@/modules/commission";

/**
 * Platform finance — statements & payouts (UC-15, FR-PRT-17..19).
 * GET  → payout queue + latest statements across tenants.
 * POST → issue-statement | decide-payout (maker-checker: approver ≠ requester)
 *        | settle-payout (DEMO clearing rail only).
 */

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue-statement"), tenantId: z.string().min(1) }),
  z.object({ action: z.literal("decide-payout"), payoutId: z.string().min(1), approve: z.boolean(), note: z.string().max(280).default("") }),
  z.object({ action: z.literal("settle-payout"), payoutId: z.string().min(1) }),
]);

export const GET = route(
  async () => {
    const [payouts, statements] = await Promise.all([
      db.payoutRequest.findMany({
        orderBy: { requestedAt: "desc" },
        take: 30,
        include: { tenant: { select: { code: true, legalName: true } } },
      }),
      db.statement.findMany({
        orderBy: { issuedAt: "desc" },
        take: 30,
        include: { tenant: { select: { code: true } } },
      }),
    ]);
    return jsonOk({
      payouts: payouts.map((p) => ({
        id: p.id,
        tenantCode: p.tenant.code,
        amountSantim: p.amountSantim.toString(),
        status: p.status,
        requestedAt: p.requestedAt.toISOString(),
        decidedById: p.decidedById,
        decisionNote: p.decisionNote,
      })),
      statements: statements.map((s) => ({
        id: s.id,
        tenantCode: s.tenant.code,
        periodMonth: s.periodMonth,
        turnoverSantim: s.turnoverSantim.toString(),
        commissionSantim: s.commissionSantim.toString(),
        payableSantim: s.payableSantim.toString(),
        status: s.status,
      })),
    });
  },
  { roles: [ROLE.PLATFORM_FINANCE, ROLE.ADMIN] }
);

export const POST = route(
  async ({ body, user }) => {
    const input = actionSchema.parse(body);
    switch (input.action) {
      case "issue-statement": {
        const { statement, alreadyIssued } = await issueStatement(input.tenantId);
        return jsonOk({ statementId: statement.id, periodMonth: statement.periodMonth, alreadyIssued });
      }
      case "decide-payout": {
        const updated = await decidePayout(input.payoutId, input.approve, input.note, user!.id);
        return jsonOk({ payoutId: updated.id, status: updated.status });
      }
      case "settle-payout": {
        const updated = await settlePayout(input.payoutId, user!.id, "DEMO");
        return jsonOk({ payoutId: updated.id, status: updated.status, journalTxId: updated.journalTxId });
      }
    }
  },
  { roles: [ROLE.PLATFORM_FINANCE, ROLE.ADMIN], schema: actionSchema }
);
