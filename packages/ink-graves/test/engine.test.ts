import { describe, expect, it } from "vitest";
import { offsetsToLine } from "@cali/ink-core";
import { GravesModel } from "../src/engine.js";
import { loadAssets } from "./helpers.js";

const assets = loadAssets();
const model = new GravesModel(assets);

describe("GravesModel end to end", () => {
  it("writes an unprimed line and terminates naturally", () => {
    const offsets = model.write("hello world", { bias: 0.75, seed: 42 });
    expect(offsets.length).toBeGreaterThan(100);
    expect(offsets.length).toBeLessThan(40 * "hello world".length);
    for (const [dx, dy, eos] of offsets) {
      expect(Number.isFinite(dx)).toBe(true);
      expect(Number.isFinite(dy)).toBe(true);
      expect(eos === 0 || eos === 1).toBe(true);
    }
    const line = offsetsToLine(offsets);
    expect(line.strokes.length).toBeGreaterThan(3);
  });

  it("is deterministic for a fixed seed and varies across seeds", () => {
    const first = model.write("hello", { bias: 0.75, seed: 7 });
    const second = model.write("hello", { bias: 0.75, seed: 7 });
    const different = model.write("hello", { bias: 0.75, seed: 8 });
    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });

  it("writes with style priming", () => {
    const offsets = model.write("hello", { bias: 0.75, style: 9, seed: 42 });
    expect(offsets.length).toBeGreaterThan(40);
    expect(offsets.every(([dx, dy]) => Number.isFinite(dx) && Number.isFinite(dy))).toBe(true);
  });

  it("rejects unknown styles and over-long text", () => {
    expect(() => model.writer("hi", { style: 99 })).toThrow(/unknown style/);
    expect(() => model.writer("x".repeat(200))).toThrow(/exceeds/);
  });
});

describe("performance gate", () => {
  it("sustains at least 125 steps/sec single-threaded", () => {
    const writer = model.writer("the quick brown fox jumps over the lazy dog then keeps on going", {
      bias: 0.75,
      seed: 1,
    });
    for (let i = 0; i < 30; i++) writer.step(); // warmup / JIT
    const begin = performance.now();
    let steps = 0;
    while (steps < 600 && writer.step() !== null) steps++;
    const elapsedSeconds = (performance.now() - begin) / 1000;
    const stepsPerSecond = steps / elapsedSeconds;
    console.log(`engine speed: ${Math.round(stepsPerSecond)} steps/sec over ${steps} steps`);
    expect(stepsPerSecond).toBeGreaterThan(125);
  });
});
