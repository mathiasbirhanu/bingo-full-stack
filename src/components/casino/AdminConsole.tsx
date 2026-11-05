"use client";

/**
 * AdminConsole — the platform operations surface (UC-07/09/12/14), role-gated
 * by the API layer; this UI only mirrors what the server already enforces:
 *   · Engine: health, live rooms, outbox lag
 *   · Rounds: void with reason (UC-09)
 *   · Tenants: KYB lifecycle (approve / suspend / restore, UC-11/14)
 *   · Commission: per-tenant turnover rate (UC-12, OD-12 bounds)
 *   · Drafts: maker-checker queue (UC-08, self-approval structurally refused)
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Ban, CheckCircle2, Percent, ScrollText, Server, Gavel, Gauge, Hand, Eye } from "lucide-react";
import { apiGet, apiPost, apiPut, etb, ApiClientError } from "@/lib/client/api";
import { ballClass } from "@/lib/client/types";

interface EngineData {
  engine: { booted: boolean; ticks: number; lastTickAt: string | null; lastTickMs: number | null; lastError: string | null };
  liveRooms: Array<{ id: string; title: string; status: string; grossSantim: string; ballIntervalMs: number; autoClaim: boolean }>;
  outboxPending: number;
}
interface RoundsData {
  id: string; title: string; variantId: string; status: string; scheduledAt: string; grossSantim: string; tickets: number; claims: number; voidReason: string | null;
}
interface TenantsData {
  tenantId: string; code: string; legalName: string; status: string;
  plans: Array<{ id: string; rateBps: number; effectiveFrom: string }>;
  accruals: Array<{ day: string; commissionSantim: string; turnoverSantim: string; rateBps: number }>;
}
interface DraftsData {
  drafts: Array<{ id: string; type: string; title: string; status: string; entityName: string | null; makerId: string; createdAt: string }>;
  entities: Array<{ id: string; type: string; name: string; tenantId: string | null; currentVersion: number; locked: boolean }>;
}

const STATUS_TONE: Record<string, string> = {
  DRAWING: "bg-accent text-accent-foreground",
  SALES_OPEN: "border-primary/60 text-primary",
  COMPLETED: "text-muted-foreground",
  APPROVED: "bg-emerald-900/40 text-emerald-400 border-emerald-700/60",
  REGISTERED: "text-muted-foreground",
  UNDER_REVIEW: "border-primary/60 text-primary",
  SUSPENDED: "bg-accent/20 text-accent-foreground border-accent/60",
  REJECTED: "bg-accent/20 text-accent-foreground border-accent/60",
};

function Tone({ status }: { status: string }) {
  return <Badge variant="outline" className={STATUS_TONE[status] ?? "text-muted-foreground"}>{status}</Badge>;
}

/* ── Draw monitor — the owner-only called list + draw order (FR-ADM) ───────
 * Players see ONE ball at a time; the full called history and the future
 * draw sequence live here and only here. The order is the deterministic
 * shuffle from the fairness seal — each number appears exactly once, which
 * this panel makes checkable at a glance. */
interface MonitorData {
  title: string;
  status: string;
  variantId: string;
  ballIntervalMs: number;
  autoClaim: boolean;
  players: number;
  tickets: number;
  ballsTotal: number;
  calledBalls: Array<{ seq: number; ball: number }>;
  drawOrder: number[] | null;
  priceSantim: string;
  netPoolSantim: string;
}

const BALL_LETTERS = ["B", "I", "N", "G", "O"];
function ballLabel(variantId: string, ball: number): string {
  if (variantId === "BALL_75") return `${BALL_LETTERS[Math.min(4, Math.floor((ball - 1) / 15))]}${ball}`;
  return String(ball);
}

