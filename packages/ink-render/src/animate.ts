/**
 * Self-contained animated SVG: the line draws itself in pen time, holds,
 * and loops. Pure SMIL — no scripts — so the file animates anywhere an
 * SVG renders live (inline, <img>, README embeds).
 *
 * Points are one model timestep apart, so a point's global index *is* its
 * pen time; every element animates over one shared cycle with keyTimes
 * marking its window.
 *
 * The pen look reveals its constant-width runs directly with the classic
 * stroke-dashoffset trick (touchdown dots pop in via discrete opacity).
 * The ribbon look is filled outlines, which dashes can't reveal, so each
 * stroke hides behind a mask whose white stroke traces the centerline —
 * sized from the ribbon's real extent — and the mask's dash animates.
 */

import type { InkLine } from "../../ink-core/src/index.js";
import { layoutLine, penStrokes, type LineSvgOptions } from "./svg.js";
import { ribbonOutline, ribbonPath, RIBBON_WIDTH } from "./ribbon.js";

export interface AnimatedSvgOptions extends LineSvgOptions {
  /** Milliseconds of animation per model timestep (pen pace). */
  msPerStep: number;
  /** Beat before the pen touches down. Defaults to 350ms. */
  leadMs?: number;
  /** Hold on the finished line before looping. Defaults to 1600ms. */
  holdMs?: number;
  /** Loop forever (default) or play once and freeze. */
  loop?: boolean;
}

const fmt = (value: number) => String(Number(value.toFixed(1)));
const fmtTime = (value: number) => String(Number(value.toFixed(5)));

