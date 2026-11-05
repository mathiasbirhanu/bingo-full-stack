"use client";

/**
 * TenantPortal — the partner's own surface (UC-11/13/15, FR-PRT).
 * Distinct from the platform AdminConsole by design: a tenant only ever
 * reaches its own scope (the API forces tenantId from the session), while
 * platform staff supervise read-only.
 *   · Content — author patterns / prize rule sets / room templates; every
 *     save runs the platform validation + guardrails; publishing needs a
 *     TENANT_SUPERVISOR check (maker-checker, self-approval refused).
 *   · KYB — dossier checklist, encrypted vault upload, submit for review.
 *   · Statements — immutable monthly statements: confirm, dispute, payout.
 * Low-bandwidth posture: one fetch per tab, lazy tab switching, manual
 * refresh — no polling loops on this surface.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { FileUp, Landmark, ScrollText, Send, Upload } from "lucide-react";
import { apiGet, apiPost, apiPatch, etb, ApiClientError } from "@/lib/client/api";
import { useApp } from "@/lib/client/store";

interface PortalDraft { id: string; type: string; title: string; status: string; entityName: string | null; currentVersion: number; rejectReason: string | null; createdAt: string; }
interface PortalEntity { id: string; type: string; name: string; currentVersion: number; locked: boolean; }
interface KybItem { type: string; label: string; required: boolean; uploaded: boolean; versions: number; }
interface KybData {
  tenant: { id: string; code: string; legalName: string; status: string; statusReason: string | null; documentSetHash: string | null };
  checklist: KybItem[];
  documents: Array<{ id: string; type: string; version: number; fileName: string; sha256: string; createdAt: string }>;
  reviews: Array<{ id: string; decision: string; note: string; createdAt: string }>;
}
interface StatementRow {
  id: string; periodMonth: string; turnoverSantim: string; prizesSantim: string; commissionSantim: string;
  payableSantim: string; status: string;
}

const STATUS_TONE: Record<string, string> = {
  APPROVED: "bg-emerald-900/40 text-emerald-400 border-emerald-700/60",
  PUBLISHED: "bg-emerald-900/40 text-emerald-400 border-emerald-700/60",
  CONFIRMED: "bg-emerald-900/40 text-emerald-400 border-emerald-700/60",
  SETTLED: "bg-emerald-900/40 text-emerald-400 border-emerald-700/60",
  PENDING: "border-primary/60 text-primary",
  UNDER_REVIEW: "border-primary/60 text-primary",
  ISSUED: "border-primary/60 text-primary",
  DISPUTED: "bg-accent/20 text-accent-foreground border-accent/60",
  REJECTED: "bg-accent/20 text-accent-foreground border-accent/60",
  INFO_REQUESTED: "bg-accent/20 text-accent-foreground border-accent/60",
  REGISTERED: "text-muted-foreground",
};
const Tone = ({ s }: { s: string }) => <Badge variant="outline" className={STATUS_TONE[s] ?? "text-muted-foreground"}>{s}</Badge>;

async function act(p: Promise<unknown>, what: string) {
  try { await p; toast({ title: `${what} ✓` }); return true; }
  catch (err) {
    toast({ title: err instanceof ApiClientError ? err.code : "Failed", description: err instanceof ApiClientError ? err.message : undefined, variant: "destructive" });
    return false;
  }
}

/** Example payloads keep the author on rails; validation still runs server-side. */
function examplePayload(type: string, entities: PortalEntity[]): unknown {
  const patternId = entities.find((e) => e.type === "PATTERN" && e.currentVersion > 0)?.id ?? "<published PATTERN entity id>";
  const rulesetId = entities.find((e) => e.type === "PRIZE_RULESET" && e.currentVersion > 0)?.id ?? "<published PRIZE_RULESET entity id>";
  switch (type) {
    case "PATTERN":
      return { variantId: "BALL_90", kind: "ROWS_MIN", rows: 2 };
    case "PRIZE_RULESET":
      return { rules: [{ patternRef: patternId, label: "Two Lines", awardType: "PERCENT_NET_POOL", valueBps: 5000 }] };
    default:
      return { variantId: "BALL_90", priceSantim: "100", cadenceMinutes: 10, salesOpenMinutes: 2, salesMinutes: 5, rulesetRef: rulesetId, patternRefs: [patternId] };
  }
}

