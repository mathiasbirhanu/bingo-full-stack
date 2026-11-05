/**
 * Bootstrap seed — idempotent (safe to re-run at any time).
 *
 * Creates exactly what the SRS demo needs and nothing more:
 *   · bootstrap funding: EXTERNAL_FUNDING → PAYMENT_CLEARING:DEMO (balanced)
 *   · variants BALL_75 / BALL_90 (FR-GAME-01)
 *   · pattern catalogue + prize rulesets + room templates, all as published
 *     ConfigVersions (UC-07/08 versioned config, Build-1 direct seed)
 *   · platform ADMIN, tenant + TENANT_OWNER, one funded demo player (UC-01/02)
 *   · one approved commission plan (UC-12, D-PRT-02 turnover basis)
 *   · rolling demo rooms via the production scheduler input
 *
 * Room templates republish a new ConfigVersion when the payload changes, so
 * existing installs pick up tuned cadence/claim settings on re-seed without
 * touching live or finished rounds (UC-07 versioning keeps history intact).
 *
 * Run: bun run scripts/seed.ts
 */
import { db } from "../src/lib/db";
import { postTransaction, AccountCodes } from "../src/modules/ledger";
import { ensureAccount } from "../src/modules/ledger/accounts";
import { encryptPhone, phoneBlindIndex, hashPayload, sha256Hex } from "../src/lib/crypto";
import { normalizeEthiopianPhone } from "../src/lib/crypto";
import { PatternFactory } from "../src/modules/game-core/patterns";
import { validateRulesetShape, type RulesetPayload } from "../src/modules/prize/rulesets";
import { ensureRollingRooms } from "../src/modules/rooms/queries";
import { activatePlan } from "../src/modules/commission/plans";

async function upsertUser(phone: string, role: string, tenantId: string | null, displayName: string | null) {
  const e164 = normalizeEthiopianPhone(phone)!;
  const idx = phoneBlindIndex(e164);
  const existing = await db.user.findUnique({ where: { phoneBlindIdx: idx } });
  if (existing) {
    if (existing.role !== role || (existing.tenantId ?? null) !== tenantId) {
      return db.user.update({ where: { id: existing.id }, data: { role, tenantId, displayName: displayName ?? existing.displayName } });
    }
    return existing;
  }
  return db.user.create({
    data: { phoneE164: encryptPhone(e164), phoneBlindIdx: idx, role, tenantId, displayName },
  });
}

async function publishEntity(input: {
  type: string;
  name: string;
  tenantId: string | null;
  payload: unknown;
  publishedById: string;
  /** Republish a new version when the payload differs (templates only). */
  republishIfChanged?: boolean;
}) {
  const existing = await db.configEntity.findFirst({
    where: { type: input.type, name: input.name, tenantId: input.tenantId },
  });
  if (existing && existing.currentVersion > 0) {
    const v = await db.configVersion.findFirst({
      where: { entityId: existing.id, version: existing.currentVersion },
    });
    if (v) {
      if (input.republishIfChanged && !existing.locked) {
        let same = false;
        try {
          same = JSON.stringify(JSON.parse(v.payloadJson)) === JSON.stringify(input.payload);
        } catch {
          same = false;
        }
        if (!same) {
          const version = await db.configVersion.create({
            data: {
              entityId: existing.id,
              version: existing.currentVersion + 1,
              payloadJson: JSON.stringify(input.payload),
              payloadHash: hashPayload(input.payload),
              publishedById: input.publishedById,
            },
          });
          await db.configEntity.update({ where: { id: existing.id }, data: { currentVersion: version.version } });
          console.log(`↻ republished ${input.name} → v${version.version} (tuned settings)`);
          return { entity: { ...existing, currentVersion: version.version }, version };
        }
      }
      return { entity: existing, version: v };
    }
  }
  const entity =
    existing ??
    (await db.configEntity.create({
      data: { type: input.type, name: input.name, tenantId: input.tenantId },
    }));
  const version = await db.configVersion.create({
    data: {
      entityId: entity.id,
      version: entity.currentVersion + 1,
      payloadJson: JSON.stringify(input.payload),
      payloadHash: hashPayload(input.payload),
      publishedById: input.publishedById,
    },
  });
  await db.configEntity.update({ where: { id: entity.id }, data: { currentVersion: version.version } });
  return { entity, version };
}

