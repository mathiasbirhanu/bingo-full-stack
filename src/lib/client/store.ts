"use client";

/**
 * Client session/view store (zustand). Server remains the single source of
 * truth for money and game state — the store caches display state only.
 */
import { create } from "zustand";
import { apiGet, apiPost } from "./api";

export type View = "lobby" | "room" | "wallet" | "history" | "admin" | "portal";

export interface SessionUser {
  id: string;
  role: string;
  tenantId: string | null;
  maskedPhone: string;
}

export interface WalletState {
  balanceSantim: string;
  balanceDisplay: string;
  history: Array<{
    kind: string;
    memo: string;
    amountSantim: string;
    amountDisplay: string;
    createdAt: string;
    demo: boolean;
  }>;
}

interface AppState {
  user: SessionUser | null;
  authChecked: boolean;
  view: View;
  activeRoomId: string | null;
  balanceDisplay: string;
  offline: boolean;
  setView: (view: View) => void;
  openRoom: (roomId: string) => void;
  setUser: (u: SessionUser | null) => void;
  setBalance: (display: string) => void;
  setOffline: (offline: boolean) => void;
  refreshSession: () => Promise<SessionUser | null>;
  logout: () => Promise<void>;
}

export const useApp = create<AppState>((set) => ({
  user: null,
  authChecked: false,
  view: "lobby",
  activeRoomId: null,
  balanceDisplay: "—",
  offline: false,
  setView: (view) => set({ view }),
  openRoom: (roomId) => set({ view: "room", activeRoomId: roomId }),
  setUser: (user) => set({ user, authChecked: true }),
  setBalance: (balanceDisplay) => set({ balanceDisplay }),
  setOffline: (offline) => set({ offline }),
  refreshSession: async () => {
    try {
      const data = await apiGet<{ user: SessionUser | null }>("/api/v1/auth", { retries: 1, timeoutMs: 8000 });
      set({ user: data.user, authChecked: true });
      return data.user;
    } catch {
      set({ user: null, authChecked: true, offline: true });
      return null;
    }
  },
  logout: async () => {
    try {
      await apiPost("/api/v1/auth", { action: "logout" });
    } catch {
      /* ignore */
    }
    set({ user: null, view: "lobby", activeRoomId: null, balanceDisplay: "—" });
  },
}));

/** The roles that may open the platform ops console (FR-PRT-20: platform staff only). */
export const STAFF_ROLES = new Set(["ADMIN", "SUPERVISOR", "SUPPORT", "AUDITOR", "PLATFORM_COMPLIANCE", "PLATFORM_FINANCE"]);
export const canSeeAdmin = (user: SessionUser | null): boolean => !!user && STAFF_ROLES.has(user.role);
/** Tenant members get their own partner portal (UC-13/15) — never the platform console. */
export const canSeePortal = (user: SessionUser | null): boolean => !!user && (user.role === "TENANT_OWNER" || user.role === "TENANT_SUPERVISOR");
