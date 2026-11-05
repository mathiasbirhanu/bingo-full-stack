/* Focused probe: enter a live room, dump board state + transport + raw counts. */
const { chromium } = require("playwright");
const BASE = "http://localhost:3000";

(async () => {
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("response", (res) => { if (res.url().includes("/events")) console.log("events response:", res.status(), res.url().slice(-60)); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("#phone", "+251911000003");
  await page.getByRole("button", { name: /send my code/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.textContent("body");
  const code = (body.match(/your code is\s*([A-Z0-9]{6})/i) || [])[1];
  await page.fill("#code", code);
  await page.getByRole("button", { name: /enter the hall/i }).click();
  await page.waitForTimeout(2200);

  // enter the first WATCH LIVE room (guaranteed drawing)
  const watch = page.getByRole("button", { name: /watch live/i }).first();
  if (await watch.count()) await watch.click();
  else await page.getByRole("button", { name: /play now/i }).first().click();
  await page.waitForTimeout(6000);

  const probe = await page.evaluate(async () => {
    const lit = document.querySelectorAll("span[class*='board-lit']").length;
    const spheres = document.querySelectorAll("span[class*='ball-sphere']").length;
    const badge = document.querySelector("section span[class*='badge']")?.textContent ?? "no badge";
    const transport = document.querySelector("span[class*='emerald']")?.textContent ?? "no transport chip";
    const ev = await fetch("/api/v1/rooms").then((r) => r.json());
    const room = ev.data.find((r) => r.status === "DRAWING");
    let balls = -1;
    if (room) {
      const snap = await fetch(`/api/v1/rooms/${room.id}/events?afterSeq=0`).then((r) => r.json());
      balls = snap.data.balls.length;
    }
    return { lit, spheres, badge, transport, drawingRoom: room?.title ?? "none", ballsFromPageFetch: balls, boardHTMLSample: document.querySelector("span[class*='board-lit']")?.outerHTML?.slice(0, 160) ?? "NONE" };
  });
  console.log("PROBE:", JSON.stringify(probe, null, 1));
  console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO console/page errors");
  await page.screenshot({ path: "/tmp/render/probe.png" });
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
