/**
 * Headless smoke test: loads the app, writes freehand and with a style,
 * and verifies ink actually lands on the canvas with no console errors.
 *
 *   node e2e/smoke.mjs [baseUrl] [screenshotPath]
 */
import { chromium } from "playwright";

const baseUrl = process.argv[2] ?? "http://localhost:5199";
const screenshotPath = process.argv[3] ?? "smoke.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 720 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

async function inkPixels() {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const context = canvas.getContext("2d");
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200 && data[i] < 100) dark++;
    }
    return dark;
  });
}

await page.goto(baseUrl);
const writeButton = page.getByRole("button", { name: "write" });

// Model load (15 MB) enables the buttons.
await writeButton.waitFor({ state: "visible" });
await page.waitForFunction(
  () => !document.querySelector("button")?.disabled,
  undefined,
  { timeout: 90_000 },
);

// Freehand write. Generation now completes before the pen animates, so the
// wait covers a full generate + partial replay.
await writeButton.click();
await page.waitForTimeout(10_000);
const freehandInk = await inkPixels();

// Styled write (exercises priming in the worker).
await page.selectOption("select", "3");
await writeButton.click();
await page.waitForTimeout(18_000);
const styledInk = await inkPixels();

await page.screenshot({ path: screenshotPath, fullPage: true });
await browser.close();

console.log(`freehand ink pixels: ${freehandInk}`);
console.log(`styled ink pixels:   ${styledInk}`);
if (errors.length > 0) {
  console.error("console errors:", errors);
  process.exit(1);
}
if (freehandInk < 1000 || styledInk < 1000) {
  console.error("canvas looks empty — expected at least 1000 ink pixels");
  process.exit(1);
}
console.log("smoke test passed");
