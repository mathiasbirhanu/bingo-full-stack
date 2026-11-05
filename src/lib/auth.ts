/**
 * Session & tokens (UC-01). Access token: JWT, 10 minutes. Refresh token:
 * opaque 32-byte secret, stored SHA-256-hashed, rotating on every refresh
 * (14 days). Delivered as httpOnly cookies; role + tenant ride the JWT claims.
 */
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { sha256Hex, secureHex } from "./crypto";
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC, APP_SECRET, JWT_ISSUER, JWT_AUDIENCE } from "./env";
import { ApiError } from "./errors";

export type Role =
  | "PLAYER"
  | "ADMIN"
  | "SUPERVISOR"
  | "SUPPORT"
  | "AUDITOR"
  | "TENANT_OWNER"
  | "TENANT_SUPERVISOR"
  | "PLATFORM_COMPLIANCE"
  | "PLATFORM_FINANCE";

export interface SessionClaims {
  sub: string; // user id
  role: Role;
  tenantId: string | null;
  phoneIdx: string;
}

const JWT_KEY = new TextEncoder().encode(APP_SECRET);

export const ACCESS_COOKIE = "bg_at";
export const REFRESH_COOKIE = "bg_rt";

export async function issueAccessToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ role: claims.role, tenantId: claims.tenantId, phoneIdx: claims.phoneIdx })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
    .sign(JWT_KEY);
}

export async function verifyAccessToken(token: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, JWT_KEY, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    return {
      sub: payload.sub as string,
      role: payload.role as Role,
      tenantId: (payload.tenantId as string | null) ?? null,
      phoneIdx: payload.phoneIdx as string,
    };
  } catch {
    throw new ApiError("UNAUTHENTICATED", "Access token invalid or expired");
  }
}

/** Create a refresh token; returns (raw, hash). Only the hash is persisted. */
export function createRefreshToken(): { raw: string; hash: string } {
  const raw = secureHex(32);
  return { raw, hash: sha256Hex(raw) };
}

export function hashRefreshToken(raw: string): string {
  return sha256Hex(raw);
}

export async function writeSessionCookies(access: string, refresh: string): Promise<void> {
  const jar = await cookies();
  const base = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: false };
  jar.set(ACCESS_COOKIE, access, { ...base, maxAge: ACCESS_TOKEN_TTL_SEC });
  jar.set(REFRESH_COOKIE, refresh, { ...base, maxAge: REFRESH_TOKEN_TTL_SEC });
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/** Read the caller's session from cookies (server components + route handlers). */
export async function getSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  try {
    return await verifyAccessToken(token);
  } catch {
    return null;
  }
}
