/**
 * Static SVG previews for the app's style dropdown: the app's default phrase
 * written once per bundled style (plus freehand), generated with the same
 * engine and polish pipeline the app uses (TS engine → smooth + align →
 * speed-based pen widths), so a preview is pixel-for-pixel the hand the
 * user will get. Serialization is the shared `lineToSvg` pen renderer:
 * tightly cropped, transparent background, `currentColor` ink.
 *
 * Run: pnpm --filter @longhand/ink-graves exec tsx scripts/make_style_previews.ts [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { offsetsToLine } from "@longhand/ink-core";
import { lineToSvg, polishLine } from "@longhand/ink-render";
import { GravesModel, STEPS_PER_CHARACTER } from "../src/engine.js";
import { loadAssets } from "../test/helpers.js";

// Same phrase and seed as the app's defaults (apps/web/src/App.tsx), but a
// neater bias and a thinner pen: previews render small, where extra
// legibility and a lighter line read better than the app defaults.
const TEXT = "a line of ink, thinking as it goes";
const BIAS = 0.95;
const SEED = 42;
const SCALE = 1.6; // App.tsx MAX_SCALE
const BASE_WIDTH = 1.8;

const outDir =
  process.argv[2] ??
  fileURLToPath(new URL("../../../apps/web/public/styles/", import.meta.url));

const model = new GravesModel(loadAssets());
mkdirSync(outDir, { recursive: true });

const jobs: Array<[name: string, style: number | null]> = [
  ["freehand", null],
  ...model.assets.styles.map((style) => [`style-${style.id}`, style.id] as [string, number]),
];

const STEP_BUDGET = STEPS_PER_CHARACTER * TEXT.length;
const MAX_ATTEMPTS = 6;

// Automatic retry catches two crisp failure signatures. A scribble the model
// recovers from still passes both, so those seeds are re-picked by eye.
// Re-check the overrides whenever TEXT or BIAS changes.
const SEED_OVERRIDES = new Map<string, number>([["freehand", 44]]);

/** Reason this line needs a new seed, or null if it looks healthy. */
function rejectReason(offsets: ReturnType<GravesModel["write"]>): string | null {
  // A healthy line terminates naturally (attention reaches the last
  // character and the pen lifts); a collapsed one scribbles until it
  // exhausts the step budget.
  if (offsets.length >= STEP_BUDGET) return "collapsed";
  // Some primings open with a pen tap: a degenerate first stroke well under
  // a unit wide, where a real letter start spans 10+ units.
  const first = offsetsToLine(offsets).strokes[0]!;
  const xs = first.points.map(([x]) => x);
  const ys = first.points.map(([, y]) => y);
  const size = Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  if (first.points.length < 8 && size < 3) return "leading pen-tap dot";
  return null;
}

for (const [name, style] of jobs) {
  const start = performance.now();
  const baseSeed = SEED_OVERRIDES.get(name) ?? SEED;
  let offsets = model.write(TEXT, { bias: BIAS, style, seed: baseSeed });
  let seed = baseSeed;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    const reason = rejectReason(offsets);
    if (reason === null) break;
    seed = baseSeed + attempt;
    console.log(`  ${name}: ${reason} at seed ${seed - 1}, retrying with seed ${seed}`);
    offsets = model.write(TEXT, { bias: BIAS, style, seed });
  }
  const svg = lineToSvg(polishLine(offsetsToLine(offsets)), {
    renderer: "pen",
    scale: SCALE,
    pen: { base: BASE_WIDTH },
  });
  const file = `${outDir}/${name}.svg`;
  writeFileSync(file, svg);
  console.log(
    `wrote ${file} (seed ${seed}, ${offsets.length} steps, ${(svg.length / 1024).toFixed(1)} KB, ${Math.round(performance.now() - start)}ms)`,
  );
}
