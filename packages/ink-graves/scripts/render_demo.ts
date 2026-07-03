/**
 * Dev sanity check: generate a few lines with the TS engine and write a
 * static SVG. Run: pnpm --filter @cali/ink-graves exec tsx scripts/render_demo.ts <out.svg>
 */
import { writeFileSync } from "node:fs";
import { offsetsToLine, lineBounds, transformLine, type InkLine } from "@cali/ink-core";
import { GravesModel } from "../src/engine.js";
import { loadAssets } from "../test/helpers.js";

const out = process.argv[2] ?? "demo.svg";
const model = new GravesModel(loadAssets());

const specs = [
  { label: "freehand", text: "hello from the typescript engine", style: null as number | null },
  { label: "style 3", text: "hello from the typescript engine", style: 3 },
  { label: "style 9", text: "hello from the typescript engine", style: 9 },
];

const SCALE = 1.5;
const LINE_HEIGHT = 90;
const MARGIN = 30;

const placed: InkLine[] = [];
let width = 0;
specs.forEach((spec, index) => {
  const start = performance.now();
  const offsets = model.write(spec.text, { bias: 0.75, style: spec.style, seed: 42 });
  const line = offsetsToLine(offsets);
  const bounds = lineBounds(line);
  const shifted = transformLine(line, {
    scale: SCALE,
    translateX: MARGIN - bounds.minX * SCALE,
    translateY: MARGIN + index * LINE_HEIGHT - bounds.minY * SCALE,
  });
  placed.push(shifted);
  width = Math.max(width, (bounds.maxX - bounds.minX) * SCALE + 2 * MARGIN);
  console.log(
    `${spec.label}: ${offsets.length} steps in ${Math.round(performance.now() - start)}ms`,
  );
});

const height = specs.length * LINE_HEIGHT + MARGIN;
const paths = placed
  .flatMap((line) => line.strokes)
  .map((stroke) => {
    const d =
      "M " + stroke.points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
    return `<path d="${d}" fill="none" stroke="#1a1a2e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  })
  .join("\n");

writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${height}">\n` +
    `<rect width="${Math.ceil(width)}" height="${height}" fill="#fffdf8"/>\n${paths}\n</svg>\n`,
);
console.log(`wrote ${out}`);
