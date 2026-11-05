"use client";

/**
 * Client API layer — thin, retry-tolerant, envelope-aware.
 *
 * Low-connectivity posture: every mutation may be retried safely because the
 * whole API is idempotent by design (idempotency keys on purchase/deposit,
 * GET catch-ups by sequence). Transient network failures retry with a short
 * backoff; domain errors (ApiError codes) surface verbatim — the honest
 * error UX the SRS demands.
 */

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; detail?: unknown };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce<T>(path: string, init: RequestInit, timeoutMs: number): Promise<Envelope<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...init,
      credentials: "include",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return (await res.json()) as Envelope<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  opts: { retries?: number; timeoutMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const env = await fetchOnce<T>(path, init, timeoutMs);
      if (env.ok && env.data !== undefined) return env.data;
      // Domain error — do NOT retry; render the code (honest UX).
      throw new ApiClientError(env.error?.code ?? "INTERNAL", env.error?.message ?? "Request failed", 400);
    } catch (err) {
      if (err instanceof ApiClientError) {
        // Access tokens live 10 minutes: one silent refresh + one replay on
        // UNAUTHENTICATED, never inside the auth route itself.
        if (err.code === "UNAUTHENTICATED" && !path.startsWith("/api/v1/auth")) {
          const refreshed = await fetchOnce("/api/v1/auth", { method: "POST", body: JSON.stringify({ action: "refresh" }) }, timeoutMs);
          if (refreshed.ok) {
            const retryEnv = await fetchOnce<T>(path, init, timeoutMs);
            if (retryEnv.ok && retryEnv.data !== undefined) return retryEnv.data;
          }
        }
        throw err;
      }
      lastErr = err; // network/timeout — retryable
      if (attempt < retries) await sleep(600 * (attempt + 1)); // 600ms, 1.2s
    }
  }
  throw new ApiClientError("NETWORK", "Network unstable — check your connection", 0);
}

export const apiGet = <T>(path: string, opts?: { retries?: number; timeoutMs?: number }) =>
  api<T>(path, { method: "GET" }, opts);

export const apiPost = <T>(path: string, body: unknown, opts?: { retries?: number; timeoutMs?: number }) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) }, opts);

export const apiPut = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });

export const apiPatch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

/** Human helper: ETB display (client mirror of lib/money formatting). */
export function etb(santim: string | number): string {
  const n = typeof santim === "number" ? santim : Number(santim);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}
