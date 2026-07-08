/**
 * File exports for a finished line, all client-side: static and animated
 * SVG straight from the vector pipeline, PNG/GIF/MP4 rasterized from an
 * offscreen replay of the same painters the canvas uses.
 *
 * Exports lay out from the raw offsets — ink-proportional and tightly
 * cropped — never from the on-screen canvas fit (whose margins and height
 * cap are display concerns). The caller resolves every style knob
 * (colors, widths, pace) into `ExportStyle`, and the per-take choices
 * (canvas ratio, padding, frame rate, end pause) into `ExportOptions`, so
 * this module stays free of app state.
 */

import { lineBounds, offsetsToLine, type Bounds, type InkLine } from "@longhand/ink-core";
import {
  alignLine,
  layoutLine,
  lineToAnimatedSvg,
  lineToSvg,
  penWidths,
  polishLine,
  ribbonPath,
} from "@longhand/ink-render";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export type ExportFormat = "svg" | "animated-svg" | "png" | "gif" | "mp4";

export interface ExportStyle {
  renderer: "pen" | "ribbon";
  /** Resolved ink color (never null — the caller applies its default). */
  ink: string;
  /** Paper color, or null for transparent (opaque formats fall back to white). */
  paper: string | null;
  /** Pen base width per unit of layout scale (thickness/weight applied). */
  penBasePerScale: number;
  /** Ribbon nominal width (factor/thickness/weight applied). */
  ribbonWidth: number;
  /** Animation pace: milliseconds per model timestep at the chosen speed. */
  msPerStep: number;
}

/** Per-take export choices, all optional (defaults match the classics). */
export interface ExportOptions {
  /** Canvas width:height to pad out to, or null to crop tight to the ink. */
  ratio?: number | null;
  /** Whitespace around the ink, in layout units (the ink is 200 tall). */
  padding?: number;
  /** Frames per second for the GIF/MP4 encodes. */
  fps?: number;
  /** Hold on the finished line — before the loop, or ending the video. */
  holdMs?: number;
}

/** Ink height in layout units; everything else keys off this. */
const INK_HEIGHT = 200;
const PADDING = 40;
/** Beat before the pen touches down / hold on the finished line. */
const LEAD_MS = 350;
const HOLD_MS = 1600;

/** Raster targets: height for a shortish word, width-capped so a long
 * line scales down instead of producing an absurdly wide file. */
const PNG_SIZE = { height: 900, maxWidth: 4800 };
const GIF_SIZE = { height: 360, maxWidth: 1280 };
const MP4_SIZE = { height: 720, maxWidth: 1920 };

const GIF_FPS = 25;
const MP4_FPS = 30;

/** Even whitespace around the ink — the chosen padding on both axes, then
 * one axis stretched (ink centered) when the tight crop is narrower or
 * flatter than the canvas ratio asks for. The ink never scales down. */
function canvasPadding(
  bounds: Bounds,
  scale: number,
  options: ExportOptions,
): { x: number; y: number } {
  const base = options.padding ?? PADDING;
  const inkWidth = (bounds.maxX - bounds.minX) * scale;
  const inkHeight = (bounds.maxY - bounds.minY) * scale;
  let width = inkWidth + 2 * base;
  let height = inkHeight + 2 * base;
  if (options.ratio) {
    if (width / height < options.ratio) width = height * options.ratio;
    else height = width / options.ratio;
  }
  return { x: (width - inkWidth) / 2, y: (height - inkHeight) / 2 };
}

/** Polish the raw offsets the same way the app's renderer does, pick the
 * ink-proportional export scale, and resolve the canvas padding. */
function exportLine(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  options: ExportOptions,
) {
  const line =
    style.renderer === "ribbon"
      ? alignLine(offsetsToLine(offsets))
      : polishLine(offsetsToLine(offsets));
  const bounds = lineBounds(line);
  const scale = INK_HEIGHT / Math.max(bounds.maxY - bounds.minY, 1);
  return { line, scale, padding: canvasPadding(bounds, scale, options) };
}

