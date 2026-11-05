/**
 * Shared write-path helpers: transactional outbox emission (ADR-03) and
 * append-only audit records. Both only ever INSERT — there is no update or
 * delete path anywhere in the codebase for audit records.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "./db";

export type OutboxTx = Prisma.TransactionClient | PrismaClient;

/**
 * Emit an event inside the caller's transaction. The gateway relay and the
 * finance worker consume these rows at-least-once and ack by marking
 * publishedAt/consumer — the source table is never mutated otherwise.
 */
export async function emitOutbox(
  tx: OutboxTx,
  event: {
    type: string;
    aggregateId: string;
    payload: unknown;
    consumer?: string;
  }
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      type: event.type,
      aggregateId: event.aggregateId,
      payloadJson: JSON.stringify(event.payload),
      consumer: event.consumer ?? null,
      publishedAt: event.consumer ? new Date() : null, // pre-acked rows go straight to their consumer
    },
  });
}

/** Consume unpublished outbox rows for a named consumer (poll relay). */
export async function claimOutbox(consumer: string, limit = 50) {
  const rows = await db.outboxEvent.findMany({
    where: { publishedAt: null, OR: [{ consumer: null }, { consumer }] },
    orderBy: { id: "asc" },
    take: limit,
  });
  if (rows.length > 0) {
    await db.outboxEvent.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { publishedAt: new Date() },
    });
  }
  return rows.map((r) => ({
    id: r.id.toString(),
    type: r.type,
    aggregateId: r.aggregateId,
    payload: JSON.parse(r.payloadJson) as unknown,
  }));
}

/** Append an audit record (fire-and-forget outside money transactions). */
export async function audit(entry: {
  actorId?: string | null;
  actorRole?: string | null;
  tenantId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  payloadHash?: string | null;
  meta?: unknown;
}): Promise<void> {
  await db.auditRecord.create({
    data: {
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole ?? null,
      tenantId: entry.tenantId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payloadHash: entry.payloadHash ?? null,
      metaJson: entry.meta === undefined ? null : JSON.stringify(entry.meta),
    },
  });
}

/** Append an audit record inside an existing transaction. */
export async function auditTx(
  tx: OutboxTx,
  entry: {
    actorId?: string | null;
    actorRole?: string | null;
    tenantId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    payloadHash?: string | null;
    meta?: unknown;
  }
): Promise<void> {
  await tx.auditRecord.create({
    data: {
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole ?? null,
      tenantId: entry.tenantId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payloadHash: entry.payloadHash ?? null,
      metaJson: entry.meta === undefined ? null : JSON.stringify(entry.meta),
    },
  });
}
