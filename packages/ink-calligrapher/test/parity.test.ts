/**
 * Golden parity: the TS port must reproduce the vendored original engine
 * bit-for-bit — same weights, same seeded random stream, identical
 * offsets. Any drift in the math (a misplaced float32 rounding, a wrong
 * gate order, a reordered random draw) diverges within a step or two and
 * fails loudly here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CalligrapherModel, parseCalligrapherWeights } from "../src/index.js";
import { Rng } from "../src/rng.js";
import { loadReference, referenceReady, referenceWrite, type ReferenceEngine } from "./reference.js";

function loadModel(): CalligrapherModel {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const bytes = readFileSync(`${here}/../../../vendor/calligrapher-ai/d.bin`);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new CalligrapherModel(parseCalligrapherWeights(buffer));
}

let reference: ReferenceEngine;
let model: CalligrapherModel;

beforeAll(async () => {
  reference = loadReference();
  model = loadModel();
  await referenceReady(reference);
}, 60_000);

const CASES: Array<{ text: string; style: number | null; bias: number; seed: number }> = [
  { text: "hello world", style: 3, bias: 0.75, seed: 42 },
  { text: "Quick Zebra!", style: 61, bias: 0.5, seed: 7 },
  { text: "parity", style: null, bias: 1.0, seed: 123 },
];

describe("port matches the vendored original exactly", () => {
  for (const { text, style, bias, seed } of CASES) {
    it(`"${text}" style=${style ?? "random"} bias=${bias} seed=${seed}`, () => {
      const rng = new Rng(seed);
      const expected = referenceWrite(reference, text, {
        style,
        bias,
        uniform: () => rng.uniform(),
      });
      const actual = model.write(text, { style, bias, seed });

      expect(actual.length).toBe(expected.length);
      expect(actual.length).toBeGreaterThan(20);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]![0], `dx at step ${i}`).toBe(expected[i]![0]);
        expect(actual[i]![1], `dy at step ${i}`).toBe(expected[i]![1]);
        expect(actual[i]![2], `pen at step ${i}`).toBe(expected[i]![2]);
      }
    }, 120_000);
  }
});

describe("model surface", () => {
  it("exposes all 80 styles and the extracted alphabet", () => {
    expect(model.styles.length).toBe(80);
    expect(model.supports("Q")).toBe(true);
    expect(model.supports("X")).toBe(true);
    expect(model.supports("Z")).toBe(true);
    expect(model.supports("~")).toBe(false);
  });

  it("is deterministic for a given seed", () => {
    const a = model.write("same seed", { style: 12, bias: 0.75, seed: 99 });
    const b = model.write("same seed", { style: 12, bias: 0.75, seed: 99 });
    expect(a).toEqual(b);
  });
});