function svgOptions(style: ExportStyle, scale: number, padding: { x: number; y: number }) {
  return {
    renderer: style.renderer,
    scale,
    padding,
    ink: style.ink,
    background: style.paper ?? undefined,
    pen: { base: style.penBasePerScale * scale },
    ribbonWidth: style.ribbonWidth,
  };
}

export function toStaticSvg(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  options: ExportOptions = {},
): Blob {
  const { line, scale, padding } = exportLine(offsets, style, options);
  return new Blob([lineToSvg(line, svgOptions(style, scale, padding))], {
    type: "image/svg+xml",
  });
}

export function toAnimatedSvg(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  options: ExportOptions = {},
): Blob {
  const { line, scale, padding } = exportLine(offsets, style, options);
  const svg = lineToAnimatedSvg(line, {
    ...svgOptions(style, scale, padding),
    msPerStep: style.msPerStep,
    leadMs: LEAD_MS,
    holdMs: options.holdMs ?? HOLD_MS,
  });
  return new Blob([svg], { type: "image/svg+xml" });
}

/** One animation step: a laid-out point with its ink width. */
interface PenStep {
  x: number;
  y: number;
  width: number;
  stroke: number;
}

/** Offscreen replay of the canvas painters: `paint(context, limit)` draws
 * the first `limit` points (monotonically increasing limits only). */
interface Painter {
  /** Layout-unit canvas size. */
  width: number;
  height: number;
  totalPoints: number;
  paint(context: OffscreenCanvasRenderingContext2D, limit: number): void;
}

function makePainter(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  background: string | null,
  options: ExportOptions,
): Painter {
  const { line, scale, padding } = exportLine(offsets, style, options);
  const { placed, width, height } = layoutLine(line, scale, padding);
  const paintBackground = (context: OffscreenCanvasRenderingContext2D) => {
    if (background === null) {
      context.clearRect(0, 0, width, height);
      return;
    }
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  };

  if (style.renderer === "ribbon") {
    const strokes = placed.strokes.map((stroke) => stroke.points);
    const totalPoints = strokes.reduce((sum, points) => sum + points.length, 0);
    const finished: Array<Path2D | null> = strokes.map(() => null);
    return {
      width,
      height,
      totalPoints,
      // Ribbons are filled outlines, so each frame repaints the line:
      // finished strokes from cached paths, the growing stroke rebuilt.
      paint(context, limit) {
        paintBackground(context);
        context.fillStyle = style.ink;
        let remaining = limit;
        for (let index = 0; index < strokes.length && remaining > 0; index++) {
          const points = strokes[index]!;
          const take = Math.min(points.length, remaining);
          remaining -= take;
          if (take < 2) continue;
          let path = take === points.length ? finished[index] : null;
          if (!path) {
            const d = ribbonPath(points.slice(0, take), scale, style.ribbonWidth);
            if (!d) continue;
            path = new Path2D(d);
            if (take === points.length) finished[index] = path;
          }
          context.fill(path);
        }
      },
    };
  }

  const widths = penWidths(placed, { base: style.penBasePerScale * scale });
  const steps: PenStep[] = placed.strokes.flatMap((stroke, strokeIndex) =>
    stroke.points.map(([x, y], pointIndex) => ({
      x,
      y,
      width: widths[strokeIndex]![pointIndex]!,
      stroke: strokeIndex,
    })),
  );
  let drawn = 0;
  const mid = (a: PenStep, b: PenStep): [number, number] => [(a.x + b.x) / 2, (a.y + b.y) / 2];
  return {
    width,
    height,
    totalPoints: steps.length,
    // Same segment construction as the app's paintPen: quadratics through
    // midpoints with the sample as control point, incremental by `drawn`.
    paint(context, limit) {
      if (drawn === 0) paintBackground(context);
      context.strokeStyle = style.ink;
      context.fillStyle = style.ink;
      context.lineCap = "round";
      context.lineJoin = "round";
      while (drawn < limit) {
        const step = steps[drawn]!;
        const previous = drawn > 0 ? steps[drawn - 1]! : null;
        if (!previous || previous.stroke !== step.stroke) {
          context.beginPath();
          context.arc(step.x, step.y, step.width / 2, 0, Math.PI * 2);
          context.fill();
        } else {
          const before = drawn > 1 ? steps[drawn - 2]! : null;
          const next = steps[drawn + 1];
          context.lineWidth = (previous.width + step.width) / 2;
          context.beginPath();
          if (before && before.stroke === step.stroke) {
            context.moveTo(...mid(before, previous));
            context.quadraticCurveTo(previous.x, previous.y, ...mid(previous, step));
          } else {
            context.moveTo(previous.x, previous.y);
            context.lineTo(...mid(previous, step));
          }
          if (!next || next.stroke !== step.stroke) {
            context.lineTo(step.x, step.y);
          }
          context.stroke();
        }
        drawn++;
      }
    },
  };
}

