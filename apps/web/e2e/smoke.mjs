/**
 * Headless smoke test: verifies the boot defaults (calligrapher engine,
 * style 2, pen stroke), writes with both engines and stroke types, replays,
 * restyles, and checks ink actually lands on the canvas with no console
 * errors.
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

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

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

// Model load enables the write button. (The style-picker trigger is also a
// button and never disables, so target the write button by text.)
const waitForIdle = () =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "write" && !button.disabled,
      ),
    undefined,
    { timeout: 90_000 },
  );

await page.goto(baseUrl);
const writeButton = page.getByRole("button", { name: "write" });
await writeButton.waitFor({ state: "visible" });
await waitForIdle();

// Every control besides the text row lives in a collapsed options panel;
// open it once and leave it open for the whole run.
await page.getByRole("button", { name: /^options/ }).click();

// The model picker is a segmented radio toggle, like stroke and legibility.
const selectEngine = async (label) => {
  await page.getByRole("radio", { name: label, exact: true }).click();
};

// Boot defaults: calligrapher engine, style 2, pen stroke.
const calligrapherChecked = await page
  .getByRole("radio", { name: "calligrapher", exact: true })
  .getAttribute("aria-checked");
if (calligrapherChecked !== "true") fail("default model is not calligrapher");
const bootStyle = await page.locator(".style-picker-trigger").getAttribute("aria-label");
if (bootStyle !== "handwriting style: style 2")
  fail(`default style is "${bootStyle}", expected style 2`);
const penChecked = await page
  .getByRole("radio", { name: "pen", exact: true })
  .getAttribute("aria-checked");
if (penChecked !== "true") fail("default stroke is not pen");

// Write with the boot defaults. Generation completes before the pen
// animates, so the wait covers a full generate + partial replay.
await writeButton.click();
await page.waitForTimeout(10_000);
const calligrapherPenInk = await inkPixels();

// Stroke type: flip the finished line to the ribbon look and back —
// in-place repaints, no rewrite.
await page.getByRole("radio", { name: "ribbon" }).click();
await page.waitForTimeout(500);
const calligrapherRibbonInk = await inkPixels();
await page.getByRole("radio", { name: "pen", exact: true }).click();
await page.waitForTimeout(500);

// Play on a finished line rewinds and animates it again: shortly after
// clicking there should be some ink, but much less than the finished line,
// and the seed must not change (same take). (Mid-write the same button
// reads "pause".)
const seedBeforeReplay = await page.locator("footer").textContent();
await page.getByRole("button", { name: "play", exact: true }).click();
await page.waitForTimeout(700);
const replayInk = await inkPixels();
if (replayInk <= 0 || replayInk >= calligrapherPenInk * 0.8)
  fail(`replay did not restart the animation (${replayInk} vs ${calligrapherPenInk})`);
if ((await page.locator("footer").textContent()) !== seedBeforeReplay)
  fail("replay changed the seed — it should reuse the same take");

// Engine switch: the graves model loads (15 MB), the style picker
// re-populates, and its null style (freehand) is the default.
await selectEngine("longhand");
await waitForIdle();
const gravesStyle = await page.locator(".style-picker-trigger").getAttribute("aria-label");
if (gravesStyle !== "handwriting style: freehand")
  fail(`graves default style is "${gravesStyle}", expected freehand`);
await writeButton.click();
await page.waitForTimeout(10_000);
const freehandInk = await inkPixels();

// Styled write (exercises priming in the worker), via the preview picker.
// Every write draws a fresh seed, so the footer should change.
await page.click(".style-picker-trigger");
await page.getByRole("option", { name: "style 3", exact: true }).click();
await writeButton.click();
await page.waitForTimeout(18_000);
const styledInk = await inkPixels();
if ((await page.locator("footer").textContent()) === seedBeforeReplay)
  fail("write reused the previous seed — every write should reshuffle");

// Ink settings restyle the finished line without a rewrite: pick blue
// (red channel low, so inkPixels still counts it) and max thickness, then
// confirm the repaint kept — and fattened — the ink.
await page.getByRole("radio", { name: "ink color: blue" }).click();
await page.getByLabel("thickness").press("End");
await page.waitForTimeout(1_000);
const restyledInk = await inkPixels();

// And back: the calligrapher engine is cached, so this is instant.
await selectEngine("calligrapher");
await waitForIdle();

await page.screenshot({ path: screenshotPath, fullPage: true });
await browser.close();

console.log(`calligrapher pen ink:    ${calligrapherPenInk}`);
console.log(`calligrapher ribbon ink: ${calligrapherRibbonInk}`);
console.log(`replay partial ink:      ${replayInk}`);
console.log(`freehand ink pixels:     ${freehandInk}`);
console.log(`styled ink pixels:       ${styledInk}`);
console.log(`restyled ink pixels:     ${restyledInk}`);
if (errors.length > 0) {
  console.error("console errors:", errors);
  process.exit(1);
}
if (
  calligrapherPenInk < 1000 ||
  calligrapherRibbonInk < 1000 ||
  freehandInk < 1000 ||
  styledInk < 1000
)
  fail("canvas looks empty — expected at least 1000 ink pixels");
if (restyledInk <= styledInk) fail("thickness change did not fatten the ink");
console.log("smoke test passed");
