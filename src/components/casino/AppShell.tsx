"use client";

/**
 * AppShell — gold header with live balance, connection banner, and the
 * thumb-reach bottom navigation (mobile-first casino layout). Sticky footer
 * posture: min-h flex column with mt-auto.
 */
import { ReactNode, useEffect, useState } from "react";
import { Dices, Wallet, History, ShieldHalf, Radio, Building2, Volume2, VolumeX, Coins } from "lucide-react";
import { useApp, canSeeAdmin, canSeePortal } from "@/lib/client/store";
import { usePhase } from "@/lib/phase";
import { initSfx, playSfx, setSfxEnabled, sfxEnabled } from "@/lib/client/sfx";

function NavButton({ view, label, icon, active, onClick }: { view: string; label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`flex flex-col items-center justify-center gap-0.5 flex-1 py-2 min-h-[56px] text-[11px] font-medium transition-colors ${
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <span className={`transition-transform ${active ? "scale-110" : ""}`}>{icon}</span>
      {label}
      <span className={`h-0.5 w-6 rounded-full transition-all ${active ? "bg-primary" : "bg-transparent"}`} />
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { view, setView, balanceDisplay, user, offline, openRoom, activeRoomId } = useApp();
  const phase = usePhase();
  const adminVisible = canSeeAdmin(user);
  const portalVisible = canSeePortal(user);
  const [sound, setSound] = useState(true);

  // Browsers allow audio only after a gesture — unlock on the first tap.
  useEffect(() => {
    const unlock = () => initSfx();
    window.addEventListener("pointerdown", unlock, { once: true });
    // Restore the persisted preference after hydration (avoids SSR mismatch).
    const t = setTimeout(() => setSound(sfxEnabled()), 0);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      clearTimeout(t);
    };
  }, []);

  const toggleSound = () => {
    const next = !sound;
    setSfxEnabled(next);
    setSound(next);
    if (next) {
      initSfx();
      playSfx("tap");
    }
  };

  return (
    <div className="casino-felt min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b border-primary/20 bg-background/85 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 h-14 flex items-center justify-between gap-3">
          <button className="flex items-center gap-2 min-w-0" onClick={() => setView("lobby")} aria-label="Bingo Royale home">
            <span className="ball-sphere ball-b4 w-8 h-8 text-[15px]">B</span>
            <span className="gold-text font-black tracking-wide text-lg truncate">BINGO ROYALE</span>
          </button>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] font-bold tracking-widest border border-accent/60 text-accent-foreground bg-accent/85 rounded-full px-2.5 py-1">
              {phase}
            </span>
            <button
              onClick={toggleSound}
              aria-label={sound ? "Mute game sounds" : "Unmute game sounds"}
              aria-pressed={sound}
              className="grid place-items-center w-9 h-9 rounded-full border border-primary/30 bg-card/80 text-primary/90 hover:border-primary/60 transition-colors"
            >
              {sound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-muted-foreground" />}
            </button>
            <button
              onClick={() => setView("wallet")}
              className="gold-frame flex items-center gap-1.5 rounded-full px-3 py-1.5 bg-card/80 btn-juice"
              aria-label={`Balance ${balanceDisplay} birr — open wallet`}
            >
              <Coins className="w-3.5 h-3.5 text-primary" />
              <span className="font-bold text-primary text-sm tabular-nums">{balanceDisplay}</span>
            </button>
          </div>
        </div>
        {offline && (
          <div className="slide-down bg-accent/90 text-accent-foreground text-xs text-center py-1.5 px-4">
            Unstable connection — syncing in the background, your game state is safe.
          </div>
        )}
      </header>

      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-4 pb-24">{children}</main>

      <footer className="mt-auto sticky bottom-0 z-40 border-t border-primary/20 bg-background/90 backdrop-blur-md pb-[env(safe-area-inset-bottom)]">
        <nav className="mx-auto max-w-3xl flex" aria-label="Main">
          <NavButton view="lobby" label="Lobby" icon={<Dices className="w-5 h-5" />} active={view === "lobby"} onClick={() => { playSfx("tap"); setView("lobby"); }} />
          <NavButton view="wallet" label="Wallet" icon={<Wallet className="w-5 h-5" />} active={view === "wallet"} onClick={() => { playSfx("tap"); setView("wallet"); }} />
          {view === "room" && (
            <NavButton view="room" label="Live" icon={<Radio className="w-5 h-5 live-dot" />} active onClick={() => activeRoomId && openRoom(activeRoomId)} />
          )}
          <NavButton view="history" label="History" icon={<History className="w-5 h-5" />} active={view === "history"} onClick={() => setView("history")} />
          {adminVisible && (
            <NavButton view="admin" label="Console" icon={<ShieldHalf className="w-5 h-5" />} active={view === "admin"} onClick={() => setView("admin")} />
          )}
          {portalVisible && (
            <NavButton view="portal" label="Portal" icon={<Building2 className="w-5 h-5" />} active={view === "portal"} onClick={() => setView("portal")} />
          )}
        </nav>
      </footer>
    </div>
  );
}