function makeCanvas(
  painter: Painter,
  size: { height: number; maxWidth: number },
  evenPixels = false,
) {
  const ratio = Math.min(size.height / painter.height, size.maxWidth / painter.width);
  let pixelWidth = Math.max(2, Math.round(painter.width * ratio));
  let pixelHeight = Math.max(2, Math.round(painter.height * ratio));
  if (evenPixels) {
    pixelWidth -= pixelWidth % 2;
    pixelHeight -= pixelHeight % 2;
  }
  const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.scale(pixelWidth / painter.width, pixelHeight / painter.height);
  return { canvas, context, pixelWidth, pixelHeight };
}

export async function toPng(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  options: ExportOptions = {},
): Promise<Blob> {
  // PNG keeps transparency when no paper is chosen.
  const painter = makePainter(offsets, style, style.paper, options);
  const { canvas, context } = makeCanvas(painter, PNG_SIZE);
  painter.paint(context, painter.totalPoints);
  return canvas.convertToBlob({ type: "image/png" });
}

export interface EncodeProgress {
  (done: number, total: number): void;
}

/** Replay timing shared by the video formats. */
function frameSchedule(painter: Painter, style: ExportStyle, fps: number, holdMs: number) {
  const frameMs = 1000 / fps;
  const drawMs = painter.totalPoints * style.msPerStep;
  const totalFrames = Math.max(2, Math.ceil((LEAD_MS + drawMs + holdMs) / frameMs));
  const limitAt = (frame: number) =>
    Math.min(
      painter.totalPoints,
      Math.max(0, Math.floor((frame * frameMs - LEAD_MS) / style.msPerStep)),
    );
  return { frameMs, totalFrames, limitAt };
}

