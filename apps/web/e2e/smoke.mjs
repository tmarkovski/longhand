/**
 * Headless smoke test: verifies the boot defaults (calligrapher engine,
 * style 2, pen stroke, empty focused text line), types and writes with both
 * engines and stroke types, replays, restyles, locks a seed, reads the code
 * dialog's snippets, opens the build page, replays a share link both live
 * and from a cold load, and checks ink actually lands on the canvas with
 * no console errors. Along the way it watches the write button's stale-take
 * dot: on when a generative setting (model, style, legibility, text, locked
 * seed) drifts from the rendered line, off after a write or when the
 * setting drifts back, never for in-place restyles (ink, thickness,
 * stroke, paper, speed).
 *
 *   node e2e/smoke.mjs [baseUrl] [screenshotPath]
 */
import { chromium } from "playwright";

const baseUrl = process.argv[2] ?? "http://localhost:5199";
const screenshotPath = process.argv[3] ?? "smoke.png";

const browser = await chromium.launch();
// The share button round-trips through the real clipboard.
const context = await browser.newContext({
  viewport: { width: 1080, height: 720 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
// The letterhead's star-count fetch must not put the suite at the mercy of
// api.github.com (unauthenticated rate limits in CI; a failed response
// logs a console error the suite would count): serve a canned answer.
await page.route("https://api.github.com/**", (route) =>
  route.fulfill({ json: { stargazers_count: 42 } }),
);
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// The canvas bitmap is transparent everywhere the pen hasn't touched (the
// paper color is the card behind it), so opaque pixels are ink regardless
// of the ink color.
async function inkPixels() {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const context = canvas.getContext("2d");
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200) ink++;
    }
    return ink;
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

// The line starts empty with the caret already on it (fine-pointer devices
// get autofocus), so the whole desktop flow is: load, type, Enter. Typing
// through the keyboard proves the focus, not just the field.
const textBox = page.getByPlaceholder("type something to write…");
if ((await textBox.inputValue()) !== "") fail("text box should start empty");
if (!(await textBox.evaluate((el) => el === document.activeElement)))
  fail("text box should be focused on load");

// An empty write is a nudge, not an error: unfocused, it aims the caret at
// the line; with the caret already there (the button never steals focus),
// it wags the pen at the margin.
await textBox.evaluate((el) => el.blur());
await writeButton.click();
if (!(await textBox.evaluate((el) => el === document.activeElement)))
  fail("empty write should focus the text line");
await writeButton.click();
if ((await page.locator(".pen-wiggle").count()) !== 1)
  fail("empty write with the caret on the line should wag the pen");

// The clear X is invisible (faded out and disabled) on a blank studio,
// wakes with typed text, blanks the line with one tap — keeping the caret
// on it — then hides again.
const clearButton = page.getByRole("button", { name: "clear", exact: true });
if (!(await clearButton.isDisabled())) fail("clear X should be hidden on a blank studio");
await page.keyboard.type("a line of ink, thinking as it goes");
if (!(await clearButton.isEnabled())) fail("typing should wake the clear X");
await clearButton.click();
if ((await textBox.inputValue()) !== "") fail("clear X did not empty the line");
if (!(await clearButton.isDisabled())) fail("clear X should hide once the line is blank");
await page.keyboard.type("a line of ink, thinking as it goes");

// The stale-take dot compares against the rendered line; with no take yet
// there is nothing to be stale against, typed text or not.
const staleDot = page.locator(".take-stale-dot");
const expectDot = async (want, label) => {
  if ((await staleDot.count()) !== (want ? 1 : 0))
    fail(`stale dot should be ${want ? "on" : "off"} ${label}`);
};
await expectDot(false, "before the first take");

// Every control besides the text row lives in a collapsed options panel;
// open it once and leave it open for the whole run.
await page.getByRole("button", { name: /^options/ }).click();

// The model picker is a segmented radio toggle, like stroke and legibility.
const selectEngine = async (label) => {
  await page.getByRole("radio", { name: label, exact: true }).click();
};

// The take's seed, read off the options readout (the collapsed one-liner
// stays in the DOM while the panel is open, just faded to invisible).
const takeSeed = async () =>
  (await page.locator(".settings-readout").textContent()).match(/seed (\d+)/)?.[1];

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

// Write with the boot defaults — Enter in the text line presses write.
// Generation completes before the pen animates, so the wait covers a full
// generate + partial replay.
await textBox.press("Enter");
await page.waitForTimeout(10_000);
const calligrapherPenInk = await inkPixels();

// Stroke type: flip the finished line to the ribbon look and back —
// in-place repaints, no rewrite.
await page.getByRole("radio", { name: "ribbon" }).click();
await page.waitForTimeout(500);
const calligrapherRibbonInk = await inkPixels();
await page.getByRole("radio", { name: "pen", exact: true }).click();
await page.waitForTimeout(500);
// Stroke restyles the line in place, so it never trips the stale dot.
await expectDot(false, "after a stroke flip");

// Play on a finished line rewinds and animates it again: shortly after
// clicking there should be some ink, but much less than the finished line,
// and the seed must not change (same take). (Mid-write the same button
// reads "pause".)
const seedBeforeReplay = await takeSeed();
await page.getByRole("button", { name: "play", exact: true }).click();
await page.waitForTimeout(700);
const replayInk = await inkPixels();
if (replayInk <= 0 || replayInk >= calligrapherPenInk * 0.8)
  fail(`replay did not restart the animation (${replayInk} vs ${calligrapherPenInk})`);
if ((await takeSeed()) !== seedBeforeReplay)
  fail("replay changed the seed — it should reuse the same take");

// Engine switch: the graves model loads (3.6 MB), the style picker
// re-populates, and its null style (freehand) is the default.
await selectEngine("longhand");
await waitForIdle();
// The calligrapher's line is still on the paper but the model pick has
// drifted from it — the dot says a rewrite is needed to catch up.
await expectDot(true, "after switching model under a rendered take");
const gravesStyle = await page.locator(".style-picker-trigger").getAttribute("aria-label");
if (gravesStyle !== "handwriting style: freehand")
  fail(`graves default style is "${gravesStyle}", expected freehand`);
await writeButton.click();
await page.waitForTimeout(10_000);
const freehandInk = await inkPixels();
await expectDot(false, "after the freehand write");

// Styled write (uses the baked primed state), via the preview picker.
// Every write draws a fresh seed, so the readout's seed should change.
await page.click(".style-picker-trigger");
await page.getByRole("option", { name: "style 3", exact: true }).click();
await expectDot(true, "after picking a new style");
await writeButton.click();
await page.waitForTimeout(18_000);
const styledInk = await inkPixels();
await expectDot(false, "after the styled write");
if ((await takeSeed()) === seedBeforeReplay)
  fail("write reused the previous seed — every write should reshuffle");

// Ink settings restyle the finished line without a rewrite: pick blue and
// max thickness, then confirm the repaint kept — and fattened — the ink.
await page.getByRole("radio", { name: "ink color: blue" }).click();
await page.getByLabel("thickness").press("End");
await page.waitForTimeout(1_000);
const restyledInk = await inkPixels();
await expectDot(false, "after ink and thickness restyles");

// The dot is a diff, not a sticky flag: drift legibility away and back
// and it goes out on its own.
await page.getByRole("radio", { name: "high" }).click();
await expectDot(true, "after changing legibility");
await page.getByRole("radio", { name: "normal" }).click();
await expectDot(false, "after changing legibility back");

// And back: the calligrapher engine is cached, so this is instant.
await selectEngine("calligrapher");
await waitForIdle();
await expectDot(true, "after switching back to calligrapher");

// Seed locking: typing a seed closes the chain-link lock, and a write
// keeps the seed (the options readout carries the take's seed).
await page.getByLabel("seed", { exact: true }).fill("12345");
const lockPressed = await page
  .getByRole("button", { name: "lock seed" })
  .getAttribute("aria-pressed");
if (lockPressed !== "true") fail("typing a seed did not lock it");
await writeButton.click();
await page.waitForTimeout(2_500);
if ((await takeSeed()) !== "12345") fail("pinned write did not keep the seed");
await expectDot(false, "after the pinned write");

// Share copies a #/write link carrying the whole take, seed included.
await page.getByRole("button", { name: "share this take" }).click();
const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
if (!sharedUrl.includes("#/write?") || !sharedUrl.includes("seed=12345"))
  fail(`share link looks wrong: ${sharedUrl}`);

// The code dialog (the </> button on the paper, next to export) emits the
// current take for both SDKs, seed included.
await page.getByRole("button", { name: "use in your app" }).click();
const codeDialog = page.getByRole("dialog");
const tsSnippet = await codeDialog.locator("pre").innerText();
if (!tsSnippet.includes("seed: 12345,") || !tsSnippet.includes("CalligrapherModel"))
  fail("web snippet does not carry the pinned take");
await codeDialog.getByRole("radio", { name: "Swift" }).click();
const swiftSnippet = await codeDialog.locator("pre").innerText();
if (!swiftSnippet.includes("seed: 12345") || !swiftSnippet.includes("import InkCalligrapher"))
  fail("swift snippet does not carry the pinned take");
await page.keyboard.press("Escape");
await codeDialog.waitFor({ state: "detached" });

await page.screenshot({ path: screenshotPath, fullPage: true });

// The platform choice lives in App, not the dialog, so it survives the
// rewrite that unmounts the dialog while the worker generates.
await writeButton.click();
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: "use in your app" }).click();
const swiftChecked = await codeDialog
  .getByRole("radio", { name: "Swift" })
  .getAttribute("aria-checked");
