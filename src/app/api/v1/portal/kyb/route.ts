import { z } from "zod";
import { jsonOk, route, requireTenantAccess } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { db } from "@/lib/db";
import { KYB_CHECKLIST, checklistStatus, uploadDocument } from "@/modules/tenancy";
import { audit } from "@/lib/write-path";

/**
 * Tenant portal — KYB dossier (UC-11, FR-PRT-01..03).
 * GET  → tenant lifecycle state + checklist status + document index.
 * POST → upload one checklist item (base64 demo transport, vault stores
 *        AES-256-GCM at rest) or submit the dossier for review.
 * Scoping: a tenant member only ever sees their own tenant; platform staff
 * may view any tenant they name (read path is audited in the vault module).
 */

const uploadSchema = z.object({
  action: z.literal("upload"),
  type: z.string().min(3).max(64),
  fileName: z.string().min(1).max(255),
  mime: z.string().min(3).max(128),
  dataBase64: z.string().min(4),
});

const submitSchema = z.object({ action: z.literal("submit-for-review") });

const bodySchema = z.discriminatedUnion("action", [uploadSchema, submitSchema]);

export const GET = route(
  async ({ req, user }) => {
    const tenantId = req.nextUrl.searchParams.get("tenantId") ?? user!.tenantId;
    if (!tenantId) throw new ApiError("FORBIDDEN", "no tenant scope");
    requireTenantAccess({ user }, tenantId);

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
    const [checklist, docs, reviews] = await Promise.all([
      checklistStatus(tenantId),
      db.kybDocument.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.kybReview.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 10 }),
    ]);

    return jsonOk({
      tenant: {
        id: tenant.id,
        code: tenant.code,
        legalName: tenant.legalName,
        status: tenant.status,
        statusReason: tenant.statusReason,
        documentSetHash: tenant.documentSetHash,
        approvedAt: tenant.approvedAt?.toISOString() ?? null,
      },
      checklist,
      documents: docs.map((d) => ({
        id: d.id, type: d.type, version: d.version, fileName: d.fileName,
        mime: d.mime, sizeBytes: d.sizeBytes, sha256: d.sha256,
        createdAt: d.createdAt.toISOString(),
      })),
      reviews: reviews.map((r) => ({
        id: r.id, decision: r.decision, note: r.note, createdAt: r.createdAt.toISOString(),
      })),
      checklistRef: KYB_CHECKLIST.map((c) => c.type),
    });
  },
  { roles: ["TENANT_OWNER", "TENANT_SUPERVISOR", "ADMIN", "PLATFORM_COMPLIANCE", "SUPPORT", "AUDITOR"] }
);

export const POST = route(
  async ({ req, body, user }) => {
    const input = bodySchema.parse(body);
    const tenantId = req.nextUrl.searchParams.get("tenantId") ?? user!.tenantId;
    if (!tenantId) throw new ApiError("FORBIDDEN", "no tenant scope");
    requireTenantAccess({ user }, tenantId);
    if (user!.role === "TENANT_SUPERVISOR" && input.action === "upload") {
      // Uploads are owner actions; supervisors check content, they don't file it.
      throw new ApiError("FORBIDDEN", "only TENANT_OWNER uploads dossier documents");
    }

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new ApiError("NOT_FOUND", "tenant");

    if (input.action === "upload") {
      const known = KYB_CHECKLIST.some((c) => c.type === input.type);
      if (!known) throw new ApiError("VALIDATION_FAILED", `unknown checklist type ${input.type}`);
      const bytes = Buffer.from(input.dataBase64, "base64");
      const doc = await uploadDocument({
        tenantId, type: input.type, fileName: input.fileName, mime: input.mime,
        bytes, uploadedById: user!.id,
      });
      return jsonOk({ documentId: doc.id, sha256: doc.sha256, version: doc.version });
    }

    // submit-for-review — only from REGISTERED / INFO_REQUESTED states.
    if (!["REGISTERED", "INFO_REQUESTED"].includes(tenant.status)) {
      throw new ApiError("VALIDATION_FAILED", `tenant is ${tenant.status}; dossier already under review or decided`);
    }
    const { submitForReview } = await import("@/modules/tenancy");
    await submitForReview(tenantId, user!.id);
    await audit({
      actorId: user!.id, actorRole: user!.role, tenantId,
      action: "KYB_DOSSIER_SUBMITTED", entityType: "Tenant", entityId: tenantId,
    });
    return jsonOk({ status: "UNDER_REVIEW" });
  },
  { roles: ["TENANT_OWNER", "TENANT_SUPERVISOR"] }
);
