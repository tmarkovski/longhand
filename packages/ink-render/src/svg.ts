/**
 * Standalone SVG documents from ink lines — the shared serializer behind
 * the per-engine style-preview scripts. One entry point with a renderer
 * switch mirroring the app's pen/ribbon split: "pen" strokes polylines
 * with speed-based widths, "ribbon" fills the calligrapher's outline
 * polygons from `ribbonPath`.
 *
 * Output is tightly cropped, transparent background, `currentColor` ink so
 * the consuming CSS picks the color (when the SVG is inlined; inside an
 * <img> it falls back to black).
 */

import { lineBounds, transformLine, type InkLine } from "@longhand/ink-core";
import { penWidths, type PenWidthOptions } from "./index.js";
import { ribbonPath, RIBBON_WIDTH } from "./ribbon.js";

export interface LineSvgOptions {
  /** Which ink look to draw; matches the engine's renderer in the app. */
  renderer: "pen" | "ribbon";
  /** Model-to-display scale applied while laying out the line. */
  scale: number;
  /** Whitespace around the ink, in display units. Defaults to 6. */
  padding?: number;
  /** Pen look: pen width options plus the run quantization step. */
  pen?: PenWidthOptions & { widthStep?: number };
  /** Ribbon look: nominal ribbon width. Defaults to `RIBBON_WIDTH`. */
  ribbonWidth?: number;
}

/**
 * Serialize one line into a self-contained SVG document, laid out at
 * `scale` and cropped to the ink plus `padding`.
 */
export function lineToSvg(line: InkLine, options: LineSvgOptions): string {
  const { scale, padding = 6 } = options;
  const bounds = lineBounds(line);
  const placed = transformLine(line, {
    scale,
    translateX: padding - bounds.minX * scale,
    translateY: padding - bounds.minY * scale,
  });
  const width = (bounds.maxX - bounds.minX) * scale + 2 * padding;
  const height = (bounds.maxY - bounds.minY) * scale + 2 * padding;

  const ribbon = options.renderer === "ribbon";
  const parts = ribbon
    ? ribbonParts(placed, scale, options.ribbonWidth ?? RIBBON_WIDTH)
    : penParts(placed, options.pen);
  // Ribbons are filled outlines; pen runs are stroked centerlines.
  const paint = ribbon
    ? `fill="currentColor" stroke="none"`
    : `fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" ` +
    `${paint} role="img">\n` +
    parts.join("\n") +
    "\n</svg>\n"
  );
}

// SVG can't vary width along one path, so pen segments are grouped into
// runs of similar width and each run becomes a path. Coarse enough to keep
// files small, fine enough that the steps are invisible at dropdown size.
const WIDTH_STEP = 0.2;

/** Stroked polyline runs with quantized widths, plus a touchdown dot per stroke. */
function penParts(placed: InkLine, options: LineSvgOptions["pen"] = {}): string[] {
  const { widthStep = WIDTH_STEP, ...widthOptions } = options;
  const widths = penWidths(placed, widthOptions);

  const parts: string[] = [];
  placed.strokes.forEach((stroke, strokeIndex) => {
    const [x0, y0] = stroke.points[0]!;
    const touchdown = widths[strokeIndex]![0]! / 2;
    parts.push(
      `<circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="${touchdown.toFixed(2)}" fill="currentColor" stroke="none"/>`,
    );
    let run: string[] = [];
    let runWidth = 0;
    const flush = () => {
      if (run.length > 1) {
        parts.push(
          `<path d="M ${run.join(" L ")}" stroke-width="${runWidth.toFixed(2)}"/>`,
        );
      }
      run = [];
    };
    for (let i = 1; i < stroke.points.length; i++) {
      const [x, y] = stroke.points[i]!;
      const segment = (widths[strokeIndex]![i - 1]! + widths[strokeIndex]![i]!) / 2;
      const bucket = Math.max(widthStep, Math.round(segment / widthStep) * widthStep);
      if (run.length === 0 || bucket !== runWidth) {
        const [px, py] = stroke.points[i - 1]!;
        flush();
        run.push(`${px.toFixed(1)} ${py.toFixed(1)}`);
        runWidth = bucket;
      }
      run.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    flush();
  });
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
