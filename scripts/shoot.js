/* Screenshot walkthrough of the redesigned player journey (390×844, DPR 2). */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  const out = "/tmp/render";
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

  // 1 — Landing
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await shot("01-landing");

  // 2 — Login (real UI flow)
  await page.fill("#phone", "+251911000003");
  await page.getByRole("button", { name: /send my code/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.textContent("body");
  const code = (body.match(/your code is\s*([A-Z0-9]{6})/i) || [])[1];
  if (!code) throw new Error("demo OTP not found on page");
  await page.fill("#code", code);
  await page.getByRole("button", { name: /enter the hall/i }).click();
  await page.waitForTimeout(2200);

  // 3 — Lobby
  await page.getByText("The Floor").waitFor({ timeout: 8000 });
  await page.waitForTimeout(1000);
  await shot("02-lobby");

  // 4 — Best available room: prefer a LIVE one, else PLAY NOW
  const watch = page.getByRole("button", { name: /watch live/i }).first();
  const play = page.getByRole("button", { name: /play now/i }).first();
  if (await watch.count()) { await watch.click(); } else if (await play.count()) { await play.click(); }
  await page.waitForTimeout(3500); // let the stage + cadence render
  await shot("03-room");

  // 4b — scroll to cards region
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(700);
  await shot("04-room-cards");

  // 5 — Wallet
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Wallet" }).click();
  await page.waitForTimeout(1500);
  await shot("05-wallet");

  console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO console/page errors");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
