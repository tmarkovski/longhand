import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InkLine } from "@longhand/ink-core";
import { alignLine, penWidths, polishLine, smoothLine } from "../src/index.js";

interface Golden {
  savgol: Array<{ input: number[]; expected: number[] }>;
  align: { input: Array<[number, number]>; expected: Array<[number, number]> };
}

const golden = JSON.parse(
  readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
) as Golden;

function lineOf(points: Array<[number, number]>): InkLine {
  return { strokes: [{ points }] };
}

describe("smoothLine", () => {
  it("matches scipy savgol_filter(7, 3, mode='nearest') at every stroke length", () => {
    for (const { input, expected } of golden.savgol) {
      // x and -x through one stroke exercises both coordinate tracks.
      const line = lineOf(input.map((v) => [v, -v]));
      const smoothed = smoothLine(line).strokes[0]!.points;
      smoothed.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(expected[i]!, 6);
        expect(y).toBeCloseTo(-expected[i]!, 6);
      });
    }
  });

  it("preserves stroke structure", () => {
    const line: InkLine = {
      strokes: [
        { points: [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1], [6, 0], [7, 1]] },
        { points: [[10, 10]] },
      ],
    };
    const smoothed = smoothLine(line);
    expect(smoothed.strokes.length).toBe(2);
    expect(smoothed.strokes[0]!.points.length).toBe(8);
    expect(smoothed.strokes[1]!.points.length).toBe(1);
  });
});

describe("alignLine", () => {
  it("matches the reference _align", () => {
    const aligned = alignLine(lineOf(golden.align.input)).strokes[0]!.points;
    aligned.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(golden.align.expected[i]![0], 5);
      expect(y).toBeCloseTo(golden.align.expected[i]![1], 5);
    });
  });

  it("levels a sloped line", () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 50; i++) points.push([i * 4, i * 0.8 + (i % 2)]);
    const aligned = alignLine(lineOf(points)).strokes[0]!.points;
    const ys = aligned.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(3);
  });

  it("leaves degenerate lines untouched", () => {
    const dot = lineOf([[5, 5]]);
    expect(alignLine(dot)).toEqual(dot);
    const vertical = lineOf([[2, 0], [2, 10], [2, 20]]);
    expect(alignLine(vertical)).toEqual(vertical);
  });
});

describe("penWidths", () => {
  it("returns one width per point and respects clamps", () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 30; i++) points.push([i * (1 + (i % 5)), 0]);
    const widths = penWidths(lineOf(points), { base: 2 });
    expect(widths.length).toBe(1);
    expect(widths[0]!.length).toBe(30);
    for (const w of widths[0]!) {
      expect(w).toBeGreaterThanOrEqual(0.7 * 1.1); // floor × end taper
      expect(w).toBeLessThanOrEqual(2.9);
    }
  });

  it("draws thinner where the pen moves faster", () => {
    const slow: Array<[number, number]> = [];
    const fast: Array<[number, number]> = [];
    for (let i = 0; i < 20; i++) {
      slow.push([i, 0]);
      fast.push([i * 6, 0]);
    }
    const line: InkLine = { strokes: [{ points: slow }, { points: fast }] };
    const [slowWidths, fastWidths] = penWidths(line, { base: 2 });
    expect(fastWidths![10]!).toBeLessThan(slowWidths![10]!);
  });

  it("uses base width at uniform speed, mid-stroke", () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 20; i++) points.push([i * 3, 0]);
    const widths = penWidths(lineOf(points), { base: 2 })[0]!;
    expect(widths[10]!).toBeCloseTo(2, 5);
  });
});

describe("polishLine", () => {
  it("composes smoothing and alignment", () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 40; i++) points.push([i * 5, i * 1.2 + (i % 3)]);
    const polished = polishLine(lineOf(points)).strokes[0]!.points;
    const ys = polished.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4);
  });
});
