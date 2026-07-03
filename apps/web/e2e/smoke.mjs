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

// Every control besides the text row lives in a collapsed options panel;
// open it once and leave it open for the whole run.
await page.getByRole("button", { name: /^options/ }).click();

// Freehand write. Generation now completes before the pen animates, so the
// wait covers a full generate + partial replay.
await writeButton.click();
await page.waitForTimeout(10_000);
const freehandInk = await inkPixels();

// Stroke type is engine-independent: flip the finished graves line to
// ribbon, confirm the in-place repaint still inks, and flip back.
await page.getByRole("radio", { name: "ribbon" }).click();
await page.waitForTimeout(500);
const gravesRibbonInk = await inkPixels();
await page.getByRole("radio", { name: "pen", exact: true }).click();
await page.waitForTimeout(500);

// Replay rewinds the finished line and animates it again: shortly after
// clicking there should be some ink, but much less than the finished line.
const seedBeforeReplay = await page.locator("footer").textContent();
await page.getByRole("button", { name: "replay" }).click();
await page.waitForTimeout(700);
const replayInk = await inkPixels();
if (replayInk <= 0 || replayInk >= freehandInk * 0.8) {
  console.error(`replay did not restart the animation (${replayInk} vs ${freehandInk})`);
  process.exit(1);
}
if ((await page.locator("footer").textContent()) !== seedBeforeReplay) {
  console.error("replay changed the seed — it should reuse the same take");
  process.exit(1);
}

// Styled write (exercises priming in the worker), via the preview picker.
// Every write draws a fresh seed, so the footer should change.
await page.click(".style-picker-trigger");
await page.getByRole("option", { name: "style 3", exact: true }).click();
await writeButton.click();
await page.waitForTimeout(18_000);
const styledInk = await inkPixels();
if ((await page.locator("footer").textContent()) === seedBeforeReplay) {
  console.error("write reused the previous seed — every write should reshuffle");
  process.exit(1);
}

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
// Calligrapher has no freehand/random mode: style 1 is preselected.
const defaultStyle = await page
  .locator(".style-picker-trigger")
  .getAttribute("aria-label");
if (defaultStyle !== "handwriting style: style 1") {
  console.error(`calligrapher default style is "${defaultStyle}", expected style 1`);
  process.exit(1);
}
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
console.log(`graves-as-ribbon pixels: ${gravesRibbonInk}`);
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
if (gravesRibbonInk < 1000) {
  console.error("graves line rendered as ribbon looks empty");
  process.exit(1);
}
if (restyledInk <= calligrapherInk) {
  console.error("thickness change did not fatten the ink");
  process.exit(1);
}
console.log("smoke test passed");
