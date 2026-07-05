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

const weightsPath = fileURLToPath(
  new URL("../../../apps/web/public/model/calligrapher-v1.bin", import.meta.url),
);
const buffer = readFileSync(weightsPath);
const assets = parseCalligrapherWeights(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);
const model = new CalligrapherModel(assets);

const cases = [
  { text: "hello world", bias: 0.75, style: null, seed: 7 },
  { text: "hello world", bias: 0.75, style: 9, seed: 42 },
  { text: "the quick brown fox", bias: 1, style: 3, seed: 1 },
];

const out = cases.map((options) => ({
  ...options,
  offsets: model.write(options.text, options),
}));

const goldensDir = fileURLToPath(new URL("../test/goldens/", import.meta.url));
mkdirSync(goldensDir, { recursive: true });
writeFileSync(`${goldensDir}swift-parity.json`, JSON.stringify(out));
console.log(out.map((c) => c.offsets.length).join(","));
