import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseModelAssets, type ModelAssets } from "../src/weights.js";

export function loadAssets(): ModelAssets {
  const path = fileURLToPath(new URL("../assets/graves-v1.bin", import.meta.url));
  const buffer = readFileSync(path);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return parseModelAssets(arrayBuffer);
}

export interface GoldenStep {
  kappa: number[];
  phi: number[];
  phiArgmax: number;
  window: number[];
  pi: number[];
  muX: number[];
  muY: number[];
  sigmaX: number[];
  sigmaY: number[];
  rho: number[];
  eos: number;
}

export interface GoldenCase {
  name: string;
  charsText: string;
  encoded: number[];
  charLen: number;
  bias: number;
  inputs: [number, number, number][];
  steps: GoldenStep[];
}

export function loadGolden(name: string): GoldenCase {
  const path = fileURLToPath(new URL(`./goldens/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Largest |a-b| scaled by (atol + rtol * |b|); <= 1 means within tolerance. */
export function worstDeviation(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  atol: number,
  rtol: number,
): { score: number; index: number; actual: number; expected: number } {
  let worst = { score: 0, index: -1, actual: 0, expected: 0 };
  for (let i = 0; i < expected.length; i++) {
    const score = Math.abs(actual[i]! - expected[i]!) / (atol + rtol * Math.abs(expected[i]!));
    if (score > worst.score) {
      worst = { score, index: i, actual: actual[i]!, expected: expected[i]! };
    }
  }
  return worst;
}
