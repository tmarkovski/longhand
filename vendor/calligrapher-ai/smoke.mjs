/**
 * Headless smoke test for the calligrapher.ai snapshot: loads run.html,
 * waits for d.bin to parse, generates a line freehand and with a fixed
 * style, and verifies SVG ink appears with no console errors.
 *
 *   python3 -m http.server 8741   (from this folder)
 *   node smoke.mjs [baseUrl] [screenshotDir]
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(
  path.join(fileURLToPath(import.meta.url), "../../../apps/web/package.json"),
);
const { chromium } = require("playwright");

const baseUrl = process.argv[2] ?? "http://localhost:8741";
const shotDir = process.argv[3] ?? ".";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 720 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const pathCount = () => page.evaluate(() => document.querySelectorAll("#canvas path").length);

/** Generation animates over rAF; wait until the path count stops growing. */
async function generate(text, style) {
  await page.selectOption("#select-style", style);
  await page.fill("#text-input", text);
  await page.click("#draw-button");
  let previous = -1;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(500);
    const current = await pathCount();
    if (current > 0 && current === previous) return current;
    previous = current;
  }
  throw new Error("generation did not settle within 60s");
}

await page.goto(`${baseUrl}/run.html`);
await page.waitForSelector("#loading-indicator", { state: "detached", timeout: 30000 });
console.log("weights loaded and parsed");

const freehand = await generate("the quick brown fox", "-");
await page.screenshot({ path: path.join(shotDir, "smoke-random-style.png") });
console.log(`random style: ${freehand} svg paths`);

const styled = await generate("jumps over the lazy dog", "3");
await page.screenshot({ path: path.join(shotDir, "smoke-style-3.png") });
console.log(`style 3: ${styled} svg paths`);

await browser.close();
if (errors.length) {
  console.error("console errors:", errors);
  process.exit(1);
}
console.log("smoke ok");
