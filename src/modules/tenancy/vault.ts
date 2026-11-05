/**
 * Encrypted document vault (UC-11). Bytes are AES-256-GCM encrypted at rest;
 * rows keep type, version and the SHA-256 checksum of the PLAINTEXT (shown to
 * reviewers, bound into the document-set hash). Every access is audited.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { aesEncrypt, aesDecrypt, sha256Hex, secureHex } from "../../lib/crypto";
import { VAULT_ROOT } from "../../lib/env";
import { audit } from "../../lib/write-path";

export interface UploadDocumentInput {
  tenantId: string;
  type: string;
  fileName: string;
  mime: string;
  bytes: Buffer;
  uploadedById: string;
}

export const KYB_CHECKLIST = [
  { type: "TIN_CERTIFICATE", label: "TIN registration certificate", required: true },
  { type: "ARTICLES_OF_ASSOCIATION", label: "Articles of association", required: true },
  { type: "BUSINESS_LICENSE", label: "Valid business license", required: true },
  { type: "ID_BENEFICIAL_OWNER", label: "Government ID of each beneficial owner", required: true },
] as const;

export async function uploadDocument(input: UploadDocumentInput) {
  if (!input.bytes || input.bytes.length === 0) throw new ApiError("VALIDATION_FAILED", "empty file");
  if (input.bytes.length > 10 * 1024 * 1024) throw new ApiError("VALIDATION_FAILED", "file exceeds 10 MB vault limit");

  const tenant = await db.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new ApiError("NOT_FOUND", "tenant");
  if (tenant.status === "SUSPENDED") throw new ApiError("TENANT_SUSPENDED");

  const sha256 = sha256Hex(input.bytes);
  const version =
    (await db.kybDocument.count({ where: { tenantId: input.tenantId, type: input.type } })) + 1;
  const storagePath = path.join(input.tenantId, `${input.type}-v${version}-${secureHex(8)}.enc`);
  const abs = path.join(VAULT_ROOT, storagePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, aesEncrypt(input.bytes.toString("base64")));

  const doc = await db.kybDocument.create({
    data: {
      tenantId: input.tenantId,
      type: input.type,
      version,
      fileName: input.fileName,
      mime: input.mime,
      sizeBytes: input.bytes.length,
      sha256,
      storagePath,
      uploadedById: input.uploadedById,
    },
  });
  await audit({
    actorId: input.uploadedById,
    actorRole: "TENANT_OWNER",
    tenantId: input.tenantId,
    action: "KYB_DOCUMENT_UPLOADED",
    entityType: "KybDocument",
    entityId: doc.id,
    payloadHash: sha256,
    meta: { type: input.type, version },
  });
  return doc;
}

/** Compliance-officer read path — audited (UC-14 watermarked views note). */
export async function readDocument(documentId: string, officerId: string): Promise<{ bytes: Buffer; doc: Awaited<ReturnType<typeof db.kybDocument.findUniqueOrThrow>> }> {
  const doc = await db.kybDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new ApiError("NOT_FOUND", "document");
  const abs = path.join(VAULT_ROOT, doc.storagePath);
  let raw: Buffer;
  try {
    raw = await fs.readFile(abs);
  } catch {
    throw new ApiError("NOT_FOUND", "vault object");
  }
  const plain = Buffer.from(aesDecrypt(raw.toString("utf8")), "base64");
  // Integrity: checksum binds the row to the bytes (UC-11).
  if (sha256Hex(plain) !== doc.sha256) {
    await audit({ actorId: officerId, actorRole: "PLATFORM_COMPLIANCE", tenantId: doc.tenantId, action: "KYB_VAULT_INTEGRITY_FAIL", entityType: "KybDocument", entityId: doc.id });
    throw new ApiError("INTERNAL", "vault integrity check failed");
  }
  await audit({ actorId: officerId, actorRole: "PLATFORM_COMPLIANCE", tenantId: doc.tenantId, action: "KYB_DOCUMENT_VIEWED", entityType: "KybDocument", entityId: doc.id });
  return { bytes: plain, doc };
}

/** SHA-256 over the ordered checksums of the tenant's latest dossier. */
export async function documentSetHash(tenantId: string): Promise<string> {
  const docs = await db.kybDocument.findMany({
    where: { tenantId },
    orderBy: [{ type: "asc" }, { version: "asc" }],
  });
  // Latest version per type.
  const latest = new Map<string, string>();
  for (const d of docs) latest.set(d.type, d.sha256);
  const ordered = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sha256Hex(ordered.map(([t, h]) => `${t}:${h}`).join("|"));
}

/** Missing required items → INFO_REQUESTED detail (UC-11 failure flow). */
export async function checklistStatus(tenantId: string) {
  const docs = await db.kybDocument.findMany({ where: { tenantId } });
  const have = new Set(docs.map((d) => d.type));
  return KYB_CHECKLIST.map((item) => ({
    ...item,
    uploaded: have.has(item.type),
    versions: docs.filter((d) => d.type === item.type).length,
  }));
}
