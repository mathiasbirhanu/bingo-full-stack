"use client";

/**
 * Bingo Royale — single-route app shell. View switching is client-side
 * (the sandbox exposes only this route); every view talks to /api/v1/* with
 * idempotent, retry-safe calls.
 */
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useApp } from "@/lib/client/store";
import { AppShell } from "@/components/casino/AppShell";
import { Landing } from "@/components/casino/Landing";
import { Lobby } from "@/components/casino/Lobby";
import { RoomView } from "@/components/casino/RoomView";
import { WalletView } from "@/components/casino/WalletView";
import { HistoryView } from "@/components/casino/HistoryView";
import { AdminConsole } from "@/components/casino/AdminConsole";
import { TenantPortal } from "@/components/casino/TenantPortal";

export default function Home() {
  const { user, authChecked, view, activeRoomId, refreshSession } = useApp();

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Online/offline banner wiring — the hook + api layer surface failures.
  useEffect(() => {
    const on = () => useApp.getState().setOffline(false);
    const off = () => useApp.getState().setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!authChecked) {
    return (
      <div className="casino-felt min-h-screen grid place-items-center">
        <div className="flex flex-col items-center gap-3">
          <span className="ball-sphere ball-b4 w-16 h-16 text-3xl pulse-gold">B</span>
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <AppShell>
      {!user ? (
        <Landing />
      ) : view === "room" && activeRoomId ? (
        <RoomView key={activeRoomId} roomId={activeRoomId} onBack={() => useApp.getState().setView("lobby")} />
      ) : view === "wallet" ? (
        <WalletView />
      ) : view === "history" ? (
        <HistoryView />
      ) : view === "admin" ? (
        <AdminConsole />
      ) : view === "portal" ? (
        <TenantPortal />
      ) : (
        <Lobby />
      )}
    </AppShell>
  );
}
