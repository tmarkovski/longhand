/**
 * Ribbon rendering, the calligrapher engine's ink look, ported from the
 * vendored reference (vendor/calligrapher-ai/engine.pretty.js, functions
 * `q` and `B`): each stroke becomes one closed outline polygon whose
 * half-width follows smoothed pen speed (ink pools where the pen is
 * slow), rounded with soft cubic segments, and filled.
 *
 * Input points are display-space (already laid out); `scale` is the
 * layout's model-to-display scale so the speed normalization matches the
 * reference regardless of canvas size. The result is an SVG path string,
 * usable directly in SVG `d` attributes or via `new Path2D(d)` on canvas.
 */

type Point = readonly [number, number];

/** Reference default for its stroke-width slider. */
export const RIBBON_WIDTH = 0.75;

/** Per-point pen speeds: segment lengths smoothed over a ±2 window. */
function smoothedSpeeds(points: readonly Point[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const from = points[i === 0 ? 0 : i - 1]!;
    const to = points[i === 0 ? 1 : i]!;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    lengths.push(Math.sqrt(dx * dx + dy * dy));
  }
  const smoothed: number[] = [];
  for (let i = 0; i < lengths.length; i++) {
    const start = Math.max(i - 2, 0);
    const end = Math.min(i + 3, lengths.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += lengths[j]!;
    smoothed.push(sum / (end - start));
  }
  return smoothed;
}

/** The ribbon's two edges, one point pair per input point. */
export interface RibbonOutline {
  top: Array<[number, number]>;
  bottom: Array<[number, number]>;
}

/**
 * Compute the ribbon's edge points for one stroke — the geometry behind
 * `ribbonPath`, exposed so exporters can measure the ribbon's extent
 * (e.g. to size a reveal mask). Returns null below two points.
 */
export function ribbonOutline(
  points: readonly Point[],
  scale: number,
  width: number = RIBBON_WIDTH,
): RibbonOutline | null {
  if (points.length < 2) return null;
  const speeds = smoothedSpeeds(points);

  const top: Array<[number, number]> = [];
  const bottom: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    let tx: number;
    let ty: number;
    if (i === 0) {
      tx = points[1]![0] - points[0]![0];
      ty = points[1]![1] - points[0]![1];
    } else if (i === points.length - 1) {
      tx = points[i]![0] - points[i - 1]![0];
      ty = points[i]![1] - points[i - 1]![1];
    } else {
      tx = points[i + 1]![0] - points[i - 1]![0];
      ty = points[i + 1]![1] - points[i - 1]![1];
    }
    const norm = Math.max(Math.sqrt(tx * tx + ty * ty), 14);
    const speed = speeds[i]! / scale;
    const nx = (width * (-ty / norm)) / speed;
    const ny = (width * (tx / norm)) / speed;
    top.push([points[i]![0] + 2 * nx, points[i]![1] + 2 * ny]);
    bottom.push([points[i]![0] - 2 * nx, points[i]![1] - 2 * ny]);
  }
  return { top, bottom };
}

/**
 * Build the filled-outline path for one stroke. Returns null for strokes
 * of fewer than two points (the reference draws nothing for those).
 */
export function ribbonPath(
  points: readonly Point[],
  scale: number,
  width: number = RIBBON_WIDTH,
): string | null {
  const edges = ribbonOutline(points, scale, width);
  if (!edges) return null;
  const { top, bottom } = edges;

  const outline = top.concat(bottom.reverse());
  const count = outline.length;
  const fmt = (value: number) => value.toFixed(2);
  const parts = [`M ${fmt(outline[0]![0])},${fmt(outline[0]![1])}`];
  for (let i = 0; i < count; i++) {
    const before = outline[(i - 1 + count) % count]!;
    const here = outline[i]!;
    const next = outline[(i + 1) % count]!;
    const after = outline[(i + 2) % count]!;
    const c1x = here[0] + 0.2 * (next[0] - before[0]);
    const c1y = here[1] + 0.2 * (next[1] - before[1]);
    const c2x = next[0] - 0.2 * (after[0] - here[0]);
    const c2y = next[1] - 0.2 * (after[1] - here[1]);
    parts.push(
      `C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(next[0])} ${fmt(next[1])}`,
    );
  }
  return parts.join(" ");
}
