/**
 * Maker-checker configuration pipeline (UC-07/08, FR-ADM-01..07, UC-13).
 *
 * Invariants enforced here, structurally:
 *   · self-approval is rejected (checker ≠ maker) — no bypass in DEMO or LIVE;
 *   · approval binds to the payload hash — a stale payload refuses approval;
 *   · publishing creates an immutable version; nothing ever mutates in place;
 *   · guardrails (GR-01 pattern validity, GR-02 margin floor, GR-PRT-02/03)
 *     run at authoring time with the named violation.
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { hashPayload } from "../../lib/crypto";
import { validatePattern, type PatternPayload } from "../game-core";
import { checkGuardrails, validateRulesetShape, type RulesetPayload } from "../prize";
import { activatePlan } from "../commission";
import { audit } from "../../lib/write-path";

export type DraftType = "PATTERN" | "ROOM_TEMPLATE" | "PRIZE_RULESET" | "COMMISSION_PLAN";

/** Guardrail constants (GR-02 margin floor 15%, GR-PRT-03 payout cap 85%). */
const GUARDRAILS = { marginFloorBps: 1500, payoutCapBps: 8500 };

export interface SubmitDraftInput {
  entityId?: string | null;
  type: DraftType;
  tenantId?: string | null;
  title: string;
  payload: unknown;
  makerId: string;
  makerRole: string;
}

/** Type-specific validation with the named violation (UC-07 failure flow). */
async function validatePayloadForType(type: DraftType, payload: unknown, tenantId: string | null): Promise<void> {
  switch (type) {
    case "PATTERN": {
      const p = payload as { variantId: string } & PatternPayload;
      const res = validatePattern(p.variantId, p);
      if (!res.valid) throw new ApiError("CONFIG_VALIDATION_FAILED", res.violation ?? "pattern invalid");
      return;
    }
    case "PRIZE_RULESET": {
      const shape = validateRulesetShape(payload as RulesetPayload);
      if (!shape.valid) throw new ApiError("CONFIG_VALIDATION_FAILED", shape.violation ?? "ruleset invalid");
      // Guardrail preview at authoring time (UC-07): use current live gross for
      // the tenant (0 → structural checks only).
      const purchaseCount = tenantId ? await db.journalTransaction.count({ where: { kind: "PURCHASE", tenantId } }) : 0;
      const grossPreview = tenantId ? (purchaseCount === 0 ? 0n : await liveGrossFor(tenantId)) : 0n;
      const guard = checkGuardrails((payload as RulesetPayload).rules, grossPreview, grossPreview, GUARDRAILS);
      if (!guard.ok) throw new ApiError("CONFIG_VALIDATION_FAILED", guard.violation ?? "guardrail breach");
      return;
    }
    case "ROOM_TEMPLATE": {
      const t = payload as {
        variantId: string;
        priceSantim: string;
        cadenceMinutes: number;
        salesOpenMinutes: number;
        salesMinutes: number;
        rulesetRef: string;
        patternRefs: string[];
        tenantScoped?: boolean;
      };
      if (!["BALL_75", "BALL_90"].includes(t.variantId)) {
        throw new ApiError("CONFIG_VALIDATION_FAILED", "VARIANT_NOT_ENABLED");
      }
      if (!t.priceSantim || BigInt(t.priceSantim) <= 0n) throw new ApiError("CONFIG_VALIDATION_FAILED", "BAD_PRICE");
      const ruleset = await db.configEntity.findUnique({ where: { id: t.rulesetRef } });
      if (!ruleset || ruleset.type !== "PRIZE_RULESET" || ruleset.currentVersion === 0) {
        throw new ApiError("CONFIG_VALIDATION_FAILED", "RULESET_NOT_PUBLISHED");
      }
      if ((ruleset.tenantId ?? null) !== (tenantId ?? null)) {
        throw new ApiError("CONFIG_VALIDATION_FAILED", "RULESET_TENANT_MISMATCH");
      }
      for (const ref of t.patternRefs) {
        const pat = await db.configEntity.findUnique({ where: { id: ref } });
        if (!pat || pat.type !== "PATTERN" || pat.currentVersion === 0) {
          throw new ApiError("CONFIG_VALIDATION_FAILED", "PATTERN_NOT_PUBLISHED");
        }
        if ((pat.tenantId ?? null) !== (tenantId ?? null)) {
          throw new ApiError("CONFIG_VALIDATION_FAILED", "PATTERN_TENANT_MISMATCH");
        }
      }
      return;
    }
    case "COMMISSION_PLAN":
      return; // validated at approval time by activatePlan (rate bounds + overlap)
    default:
      throw new ApiError("CONFIG_VALIDATION_FAILED", "UNKNOWN_TYPE");
  }
}

async function liveGrossFor(tenantId: string): Promise<bigint> {
  const txs = await db.journalTransaction.findMany({
    where: { kind: "PURCHASE", tenantId },
    select: { entries: true },
  });
  let sum = 0n;
  for (const t of txs) for (const e of t.entries) if (e.direction === "CREDIT") sum += e.amountSantim;
  return sum;
}

