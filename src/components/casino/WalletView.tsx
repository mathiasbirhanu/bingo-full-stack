"use client";

/**
 * WalletView — UC-02 deposit through the payment port. Presets keep the flow
 * one-tap. DEMO: the simulated checkout confirms instantly. LIVE: the intent
 * stays PENDING and the wallet credits when the telebirr callback verifies —
 * the UI says exactly that instead of pretending.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { Wallet, Loader2, BadgeCheck, ArrowDownLeft, ArrowUpRight, Info, Coins, Smartphone } from "lucide-react";
import { apiGet, apiPost, etb, newIdempotencyKey, ApiClientError } from "@/lib/client/api";
import { useApp } from "@/lib/client/store";
import { usePhase, phaseCopy } from "@/lib/phase";
import { playSfx } from "@/lib/client/sfx";
import type { WalletData } from "@/lib/client/types";

const PRESETS = [25, 50, 100, 250];

const KIND_LABEL: Record<string, string> = {
  DEPOSIT: "Deposit",
  PURCHASE: "Cards bought",
  PRIZE: "Prize won",
  REFUND: "Refund",
  PRIZE_ADJUSTMENT: "Prize adjustment",
  ADJUSTMENT: "Adjustment",
};

export function WalletView() {
  const { setBalance } = useApp();
  const phase = usePhase();
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [selected, setSelected] = useState(50);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const w = await apiGet<WalletData>("/api/v1/wallet", { retries: 2 });
      setWallet(w);
      setBalance(w.balanceDisplay);
    } catch {
      /* retry on next interval */
    }
  }, [setBalance]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(load, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const deposit = async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ balanceDisplay?: string; replayed: boolean; providerRef: string; pending: boolean }>(
        "/api/v1/wallet",
        { amountEtb: selected.toFixed(2), idempotencyKey: newIdempotencyKey("dep") }
      );
      if (res.pending) {
        // LIVE rail: the wallet credits when telebirr's verified callback
        // lands — never pretend otherwise. The 15s poll picks it up.
        toast({ title: `${selected.toFixed(2)} ETB deposit opened`, description: phaseCopy.walletToast(phase, res.providerRef) });
      } else {
        setBalance(res.balanceDisplay!);
        toast({ title: `${selected.toFixed(2)} ETB added`, description: phaseCopy.walletToast(phase, res.providerRef) });
      }
      await load();
    } catch (err) {
      toast({
        title: err instanceof ApiClientError ? err.code : "Deposit failed",
        description: err instanceof ApiClientError ? err.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Balance hero — coin stack energy */}
      <section className="gold-frame rounded-2xl bg-gradient-to-b from-card to-card/60 p-6 text-center space-y-1 relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-56 h-56 rounded-full bg-[radial-gradient(circle,oklch(0.72_0.14_85/16%),transparent_65%)]" />
        <Coins aria-hidden className="w-6 h-6 text-primary mx-auto" />
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Wallet balance</p>
        {wallet ? (
          <p className="text-4xl font-black gold-text tabular-nums">{wallet.balanceDisplay} <span className="text-lg">ETB</span></p>
        ) : (
          <Skeleton className="h-10 w-40 mx-auto bg-card/70" />
        )}
        {wallet && (
          <div className="flex items-center justify-center gap-2 pt-1">
            <Badge variant="outline" className="border-accent/60 text-accent-foreground">{wallet.mode} rail</Badge>
            <Badge variant="outline" className="text-muted-foreground">{wallet.phase} phase</Badge>
          </div>
        )}
      </section>

      {/* Deposit */}
      <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-3">
        <h3 className="font-bold inline-flex items-center gap-1.5"><Wallet className="w-4 h-4 text-primary" /> Add money {phase === "DEMO" && <span className="text-xs font-normal text-muted-foreground">(demo)</span>}</h3>
        <div className="grid grid-cols-4 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => { setSelected(p); playSfx("tap"); }}
              aria-pressed={selected === p}
              className={`min-h-11 rounded-lg border text-sm font-black transition-colors btn-juice ${selected === p ? "border-primary bg-primary/20 text-primary" : "border-border bg-background/40 hover:border-primary/50"}`}
            >
              {p}
            </button>
          ))}
        </div>
        <Button className="btn-gold btn-shine btn-juice w-full font-black min-h-12 text-base" disabled={busy} onClick={deposit}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="inline-flex items-center gap-2"><Smartphone className="w-4 h-4" />Deposit {selected}.00 ETB</span>}
        </Button>
        <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1">
          <Info className="w-3 h-3 mt-0.5 flex-none" />
          {phaseCopy.walletRail(phase)}
        </p>
      </section>

      {/* History */}
      <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
        <h3 className="font-bold">Recent activity</h3>
        {!wallet && <Skeleton className="h-24 w-full bg-card/60" />}
        {wallet && wallet.history.length === 0 && <p className="text-sm text-muted-foreground py-3 text-center">No movement yet — deposit and grab your first cards.</p>}
        <div className="luxe-scroll max-h-80 overflow-y-auto space-y-1.5 pr-1">
          {wallet?.history.map((h, i) => {
            const positive = ["DEPOSIT", "PRIZE", "REFUND", "PRIZE_ADJUSTMENT"].includes(h.kind);
            return (
              <div key={i} className="flex items-center justify-between rounded-lg bg-background/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold inline-flex items-center gap-1.5">
                    {positive ? <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-500" /> : <ArrowUpRight className="w-3.5 h-3.5 text-accent" />}
                    {KIND_LABEL[h.kind] ?? h.kind}
                    {h.demo && <BadgeCheck className="w-3 h-3 text-muted-foreground" />}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate max-w-[46ch]">{h.memo}</p>
                </div>
                <div className="text-right flex-none">
                  <p className={`text-sm font-bold tabular-nums ${positive ? "text-emerald-500" : "text-foreground"}`}>{positive ? "+" : "−"}{h.amountDisplay}</p>
                  <p className="text-[10px] text-muted-foreground">{new Date(h.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
