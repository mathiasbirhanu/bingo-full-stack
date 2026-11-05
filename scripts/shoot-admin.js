/* Admin console: engine strip + owner-only draw monitor (called list + draw order). */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  const shot = (name) => page.screenshot({ path: `/tmp/render/${name}.png` });

  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.fill("#phone", "+251911000001");
  await page.getByRole("button", { name: /send my code/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.textContent("body");
  const code = (body.match(/your code is\s*([A-Z0-9]{6})/i) || [])[1];
  if (!code) throw new Error("demo OTP not found");
  await page.fill("#code", code);
  await page.getByRole("button", { name: /enter the hall/i }).click();
  await page.waitForTimeout(2500);

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Console" }).click();
  await page.waitForTimeout(2500);
  await shot("08-admin");

  // Expand the first draw monitor.
  const monitor = page.getByRole("button", { name: /draw monitor/i }).first();
  await monitor.waitFor({ timeout: 8000 });
  await monitor.click();
  await page.waitForTimeout(2500);
  await shot("09-admin-monitor");
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(600);
  await shot("10-admin-monitor-2");

  console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO console/page errors");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
