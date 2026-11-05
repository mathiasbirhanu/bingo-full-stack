/* Manual-play verification journey: board+card side-by-side, tap-to-daub,
 * BINGO! bar, claim API honesty, admin live speed control. 390×844 DPR 2. */
const { chromium } = require("playwright");

  const BASE = "http://localhost:3000";

async function login(page, phone) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("#phone", phone);
  await page.getByRole("button", { name: /send my code/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.textContent("body");
  const code = (body.match(/your code is\s*([A-Z0-9]{6})/i) || [])[1];
  if (!code) throw new Error(`demo OTP not found for ${phone}`);
  await page.fill("#code", code);
  await page.getByRole("button", { name: /enter the hall/i }).click();
  await page.waitForTimeout(2200);
}

(async () => {
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  let currentRoomId = null;
  page.on("response", (res) => {
    const m = res.url().match(/\/api\/v1\/rooms\/([a-z0-9]+)\/?$/i);
    if (m) currentRoomId = m[1];
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  const out = "/tmp/render";
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
  const log = (m) => console.log(`• ${m}`);

  // 1 — landing + login as the funded demo player
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot("m1-landing");
  await login(page, "+251911000003");

  // 2 — lobby → first room
  await page.getByText("The Floor").waitFor({ timeout: 8000 });
  await page.waitForTimeout(800);
  await shot("m2-lobby");
  const watch = page.getByRole("button", { name: /watch live/i }).first();
  const play = page.getByRole("button", { name: /play now/i }).first();
  const preview = page.getByRole("button", { name: /preview/i }).first();
  if (await play.count()) await play.click();
  else if (await watch.count()) await watch.click();
  else if (await preview.count()) await preview.click();
  else throw new Error("no rooms in lobby");
  await page.waitForTimeout(2500);

  // 3 — buy 2 cards if sales are open (drawing starts at scheduledAt)
  const buyBtn = page.getByRole("button", { name: /buy \d+ for/i }).first();
  if (await buyBtn.count()) {
    await page.getByRole("button", { name: "×2", exact: true }).click().catch(() => undefined);
    await buyBtn.click();
    await page.waitForTimeout(1800);
    log("bought 2 cards");
  } else {
    log("sales closed — riding the live round as a watcher");
  }

  // 4 — wait for the draw: at least 4 balls lit on the called board
  await page.waitForFunction(
    () => document.querySelectorAll("span[class*='ball-sphere'][class*='board-lit']").length >= 4,
    undefined,
    { timeout: 150_000, polling: 750 }
  );
  log(`current room: ${currentRoomId}`);
  log(`board lit cells: ${await page.locator("span[class*='board-lit']").count()}`);
  await shot("m3-room-board");

  // 5 — scroll to the cards, verify manual tap-to-daub
  const cardHeader = page.getByText(/My cards \(\d+\)/).first();
  if (await cardHeader.count()) {
    await cardHeader.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }
  await shot("m4-cards");

  const tapButtons = page.locator("button[aria-label^='Tap to daub']");
  log(`tappable cells: ${await tapButtons.count()}`);
  let markedBefore = await page.locator("button[aria-label$='marked']").count();
  // tap up to 6 cells — some called (mark), some not (shake + buzz)
  const n = Math.min(6, await tapButtons.count());
  for (let i = 0; i < n; i++) {
    await tapButtons.nth(i).click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(160);
  }
  const markedAfter = await page.locator("button[aria-label$='marked']").count();
  log(`marked cells before=${markedBefore} after=${markedAfter} (manual daub ${markedAfter > markedBefore ? "WORKS" : "no-op?"})`);
  await shot("m5-cards-tapped");

  // 6 — BINGO! bar present (manual hall) + claim honesty via the API
  const bingo = page.getByRole("button", { name: /bingo/i }).last();
  log(`BINGO! bar visible: ${await bingo.isVisible().catch(() => false)}, disabled=${await bingo.isDisabled().catch(() => "n/a")}`);

  // patterns popup
  const info = page.getByRole("button", { name: "How to win" }).last();
  if (await info.count()) {
    await info.click();
    await page.waitForTimeout(900);
    await shot("m6-patterns-popup");
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await page.waitForTimeout(500);
  }

  // claim through the real endpoint (cookies ride the page session)
  const claim = await page.evaluate(async (roomId) => {
    const res = await (await fetch(`/api/v1/rooms/${roomId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json();
    return res;
  }, currentRoomId);
  log(`claim API → ok=${claim.ok} claimed=${claim.data?.claimed} reason=${claim.data?.reason ?? "-"} msg=${claim.data?.message ?? "-"}`);
  await shot("m7-bingo-bar");

  // 7 — admin: live caller speed control (own context = own session)
  const adminCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const admin = await adminCtx.newPage();
  await login(admin, "+251911000001");
  const engine = await admin.evaluate(async () => (await (await fetch("/api/v1/admin/engine")).json()).data);
  const target = engine.liveRooms.find((r) => ["SALES_OPEN", "LOCKED", "DRAWING"].includes(r.status)) ?? engine.liveRooms[0];
  log(`admin tuning room "${target.title}" (${target.status}) from ${target.ballIntervalMs}ms`);
  const setSpeed = await admin.evaluate(async (id) => {
    const res = await (await fetch(`/api/v1/admin/rounds/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-speed", ballIntervalMs: 1000 }),
    })).json();
    return res;
  }, target.id);
  log(`set-speed → ok=${setSpeed.ok} interval=${setSpeed.data?.ballIntervalMs}ms`);
  const events = await admin.evaluate(async (id) => {
    const res = await (await fetch(`/api/v1/rooms/${id}/events?afterSeq=0`)).json();
    return { interval: res.data.ballIntervalMs, balls: res.data.balls.length };
  }, target.id);
  log(`events after speed change → intervalMs=${events.interval} balls=${events.balls} ${events.interval === 1000 ? "SPEED LIVE ✓" : "SPEED NOT APPLIED ✗"}`);
  const setMode = await admin.evaluate(async (id) => {
    const res = await (await fetch(`/api/v1/admin/rounds/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-claim-mode", autoClaim: false }),
    })).json();
    return res;
  }, target.id);
  log(`set-claim-mode → ok=${setMode.ok} autoClaim=${setMode.data?.autoClaim}`);

  console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO console/page errors");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
