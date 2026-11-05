/**
 * Domain error codes — the exact reason codes named by the SRS. API routes and
 * the game gateway throw ApiError; the transport layer maps them to responses.
 * The client renders these codes verbatim (honest error UX, FR-PLY-03/04).
 */
export type ErrorCode =
  // auth (UC-01)
  | "RATE_LIMITED"
  | "INVALID_PHONE"
  | "INVALID_OR_EXPIRED_OTP"
  | "BLOCKED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  // payments (UC-02)
  | "IDEMPOTENCY_CONFLICT"
  | "PAYMENT_MODE_GUARD"
  | "DEMO_PAYOUT_BLOCKED"
  // PSP rails (UC-02, telebirr adapter)
  | "PSP_UNAVAILABLE"
  | "PSP_REJECTED"
  | "PAYMENT_CALLBACK_INVALID"
  | "AMOUNT_MISMATCH"
  | "UNKNOWN_DEPOSIT_REF"
  | "DEPOSIT_FAILED"
  // purchase (UC-03)
  | "MAX_CARDS_REACHED"
  | "INSUFFICIENT_FUNDS"
  | "SALES_CLOSED"
  | "QUEUED"
  | "ROOM_NOT_FOUND"
  // claims (UC-04)
  | "BALL_NOT_CALLED"
  | "PATTERN_ALREADY_CONFIRMED"
  | "NOT_COMPLETE"
  | "INVALID_CLAIM"
  // config (UC-07/08)
  | "CONFIG_VALIDATION_FAILED"
  | "SELF_APPROVAL_REJECTED"
  | "PAYLOAD_HASH_MISMATCH"
  | "ENTITY_LOCKED"
  // tenancy (UC-11/14)
  | "TENANT_SUSPENDED"
  | "INFO_REQUESTED"
  | "KYB_INCOMPLETE"
  // commission (UC-12/15)
  | "COMMISSION_RATE_OUT_OF_BOUNDS"
  | "COMMISSION_PLAN_CONFLICT"
  | "STATEMENT_NOT_CONFIRMED"
  | "DISPUTE_WINDOW_CLOSED"
  // misc
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  RATE_LIMITED: 429,
  INVALID_PHONE: 400,
  INVALID_OR_EXPIRED_OTP: 401,
  BLOCKED: 403,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  PAYMENT_MODE_GUARD: 403,
  DEMO_PAYOUT_BLOCKED: 403,
  PSP_UNAVAILABLE: 502,
  PSP_REJECTED: 502,
  PAYMENT_CALLBACK_INVALID: 400,
  AMOUNT_MISMATCH: 409,
  UNKNOWN_DEPOSIT_REF: 404,
  DEPOSIT_FAILED: 409,
  MAX_CARDS_REACHED: 409,
  INSUFFICIENT_FUNDS: 402,
  SALES_CLOSED: 409,
  QUEUED: 202,
  ROOM_NOT_FOUND: 404,
  BALL_NOT_CALLED: 409,
  PATTERN_ALREADY_CONFIRMED: 409,
  NOT_COMPLETE: 409,
  INVALID_CLAIM: 400,
  CONFIG_VALIDATION_FAILED: 422,
  SELF_APPROVAL_REJECTED: 403,
  PAYLOAD_HASH_MISMATCH: 409,
  ENTITY_LOCKED: 409,
  TENANT_SUSPENDED: 403,
  INFO_REQUESTED: 400,
  KYB_INCOMPLETE: 400,
  COMMISSION_RATE_OUT_OF_BOUNDS: 422,
  COMMISSION_PLAN_CONFLICT: 409,
  STATEMENT_NOT_CONFIRMED: 409,
  DISPUTE_WINDOW_CLOSED: 409,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: unknown;
  constructor(code: ErrorCode, message?: string, detail?: unknown) {
    super(message ?? code);
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}