async function main() {
  console.log("── bingo seed: start ──");

  // 1. Bootstrap funding (balanced: equity → demo clearing).
  await ensureAccount({ code: AccountCodes.externalFunding(), type: "EQUITY", displayName: "External funding (bootstrap)" });
  await postTransaction(db, {
    kind: "ADJUSTMENT",
    idempotencyKey: "seed:bootstrap:funding:v1",
    memo: "Bootstrap funding — EXTERNAL_FUNDING to demo clearing",
    entries: [
      { accountCode: AccountCodes.externalFunding(), accountType: "EQUITY", accountName: "External funding (bootstrap)", direction: "CREDIT", amount: 100_000_000n },
      { accountCode: AccountCodes.paymentClearing(), accountType: "ASSET", accountName: "Demo payment clearing", direction: "DEBIT", amount: 100_000_000n },
    ],
  });
  console.log("✓ bootstrap funding (1,000,000.00 ETB in demo clearing)");

  // 2. Variants.
  for (const v of [
    { id: "BALL_75", name: "75-Ball American Bingo", gridSpec: JSON.stringify({ rows: 5, cols: 5, freeCells: [[2, 2]] }) },
    { id: "BALL_90", name: "90-Ball UK Bingo", gridSpec: JSON.stringify({ rows: 3, cols: 9, freeCells: [] }) },
  ]) {
    await db.variant.upsert({ where: { id: v.id }, create: v, update: {} });
  }
  console.log("✓ variants BALL_75 / BALL_90");

  // 3. Admin officer first (publisher of record for all config).
  const admin = await upsertUser("+251911000001", "ADMIN", null, "Platform Admin");

  // 4. Pattern catalogue (versioned config entities).
  const corners = await publishEntity({ type: "PATTERN", name: "Four Corners", tenantId: null, payload: PatternFactory.fourCorners75(), publishedById: admin.id });
  const xPattern = await publishEntity({ type: "PATTERN", name: "X Pattern", tenantId: null, payload: PatternFactory.x75(), publishedById: admin.id });
  const topLine = await publishEntity({ type: "PATTERN", name: "Top Line", tenantId: null, payload: PatternFactory.row75(0), publishedById: admin.id });
  const blackout = await publishEntity({ type: "PATTERN", name: "Blackout", tenantId: null, payload: PatternFactory.blackout75(), publishedById: admin.id });
  const line90 = await publishEntity({ type: "PATTERN", name: "One Line", tenantId: null, payload: PatternFactory.line90(), publishedById: admin.id });
  const twoLines90 = await publishEntity({ type: "PATTERN", name: "Two Lines", tenantId: null, payload: PatternFactory.twoLines90(), publishedById: admin.id });
  const fullHouse90 = await publishEntity({ type: "PATTERN", name: "Full House", tenantId: null, payload: PatternFactory.fullHouse90(), publishedById: admin.id });
  console.log("✓ pattern catalogue (7 patterns)");

  // 5. Prize rulesets — worst-case stays inside the payout guardrails.
  const rules75: RulesetPayload = {
    rules: [
      { patternRef: corners.entity.id, label: "Four Corners", awardType: "PERCENT_NET_POOL", valueBps: 1500 },
      { patternRef: xPattern.entity.id, label: "X Pattern", awardType: "PERCENT_NET_POOL", valueBps: 2000 },
      { patternRef: topLine.entity.id, label: "Top Line", awardType: "PERCENT_NET_POOL", valueBps: 2500 },
      { patternRef: blackout.entity.id, label: "Blackout", awardType: "PERCENT_NET_POOL", valueBps: 3000 },
    ],
  };
  const rules90: RulesetPayload = {
    rules: [
      { patternRef: line90.entity.id, label: "One Line", awardType: "PERCENT_NET_POOL", valueBps: 2000 },
      { patternRef: twoLines90.entity.id, label: "Two Lines", awardType: "PERCENT_NET_POOL", valueBps: 3000 },
      { patternRef: fullHouse90.entity.id, label: "Full House", awardType: "PERCENT_NET_POOL", valueBps: 3500 },
    ],
  };
  if (!validateRulesetShape(rules75).valid || !validateRulesetShape(rules90).valid) throw new Error("seed ruleset invalid");
  const rs75 = await publishEntity({ type: "PRIZE_RULESET", name: "Golden Rules 75", tenantId: null, payload: rules75, publishedById: admin.id });
  const rs90 = await publishEntity({ type: "PRIZE_RULESET", name: "Golden Rules 90", tenantId: null, payload: rules90, publishedById: admin.id });
  console.log("✓ prize rulesets (75-ball, 90-ball)");

  // 6. Room templates — the rolling scheduler's input.
  const tplGolden = await publishEntity({
    type: "ROOM_TEMPLATE",
    name: "Golden Hall 75",
    tenantId: null,
    republishIfChanged: true,
    payload: {
      title: "Golden Hall 75",
      variantId: "BALL_75",
      priceSantim: "500",
      cadenceMinutes: 10,
      salesOpenMinutes: 4,
      salesMinutes: 1,
      ballIntervalMs: 2000,
      autoClaim: false,
      rulesetRef: rs75.entity.id,
      patternRefs: [corners.entity.id, xPattern.entity.id, topLine.entity.id, blackout.entity.id],
    },
    publishedById: admin.id,
  });
  const tplRapid = await publishEntity({
    type: "ROOM_TEMPLATE",
    name: "Rapid Fire 90",
    tenantId: null,
    republishIfChanged: true,
    payload: {
      title: "Rapid Fire 90",
      variantId: "BALL_90",
      priceSantim: "300",
      cadenceMinutes: 8,
      salesOpenMinutes: 3,
      salesMinutes: 1,
      ballIntervalMs: 1800,
      autoClaim: false,
      rulesetRef: rs90.entity.id,
      patternRefs: [line90.entity.id, twoLines90.entity.id, fullHouse90.entity.id],
    },
    publishedById: admin.id,
  });
  console.log("✓ room templates (Golden Hall 75 @2s, Rapid Fire 90 @1.8s — manual BINGO! claims)");

  // 7. Tenant (KYB-approved) + owner + commission plan (UC-11/12).
  let tenant = await db.tenant.findFirst({ where: { code: "SHEGER" } });
  if (!tenant) {
    tenant = await db.tenant.create({
      data: {
        code: "SHEGER",
        legalName: "Sheger Entertainment PLC",
        tin: "00-1234567890",
        jurisdiction: "Addis Ababa, Ethiopia",
        contactEmail: "ops@sheger-demo.et",
        contactPhone: "+251911000002",
        status: "REGISTERED",
        beneficialOwners: JSON.stringify([{ name: "Abebe Kebede", idType: "PASSPORT", idRef: "ET-DEMO-0001", sharePct: 100 }]),
      },
    });
  }
  const owner = await upsertUser("+251911000002", "TENANT_OWNER", tenant.id, "Sheger Ops");
  if (tenant.status !== "APPROVED") {
    await db.tenant.update({
      where: { id: tenant.id },
      data: { status: "APPROVED", approvedAt: new Date(), statusReason: null, documentSetHash: sha256Hex("seed:dossier:v1") },
    });
    await db.kybReview.create({
      data: { tenantId: tenant.id, officerId: admin.id, decision: "APPROVED", note: "Seed approval — demo dossier", documentSetHash: sha256Hex("seed:dossier:v1") },
    });
  }
  if ((await db.commissionPlan.count({ where: { tenantId: tenant.id } })) === 0) {
    await activatePlan(
      { tenantId: tenant.id, rateBps: 2500, basis: "TURNOVER", effectiveFrom: new Date(Date.now() - 3600_000) },
      admin.id,
      "seed:plan:v1"
    );
  }
  console.log(`✓ tenant ${tenant.code} APPROVED, owner ${owner.id.slice(-4)}, commission 25.00% TURNOVER`);

  // Tenant-branded template — proves tenant-owned content flows through the
  // same scheduler (FR-PRT-05/06; platform stays read-only supervisor).
  await publishEntity({
    type: "ROOM_TEMPLATE",
    name: "Sheger Lounge 90",
    tenantId: tenant.id,
    republishIfChanged: true,
    payload: {
      title: "Sheger Lounge 90",
      variantId: "BALL_90",
      priceSantim: "400",
      cadenceMinutes: 12,
      salesOpenMinutes: 4,
      salesMinutes: 1,
      ballIntervalMs: 2200,
      autoClaim: false,
      rulesetRef: rs90.entity.id,
      patternRefs: [line90.entity.id, twoLines90.entity.id, fullHouse90.entity.id],
    },
    publishedById: admin.id,
  });
  console.log("✓ tenant room template (Sheger Lounge 90)");

  // 8. Demo player with a funded wallet (UC-02 demo deposit, ledger-real).
  const demoPlayer = await upsertUser("+251911000003", "PLAYER", null, "Lucky Star");
  await postTransaction(db, {
    kind: "DEPOSIT",
    idempotencyKey: "seed:deposit:demo:v1",
    memo: "Demo player wallet funding (simulated checkout)",
    entries: [
      { accountCode: AccountCodes.paymentClearing(), accountType: "ASSET", accountName: "Demo payment clearing", direction: "DEBIT", amount: 50_000n },
      { accountCode: AccountCodes.playerWallet(demoPlayer.id), accountType: "LIABILITY", accountName: "Player wallet", direction: "CREDIT", amount: 50_000n, ownerUserId: demoPlayer.id },
    ],
  });
  console.log(`✓ demo player funded (500.00 ETB) — ${demoPlayer.id}`);

  // 9. Rolling rooms via the production scheduler input.
  const created = await ensureRollingRooms(3);
  console.log(`✓ rolling rooms ensured (${created.length} created now, scheduler keeps them flowing)`);

  console.log("── bingo seed: done ──");
  await db.$disconnect();
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
