/**
 * Headless smoke test: loads the app, writes freehand and with a style,
 * switches to the calligrapher engine and writes again, and verifies ink
 * actually lands on the canvas with no console errors.
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

// Model load (15 MB) enables the write button. (The style-picker trigger is
// also a button and never disables, so target the write button by text.)
await writeButton.waitFor({ state: "visible" });
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent.trim() === "write" && !button.disabled,
    ),
  undefined,
  { timeout: 90_000 },
);

// Freehand write. Generation now completes before the pen animates, so the
// wait covers a full generate + partial replay.
await writeButton.click();
await page.waitForTimeout(10_000);
const freehandInk = await inkPixels();

// Styled write (exercises priming in the worker), via the preview picker.
await page.click(".style-picker-trigger");
await page.getByRole("option", { name: "style 3", exact: true }).click();
await writeButton.click();
await page.waitForTimeout(18_000);
const styledInk = await inkPixels();

// Engine switch: the calligrapher model loads (2.6 MB), the style picker
// re-populates with the calligrapher styles, and a write paints ribbons.
const waitForIdle = () =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "write" && !button.disabled,
      ),
    undefined,
    { timeout: 90_000 },
  );
await page.selectOption(".engine-select", "calligrapher");
await waitForIdle();
await page.click(".style-picker-trigger");
await page.getByRole("option", { name: "style 6", exact: true }).click();
await writeButton.click();
await page.waitForTimeout(12_000);
const calligrapherInk = await inkPixels();

// Ink settings restyle the finished line without a rewrite: pick blue
// (red channel low, so inkPixels still counts it) and max thickness, then
// confirm the repaint kept — and fattened — the ink.
await page.getByRole("radio", { name: "ink color: blue" }).click();
await page.getByLabel("thickness").press("End");
await page.waitForTimeout(1_000);
const restyledInk = await inkPixels();

// And back: the graves engine is cached, so this is instant.
await page.selectOption(".engine-select", "graves");
await waitForIdle();

await page.screenshot({ path: screenshotPath, fullPage: true });
await browser.close();

console.log(`freehand ink pixels:     ${freehandInk}`);
console.log(`styled ink pixels:       ${styledInk}`);
console.log(`calligrapher ink pixels: ${calligrapherInk}`);
console.log(`restyled ink pixels:     ${restyledInk}`);
if (errors.length > 0) {
  console.error("console errors:", errors);
  process.exit(1);
}
if (freehandInk < 1000 || styledInk < 1000 || calligrapherInk < 1000) {
  console.error("canvas looks empty — expected at least 1000 ink pixels");
  process.exit(1);
}
if (restyledInk <= calligrapherInk) {
  console.error("thickness change did not fatten the ink");
  process.exit(1);
}
console.log("smoke test passed");