if (swiftChecked !== "true") fail("platform choice did not survive a rewrite");

// Navigating to the guide from inside the dialog must close it (the
// dialog is portaled above the hash router, so nothing else would — a
// stale modal would blanket the guide) and keep the dialed-in take
// (the studio stays mounted, hidden), or the dialog's own guide link
// would destroy the seed it tells users to carry into their app.
const inkBeforeGuide = await inkPixels();
await codeDialog.getByRole("link", { name: "full setup guide" }).click();
await codeDialog.waitFor({ state: "detached", timeout: 5_000 });
await page.getByRole("heading", { name: "Build with Longhand" }).waitFor({ timeout: 5_000 });
await page.getByRole("link", { name: "studio", exact: true }).first().click();
await page
  .getByRole("heading", { name: "Build with Longhand" })
  .waitFor({ state: "detached", timeout: 5_000 });
if ((await takeSeed()) !== "12345")
  fail("returning from the build page lost the pinned take");
if ((await inkPixels()) < inkBeforeGuide * 0.9)
  fail("returning from the build page lost the canvas ink");

// The build page also deep-links (hash route on a cold load).
await page.goto(`${baseUrl}/#/build`);
await page.getByRole("heading", { name: "Build with Longhand" }).waitFor({ timeout: 10_000 });

