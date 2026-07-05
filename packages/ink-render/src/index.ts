/**
 * Post-processing that turns raw model strokes into ink worth looking at:
 * per-stroke Savitzky-Golay smoothing, least-squares baseline alignment,
 * and speed-based pen widths. Pure geometry over the ink-core IR — no DOM,
 * so the web canvas, exporters, and node scripts all share one pipeline.
 *
 * `smoothLine` and `alignLine` port `_denoise` and `_align` from the
 * reference implementation (graves-handwriting-mlx `draw.py`) and are
 * golden-tested against scipy/numpy outputs. Both are orientation-agnostic,
 * so they work on screen-space (y-down) lines as-is.
 */

import type { InkLine } from "../../ink-core/src/index.js";

export { ribbonOutline, ribbonPath, RIBBON_WIDTH, type RibbonOutline } from "./ribbon.js";
export { layoutLine, lineToSvg, penStrokes, type LineLayout, type LineSvgOptions, type PenRun, type PenStrokeParts } from "./svg.js";
export { lineToAnimatedSvg, type AnimatedSvgOptions } from "./animate.js";

/** Savitzky-Golay smoothing kernel, window 7 / polyorder 3 (savgol_coeffs). */
const SG_KERNEL = [-2 / 21, 3 / 21, 6 / 21, 7 / 21, 6 / 21, 3 / 21, -2 / 21];
const SG_HALF = 3;

/** savgol_filter(values, 7, 3, mode="nearest") — edges clamp to endpoints. */
function savgol(values: readonly number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -SG_HALF; k <= SG_HALF; k++) {
      const j = Math.min(Math.max(i + k, 0), n - 1);
      sum += SG_KERNEL[k + SG_HALF]! * values[j]!;
    }
    out[i] = sum;
  }
  return out;
}

/**
 * Smooth each stroke's x and y tracks independently. Removes the sampling
 * jitter that makes raw model output look shaky, while pen-up gaps stay
 * exactly where the model put them.
 */
export function smoothLine(line: InkLine): InkLine {
  return {
    strokes: line.strokes.map((stroke) => {
      const xs = savgol(stroke.points.map(([x]) => x));
      const ys = savgol(stroke.points.map(([, y]) => y));
      return { points: xs.map((x, i) => [x, ys[i]!] as [number, number]) };
    }),
  };
}

/**
 * Level the baseline: least-squares fit of y over x across every point,
 * then rotate the whole line so the fitted slope becomes horizontal.
 * This is what removes the model's uphill/downhill drift. Matches the
 * reference `_align` exactly, including its scalar offset subtraction
 * (a translation later normalized away by layout).
 */
export function alignLine(line: InkLine): InkLine {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const stroke of line.strokes) {
    for (const [x, y] of stroke.points) {
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
  }
  const denom = n * sxx - sx * sx;
  if (n < 2 || Math.abs(denom) < 1e-9) return line;
  const slope = (n * sxy - sx * sy) / denom;
  const offset = (sy - slope * sx) / n;
  const theta = Math.atan(slope);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    strokes: line.strokes.map((stroke) => ({
      points: stroke.points.map(
        ([x, y]) => [x * cos + y * sin - offset, y * cos - x * sin - offset] as [number, number],
      ),
    })),
  };
}

/** Smoothing then alignment — the standard polish for a finished line. */
export function polishLine(line: InkLine): InkLine {
  return alignLine(smoothLine(line));
}

export interface PenWidthOptions {
  /** Nominal width at reference pen speed. */
  base?: number;
  /** Width floor (fast strokes). Defaults to 0.55 × base. */
  min?: number;
  /** Width ceiling (slow, deliberate strokes). Defaults to 1.45 × base. */
  max?: number;
  /**
   * Pen speed (units per timestep) that maps to `base` width. Defaults to
   * the line's median segment length, so width adapts to the writing scale.
   */
  refSpeed?: number;
  /** EMA factor for speed smoothing, 0–1; higher follows speed faster. */
  smoothing?: number;
}

/**
 * Per-point pen widths from pen speed: ink runs thin where the pen moves
 * fast and pools where it slows, with a slight taper at stroke ends where
 * the pen lands and lifts. Points are one model timestep apart, so segment
 * length *is* speed. Returns one width per point, per stroke.
 */
export function penWidths(line: InkLine, options: PenWidthOptions = {}): number[][] {
  const base = options.base ?? 2;
  const min = options.min ?? 0.55 * base;
  const max = options.max ?? 1.45 * base;
  const smoothing = options.smoothing ?? 0.35;

  const segmentLengths = line.strokes.flatMap((stroke) => {
    const lengths: number[] = [];
    for (let i = 1; i < stroke.points.length; i++) {
      const [x0, y0] = stroke.points[i - 1]!;
      const [x1, y1] = stroke.points[i]!;
      lengths.push(Math.hypot(x1 - x0, y1 - y0));
    }
    return lengths;
  });
  const refSpeed = options.refSpeed ?? (median(segmentLengths) || 1);

  return line.strokes.map((stroke) => {
    const count = stroke.points.length;
    const widths = new Array<number>(count);
    let ema = refSpeed;
    for (let i = 0; i < count; i++) {
      const prev = stroke.points[Math.max(i - 1, 0)]!;
      const here = stroke.points[i]!;
      const speed = i === 0 ? refSpeed : Math.hypot(here[0] - prev[0], here[1] - prev[1]);
      ema = smoothing * speed + (1 - smoothing) * ema;
      // Hyperbolic falloff: base at refSpeed, thicker when slower, thinner
      // when faster, clamped to keep the line readable at the extremes.
      const width = base * ((1.5 * refSpeed) / (0.5 * refSpeed + ema));
      widths[i] = Math.min(Math.max(width, min), max);
    }
    if (count >= 4) {
      widths[0]! *= 0.7;
      widths[1]! *= 0.88;
      widths[count - 2]! *= 0.88;
      widths[count - 1]! *= 0.7;
    }
    return widths;
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
