"use client";

/**
 * Landing — phone-first sign-in (UC-01). The demo OTP is shown in the DEMO
 * notice (no SMS is sent); normalization and rate limiting are server-side.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Smartphone, ShieldCheck, Sparkles, Wifi, Zap } from "lucide-react";
import { apiPost, ApiClientError } from "@/lib/client/api";
import { useApp, type SessionUser } from "@/lib/client/store";
import { usePhase, phaseCopy } from "@/lib/phase";
import { playSfx } from "@/lib/client/sfx";

export function Landing() {
  const { setUser, setBalance } = useApp();
  const phase = usePhase();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestOtp = async () => {
    setBusy(true);
    setError(null);
    playSfx("tap");
    try {
      const data = await apiPost<{ sent: boolean; demoCode?: string; phone: string }>("/api/v1/auth", {
        action: "request-otp",
        phone,
      });
      setDemoCode(data.demoCode ?? null);
      setStep("otp");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not send the code — try again");
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiPost<{ user: SessionUser }>("/api/v1/auth", { action: "login", phone, code });
      playSfx("coin");
      setUser(data.user);
      // Funded demo player lands ready to play.
      try {
        const w = await import("@/lib/client/api").then((m) => m.apiGet<{ balanceDisplay: string }>("/api/v1/wallet"));
        setBalance(w.balanceDisplay);
      } catch {
        /* balance chip refreshes on next wallet visit */
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Sign-in failed — try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 pt-2">
      {/* Hero — TV-show energy */}
      <section className="relative text-center space-y-4 pt-6">
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 w-72 h-72 rounded-full bg-[radial-gradient(circle,oklch(0.72_0.14_85/22%),transparent_65%)] blur-md" />
        <div className="relative flex items-end justify-center gap-3">
          <span className="ball-sphere ball-b1 w-14 h-14 text-2xl ball-drop" style={{ animationDelay: "0.12s" }}>7</span>
          <span className="ball-sphere ball-b4 w-20 h-20 text-4xl ball-drop bob" style={{ animationDelay: "0s" }}>B</span>
          <span className="ball-sphere ball-b3 w-14 h-14 text-2xl ball-drop" style={{ animationDelay: "0.24s" }}>0</span>
        </div>
        <h1 className="relative gold-text text-5xl font-black tracking-tight">BINGO ROYALE</h1>
        <p className="relative text-muted-foreground text-sm max-w-md mx-auto">
          Ethiopia&apos;s provably-fair bingo hall. Play 75-ball &amp; 90-ball rounds from your phone — no card, no cash, pure Birr.
        </p>
        <div className="relative flex flex-wrap items-center justify-center gap-2 pt-1">
          <Badge variant="outline" className="border-primary/50 text-primary"><ShieldCheck className="w-3 h-3 mr-1" />Commit-reveal fairness</Badge>
          <Badge variant="outline" className="border-primary/50 text-primary"><Wifi className="w-3 h-3 mr-1" />Low-data live play</Badge>
          <Badge variant="outline" className="border-primary/50 text-primary"><Zap className="w-3 h-3 mr-1" />Instant payouts</Badge>
          <Badge variant="outline" className="border-accent/60 text-accent-foreground"><Sparkles className="w-3 h-3 mr-1" />{phaseCopy.landingBadge(phase)}</Badge>
        </div>
      </section>

      {/* Auth card */}
      <section className="gold-frame rounded-2xl bg-card/85 p-6 space-y-4">
        <div className="flex items-center gap-2 text-primary font-bold">
          <Smartphone className="w-5 h-5" />
          <span>{step === "phone" ? "Sign in with your phone" : "Enter your code"}</span>
        </div>

        {step === "phone" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone number</Label>
              <Input
                id="phone"
                inputMode="tel"
                placeholder="09•• ••• •••"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && phone.trim() && requestOtp()}
                autoComplete="tel"
              />
              <p className="text-xs text-muted-foreground">Ethiopian mobile numbers — +251, 09…, or 9… all work.</p>
            </div>
            <Button className="btn-gold btn-shine btn-juice w-full font-black min-h-12 text-base tracking-wide" disabled={busy || phone.trim().length < 9} onClick={requestOtp}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send my code →"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {demoCode && (
              <div className="rounded-lg border border-accent/50 bg-accent/15 px-3 py-2 text-sm">
                <span className="font-bold text-accent-foreground">DEMO notice:</span> no SMS is sent in this build — your code is{" "}
                <span className="font-black tracking-widest text-primary text-base">{demoCode}</span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="code">6-character code</Label>
              <Input
                id="code"
                inputMode="text"
                autoComplete="one-time-code"
                placeholder="······"
                maxLength={6}
                className="text-center text-lg tracking-[0.4em] font-bold"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && code.length >= 4 && login()}
              />
            </div>
            <Button className="btn-gold btn-shine btn-juice w-full font-black min-h-12 text-base tracking-wide" disabled={busy || code.length < 4} onClick={login}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Enter the hall →"}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => { setStep("phone"); setCode(""); }} disabled={busy}>
              Change number
            </Button>
          </div>
        )}

        {error && <p className="text-destructive text-sm font-medium" role="alert">{error}</p>}
      </section>

      <p className="text-center text-[11px] text-muted-foreground pb-2">
        {phaseCopy.landingFooter(phase)}
      </p>
    </div>
  );
}
