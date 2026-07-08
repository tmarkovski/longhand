/**
 * Standalone SVG documents from ink lines — the shared serializer behind
 * the per-engine style-preview scripts and the app's export dialog. One
 * entry point with a renderer switch mirroring the app's pen/ribbon split:
 * "pen" strokes polylines with speed-based widths, "ribbon" fills the
 * calligrapher's outline polygons from `ribbonPath`.
 *
 * Output is tightly cropped and, by default, transparent-background
 * `currentColor` ink so the consuming CSS picks the color (when the SVG is
 * inlined; inside an <img> it falls back to black). Exports pass explicit
 * `ink`/`background` so the file looks right anywhere.
 */

import { lineBounds, transformLine, type InkLine } from "../../ink-core/src/index.js";
import { penWidths, type PenWidthOptions } from "./index.js";
import { ribbonPath, RIBBON_WIDTH } from "./ribbon.js";

export interface LineSvgOptions {
  /** Which ink look to draw; matches the engine's renderer in the app. */
  renderer: "pen" | "ribbon";
  /** Model-to-display scale applied while laying out the line. */
  scale: number;
  /** Whitespace around the ink, in display units: one number for both
   * axes, or separate horizontal/vertical amounts (how a caller pads a
   * line out to a target canvas ratio). Defaults to 6. */
  padding?: number | { x: number; y: number };
  /** Ink paint. Defaults to `currentColor` (inherit when inlined). */
  ink?: string;
  /** Background paint; omitted (transparent) by default. */
  background?: string;
  /** Pen look: pen width options plus the run quantization step. */
  pen?: PenWidthOptions & { widthStep?: number };
  /** Ribbon look: nominal ribbon width. Defaults to `RIBBON_WIDTH`. */
  ribbonWidth?: number;
}

/** A line laid out for serialization: placed ink plus the crop size. */
export interface LineLayout {
  placed: InkLine;
  width: number;
  height: number;
}

/** Lay the line out at `scale`, cropped to the ink plus `padding`. */
export function layoutLine(
  line: InkLine,
  scale: number,
  padding: number | { x: number; y: number },
): LineLayout {
  const pad = typeof padding === "number" ? { x: padding, y: padding } : padding;
  const bounds = lineBounds(line);
  const placed = transformLine(line, {
    scale,
    translateX: pad.x - bounds.minX * scale,
    translateY: pad.y - bounds.minY * scale,
  });
  return {
    placed,
    width: (bounds.maxX - bounds.minX) * scale + 2 * pad.x,
    height: (bounds.maxY - bounds.minY) * scale + 2 * pad.y,
  };
}

/**
 * Serialize one line into a self-contained SVG document, laid out at
 * `scale` and cropped to the ink plus `padding`.
 */
export function lineToSvg(line: InkLine, options: LineSvgOptions): string {
  const { scale, padding = 6, ink = "currentColor" } = options;
  const { placed, width, height } = layoutLine(line, scale, padding);

  const ribbon = options.renderer === "ribbon";
  const parts = ribbon
    ? ribbonParts(placed, scale, options.ribbonWidth ?? RIBBON_WIDTH)
    : penPartStrings(penStrokes(placed, options.pen), ink);
  // Ribbons are filled outlines; pen runs are stroked centerlines.
  const paint = ribbon
    ? `fill="${ink}" stroke="none"`
    : `fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round"`;
  const backdrop = options.background
    ? `<rect width="100%" height="100%" fill="${options.background}"/>\n`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" ` +
    `${paint} role="img">\n` +
    backdrop +
    parts.join("\n") +
    "\n</svg>\n"
  );
}

// SVG can't vary width along one path, so pen segments are grouped into
// runs of similar width and each run becomes a path. Coarse enough to keep
// files small, fine enough that the steps are invisible at dropdown size.
const WIDTH_STEP = 0.2;

/** One constant-width polyline run, with the point-count timing an
 * animated serialization needs: global point indices are pen time. */
export interface PenRun {
  points: Array<[number, number]>;
  width: number;
  /** Global index (across all strokes) of the run's first point. */
  startIndex: number;
  /** Global index of the run's last point. */
  endIndex: number;
  /** Geometric polyline length. */
  length: number;
}

/** A stroke rendered for SVG: a touchdown dot plus width-bucketed runs. */
export interface PenStrokeParts {
  touchdown: { x: number; y: number; r: number; index: number };
  runs: PenRun[];
}

/** Split each stroke into constant-width runs (shared by the static and
 * animated serializers). */
export function penStrokes(
  placed: InkLine,
  options: LineSvgOptions["pen"] = {},
): PenStrokeParts[] {
  const { widthStep = WIDTH_STEP, ...widthOptions } = options;
  const widths = penWidths(placed, widthOptions);

  let globalIndex = 0;
  return placed.strokes.map((stroke, strokeIndex) => {
    const [x0, y0] = stroke.points[0]!;
    const parts: PenStrokeParts = {
      touchdown: { x: x0, y: y0, r: widths[strokeIndex]![0]! / 2, index: globalIndex },
      runs: [],
    };
    let run: Array<[number, number]> = [];
    let runWidth = 0;
    let runStart = 0;
    let runLength = 0;
    const flush = (endIndex: number) => {
      if (run.length > 1) {
        parts.runs.push({
          points: run,
          width: runWidth,
          startIndex: runStart,
          endIndex,
          length: runLength,
        });
      }
      run = [];
      runLength = 0;
    };
    for (let i = 1; i < stroke.points.length; i++) {
      const [x, y] = stroke.points[i]!;
      const [px, py] = stroke.points[i - 1]!;
      const segment = (widths[strokeIndex]![i - 1]! + widths[strokeIndex]![i]!) / 2;
      const bucket = Math.max(widthStep, Math.round(segment / widthStep) * widthStep);
      if (run.length === 0 || bucket !== runWidth) {
        flush(globalIndex + i - 1);
        run.push([px, py]);
        runWidth = bucket;
        runStart = globalIndex + i - 1;
      }
      run.push([x, y]);
      runLength += Math.hypot(x - px, y - py);
    }
    flush(globalIndex + stroke.points.length - 1);
    globalIndex += stroke.points.length;
    return parts;
  });
}

/** Static markup for pen strokes: a dot and a path per run. */
function penPartStrings(strokes: PenStrokeParts[], ink: string): string[] {
  const parts: string[] = [];
  for (const stroke of strokes) {
    const { x, y, r } = stroke.touchdown;
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${ink}" stroke="none"/>`,
    );
    for (const run of stroke.runs) {
      const d = run.points.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(" L ");
      parts.push(`<path d="M ${d}" stroke-width="${run.width.toFixed(2)}"/>`);
    }
  }
  return parts;
}

/** One filled outline path per stroke; sub-two-point strokes draw nothing. */
function ribbonParts(placed: InkLine, scale: number, width: number): string[] {
  const parts: string[] = [];
  for (const stroke of placed.strokes) {
    const d = ribbonPath(stroke.points, scale, width);
    if (d) parts.push(`<path d="${d}"/>`);
  }
  return parts;
}
