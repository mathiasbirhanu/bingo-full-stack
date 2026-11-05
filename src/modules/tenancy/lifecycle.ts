/**
 * Tenant lifecycle (UC-11/14, FR-PRT-01..06, FR-PRT-14..16).
 *
 * REGISTERED → UNDER_REVIEW → (INFO_REQUESTED →)* UNDER_REVIEW → APPROVED | REJECTED
 * APPROVED ⇄ SUSPENDED (mandatory reason code; in-flight rounds complete under
 * their locked rules — the engine completes them, scheduling stops).
 *
 * Maker-checker on approval: the approving officer must differ from the last
 * reviewing officer — enforced structurally (FR-PRT-04).
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { documentSetHash, checklistStatus } from "./vault";
import { audit } from "../../lib/write-path";

export interface RegisterTenantInput {
  code: string;
  legalName: string;
  tin: string;
  jurisdiction: string;
  contactEmail: string;
  contactPhone: string;
  beneficialOwners: Array<{ name: string; idType: string; idRef: string; sharePct: number }>;
  ownerUserId: string;
}

export async function registerTenant(input: RegisterTenantInput) {
  if (!/^[A-Z0-9_]{3,12}$/.test(input.code)) throw new ApiError("VALIDATION_FAILED", "tenant code must be 3-12 A-Z/0-9/_");
  const exists = await db.tenant.findUnique({ where: { code: input.code } });
  if (exists) throw new ApiError("VALIDATION_FAILED", "tenant code already registered");
  const tenant = await db.tenant.create({
    data: {
      code: input.code,
      legalName: input.legalName,
      tin: input.tin,
      jurisdiction: input.jurisdiction,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      beneficialOwners: JSON.stringify(input.beneficialOwners),
      status: "REGISTERED",
    },
  });
  // Bind the applicant as the tenant owner.
  await db.user.update({ where: { id: input.ownerUserId }, data: { role: "TENANT_OWNER", tenantId: tenant.id } });
  await audit({ actorId: input.ownerUserId, actorRole: "TENANT_OWNER", tenantId: tenant.id, action: "TENANT_REGISTERED", entityType: "Tenant", entityId: tenant.id });
  return tenant;
}

/** Submission moves the tenant to UNDER_REVIEW after a checklist sanity check. */
export async function submitForReview(tenantId: string, actorId: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
  if (!["REGISTERED", "INFO_REQUESTED", "REJECTED"].includes(tenant.status)) {
    throw new ApiError("VALIDATION_FAILED", `cannot submit from ${tenant.status}`);
  }
  const checklist = await checklistStatus(tenantId);
  const missing = checklist.filter((c) => c.required && !c.uploaded).map((c) => c.type);
  if (missing.length > 0) {
    throw new ApiError("KYB_INCOMPLETE", `missing: ${missing.join(", ")}`);
  }
  const updated = await db.tenant.update({ where: { id: tenantId }, data: { status: "UNDER_REVIEW" } });
  await audit({ actorId, actorRole: "TENANT_OWNER", tenantId, action: "KYB_SUBMITTED", entityType: "Tenant", entityId: tenantId });
  return updated;
}

/** Officer review step — INFO_REQUESTED or REJECTED (append-only review rows). */
export async function reviewTenant(tenantId: string, officerId: string, decision: "INFO_REQUESTED" | "REJECTED", note: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
  if (tenant.status !== "UNDER_REVIEW") throw new ApiError("VALIDATION_FAILED", `tenant is ${tenant.status}`);
  await db.kybReview.create({ data: { tenantId, officerId, decision, note } });
  const updated = await db.tenant.update({
    where: { id: tenantId },
    data: { status: decision },
  });
  await audit({ actorId: officerId, actorRole: "PLATFORM_COMPLIANCE", tenantId, action: `KYB_${decision}`, entityType: "Tenant", entityId: tenantId, meta: { note } });
  return updated;
}

/**
 * Second-officer approval (UC-11): binds to the document-set hash; refused if
 * the same officer performed the most recent review (SELF_APPROVAL_REJECTED).
 */
export async function approveTenant(tenantId: string, officerId: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
  if (tenant.status !== "UNDER_REVIEW") throw new ApiError("VALIDATION_FAILED", `tenant is ${tenant.status}`);
  const lastReview = await db.kybReview.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" } });
  if (lastReview && lastReview.officerId === officerId) {
    throw new ApiError("SELF_APPROVAL_REJECTED", "the approver must be a second officer");
  }
  const docSetHash = await documentSetHash(tenantId);
  await db.kybReview.create({
    data: { tenantId, officerId, decision: "APPROVED", note: "Dossier complete", documentSetHash: docSetHash },
  });
  const updated = await db.tenant.update({
    where: { id: tenantId },
    data: { status: "APPROVED", documentSetHash: docSetHash, approvedAt: new Date(), statusReason: null },
  });
  await audit({
    actorId: officerId,
    actorRole: "PLATFORM_COMPLIANCE",
    tenantId,
    action: "KYB_APPROVED",
    entityType: "Tenant",
    entityId: tenantId,
    payloadHash: docSetHash,
  });
  return updated;
}

/** Suspension switch (UC-14): reason code mandatory; restoration audited. */
export async function setTenantSuspension(tenantId: string, suspend: boolean, reasonCode: string, officerId: string) {
  if (!reasonCode) throw new ApiError("VALIDATION_FAILED", "reason code is mandatory for both directions");
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
  if (suspend && tenant.status !== "APPROVED") throw new ApiError("VALIDATION_FAILED", `cannot suspend from ${tenant.status}`);
  if (!suspend && tenant.status !== "SUSPENDED") throw new ApiError("VALIDATION_FAILED", `cannot restore from ${tenant.status}`);
  const updated = await db.tenant.update({
    where: { id: tenantId },
    data: suspend
      ? { status: "SUSPENDED", suspendedAt: new Date(), statusReason: reasonCode }
      : { status: "APPROVED", statusReason: null },
  });
  await audit({
    actorId: officerId,
    actorRole: "PLATFORM_COMPLIANCE",
    tenantId,
    action: suspend ? "TENANT_SUSPENDED" : "TENANT_RESTORED",
    entityType: "Tenant",
    entityId: tenantId,
    meta: { reasonCode },
  });
  return updated;
}

/** Privilege gate used by scheduling + publication paths (UC-11 postcondition). */
export async function assertTenantOperational(tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
  if (tenant.status !== "APPROVED") throw new ApiError("TENANT_SUSPENDED", `tenant is ${tenant.status}`);
}
