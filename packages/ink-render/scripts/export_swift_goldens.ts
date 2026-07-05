/**
 * Dumps deterministic geometry fixtures for the Swift port's parity tests
 * (packages/ink-swift InkRenderTests). The savgol/align math is already
 * pinned to scipy by test/golden.json; this adds the TS package's own
 * outputs (polish, pen widths, ribbon outlines, layout) over a fixed
 * pseudo-random line so the Swift transliteration can be checked
 * number-for-number.
 *
 *   pnpm exec tsx scripts/export_swift_goldens.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InkLine } from "@longhand/ink-core";
import { layoutLine, penWidths, polishLine, ribbonOutline } from "../src/index.js";
import { penStrokes } from "../src/svg.js";

// Fixed LCG so the fixture line is reproducible without an engine.
let seed = 0x2f6e2b1;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// Three strokes of wandering ink with varied speeds, plus a pen tap.
const strokes: InkLine["strokes"] = [];
let x = 0;
let y = 0;
for (const count of [60, 25, 40]) {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    x += 0.4 + 2.4 * random();
    y = 6 * Math.sin(x / 7) + 1.5 * (random() - 0.5) + x * 0.05;
    points.push([x, y]);
  }
  strokes.push({ points });
  x += 4;
}
strokes.push({ points: [[x + 2, y]] });
const line: InkLine = { strokes };

const layout = layoutLine(line, 3, 6);
const out = {
  line: line.strokes.map((stroke) => stroke.points),
  polished: polishLine(line).strokes.map((stroke) => stroke.points),
  penWidths: penWidths(line),
  layout: {
    width: layout.width,
    height: layout.height,
    placed: layout.placed.strokes.map((stroke) => stroke.points),
  },
  penRuns: penStrokes(layout.placed).map((stroke) => ({
    touchdown: stroke.touchdown,
    runs: stroke.runs.map(({ points, ...rest }) => ({ ...rest, pointCount: points.length })),
  })),
  ribbons: layout.placed.strokes.map((stroke) => ribbonOutline(stroke.points, 3)),
};

const goldensDir = fileURLToPath(new URL("../test/goldens/", import.meta.url));
mkdirSync(goldensDir, { recursive: true });
writeFileSync(`${goldensDir}swift-parity.json`, JSON.stringify(out));
console.log(
  `strokes=${line.strokes.length} layout=${layout.width.toFixed(2)}x${layout.height.toFixed(2)}`,
);
