"use client";

/**
 * HistoryView — the player's ledger eye-view: money movement plus round
 * participation. Reuses the wallet history (kinds) — one endpoint, compact.
 */
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { History, Coins, Sparkles } from "lucide-react";
import { apiGet, etb } from "@/lib/client/api";
import type { WalletData } from "@/lib/client/types";
import { STAFF_ROLES, useApp } from "@/lib/client/store";

export function HistoryView() {
  const { user, setBalance } = useApp();
  const [wallet, setWallet] = useState<WalletData | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await apiGet<WalletData>("/api/v1/wallet", { retries: 2 });
      setWallet(w);
      setBalance(w.balanceDisplay); // header chip stays truthful on every view
    } catch {
      /* transient */
    }
  }, [setBalance]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(load, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const totals = (wallet?.history ?? []).reduce(
    (acc, h) => {
      const v = Number(h.amountSantim);
      if (["DEPOSIT", "PRIZE", "REFUND", "PRIZE_ADJUSTMENT"].includes(h.kind)) acc.in += v;
      else acc.out += v;
      return acc;
    },
    { in: 0, out: 0 }
  );

  const staff = user && STAFF_ROLES.has(user.role);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3">
        <div className="gold-frame rounded-xl bg-card/85 p-3 text-center">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Money in</p>
          <p className="font-black text-emerald-500 tabular-nums">{etb(totals.in)}</p>
        </div>
        <div className="gold-frame rounded-xl bg-card/85 p-3 text-center">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stakes</p>
          <p className="font-black text-foreground tabular-nums">{etb(totals.out)}</p>
        </div>
      </section>

      <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
        <h3 className="font-bold inline-flex items-center gap-1.5"><History className="w-4 h-4 text-primary" /> Ledger trail</h3>
        {!wallet && <Skeleton className="h-28 w-full bg-card/60" />}
        {wallet && wallet.history.length === 0 && <p className="text-sm text-muted-foreground py-3 text-center">Nothing yet — your story starts with a deposit.</p>}
        <div className="luxe-scroll max-h-[26rem] overflow-y-auto space-y-1.5 pr-1">
          {wallet?.history.map((h, i) => (
            <div key={i} className="flex items-start justify-between gap-2 rounded-lg bg-background/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold inline-flex items-center gap-1.5">
                  {h.kind === "PRIZE" ? <Sparkles className="w-3.5 h-3.5 text-primary" /> : <Coins className="w-3.5 h-3.5 text-muted-foreground" />}
                  {h.kind}
                </p>
                <p className="text-[11px] text-muted-foreground truncate max-w-[48ch]">{h.memo}</p>
              </div>
              <div className="text-right flex-none">
                <p className="text-sm font-bold tabular-nums">{h.amountDisplay}</p>
                <p className="text-[10px] text-muted-foreground">{new Date(h.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
              </div>
            </div>
          ))}
        </div>
        {staff && (
          <p className="text-[11px] text-muted-foreground pt-1">
            <Badge variant="outline" className="mr-1 text-primary border-primary/40">staff</Badge>
            Journal entries are append-only; every posting is visible to the audit role in the console.
          </p>
        )}
      </section>
    </div>
  );
}
