/**
 * Player authentication (UC-01, FR-PLY-01, FR-SEC-01/03).
 *
 * Phone + OTP over the SMS port (demo adapter: the code is returned in the
 * response and shown in the DEMO banner — no real SMS is sent). Normalization
 * to +251 E.164 happens BEFORE any send. Rate limit: 5 requests / minute.
 * Access JWT 10 min; refresh token rotating, stored hashed, 14 days.
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import {
  normalizeEthiopianPhone,
  phoneBlindIndex,
  encryptPhone,
  decryptPhone,
  sha256Hex,
  secureHex,
} from "../../lib/crypto";
import { OTP_TTL_SEC, OTP_RATE_LIMIT, REFRESH_TOKEN_TTL_SEC } from "../../lib/env";
import { createRefreshToken, issueAccessToken, writeSessionCookies, verifyAccessToken, hashRefreshToken, clearSessionCookies, type SessionClaims } from "../../lib/auth";
import { audit } from "../../lib/write-path";

/** In-memory OTP rate limiting (production: Redis-backed, AP-04 allows). */
const otpAttempts = new Map<string, number[]>();

function rateLimit(phoneIdx: string): void {
  const now = Date.now();
  const hits = (otpAttempts.get(phoneIdx) ?? []).filter((t) => now - t < OTP_RATE_LIMIT.windowMs);
  if (hits.length >= OTP_RATE_LIMIT.max) throw new ApiError("RATE_LIMITED", "5 OTP requests per minute maximum");
  hits.push(now);
  otpAttempts.set(phoneIdx, hits);
}

/** Issue an OTP for a normalized phone number (UC-01 main flow). */
export async function requestOtp(rawPhone: string): Promise<{ sent: true; demoCode?: string; phone: string }> {
  const phone = normalizeEthiopianPhone(rawPhone);
  if (!phone) throw new ApiError("INVALID_PHONE", "unknown-format number rejected before any SMS is sent");
  const idx = phoneBlindIndex(phone);
  rateLimit(idx);

  const code = secureHex(3); // 6 hex chars → 16^6 space, 5-minute validity
  await db.otpCode.create({
    data: { phoneIdx: idx, codeHash: sha256Hex(`${code}:${idx}`), expiresAt: new Date(Date.now() + OTP_TTL_SEC * 1000) },
  });
  // SMS port adapter (demo): log + return the code in the DEMO envelope.
  console.log(`[sms-demo] OTP for ${phone}: ${code} (valid ${OTP_TTL_SEC}s)`);
  return { sent: true, demoCode: code, phone };
}

export interface LoginResult {
  user: { id: string; role: string; tenantId: string | null; maskedPhone: string };
}

/** Verify the OTP and open a session; creates the account on first login. */
export async function verifyOtpAndLogin(rawPhone: string, code: string, userAgent?: string): Promise<LoginResult> {
  const phone = normalizeEthiopianPhone(rawPhone);
  if (!phone || !code) throw new ApiError("INVALID_OR_EXPIRED_OTP");
  const idx = phoneBlindIndex(phone);
  // Canonical compare: codes are lowercase hex at issue time; the client may
  // render them uppercased — accept any case, trim whitespace.
  const canonical = code.trim().toLowerCase();

  const otp = await db.otpCode.findFirst({
    where: { phoneIdx: idx, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp || otp.codeHash !== sha256Hex(`${canonical}:${idx}`)) {
    if (otp) await db.otpCode.update({ where: { id: otp.id }, data: { attempts: otp.attempts + 1 } });
    throw new ApiError("INVALID_OR_EXPIRED_OTP");
  }
  await db.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  // Blocked flags stop login with a reason code (UC-01 failure flow).
  let user = await db.user.findUnique({ where: { phoneBlindIdx: idx } });
  if (user && user.status !== "ACTIVE") {
    throw new ApiError("BLOCKED", user.statusReason ?? "account blocked");
  }
  if (!user) {
    user = await db.user.create({
      data: { phoneE164: encryptPhone(phone), phoneBlindIdx: idx, role: "PLAYER" },
    });
  }
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  // Session: access JWT + rotating hashed refresh.
  const refresh = createRefreshToken();
  await db.session.create({
    data: {
      userId: user.id,
      refreshHash: refresh.hash,
      userAgent: userAgent ?? null,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    },
  });
  const claims: SessionClaims = {
    sub: user.id,
    role: user.role as SessionClaims["role"],
    tenantId: user.tenantId,
    phoneIdx: idx,
  };
  const access = await issueAccessToken(claims);
  await writeSessionCookies(access, refresh.raw);
  await audit({ actorId: user.id, actorRole: user.role, action: "OTP_LOGIN", entityType: "User", entityId: user.id });

  const masked = `+251••••${phone.slice(-3)}`;
  return { user: { id: user.id, role: user.role, tenantId: user.tenantId, maskedPhone: masked } };
}

/** Refresh rotation: old token dies, a new pair is issued. */
export async function rotateRefresh(rawRefresh: string): Promise<LoginResult> {
  const hash = hashRefreshToken(rawRefresh);
  const session = await db.session.findUnique({ where: { refreshHash: hash }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new ApiError("UNAUTHENTICATED", "refresh token invalid or expired");
  }
  await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  const refresh = createRefreshToken();
  await db.session.create({
    data: {
      userId: session.userId,
      refreshHash: refresh.hash,
      userAgent: session.userAgent,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    },
  });
  const claims: SessionClaims = {
    sub: session.user.id,
    role: session.user.role as SessionClaims["role"],
    tenantId: session.user.tenantId,
    phoneIdx: session.user.phoneBlindIdx,
  };
  await writeSessionCookies(await issueAccessToken(claims), refresh.raw);
  return {
    user: {
      id: session.user.id,
      role: session.user.role,
      tenantId: session.user.tenantId,
      maskedPhone: "",
    },
  };
}

export async function logout(): Promise<void> {
  const jarToken = (await import("next/headers")).cookies;
  const jar = await jarToken();
  const raw = jar.get("bg_rt")?.value;
  if (raw) {
    const hash = hashRefreshToken(raw);
    await db.session.updateMany({ where: { refreshHash: hash }, data: { revokedAt: new Date() } });
  }
  await clearSessionCookies();
}

/** Who am I — re-verified against the live user row each call. */
export async function me(): Promise<LoginResult["user"] | null> {
  const { getSession } = await import("../../lib/auth");
  const session = await getSession();
  if (!session) return null;
  const user = await db.user.findUnique({ where: { id: session.sub } });
  if (!user || user.status !== "ACTIVE") return null;
  // Masking needs the PLAINTEXT number — the stored column is an AES envelope,
  // so decrypt first, then mask (slicing ciphertext would leak nothing useful).
  let masked = "+251•••••••";
  try {
    const e164 = decryptPhone(user.phoneE164);
    masked = `${e164.slice(0, 4)}••••${e164.slice(-3)}`;
  } catch {
    /* keep the fully-masked fallback */
  }
  return { id: user.id, role: user.role, tenantId: user.tenantId, maskedPhone: masked };
}
