/* Player journey with a real card: buy → wait for the draw → cards + BINGO! bar. */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  const shot = (name) => page.screenshot({ path: `/tmp/render/${name}.png` });

  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.fill("#phone", "+251911000003");
  await page.getByRole("button", { name: /send my code/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.textContent("body");
  const code = (body.match(/your code is\s*([A-Z0-9]{6})/i) || [])[1];
  if (!code) throw new Error("demo OTP not found");
  await page.fill("#code", code);
  await page.getByRole("button", { name: /enter the hall/i }).click();
  await page.getByText("The Floor").waitFor({ timeout: 8000 });

  // Join the first room with cards on sale — poll; the scheduler tops rooms
  // up every 30s, so a sale window opens within a couple of minutes.
  let joined = false;
  for (let i = 0; i < 36 && !joined; i++) {
    const play = page.getByRole("button", { name: /play now/i }).first();
    if (await play.count()) {
      await play.click();
      joined = true;
      break;
    }
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
  }
  if (!joined) throw new Error("no room opened sales within the wait window");
  await page.waitForTimeout(2500);

  // Buy one card.
  const buy = page.getByRole("button", { name: /buy 1 for/i }).first();
  await buy.waitFor({ timeout: 6000 });
  await buy.click();
  await page.waitForTimeout(2000);

  // Wait until the round draws (sales close ~1 min after start).
  await page.waitForTimeout(45_000);
  await shot("06-my-room");

  // Cards + sticky BINGO! bar.
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(800);
  await shot("07-my-cards");

  console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO console/page errors");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
