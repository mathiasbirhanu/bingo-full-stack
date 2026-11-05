"use client";

/**
 * Phase context — the ONE switch that flips every player-facing surface
 * between DEMO and LIVE wording (D-PRT-06). The server layout reads
 * PLATFORM_PHASE (derived from PAYMENT_MODE) and injects it here, so the
 * correct wording renders from first paint — no fetch, no flash, no drift.
 *
 * Rule: no component hardcodes the words "demo money" or real-money claims.
 * They branch on usePhase() — flipping the rail to LIVE is a config change,
 * not a copy-editing project.
 */
import { createContext, useContext, type ReactNode } from "react";

export type Phase = "DEMO" | "LIVE";

const PhaseContext = createContext<Phase>("DEMO");

export function PhaseProvider({ phase, children }: { phase: Phase; children: ReactNode }) {
  return <PhaseContext.Provider value={phase}>{children}</PhaseContext.Provider>;
}

export function usePhase(): Phase {
  return useContext(PhaseContext);
}

/** Shared copy dictionary — the exact player-facing strings per phase. */
export const phaseCopy = {
  headerBadge: (phase: Phase) => phase, // DEMO / LIVE chip in the gold header
  landingBadge: (phase: Phase) =>
    phase === "DEMO" ? "Instant demo deposits" : "Instant telebirr deposits",
  landingFooter: (phase: Phase) =>
    phase === "DEMO"
      ? "18+ · Play responsibly · Every balance, prize and payout in this build is demo money on a real double-entry ledger."
      : "18+ · Play responsibly · Real-money play. Set your deposit limits in the wallet — help is always one tap away.",
  lobbyBanner: (phase: Phase) =>
    phase === "DEMO"
      ? "Welcome to the Royale hall — demo money, real engineering"
      : "Welcome to the Royale hall — real birr, provably fair",
  walletRail: (phase: Phase) =>
    phase === "DEMO"
      ? "Demo rail: the PSP checkout is simulated and money moves through the real double-entry ledger (clearing → wallet)."
      : "Deposits arrive via telebirr — confirm in the app and the balance lands in seconds.",
  walletToast: (phase: Phase, providerRef: string) =>
    phase === "DEMO"
      ? `Demo checkout ${providerRef} — confirmed instantly.`
      : `telebirr ${providerRef} — pending confirmation.`,
  otpNotice: (code: string) => (
    <>DEMO notice: no SMS is sent in this build — your code is <span className="font-black tracking-widest text-primary text-base">{code}</span></>
  ),
} as const;