export async function submitDraft(input: SubmitDraftInput) {
  // Lock check: entity pinned by an active round refuses new pending drafts.
  if (input.entityId) {
    const entity = await db.configEntity.findUnique({ where: { id: input.entityId } });
    if (!entity) throw new ApiError("NOT_FOUND", "config entity");
    if (entity.locked) throw new ApiError("ENTITY_LOCKED", "entity pinned by an active round");
  }
  await validatePayloadForType(input.type, input.payload, input.tenantId ?? null);
  const payloadHash = hashPayload(input.payload);
  const draft = await db.configDraft.create({
    data: {
      entityId: input.entityId ?? null,
      type: input.type,
      tenantId: input.tenantId ?? null,
      title: input.title,
      payloadJson: JSON.stringify(input.payload),
      payloadHash,
      status: "PENDING",
      makerId: input.makerId,
      submittedAt: new Date(),
    },
  });
  await audit({
    actorId: input.makerId,
    actorRole: input.makerRole,
    tenantId: input.tenantId ?? null,
    action: "DRAFT_SUBMITTED",
    entityType: "ConfigDraft",
    entityId: draft.id,
    payloadHash,
    meta: { type: input.type, title: input.title },
  });
  return draft;
}

/**
 * Checker approval (UC-08). Binds to the payload hash; publishing creates the
 * immutable version. COMMISSION_PLAN drafts take the special activation path.
 */
export async function approveDraft(draftId: string, checkerId: string, checkerRole: string) {
  const draft = await db.configDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new ApiError("NOT_FOUND", "draft");
  if (draft.status !== "PENDING") throw new ApiError("VALIDATION_FAILED", `draft is ${draft.status}`);
  if (draft.makerId === checkerId) {
    // Structural rejection — there is no code path that allows self-approval.
    throw new ApiError("SELF_APPROVAL_REJECTED", "the checker must differ from the maker");
  }
  const currentHash = hashPayload(JSON.parse(draft.payloadJson));
  if (currentHash !== draft.payloadHash) {
    throw new ApiError("PAYLOAD_HASH_MISMATCH", "payload changed after submission");
  }

  const payload = JSON.parse(draft.payloadJson);
  let entityId = draft.entityId;

  await db.$transaction(async (tx) => {
    if (draft.type === "COMMISSION_PLAN") {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: draft.tenantId! } });
      if (tenant.status !== "APPROVED") throw new ApiError("TENANT_SUSPENDED", "commission plans require an APPROVED tenant");
      await activatePlan(
        {
          tenantId: draft.tenantId!,
          rateBps: (payload as { rateBps: number }).rateBps,
          effectiveFrom: new Date((payload as { effectiveFrom: string }).effectiveFrom),
        },
        checkerId,
        draft.id
      );
    } else {
      if (!entityId) {
        const entity = await tx.configEntity.create({
          data: { type: draft.type, tenantId: draft.tenantId, name: draft.title },
        });
        entityId = entity.id;
      }
      const entity = await tx.configEntity.findUniqueOrThrow({ where: { id: entityId } });
      const version = await tx.configVersion.create({
        data: {
          entityId,
          version: entity.currentVersion + 1,
          payloadJson: draft.payloadJson,
          payloadHash: draft.payloadHash,
          publishedById: checkerId,
          draftId: draft.id,
        },
      });
      await tx.configEntity.update({ where: { id: entityId }, data: { currentVersion: version.version } });
    }
    await tx.configDraft.update({
      where: { id: draft.id },
      data: { status: "PUBLISHED", checkerId, decidedAt: new Date() },
    });
  });

  await audit({
    actorId: checkerId,
    actorRole: checkerRole,
    tenantId: draft.tenantId,
    action: "DRAFT_PUBLISHED",
    entityType: draft.type,
    entityId: entityId ?? draft.id,
    payloadHash: draft.payloadHash,
    meta: { draftId: draft.id, makerId: draft.makerId, checkerId },
  });
  return { draftId: draft.id, entityId };
}

export async function rejectDraft(draftId: string, checkerId: string, checkerRole: string, reason: string) {
  const draft = await db.configDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new ApiError("NOT_FOUND", "draft");
  if (draft.status !== "PENDING") throw new ApiError("VALIDATION_FAILED", `draft is ${draft.status}`);
  if (draft.makerId === checkerId) throw new ApiError("SELF_APPROVAL_REJECTED");
  await db.configDraft.update({
    where: { id: draftId },
    data: { status: "REJECTED", checkerId, rejectReason: reason, decidedAt: new Date() },
  });
  await audit({
    actorId: checkerId,
    actorRole: checkerRole,
    tenantId: draft.tenantId,
    action: "DRAFT_REJECTED",
    entityType: "ConfigDraft",
    entityId: draftId,
    meta: { reason },
  });
  return { ok: true };
}

/** Entity lock/unlock driven by round lifecycle (engine pins active rooms). */
export async function setEntityLock(entityId: string, locked: boolean) {
  await db.configEntity.update({ where: { id: entityId }, data: { locked } });
}
