/**
 * Dumps deterministic stroke streams for the Swift port's parity tests
 * (packages/ink-swift). The TS engine is held bit-compatible with the
 * vendored calligrapher.ai reference by test/parity.test.ts, so these
 * fixtures carry that authority over to Swift.
 *
 *   pnpm exec tsx scripts/export_swift_goldens.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CalligrapherModel } from "../src/engine.js";
import { parseCalligrapherWeights } from "../src/weights.js";

const weightsPath = fileURLToPath(new URL("../assets/calligrapher-v1.bin", import.meta.url));
const buffer = readFileSync(weightsPath);
const assets = parseCalligrapherWeights(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);
const model = new CalligrapherModel(assets);

// Deliberately wide coverage: this fixture set is the safety net for any
// Swift-side rewrite of the cell (rounding-order changes show up as count
// or pen-bit divergence). Unknown characters stay single-code-unit so TS
// (UTF-16 units) and Swift (graphemes) agree on text length.
const cases = [
  { text: "hello world", bias: 0.75, style: null, seed: 7 },
  { text: "hello world", bias: 0.75, style: 9, seed: 42 },
  { text: "the quick brown fox", bias: 1, style: 3, seed: 1 },
  { text: "Pack my box with five dozen liquor jugs!", bias: 0.75, style: 0, seed: 2026 },
  { text: "hello world", bias: 0, style: 5, seed: 99 }, // unbiased sampling
  { text: "hello world", bias: 2, style: 5, seed: 99 }, // heavy bias, same seed
  { text: "a", bias: 0.75, style: 1, seed: 3 }, // tiny step budget
  { text: "héllo wörld", bias: 0.75, style: 7, seed: 11 }, // UNKNOWN fallback
  { text: "0123456789 -- \"quotes\" & (parens)?", bias: 0.75, style: 77, seed: 5 }, // digits, punctuation, unexposed style
  { text: "it was the best of times, it was the worst of times", bias: 0.5, style: null, seed: 123456789 },
];

const out = cases.map((options) => ({
  ...options,
  offsets: model.write(options.text, options),
}));

const goldensDir = fileURLToPath(new URL("../test/goldens/", import.meta.url));
mkdirSync(goldensDir, { recursive: true });
writeFileSync(`${goldensDir}swift-parity.json`, JSON.stringify(out));
console.log(out.map((c) => c.offsets.length).join(","));
