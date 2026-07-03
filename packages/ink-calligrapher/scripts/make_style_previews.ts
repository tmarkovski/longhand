/**
 * Static SVG previews for the app's style dropdown: the app's default
 * phrase written once per calligrapher style, generated with the same
 * engine and ribbon rendering the app uses, so a preview is
 * pixel-for-pixel the hand the user will get. Serialization is the shared
 * `lineToSvg` ribbon renderer: tightly cropped, transparent background,
 * `currentColor` ink.
 *
 * Run: pnpm --filter @longhand/ink-calligrapher exec tsx scripts/make_style_previews.ts [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { offsetsToLine } from "@longhand/ink-core";
import { lineToSvg } from "@longhand/ink-render";
import { CalligrapherModel, EXPOSED_STYLES, STEPS_PER_CHARACTER } from "../src/engine.js";
import { parseCalligrapherWeights } from "../src/weights.js";

// Same phrase and seed family as the graves previews so the two engines'
// dropdowns compare like for like.
const TEXT = "a line of ink, thinking as it goes";
const BIAS = 1.0;
const SEED = 42;
const SCALE = 1.6; // App.tsx MAX_SCALE

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

for (const style of EXPOSED_STYLES) {
  const start = performance.now();
  let seed = SEED;
  let offsets = model.write(TEXT, { bias: BIAS, style, seed });
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    // A healthy line terminates naturally; a collapsed one scribbles
    // until it exhausts the step budget.
    if (offsets.length < STEP_BUDGET) break;
    seed = SEED + attempt;
    console.log(`  style ${style}: collapsed at seed ${seed - 1}, retrying with seed ${seed}`);
    offsets = model.write(TEXT, { bias: BIAS, style, seed });
  }
  const svg = lineToSvg(offsetsToLine(offsets), { renderer: "ribbon", scale: SCALE });
  const file = `${outDir}/style-${style}.svg`;
  writeFileSync(file, svg);
  console.log(
    `wrote ${file} (seed ${seed}, ${offsets.length} steps, ${(svg.length / 1024).toFixed(1)} KB, ${Math.round(performance.now() - start)}ms)`,
  );
}
