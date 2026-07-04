/**
 * Static PNG previews for the app's style picker: the app's default
 * phrase written once per calligrapher style, generated with the same
 * engine and ribbon rendering the app uses, so a preview is
 * pixel-for-pixel the hand the user will get. The line is serialized
 * through the shared `lineToSvg` ribbon renderer, then rasterized with
 * resvg: tightly cropped, transparent background, the app's default ink
 * color.
 *
 * Run: pnpm --filter @longhand/ink-calligrapher exec tsx scripts/make_style_previews.ts [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { offsetsToLine } from "@longhand/ink-core";
import { lineToSvg, RIBBON_WIDTH } from "@longhand/ink-render";
import { CalligrapherModel, EXPOSED_STYLES, STEPS_PER_CHARACTER } from "../src/engine.js";
import { parseCalligrapherWeights } from "../src/weights.js";

// Same phrase and seed family as the graves previews so the two engines'
// pickers compare like for like.
const TEXT = "a line of ink, thinking as it goes";
const BIAS = 1.0;
const SEED = 42;
const SCALE = 1.6; // App.tsx MAX_SCALE

// Ink weight follows the app's formula (App.tsx RIBBON_WIDTH ×
// ribbonWidthFactor × thickness × INK_WEIGHT.calligrapher.ribbon, with
// this engine's factor being 1) at a thickness a touch above the 1x
// default, so previews match the normalized in-app look but stay readable
// at picker size.
const THICKNESS = 1.15;
const INK_WEIGHT = 2;
const PREVIEW_RIBBON_WIDTH = RIBBON_WIDTH * THICKNESS * INK_WEIGHT;

// Rasterization width: previews show at up to ~500 CSS px in the picker
// dialog, so 1000 device px covers retina.
const PNG_WIDTH = 1000;
const INK = "#1c1c28"; // App.tsx DEFAULT_INK

const outDir =
  process.argv[2] ??
  fileURLToPath(new URL("../../../apps/web/public/styles/calligrapher/", import.meta.url));

function loadModel(): CalligrapherModel {
  const path = fileURLToPath(new URL("../../../vendor/calligrapher-ai/d.bin", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new CalligrapherModel(parseCalligrapherWeights(buffer));
}

const model = loadModel();
mkdirSync(outDir, { recursive: true });

const STEP_BUDGET = STEPS_PER_CHARACTER * TEXT.length;
const MAX_ATTEMPTS = 6;

// A garbled line the model recovers from still terminates in budget, so
// those seeds are re-picked by eye. Re-check whenever TEXT or BIAS changes.
const SEED_OVERRIDES = new Map<number, number>([[8, 43]]);

for (const style of EXPOSED_STYLES) {
  const start = performance.now();
  const baseSeed = SEED_OVERRIDES.get(style) ?? SEED;
  let seed = baseSeed;
  let offsets = model.write(TEXT, { bias: BIAS, style, seed });
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    // A healthy line terminates naturally; a collapsed one scribbles
    // until it exhausts the step budget.
    if (offsets.length < STEP_BUDGET) break;
    seed = baseSeed + attempt;
    console.log(`  style ${style}: collapsed at seed ${seed - 1}, retrying with seed ${seed}`);
    offsets = model.write(TEXT, { bias: BIAS, style, seed });
  }
  const svg = lineToSvg(offsetsToLine(offsets), {
    renderer: "ribbon",
    scale: SCALE,
    ribbonWidth: PREVIEW_RIBBON_WIDTH,
  });
  // resvg has no CSS context, so currentColor must become a literal color.
  const png = new Resvg(svg.replaceAll("currentColor", INK), {
    fitTo: { mode: "width", value: PNG_WIDTH },
  })
    .render()
    .asPng();
  const file = `${outDir}/style-${style}.png`;
  writeFileSync(file, png);
  console.log(
    `wrote ${file} (seed ${seed}, ${offsets.length} steps, ${(png.length / 1024).toFixed(1)} KB, ${Math.round(performance.now() - start)}ms)`,
  );
}
