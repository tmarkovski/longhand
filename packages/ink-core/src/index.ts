/**
 * The stroke IR: the one abstraction every engine emits and every
 * renderer/exporter consumes.
 *
 * Coordinates are screen-space (y grows downward). Points are one model
 * timestep apart (`dtMs`), which is what encodes pen speed: dense points
 * mean the pen moved slowly, sparse points mean it moved fast.
 */

export interface InkMeta {
  text: string;
  style: number | null;
  bias: number;
  seed: number;
}

export interface InkStroke {
  /** Absolute [x, y] positions, one per model timestep. */
  points: Array<[number, number]>;
}

export interface InkLine {
  strokes: InkStroke[];
}

export interface InkDocument {
  version: 1;
  /** Milliseconds represented by one point-to-point step. */
  dtMs: number;
  lines: InkLine[];
  meta?: Partial<InkMeta>;
}

/** One raw model output row: pen movement delta and end-of-stroke flag. */
export type StrokeOffset = readonly [dx: number, dy: number, eos: number];

/** Incremental generation of one line: step until it reports done. */
export interface LineWriter {
  readonly done: boolean;
  /** Advance one timestep. Returns the sampled offset, or null once done. */
  step(): StrokeOffset | null;
}

export interface EngineWriteOptions {
  /** Legibility / sampling sharpness; each engine has its own default. */
  bias?: number;
  /** Style id, or null for the engine's unstyled/random mode. */
  style?: number | null;
  /** RNG seed; same inputs + seed reproduce the exact same strokes. */
  seed?: number;
}

/**
 * The contract every handwriting engine implements. Engines emit raw
 * model-space stroke offsets (y up); everything downstream — layout,
 * polish, rendering — consumes the shared IR above.
 */
export interface InkEngine {
  /** Style ids this engine can write. */
  readonly styles: number[];
  /** Characters the engine was trained on; others must be dropped. */
  supports(character: string): boolean;
  writer(text: string, options?: EngineWriteOptions): LineWriter;
}

/**
 * Fold raw (Δx, Δy, eos) offsets into absolute screen-space strokes.
 * The model's y grows upward, so it is flipped here. eos=1 marks the last
 * point of a stroke; the next point begins a new one.
 */
export function offsetsToLine(offsets: readonly StrokeOffset[]): InkLine {
  const strokes: InkStroke[] = [];
  let points: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  for (const [dx, dy, eos] of offsets) {
    x += dx;
    y -= dy;
    points.push([x, y]);
    if (eos === 1) {
      strokes.push({ points });
      points = [];
    }
  }
  if (points.length > 0) strokes.push({ points });
  return { strokes };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function lineBounds(line: InkLine): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of line.strokes) {
    for (const [x, y] of stroke.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Translate and scale a line in place-like fashion (returns a new line). */
export function transformLine(
  line: InkLine,
  { scale = 1, translateX = 0, translateY = 0 }: { scale?: number; translateX?: number; translateY?: number },
): InkLine {
  return {
    strokes: line.strokes.map((stroke) => ({
      points: stroke.points.map(([x, y]) => [x * scale + translateX, y * scale + translateY] as [number, number]),
    })),
  };
}
