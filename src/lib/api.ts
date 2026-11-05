/**
 * Route-handler plumbing: guards, error mapping, JSON envelopes.
 * Every /api route goes through `route()` so auth, role, tenant scoping and
 * error codes behave identically everywhere (FR-SEC, FR-PRT scope rules).
 */
import { NextRequest, NextResponse } from "next/server";
import { ZodSchema } from "zod";
import { ApiError, ErrorCode } from "./errors";
import { getSession, SessionClaims, Role } from "./auth";
import { db } from "./db";

export interface Ctx {
  req: NextRequest;
  params: Record<string, string>;
  body: unknown;
  /** Exact request bytes (POST/PUT/PATCH). PSP callback signatures verify
   * over RAW bytes — re-serialized JSON is the classic forgery bug. */
  rawBody?: string;
  /** Parsed query string (?rail=TELEBIRR on the callback route). */
  query: URLSearchParams;
  /** Request headers (PSP callback signature headers). */
  headers: Headers;
  session: SessionClaims | null;
  /** Loaded user row (fresh role/status — never trust an old JWT alone). */
  user: {
    id: string;
    role: Role;
    tenantId: string | null;
    status: string;
  } | null;
}

interface RouteOptions {
  /** Required roles; empty = PLAYER-equivalent authenticated access. */
  roles?: Role[];
  /** Allow unauthenticated callers. */
  anon?: boolean;
  schema?: ZodSchema;
}

/**
 * BigInt-safe JSON envelope. The money convention (lib/money) is "bigint
 * serializes to string across the API" — enforced HERE so no route can ever
 * crash on serialization again (santim values flow through as strings).
 */
function bigintSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = bigintSafe(v);
    return out;
  }
  return value;
}

export function jsonOk(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data: bigintSafe(data) }, init);
}

export function jsonError(code: ErrorCode, message?: string, detail?: unknown): NextResponse {
  const e = new ApiError(code, message, detail);
  return NextResponse.json({ ok: false, error: { code: e.code, message: e.message, detail: e.detail } }, { status: e.status });
}

async function refreshAccessTokenIfNeeded(): Promise<SessionClaims | null> {
  // Access tokens are short (10 min). Middleware-free refresh: on 401 the
  // client calls /api/v1/auth/refresh. Server components simply see null.
  return null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function route(handler: (ctx: Ctx) => Promise<NextResponse>, options: RouteOptions = {}) {
  return async (req: NextRequest, routeParams?: { params: Promise<Record<string, string>> }): Promise<NextResponse> => {
    try {
      const params = routeParams?.params ? await routeParams.params : {};
      let session = await getSession();
      let user: Ctx["user"] = null;

      if (session) {
        const u = await db.user.findUnique({ where: { id: session.sub } });
        if (!u || u.status !== "ACTIVE") {
          session = null;
        } else {
          user = { id: u.id, role: u.role as Role, tenantId: u.tenantId, status: u.status };
          // Fresh role wins over stale JWT (e.g. role elevated after issue).
          if (user.role !== session.role || (user.tenantId ?? null) !== (session.tenantId ?? null)) {
            session = { ...session, role: user.role, tenantId: user.tenantId };
          }
        }
      }

      if (!options.anon && !session) {
        const refreshed = await refreshAccessTokenIfNeeded();
        if (!refreshed) return jsonError("UNAUTHENTICATED");
      }

      if (options.roles && options.roles.length > 0) {
        if (!user) return jsonError("UNAUTHENTICATED");
        if (!options.roles.includes(user.role)) return jsonError("FORBIDDEN", `requires ${options.roles.join("|")}`);
      }

      let body: unknown = undefined;
      let rawBody: string | undefined;
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        // Single read: raw bytes first, JSON parsed FROM them. Double-calling
        // req.json()/req.text() throws — and raw order matters for signatures.
        rawBody = await req.text();
        if (options.schema) {
          body = options.schema.parse(JSON.parse(rawBody));
        } else {
          body = rawBody ? safeJsonParse(rawBody) : undefined;
        }
      }

      return await handler({ req, params, body, rawBody, query: req.nextUrl.searchParams, headers: req.headers, session, user });
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json(
          { ok: false, error: { code: err.code, message: err.message, detail: err.detail } },
          { status: err.status }
        );
      }
      if (err && typeof err === "object" && "issues" in err) {
        return jsonError("VALIDATION_FAILED", "Request body failed validation", (err as { issues: unknown }).issues);
      }
      console.error("[api] unhandled", err);
      return jsonError("INTERNAL", err instanceof Error ? err.message : undefined);
    }
  };
}

/** Assert the caller may act for a tenant (portal endpoints). */
export function requireTenantAccess(caller: { user: Ctx["user"] }, tenantId: string): void {
  const user = caller.user;
  if (!user) throw new ApiError("UNAUTHENTICATED");
  const platformStaff = ["ADMIN", "PLATFORM_COMPLIANCE", "PLATFORM_FINANCE", "SUPERVISOR", "SUPPORT", "AUDITOR"];
  if (platformStaff.includes(user.role)) return;
  if ((user.role === "TENANT_OWNER" || user.role === "TENANT_SUPERVISOR") && user.tenantId === tenantId) return;
  throw new ApiError("FORBIDDEN", "not a member of this tenant");
}

export const ROLE = {
  ADMIN: "ADMIN",
  SUPERVISOR: "SUPERVISOR",
  SUPPORT: "SUPPORT",
  AUDITOR: "AUDITOR",
  TENANT_OWNER: "TENANT_OWNER",
  TENANT_SUPERVISOR: "TENANT_SUPERVISOR",
  PLATFORM_COMPLIANCE: "PLATFORM_COMPLIANCE",
  PLATFORM_FINANCE: "PLATFORM_FINANCE",
} as const;

/** Read client IP for rate limiting (best effort behind the gateway). */
export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