function DrawMonitor({ roomId, title }: { roomId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MonitorData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !err) {
      try {
        setData(await apiGet<MonitorData>(`/api/v1/admin/rounds/${roomId}`, { retries: 1 }));
      } catch (e) {
        setErr(e instanceof ApiClientError ? e.code : "Failed to load");
      }
    }
  };

  return (
    <div className="space-y-1.5">
      <button
        onClick={toggle}
        aria-expanded={open}
        className={`inline-flex items-center gap-1 min-h-7 px-2 rounded-md text-[10px] font-black border transition-colors ${
          open ? "border-primary bg-primary/20 text-primary" : "border-border bg-card/60 text-muted-foreground hover:border-primary/50"
        }`}
      >
        <Eye className="w-3 h-3" /> {open ? "Hide draw monitor" : "Draw monitor"}
      </button>
      {open && (
        !data ? (
          <p className="text-[11px] text-muted-foreground">{err ?? `Loading ${title}…`}</p>
        ) : (
          <div className="space-y-2 rounded-lg bg-background/50 p-2">
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              <span><b className="text-foreground tabular-nums">{data.players}</b> players</span>
              <span><b className="text-foreground tabular-nums">{data.tickets}</b> cards</span>
              <span><b className="text-foreground tabular-nums">{data.calledBalls.length}/{data.ballsTotal}</b> called</span>
              <span>card <b className="text-foreground tabular-nums">{etb(data.priceSantim)} ETB</b></span>
              <span>pool <b className="text-foreground tabular-nums">{etb(data.netPoolSantim)} ETB</b></span>
              <span>{(data.ballIntervalMs / 1000).toFixed(1)}s/ball · {data.autoClaim ? "auto-pay" : "manual BINGO!"}</span>
            </div>

            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold mb-1">Called so far, in order</p>
              {data.calledBalls.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No balls drawn yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {data.calledBalls.map((b) => (
                    <span key={b.seq} className={`ball-sphere ${ballClass(b.ball)} w-7 h-7 text-[10px] font-black`}>
                      {ballLabel(data.variantId, b.ball)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                Full draw order (owner-only · sealed until reveal)
              </p>
              {data.drawOrder ? (
                <>
                  <div className="flex flex-wrap gap-1 luxe-scroll max-h-24 overflow-y-auto">
                    {data.drawOrder.map((n, i) => {
                      const called = i < data.calledBalls.length;
                      return (
                        <span
                          key={n}
                          className={`inline-grid place-items-center min-w-7 h-7 px-1 rounded-md text-[10px] font-bold tabular-nums ${
                            called ? "bg-primary/20 text-primary" : "bg-background/60 text-muted-foreground/60"
                          }`}
                          title={`ball #${i + 1}`}
                        >
                          {ballLabel(data.variantId, n)}
                        </span>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {data.drawOrder.length} numbers, each exactly once — deterministic shuffle from the fairness seal (BallDraw enforces a unique ball per room in the DB).
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">The order materialises when the round locks (commitment published, seed sealed).</p>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}

async function action(promise: Promise<unknown>, what: string) {
  try {
    await promise;
    toast({ title: `${what} ✓` });
    return true;
  } catch (err) {
    toast({ title: err instanceof ApiClientError ? err.code : "Failed", description: err instanceof ApiClientError ? err.message : undefined, variant: "destructive" });
    return false;
  }
}

export function AdminConsole() {
  const [engine, setEngine] = useState<EngineData | null>(null);
  const [rounds, setRounds] = useState<RoundsData[] | null>(null);
  const [tenants, setTenants] = useState<TenantsData[] | null>(null);
  const [drafts, setDrafts] = useState<DraftsData | null>(null);
  const [rateInput, setRateInput] = useState<Record<string, string>>({});
  const [voidReason, setVoidReason] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    const [e, r, t, d] = await Promise.allSettled([
      apiGet<EngineData>("/api/v1/admin/engine", { retries: 1 }),
      apiGet<RoundsData[]>("/api/v1/admin/rounds", { retries: 1 }),
      apiGet<TenantsData[]>("/api/v1/admin/commission", { retries: 1 }),
      apiGet<DraftsData>("/api/v1/admin/drafts", { retries: 1 }),
    ]);
    if (e.status === "fulfilled") setEngine(e.value);
    if (r.status === "fulfilled") setRounds(r.value);
    if (t.status === "fulfilled") setTenants(t.value);
    if (d.status === "fulfilled") setDrafts(d.value);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void loadAll(), 0);
    const t = setInterval(loadAll, 12_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [loadAll]);

  return (
    <div className="space-y-4">
      {/* Engine strip */}
      <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
        <h3 className="font-bold inline-flex items-center gap-1.5"><Server className="w-4 h-4 text-primary" /> Engine</h3>
        {!engine ? (
          <Skeleton className="h-16 w-full bg-card/60" />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-sm">
            <div className="rounded-lg bg-background/40 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">State</p>
              <p className={`font-bold ${engine.engine.booted && !engine.engine.lastError ? "text-emerald-500" : "text-accent"}`}>
                {engine.engine.booted ? (engine.engine.lastError ? "degraded" : "healthy") : "off"}
              </p>
            </div>
            <div className="rounded-lg bg-background/40 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Ticks</p>
              <p className="font-bold tabular-nums">{engine.engine.ticks}</p>
            </div>
            <div className="rounded-lg bg-background/40 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Live rooms</p>
              <p className="font-bold tabular-nums">{engine.liveRooms.length}</p>
            </div>
            <div className="rounded-lg bg-background/40 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Outbox pending</p>
              <p className={`font-bold tabular-nums ${engine.outboxPending > 0 ? "text-accent" : "text-emerald-500"}`}>{engine.outboxPending}</p>
            </div>
          </div>
        )}
        {engine?.liveRooms.map((r) => (
          <div key={r.id} className="bg-background/30 rounded-lg px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold truncate">{r.title}</span>
              <span className="flex items-center gap-2"><Tone status={r.status} /><span className="tabular-nums">{etb(r.grossSantim)} ETB</span></span>
            </div>
            {/* Owner-only monitor: called list + full draw order */}
            <DrawMonitor roomId={r.id} title={r.title} />
            {/* Live caller tuning — the engine re-reads the room row every tick,
                so a speed change lands on the very next ball. */}
            {["SALES_OPEN", "LOCKED", "DRAWING"].includes(r.status) && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Gauge className="w-3 h-3" /> caller {r.ballIntervalMs >= 1000 ? `${(r.ballIntervalMs / 1000).toFixed(1)}s` : `${r.ballIntervalMs}ms`} / ball
                </span>
                <span className="flex items-center gap-1">
                  {[1000, 2000, 3000, 5000].map((ms) => (
                    <button
                      key={ms}
                      onClick={async () => {
                        const ok = await action(apiPost(`/api/v1/admin/rounds/${r.id}`, { action: "set-speed", ballIntervalMs: ms }), `Caller speed → ${ms / 1000}s`);
                        if (ok) void loadAll();
                      }}
                      aria-pressed={r.ballIntervalMs === ms}
                      className={`min-h-7 px-2 rounded-md text-[10px] font-black border transition-colors ${
                        r.ballIntervalMs === ms ? "border-primary bg-primary/20 text-primary" : "border-border bg-card/60 text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {ms / 1000}s
                    </button>
                  ))}
                  <button
                    onClick={async () => {
                      const ok = await action(apiPost(`/api/v1/admin/rounds/${r.id}`, { action: "set-claim-mode", autoClaim: !r.autoClaim }), r.autoClaim ? "Claim mode → manual (players tap BINGO!)" : "Claim mode → auto-pay");
                      if (ok) void loadAll();
                    }}
                    aria-pressed={!r.autoClaim}
                    className={`min-h-7 px-2 rounded-md text-[10px] font-black border inline-flex items-center gap-1 transition-colors ${
                      r.autoClaim ? "border-border bg-card/60 text-muted-foreground hover:border-accent/60" : "border-accent/60 bg-accent/20 text-accent-foreground"
                    }`}
                  >
                    <Hand className="w-3 h-3" /> {r.autoClaim ? "AUTO-PAY" : "MANUAL"}
                  </button>
                </span>
              </div>
            )}
          </div>
        ))}
      </section>

      <Tabs defaultValue="rounds">
        <TabsList className="bg-card/70 border border-border w-full justify-start overflow-x-auto">
          <TabsTrigger value="rounds"><Gavel className="w-3.5 h-3.5 mr-1" />Rounds</TabsTrigger>
          <TabsTrigger value="tenants"><Activity className="w-3.5 h-3.5 mr-1" />Tenants</TabsTrigger>
          <TabsTrigger value="commission"><Percent className="w-3.5 h-3.5 mr-1" />Commission</TabsTrigger>
          <TabsTrigger value="drafts"><ScrollText className="w-3.5 h-3.5 mr-1" />Drafts</TabsTrigger>
        </TabsList>

        {/* Rounds */}
        <TabsContent value="rounds" className="space-y-2 mt-3">
          {(rounds ?? []).slice(0, 12).map((r) => (
            <div key={r.id} className="gold-frame rounded-xl bg-card/85 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">{r.title}</p>
                  <p className="text-[11px] text-muted-foreground">{r.variantId} · {r.tickets} cards · {r.claims} claims · {etb(r.grossSantim)} ETB</p>
                </div>
                <Tone status={r.status} />
              </div>
              {["SALES_OPEN", "LOCKED", "DRAWING"].includes(r.status) && (
                <div className="flex gap-2">
                  <Input
                    className="h-9 text-xs"
                    placeholder="reason code (e.g. OPERATOR_REQUEST)"
                    value={voidReason[r.id] ?? ""}
                    onChange={(e) => setVoidReason((s) => ({ ...s, [r.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-9 flex-none"
                    onClick={async () => {
                      const ok = await action(apiPost(`/api/v1/admin/rounds/${r.id}`, { action: "void", reasonCode: voidReason[r.id] || "OPERATOR_REQUEST" }), "Round voided + refunds posted");
                      if (ok) void loadAll();
                    }}
                  >
                    <Ban className="w-3.5 h-3.5" /> Void
                  </Button>
                </div>
              )}
              <DrawMonitor roomId={r.id} title={r.title} />
            </div>
          ))}
          {!rounds && <Skeleton className="h-24 w-full bg-card/60" />}
        </TabsContent>

        {/* Tenants */}
        <TabsContent value="tenants" className="space-y-2 mt-3">
          {(tenants ?? []).map((t) => (
            <div key={t.tenantId} className="gold-frame rounded-xl bg-card/85 p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">{t.code} — {t.legalName}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t.plans[0] ? `commission ${(t.plans[0].rateBps / 100).toFixed(2)}% · from ${new Date(t.plans[0].effectiveFrom).toLocaleDateString()}` : "no plan"}
                  {t.accruals[0] ? ` · last accrual ${t.accruals[0].day}: ${etb(t.accruals[0].commissionSantim)} ETB` : ""}
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-none">
                <Tone status={t.status} />
                {t.status !== "APPROVED" && (
                  <Button size="sm" variant="outline" className="h-8 text-xs border-primary/50 text-primary"
                    onClick={async () => { const ok = await action(apiPost(`/api/v1/admin/tenants/${t.tenantId}`, { action: "approve" }), "Tenant approved"); if (ok) void loadAll(); }}>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  </Button>
                )}
                {t.status === "APPROVED" && (
                  <Button size="sm" variant="outline" className="h-8 text-xs border-accent/60 text-accent-foreground"
                    onClick={async () => { const ok = await action(apiPost(`/api/v1/admin/tenants/${t.tenantId}`, { action: "suspend", reasonCode: "OPERATOR_REVIEW" }), "Tenant suspended"); if (ok) void loadAll(); }}>
                    <Ban className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
          {!tenants && <Skeleton className="h-16 w-full bg-card/60" />}
        </TabsContent>

        {/* Commission */}
        <TabsContent value="commission" className="space-y-2 mt-3">
          {(tenants ?? []).map((t) => (
            <div key={t.tenantId} className="gold-frame rounded-xl bg-card/85 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">{t.code}</p>
                <Badge variant="outline" className="text-primary border-primary/40">TURNOVER basis</Badge>
              </div>
              <div className="flex gap-2">
                <Input
                  className="h-9 text-sm"
                  inputMode="decimal"
                  placeholder={`new rate % (current ${(t.plans[0]?.rateBps ?? 0) / 100}%)`}
                  value={rateInput[t.tenantId] ?? ""}
                  onChange={(e) => setRateInput((s) => ({ ...s, [t.tenantId]: e.target.value }))}
                />
                <Button
                  size="sm"
                  className="btn-gold h-9 font-bold flex-none"
                  onClick={async () => {
                    const pct = Number(rateInput[t.tenantId]);
                    if (!Number.isFinite(pct) || pct < 0 || pct > 35) {
                      toast({ title: "VALIDATION_FAILED", description: "Rate must be 0–35% (OD-12 bounds).", variant: "destructive" });
                      return;
                    }
                    const ok = await action(apiPost("/api/v1/admin/commission", { tenantId: t.tenantId, rateBps: Math.round(pct * 100) }), `Plan activated at ${pct}%`);
                    if (ok) { setRateInput((s) => ({ ...s, [t.tenantId]: "" })); void loadAll(); }
                  }}
                >
                  Set
                </Button>
              </div>
              <div className="luxe-scroll max-h-24 overflow-y-auto space-y-1">
                {t.accruals.map((a) => (
                  <div key={a.day} className="flex justify-between text-[11px] text-muted-foreground bg-background/30 rounded px-2 py-1">
                    <span>{a.day} @ {(a.rateBps / 100).toFixed(2)}%</span>
                    <span>turnover {etb(a.turnoverSantim)} → fee {etb(a.commissionSantim)} ETB</span>
                  </div>
                ))}
                {t.accruals.length === 0 && <p className="text-[11px] text-muted-foreground">No accruals yet — they post when partner rounds complete.</p>}
              </div>
            </div>
          ))}
          {!tenants && <Skeleton className="h-16 w-full bg-card/60" />}
        </TabsContent>

        {/* Drafts (maker-checker) */}
        <TabsContent value="drafts" className="space-y-2 mt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Config changes flow maker → checker → publish (UC-08). Self-approval is structurally refused.</p>
            <Button size="sm" variant="outline" className="h-8 text-xs"
              onClick={async () => { const ok = await action(apiPut("/api/v1/admin/drafts"), "Scheduler topped up"); if (ok) void loadAll(); }}>
              Top up rooms
            </Button>
          </div>
          {(drafts?.drafts ?? []).slice(0, 10).map((d) => (
            <div key={d.id} className="rounded-xl border border-border bg-card/70 p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">{d.title}</p>
                <p className="text-[11px] text-muted-foreground">{d.type}{d.entityName ? ` · ${d.entityName}` : " · new entity"} · maker {d.makerId.slice(-4)}</p>
              </div>
              <div className="flex items-center gap-1.5 flex-none">
                <Tone status={d.status} />
                {d.status === "PENDING" && (
                  <>
                    <Button size="sm" variant="outline" className="h-8 text-xs border-primary/50 text-primary"
                      onClick={async () => { const ok = await action(apiPost(`/api/v1/admin/drafts/${d.id}`, { action: "approve" }), "Draft approved + published"); if (ok) void loadAll(); }}>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs border-accent/60 text-accent-foreground"
                      onClick={async () => { const ok = await action(apiPost(`/api/v1/admin/drafts/${d.id}`, { action: "reject", reason: "operator rejection" }), "Draft rejected"); if (ok) void loadAll(); }}>
                      <Ban className="w-3.5 h-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {drafts && drafts.drafts.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No drafts in the pipeline.</p>}
          {!drafts && <Skeleton className="h-16 w-full bg-card/60" />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