export function TenantPortal() {
  const user = useApp((s) => s.user);
  const isChecker = user?.role === "TENANT_SUPERVISOR" || user?.role === "ADMIN";

  const [tab, setTab] = useState("content");
  const [drafts, setDrafts] = useState<PortalDraft[] | null>(null);
  const [entities, setEntities] = useState<PortalEntity[] | null>(null);
  const [kyb, setKyb] = useState<KybData | null>(null);
  const [statements, setStatements] = useState<StatementRow[] | null>(null);
  const [draftType, setDraftType] = useState("PATTERN");
  const [title, setTitle] = useState("");
  const [payload, setPayload] = useState(JSON.stringify(examplePayload("PATTERN", []), null, 1));
  const [disputeFor, setDisputeFor] = useState<Record<string, { reasonCode: string; note: string }>>({});

  const loadContent = useCallback(async () => {
    const d = await apiGet<{ drafts: PortalDraft[]; entities: PortalEntity[] }>("/api/v1/portal/drafts", { retries: 1 });
    setDrafts(d.drafts); setEntities(d.entities);
  }, []);
  const loadKyb = useCallback(async () => {
    setKyb(await apiGet<KybData>("/api/v1/portal/kyb", { retries: 1 }));
  }, []);
  const loadStatements = useCallback(async () => {
    const s = await apiGet<{ statements: StatementRow[] }>("/api/v1/portal/statements", { retries: 1 });
    setStatements(s.statements);
  }, []);

  useEffect(() => {
    // Same deferred-load posture as AdminConsole: fetch off the effect body.
    const t = setTimeout(() => void loadContent(), 0);
    return () => clearTimeout(t);
  }, [loadContent]);
  // Lazy tab data: fetch inside the event handler chain (not the effect body)
  // so the lint rule on effect-side setState stays satisfied.
  const onTabChange = (next: string) => {
    setTab(next);
    if (next === "kyb" && !kyb) void loadKyb();
    if (next === "statements" && !statements) void loadStatements();
  };

  const submitDraft = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { toast({ title: "VALIDATION_FAILED", description: "Payload is not valid JSON.", variant: "destructive" }); return; }
    const ok = await act(
      apiPost("/api/v1/portal/drafts", { type: draftType, title: title || `${draftType} draft`, payload: parsed }),
      "Draft submitted to checker"
    );
    if (ok) void loadContent();
  };

  const uploadChecklistItem = async (item: KybItem, file: File) => {
    if (file.size > 2 * 1024 * 1024) { toast({ title: "VALIDATION_FAILED", description: "Browser transport caps at 2 MB — the vault allows 10 MB.", variant: "destructive" }); return; }
    const buf = await file.arrayBuffer();
    let bin = ""; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    const ok = await act(
      apiPost("/api/v1/portal/kyb", { action: "upload", type: item.type, fileName: file.name, mime: file.type || "application/octet-stream", dataBase64: btoa(bin) }),
      `${item.type} uploaded to vault`
    );
    if (ok) setKyb(null); // forces a fresh GET on next tab visit
  };

  return (
    <div className="space-y-4">
      <section className="gold-frame rounded-2xl bg-card/85 p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="gold-text font-black tracking-wide text-lg">Partner Portal</h2>
          <p className="text-[11px] text-muted-foreground truncate">
            {kyb ? `${kyb.tenant.code} — ${kyb.tenant.legalName}` : "Tenant self-service (UC-13 / UC-15)"}
          </p>
        </div>
        {kyb ? <Tone s={kyb.tenant.status} /> : <Skeleton className="h-6 w-20 bg-card/60" />}
      </section>

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList className="bg-card/70 border border-border w-full justify-start overflow-x-auto">
          <TabsTrigger value="content"><ScrollText className="w-3.5 h-3.5 mr-1" />Content</TabsTrigger>
          <TabsTrigger value="kyb"><FileUp className="w-3.5 h-3.5 mr-1" />KYB</TabsTrigger>
          <TabsTrigger value="statements"><Landmark className="w-3.5 h-3.5 mr-1" />Statements</TabsTrigger>
        </TabsList>

        {/* ── Content (UC-13) ─────────────────────────────────────────── */}
        <TabsContent value="content" className="space-y-3 mt-3">
          <div className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
            <p className="text-xs text-muted-foreground">Author game content — validation + guardrails run on save; a checker must publish it (maker-checker, UC-08).</p>
            <div className="flex gap-2">
              <select
                aria-label="Draft type"
                className="h-9 rounded-md border border-border bg-background/60 px-2 text-sm"
                value={draftType}
                onChange={(e) => { setDraftType(e.target.value); setPayload(JSON.stringify(examplePayload(e.target.value, entities ?? []), null, 1)); }}
              >
                <option value="PATTERN">Pattern</option>
                <option value="PRIZE_RULESET">Prize ruleset</option>
                <option value="ROOM_TEMPLATE">Room template</option>
              </select>
              <Input className="h-9 text-sm" placeholder="Draft title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <textarea
              aria-label="Payload JSON"
              className="w-full h-28 rounded-md border border-border bg-background/60 p-2 text-[11px] font-mono luxe-scroll"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              spellCheck={false}
            />
            <Button size="sm" className="btn-gold font-bold" onClick={() => void submitDraft()}>
              <Send className="w-3.5 h-3.5 mr-1" /> Submit for check
            </Button>
          </div>

          {(drafts ?? []).slice(0, 10).map((d) => (
            <div key={d.id} className="rounded-xl border border-border bg-card/70 p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">{d.title}</p>
                <p className="text-[11px] text-muted-foreground">{d.type}{d.entityName ? ` · ${d.entityName} v${d.currentVersion}` : " · new entity"}{d.rejectReason ? ` · ${d.rejectReason}` : ""}</p>
              </div>
              <div className="flex items-center gap-1.5 flex-none">
                <Tone s={d.status} />
                {d.status === "PENDING" && isChecker && (
                  <>
                    <Button size="sm" variant="outline" className="h-8 text-xs border-primary/50 text-primary"
                      onClick={async () => { const ok = await act(apiPatch("/api/v1/portal/drafts", { draftId: d.id, action: "approve" }), "Published"); if (ok) void loadContent(); }}>
                      ✓
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs border-accent/60 text-accent-foreground"
                      onClick={async () => { const ok = await act(apiPatch("/api/v1/portal/drafts", { draftId: d.id, action: "reject", reason: "portal rejection" }), "Rejected"); if (ok) void loadContent(); }}>
                      ✕
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!drafts && <Skeleton className="h-24 w-full bg-card/60" />}
        </TabsContent>

        {/* ── KYB (UC-11) ─────────────────────────────────────────────── */}
        <TabsContent value="kyb" className="space-y-3 mt-3">
          {!kyb ? (
            <Skeleton className="h-40 w-full bg-card/60" />
          ) : (
            <>
              <div className="gold-frame rounded-2xl bg-card/85 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold">Dossier checklist</p>
                  <Tone s={kyb.tenant.status} />
                </div>
                {kyb.checklist.map((item) => (
                  <div key={item.type} className="flex items-center justify-between gap-2 bg-background/30 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{item.label}</p>
                      <p className="text-[10px] text-muted-foreground">{item.uploaded ? `${item.versions} version(s) in vault` : item.required ? "required — missing" : "optional"}</p>
                    </div>
                    <label className="flex-none">
                      <input type="file" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadChecklistItem(item, f); }} aria-label={`Upload ${item.label}`} />
                      <span className="btn-gold inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-bold cursor-pointer">
                        <Upload className="w-3.5 h-3.5" /> Upload
                      </span>
                    </label>
                  </div>
                ))}
                {["REGISTERED", "INFO_REQUESTED"].includes(kyb.tenant.status) && (
                  <Button size="sm" className="btn-gold font-bold"
                    onClick={async () => { const ok = await act(apiPost("/api/v1/portal/kyb", { action: "submit-for-review" }), "Dossier submitted for review"); if (ok) void loadKyb(); }}>
                    <Send className="w-3.5 h-3.5 mr-1" /> Submit for compliance review
                  </Button>
                )}
              </div>
              {kyb.reviews.map((r) => (
                <div key={r.id} className="rounded-xl border border-border bg-card/70 p-3">
                  <div className="flex items-center justify-between"><Tone s={r.decision} /><span className="text-[10px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span></div>
                  <p className="text-xs text-muted-foreground mt-1">{r.note}</p>
                </div>
              ))}
            </>
          )}
        </TabsContent>

        {/* ── Statements (UC-15) ──────────────────────────────────────── */}
        <TabsContent value="statements" className="space-y-3 mt-3">
          {!statements ? (
            <Skeleton className="h-32 w-full bg-card/60" />
          ) : statements.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No statements issued yet — finance issues them per month (FR-PRT-17).</p>
          ) : (
            statements.map((s) => (
              <div key={s.id} className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold">{s.periodMonth}</p>
                  <Tone s={s.status} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-center text-[11px]">
                  {[
                    ["Turnover", etb(s.turnoverSantim)],
                    ["Prizes", etb(s.prizesSantim)],
                    ["Commission", etb(s.commissionSantim)],
                    ["Payable", etb(s.payableSantim)],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-background/40 py-1.5">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{k}</p>
                      <p className="font-bold tabular-nums">{v} ETB</p>
                    </div>
                  ))}
                </div>
                {s.status === "ISSUED" && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-8 text-xs border-primary/50 text-primary"
                      onClick={async () => { const ok = await act(apiPost(`/api/v1/portal/statements/${s.id}`, { action: "confirm" }), "Statement confirmed"); if (ok) void loadStatements(); }}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs border-accent/60 text-accent-foreground"
                      onClick={async () => {
                        const d = disputeFor[s.id] ?? { reasonCode: "", note: "" };
                        if (!d.reasonCode || !d.note) { toast({ title: "VALIDATION_FAILED", description: "Reason code + note required.", variant: "destructive" }); return; }
                        const ok = await act(apiPost(`/api/v1/portal/statements/${s.id}`, { action: "dispute", ...d }), "Dispute raised");
                        if (ok) void loadStatements();
                      }}>
                      Dispute
                    </Button>
                  </div>
                )}
                {s.status === "ISSUED" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input className="h-8 text-xs" placeholder="DISPUTE_REASON_CODE" value={disputeFor[s.id]?.reasonCode ?? ""}
                      onChange={(e) => setDisputeFor((m) => ({ ...m, [s.id]: { note: m[s.id]?.note ?? "", reasonCode: e.target.value } }))} />
                    <Input className="h-8 text-xs" placeholder="Dispute note" value={disputeFor[s.id]?.note ?? ""}
                      onChange={(e) => setDisputeFor((m) => ({ ...m, [s.id]: { reasonCode: m[s.id]?.reasonCode ?? "", note: e.target.value } }))} />
                  </div>
                )}
                {s.status === "CONFIRMED" && (
                  <Button size="sm" className="btn-gold font-bold"
                    onClick={async () => {
                      const payable = Number(s.payableSantim);
                      if (payable <= 0) { toast({ title: "VALIDATION_FAILED", description: "Nothing payable on this statement.", variant: "destructive" }); return; }
                      const ok = await act(apiPost(`/api/v1/portal/statements/${s.id}`, { action: "request-payout", amountSantim: String(payable) }), "Payout requested (finance check next)");
                      if (ok) void loadStatements();
                    }}>
                    Request payout
                  </Button>
                )}
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