export function lineToAnimatedSvg(line: InkLine, options: AnimatedSvgOptions): string {
  const { scale, padding = 6, ink = "currentColor", msPerStep } = options;
  const leadMs = options.leadMs ?? 350;
  const holdMs = options.holdMs ?? 1600;
  const { placed, width, height } = layoutLine(line, scale, padding);

  const totalPoints = placed.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  const cycleMs = leadMs + totalPoints * msPerStep + holdMs;
  // A keyTime per point, clamped off the exact endpoints so every list can
  // start at 0 and end at 1.
  const timeOf = (index: number) =>
    Math.min(Math.max((leadMs + index * msPerStep) / cycleMs, 0.00001), 0.99999);
  const timing = options.loop === false ? `repeatCount="1" fill="freeze"` : `repeatCount="indefinite"`;

  const animateOffset = (values: number[], keyTimes: number[]) =>
    `<animate attributeName="stroke-dashoffset" dur="${cycleMs}ms" ${timing} ` +
    `values="${values.map(fmt).join(";")}" keyTimes="${keyTimes.map(fmtTime).join(";")}"/>`;

  const ribbon = options.renderer === "ribbon";
  const parts = ribbon
    ? ribbonAnimatedParts(placed, scale, options.ribbonWidth ?? RIBBON_WIDTH, {
        width,
        height,
        timeOf,
        animateOffset,
      })
    : penAnimatedParts(placed, options.pen, { ink, cycleMs, timing, timeOf, animateOffset });

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

interface PenAnimationContext {
  ink: string;
  cycleMs: number;
  timing: string;
  timeOf: (index: number) => number;
  animateOffset: (values: number[], keyTimes: number[]) => string;
}

function penAnimatedParts(
  placed: InkLine,
  penOptions: LineSvgOptions["pen"],
  context: PenAnimationContext,
): string[] {
  const { ink, cycleMs, timing, timeOf, animateOffset } = context;
  const parts: string[] = [];
  for (const stroke of penStrokes(placed, penOptions)) {
    const { x, y, r, index } = stroke.touchdown;
    parts.push(
      `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r.toFixed(2)}" fill="${ink}" stroke="none" opacity="0">` +
        `<animate attributeName="opacity" dur="${cycleMs}ms" ${timing} calcMode="discrete" ` +
        `values="0;1;1" keyTimes="0;${fmtTime(timeOf(index))};1"/></circle>`,
    );
    for (const run of stroke.runs) {
      // Dash slack over the measured length hides coordinate-rounding
      // drift; the offset animates to exactly 0, so the run still reveals
      // in full.
      const dash = run.length * 1.02 + 0.5;
      const d = run.points.map(([px, py]) => `${fmt(px)} ${fmt(py)}`).join(" L ");
      parts.push(
        `<path d="M ${d}" stroke-width="${run.width.toFixed(2)}" ` +
          `stroke-dasharray="${fmt(dash)}" stroke-dashoffset="${fmt(dash)}">` +
          animateOffset(
            [dash, dash, 0, 0],
            [0, timeOf(run.startIndex), timeOf(run.endIndex), 1],
          ) +
          `</path>`,
      );
    }
  }
  return parts;
}

interface RibbonAnimationContext {
  width: number;
  height: number;
  timeOf: (index: number) => number;
  animateOffset: (values: number[], keyTimes: number[]) => string;
}

function ribbonAnimatedParts(
  placed: InkLine,
  scale: number,
  ribbonWidth: number,
  context: RibbonAnimationContext,
): string[] {
  const { width, height, timeOf, animateOffset } = context;
  const parts: string[] = [];
  let globalIndex = 0;
  placed.strokes.forEach((stroke, strokeIndex) => {
    const points = stroke.points;
    const startIndex = globalIndex;
    globalIndex += points.length;
    const d = ribbonPath(points, scale, ribbonWidth);
    const edges = ribbonOutline(points, scale, ribbonWidth);
    if (!d || !edges) return;

    // The mask stroke must cover the ribbon wherever the pen has passed:
    // width from the ribbon's widest point (plus slack for the outline's
    // soft cubic overshoot), dash length from the centerline.
    let maskWidth = 0;
    const cumulative: number[] = [0];
    for (let i = 0; i < points.length; i++) {
      const [tx, ty] = edges.top[i]!;
      const [bx, by] = edges.bottom[i]!;
      maskWidth = Math.max(maskWidth, Math.hypot(tx - bx, ty - by));
      if (i > 0) {
        const [px, py] = points[i - 1]!;
        const [cx, cy] = points[i]!;
        cumulative.push(cumulative[i - 1]! + Math.hypot(cx - px, cy - py));
      }
    }
    maskWidth = maskWidth * 1.3 + 2;
    const length = cumulative[points.length - 1]!;
    const dash = length * 1.02 + maskWidth;
    // Resting a full mask-width past "nothing revealed" keeps the dash
    // edge's round cap from peeking out before the stroke starts.
    const hidden = dash + maskWidth;

    // Offset keyframes sampled along the stroke, so the reveal follows the
    // pen's real pace (slow in curves, quick on links between letters).
    const step = Math.max(2, Math.round(points.length / 32));
    const values: number[] = [hidden, hidden];
    const keyTimes: number[] = [0, timeOf(startIndex)];
    for (let i = step; i < points.length - 1; i += step) {
      values.push(dash - cumulative[i]!);
      keyTimes.push(timeOf(startIndex + i));
    }
    values.push(dash - length, dash - length);
    keyTimes.push(timeOf(startIndex + points.length - 1), 1);

    const centerline = points.map(([px, py]) => `${fmt(px)} ${fmt(py)}`).join(" L ");
    parts.push(
      `<mask id="reveal${strokeIndex}" maskUnits="userSpaceOnUse" x="0" y="0" ` +
        `width="${width.toFixed(1)}" height="${height.toFixed(1)}">` +
        `<path d="M ${centerline}" fill="none" stroke="#fff" stroke-width="${fmt(maskWidth)}" ` +
        `stroke-linecap="round" stroke-linejoin="round" ` +
        `stroke-dasharray="${fmt(dash)}" stroke-dashoffset="${fmt(hidden)}">` +
        animateOffset(values, keyTimes) +
        `</path></mask>`,
    );
    parts.push(`<path d="${d}" mask="url(#reveal${strokeIndex})"/>`);
  });
  return parts;
}