export async function toGif(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  options: ExportOptions = {},
  onProgress?: EncodeProgress,
  signal?: AbortSignal,
): Promise<Blob> {
  // GIF transparency is binary and fringes badly, so it's always opaque.
  const painter = makePainter(offsets, style, style.paper ?? "#ffffff", options);
  const { canvas, context, pixelWidth, pixelHeight } = makeCanvas(painter, GIF_SIZE);
  const { frameMs, totalFrames, limitAt } = frameSchedule(
    painter,
    style,
    options.fps ?? GIF_FPS,
    options.holdMs ?? HOLD_MS,
  );

  // Global palette from the finished line, so colors stay rock steady
  // across frames (the ink is few-colored by construction).
  const preview = makePainter(offsets, style, style.paper ?? "#ffffff", options);
  const previewTarget = makeCanvas(preview, GIF_SIZE);
  preview.paint(previewTarget.context, preview.totalPoints);
  const finished = previewTarget.context.getImageData(0, 0, pixelWidth, pixelHeight);
  const palette = quantize(finished.data, 256);

  const encoder = GIFEncoder();
  for (let frame = 0; frame < totalFrames; frame++) {
    if (signal?.aborted) throw new DOMException("export cancelled", "AbortError");
    painter.paint(context, limitAt(frame));
    const { data } = context.getImageData(0, 0, pixelWidth, pixelHeight);
    const indexed = applyPalette(data, palette);
    encoder.writeFrame(indexed, pixelWidth, pixelHeight, {
      palette,
      delay: frameMs,
      repeat: 0,
    });
    onProgress?.(frame + 1, totalFrames);
    // Yield so the dialog's progress paints and cancellation lands.
    if (frame % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  encoder.finish();
  return new Blob([encoder.bytes()], { type: "image/gif" });
}

/** Encoder configs to try, best first: H.264 plays everywhere; Chromium
 * builds without proprietary codecs (and some hardware) fall back to VP9
 * or AV1 in the same MP4 container. */
const MP4_CODECS: Array<{ codec: string; muxerCodec: "avc" | "vp9" | "av1" }> = [
  { codec: "avc1.640029", muxerCodec: "avc" },
  { codec: "avc1.4d0029", muxerCodec: "avc" },
  { codec: "avc1.42001f", muxerCodec: "avc" },
  { codec: "vp09.00.31.08", muxerCodec: "vp9" },
  { codec: "av01.0.08M.08", muxerCodec: "av1" },
];

export function videoSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

export async function toMp4(
  offsets: ReadonlyArray<[number, number, number]>,
  style: ExportStyle,
  options: ExportOptions = {},
  onProgress?: EncodeProgress,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!videoSupported()) throw new Error("video export needs a browser with WebCodecs");
  const fps = options.fps ?? MP4_FPS;
  // H.264 has no alpha; the video always sits on paper (white by default).
  const painter = makePainter(offsets, style, style.paper ?? "#ffffff", options);
  const { canvas, context, pixelWidth, pixelHeight } = makeCanvas(painter, MP4_SIZE, true);
  const { totalFrames, limitAt } = frameSchedule(painter, style, fps, options.holdMs ?? 1000);

  const config: VideoEncoderConfig = {
    codec: "",
    width: pixelWidth,
    height: pixelHeight,
    framerate: fps,
    bitrate: Math.min(12_000_000, Math.max(2_000_000, Math.round(pixelWidth * pixelHeight * fps * 0.12))),
  };
  let muxerCodec: "avc" | "vp9" | "av1" | null = null;
  for (const candidate of MP4_CODECS) {
    const support = await VideoEncoder.isConfigSupported({ ...config, codec: candidate.codec });
    if (support.supported) {
      config.codec = candidate.codec;
      muxerCodec = candidate.muxerCodec;
      break;
    }
  }
  if (!muxerCodec) throw new Error("this browser can't encode MP4 video");

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: muxerCodec, width: pixelWidth, height: pixelHeight },
    fastStart: "in-memory",
  });
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encodeError = error;
    },
  });
  encoder.configure(config);

  const frameUs = Math.round((1000 / fps) * 1000);
  for (let frame = 0; frame < totalFrames; frame++) {
    if (signal?.aborted) {
      encoder.close();
      throw new DOMException("export cancelled", "AbortError");
    }
    if (encodeError) throw encodeError;
    painter.paint(context, limitAt(frame));
    const videoFrame = new VideoFrame(canvas, {
      timestamp: frame * frameUs,
      duration: frameUs,
    });
    encoder.encode(videoFrame, { keyFrame: frame % (fps * 2) === 0 });
    videoFrame.close();
    onProgress?.(frame + 1, totalFrames);
    if (encoder.encodeQueueSize > 4) {
      await new Promise<void>((resolve) =>
        encoder.addEventListener("dequeue", () => resolve(), { once: true }),
      );
    } else if (frame % 8 === 7) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await encoder.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}

/** longhand-<text slug>.<ext> */
export function exportFileName(text: string, format: ExportFormat): string {
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "line";
  const extension = format === "animated-svg" ? "svg" : format;
  return `longhand-${slug}.${extension}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the click a beat to grab the URL before revoking it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
