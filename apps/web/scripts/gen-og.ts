/**
 * Prerenders the social-share card (public/og.png, 1200x630) referenced
 * by the og:image / twitter:image tags in index.html. The wordmark is
 * real engine output: the studio's boot hand (calligrapher, style 2,
 * ribbon, red ink) writing "longhand", rendered through the same static
 * SVG pipeline as the export dialog, staged on the site's warm paper
 * gradient and grain, and screenshotted with playwright. The output is
 * committed so builds never need the models or a browser.
 *
 * Run from the repo root: `pnpm gen:og`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { lineBounds, offsetsToLine } from "@longhand/ink-core";
import { CalligrapherModel, parseCalligrapherWeights } from "@longhand/ink-calligrapher";
import { alignLine, lineToSvg } from "@longhand/ink-render";
import { renderNumbers, type SnippetParams } from "../src/snippets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outFile = path.resolve(here, "../public/og.png");

// The wordmark take: the studio's boot settings (seed hand-picked from a
// contact sheet; rerun a few seeds and eyeball before changing it).
const TAKE: SnippetParams = {
  engine: "calligrapher",
  text: "longhand",
  bias: 0.9,
  legibility: "high",
  style: 2,
  seed: 7,
  renderer: "ribbon",
  // A touch heavier than the studio's boot thickness: the card is seen
  // small, so the stroke needs a bit more meat.
  thickness: 1.25,
  speed: 1,
  ink: "#b3261e",
  paper: null,
};

const weightsBuffer = await readFile(
  path.join(repoRoot, "packages/ink-calligrapher/assets/calligrapher-v1.bin"),
);
const model = new CalligrapherModel(
  parseCalligrapherWeights(
    weightsBuffer.buffer.slice(
      weightsBuffer.byteOffset,
      weightsBuffer.byteOffset + weightsBuffer.byteLength,
    ),
  ),
);

const offsets = model.write(TAKE.text, { bias: TAKE.bias, style: TAKE.style, seed: TAKE.seed });
const line = alignLine(offsetsToLine(offsets));
const bounds = lineBounds(line);
const scale = 200 / Math.max(bounds.maxY - bounds.minY, 1);
const { penBasePerScale, ribbonWidth } = renderNumbers(TAKE);
const svg = lineToSvg(line, {
  renderer: TAKE.renderer,
  scale,
  padding: 20,
  ink: TAKE.ink!,
  pen: { base: Number(penBasePerScale) * scale },
  ribbonWidth: Number(ribbonWidth),
});

// The caption uses the site's UI font, inlined so the stage needs no
// network.
const geist = await readFile(
  path.resolve(here, "../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"),
);

// Mirrors the body grain in styles.css: same turbulence tile, same 0.1
// rect opacity, so the card is the site's own desk.
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.1'/%3E%3C/svg%3E";

const html = `<!doctype html><meta charset="utf-8"><style>
  @font-face {
    font-family: "Geist Variable";
    font-style: normal;
    font-weight: 100 900;
    src: url(data:font/woff2;base64,${geist.toString("base64")}) format("woff2-variations");
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: radial-gradient(120% 140% at 15% 10%, #fbf8f1 0%, #f4eddd 55%, #e9d8bc 100%);
    font-family: "Geist Variable", sans-serif;
  }
  .grain { position: absolute; inset: 0; background-image: url("${GRAIN}"); }
  main {
    position: relative; width: 100%; height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 24px; padding: 60px 120px 72px;
  }
  .ink { color: #b3261e; width: 100%; display: flex; justify-content: center; }
  .ink svg { width: 100%; max-width: 880px; max-height: 300px; }
  p { font-size: 34px; font-weight: 450; letter-spacing: 0.01em; color: #4d4437; }
  .cta {
    margin-top: 8px;
    padding: 15px 36px;
    border-radius: 999px;
    background: linear-gradient(180deg, #c93d2f 0%, #b3261e 55%, #9a1e16 100%);
    color: #fdf8f0;
    font-size: 25px;
    font-weight: 500;
    letter-spacing: 0.02em;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.22),
      0 1px 2px 0 oklch(0.35 0.04 80 / 0.2),
      0 6px 18px -2px oklch(0.35 0.04 80 / 0.25);
  }
</style>
<div class="grain"></div>
<main>
  <div class="ink">${svg}</div>
  <p>neural handwriting synthesis for web and mobile</p>
  <div class="cta">remix your own</div>
</main>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: outFile });
await browser.close();

const size = (await readFile(outFile)).length;
console.log(`og.png  ${(size / 1024).toFixed(0)} KB  (${offsets.length} steps, seed ${TAKE.seed})`);