// Opening the share link writes the take hands-off: settings restored, the
// promised write fired with the pinned seed, and the launcher hash cleaned
// off the address bar afterwards.
const expectSharedTake = async (label) => {
  await waitForIdle();
  await page.waitForTimeout(10_000);
  if ((await textBox.inputValue()) !== "a line of ink, thinking as it goes")
    fail(`${label}: share link did not restore the text`);
  if ((await takeSeed()) !== "12345")
    fail(`${label}: share link did not replay the pinned seed`);
  if ((await inkPixels()) < 1000) fail(`${label}: share link did not write the line`);
  if (page.url().includes("#/write")) fail(`${label}: share link should clean its hash`);
};

// Live: from the build page this is a same-document hash navigation, the
// path a link clicked (or pasted) inside the running app takes.
await page.goto(sharedUrl);
await expectSharedTake("live");

// Cold: a full page load with the #/write hash, the path a link opened in
// a fresh tab takes.
await page.goto("about:blank");
await page.goto(sharedUrl);
await expectSharedTake("cold load");

// The clear X also wipes a rendered take: blank line, blank paper, gone.
await page.getByRole("button", { name: "clear", exact: true }).click();
if ((await textBox.inputValue()) !== "") fail("clear X did not empty the replayed text");
if ((await inkPixels()) !== 0) fail("clear X did not blank the paper");
if (!(await page.getByRole("button", { name: "clear", exact: true }).isDisabled()))
  fail("clear X should hide after wiping the take");

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
