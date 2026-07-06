/**
 * A/B harness for the quantization size study (tools/quantize_weights.py).
 *
 * Loads the shipped f32 weights plus each scheme's dequantized "sim"
 * container, generates the same cases through all of them — identical
 * text, style, bias, and seed, so every variant consumes the exact same
 * RNG stream — and writes one PNG per case with the variants stacked and
 * labeled for eyeball comparison. Rendering uses the app's pipeline
 * (polish + speed-based pen widths) so degradation is judged on what a
 * user would actually see.
 *
 * Run: pnpm --filter @longhand/ink-graves exec tsx scripts/compare_quantized.ts <simDir> <outDir>
 * where <simDir> holds graves-v1-{f16,q8,q4}-sim.bin.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { offsetsToLine, type StrokeOffset } from "@longhand/ink-core";
import { lineToSvg, polishLine } from "@longhand/ink-render";
import { GravesModel } from "../src/engine.js";
import { parseModelAssets } from "../src/weights.js";
import { loadAssets } from "../test/helpers.js";

const simDir = process.argv[2];
const outDir = process.argv[3];
if (!simDir || !outDir) {
  console.error("usage: tsx scripts/compare_quantized.ts <simDir> <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const SCHEMES = ["f16", "q8", "q4"] as const;

function loadSim(scheme: string): GravesModel {
  const buffer = readFileSync(`${simDir}/graves-v1-${scheme}-sim.bin`);
  return new GravesModel(
    parseModelAssets(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  );
}

const variants: Array<[label: string, model: GravesModel]> = [
  ["original", new GravesModel(loadAssets())],
  ...SCHEMES.map((scheme): [string, GravesModel] => [scheme, loadSim(scheme)]),
];

interface Case {
  name: string;
  text: string;
  style: number | null;
  bias: number;
  seed: number;
}

const CASES: Case[] = [
  { name: "app-default", text: "a line of ink, thinking as it goes", style: null, bias: 0.75, seed: 42 },
  { name: "style3", text: "the quick brown fox jumps over the dog", style: 3, bias: 0.75, seed: 42 },
  { name: "style7-neat", text: "a smaller model with the same hand", style: 7, bias: 0.95, seed: 42 },
  { name: "freehand-loose", text: "hello world", style: null, bias: 0.3, seed: 42 },
  { name: "style9-seed7", text: "fourteen megabytes down to two", style: 9, bias: 0.75, seed: 7 },
  { name: "style5-digits", text: "pi is 3.14159 more or less", style: 5, bias: 1.0, seed: 123 },
];

// App-like look, matched to make_style_previews.ts.
const SCALE = 1.6;
const BASE_WIDTH = 2.2;
const INK = "#1c1c28";
const PAPER = "#ffffff";
const GUTTER = 185; // label column, svg units
const ROW_GAP = 14;
const TITLE_H = 34;

/** First step where the two offset streams visibly part ways. */
function firstDivergence(a: StrokeOffset[], b: StrokeOffset[]): number | null {
  const n = Math.min(a.length, b.length);
  for (let t = 0; t < n; t++) {
    if (
      Math.abs(a[t]![0] - b[t]![0]) > 0.05 ||
      Math.abs(a[t]![1] - b[t]![1]) > 0.05 ||
      a[t]![2] !== b[t]![2]
    ) {
      return t;
    }
  }
  return a.length === b.length ? null : n;
}

interface Row {
  label: string;
  note: string;
  inner: string; // svg content without the root element
  width: number;
  height: number;
}

/** Render one take to inner-SVG content plus its crop size. */
function renderRow(label: string, note: string, offsets: StrokeOffset[]): Row {
  const svg = lineToSvg(polishLine(offsetsToLine(offsets)), {
    renderer: "pen",
    scale: SCALE,
    ink: INK,
    pen: { base: BASE_WIDTH },
  });
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!viewBox) throw new Error("lineToSvg output missing viewBox");
  const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
  return { label, note, inner, width: Number(viewBox[1]), height: Number(viewBox[2]) };
}

for (const spec of CASES) {
  const options = { bias: spec.bias, style: spec.style, seed: spec.seed };
  const takes = variants.map(([label, model]) => ({ label, offsets: model.write(spec.text, options) }));
  const reference = takes[0]!.offsets;

  const rows: Row[] = takes.map(({ label, offsets }) => {
    const diverges = label === "original" ? null : firstDivergence(reference, offsets);
    const note = `${offsets.length} steps${diverges === null ? "" : ` · diverges @ ${diverges}`}`;
    console.log(`  ${spec.name} ${label}: ${note}`);
    return renderRow(label, note, offsets);
  });

  const width = GUTTER + Math.max(...rows.map((row) => row.width)) + 10;
  let y = TITLE_H;
  const body: string[] = [];
  const title = `${spec.text} · ${spec.style === null ? "freehand" : `style ${spec.style}`} · bias ${spec.bias} · seed ${spec.seed}`;
  body.push(
    `<text x="12" y="22" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#666">${title}</text>`,
  );
  for (const row of rows) {
    body.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#e4e4e4" stroke-width="1"/>`);
    body.push(
      `<text x="12" y="${y + row.height / 2 - 2}" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#222">${row.label}</text>`,
      `<text x="12" y="${y + row.height / 2 + 15}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#999">${row.note}</text>`,
    );
    body.push(
      `<g transform="translate(${GUTTER}, ${y + ROW_GAP / 2})" fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">${row.inner}</g>`,
    );
    y += row.height + ROW_GAP;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${y}">` +
    `<rect width="${width}" height="${y}" fill="${PAPER}"/>` +
    body.join("") +
    `</svg>`;

  const png = new Resvg(svg, {
    font: { loadSystemFonts: true },
    fitTo: { mode: "zoom", value: 2 },
  })
    .render()
    .asPng();
  const file = `${outDir}/${spec.name}.png`;
  writeFileSync(file, png);
  console.log(`wrote ${file} (${(png.length / 1024).toFixed(0)} KB)`);
}
