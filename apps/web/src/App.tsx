import { useEffect, useRef, useState } from "react";
import { lineBounds, offsetsToLine, transformLine } from "@longhand/ink-core";
import { alignLine, penWidths, polishLine, ribbonPath, RIBBON_WIDTH } from "@longhand/ink-render";
import {
  ChevronDownIcon,
  CodeIcon,
  LinkIcon,
  PauseIcon,
  PenLineIcon,
  PlayIcon,
  Share2Icon,
  UnlinkIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import CodeDialog from "./CodeDialog.js";
import { ChipLabel, chipClass, Segmented, ThemeToggle } from "./controls.js";
import ExportDialog from "./ExportDialog.js";
import type { ExportStyle } from "./export.js";
import { buildShareUrl, parseSharedTake, type SharedTake } from "./share.js";
import type { Platform, SnippetParams } from "./snippets.js";
import StylePicker, { styleOptions } from "./StylePicker.js";
import type {
  EngineDescriptor,
  EngineId,
  RendererKind,
  SelectEngineRequest,
  WorkerEvent,
  WriteRequest,
} from "./protocol.js";

const DT_MS = 8; // one model timestep of pen time
const MARGIN_X = 32;
const MARGIN_Y = 24;
// Short words are width-light, so the height limit is what binds for them;
// cap the ink to 80% of the canvas so a two-letter word doesn't balloon to
// fill it edge to edge. Screen fit only — an SVG export lays out from the
// raw offsets, not this canvas fit.
const MAX_INK_HEIGHT = 0.8;
// Pen ink weight per unit of layout scale, so ink gets heavier as a line
// scales up to fill the canvas (the ribbon's width already rides the
// layout scale the same way). 2.2px at the old fixed 1.6 scale.
const PEN_WIDTH_PER_SCALE = 2.2 / 1.6;

// The page's ink color (matches the CSS text color). "no color" paints with
// this, and an SVG export would omit fill/stroke entirely so the paths
// inherit from wherever they're embedded.
const DEFAULT_INK = "#1c1c28";
const DEFAULT_INK_DARK = "#ececf1";

/** Cheap sRGB luminance for a #rgb/#rrggbb color, 0..1. */
function luminance(hex: string): number {
  let digits = hex.replace("#", "");
  if (digits.length === 3) digits = [...digits].map((c) => c + c).join("");
  const packed = parseInt(digits, 16);
  if (digits.length !== 6 || Number.isNaN(packed)) return 1; // unparseable: treat as light
  const r = (packed >> 16) & 255;
  const g = (packed >> 8) & 255;
  const b = packed & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** "No color" means an ink that reads on what it sits on. On the default
 * card that's the page's ink, which flips with the theme (read at paint
 * time; the theme toggle triggers a repaint when the class changes). On a
 * chosen paper the theme is irrelevant — a light paper needs dark ink even
 * in dark mode — so the paper's own luminance decides. */
function defaultInk(paper: string | null): string {
  if (paper) return luminance(paper) > 0.5 ? DEFAULT_INK : DEFAULT_INK_DARK;
  return document.documentElement.classList.contains("dark") ? DEFAULT_INK_DARK : DEFAULT_INK;
}

// Thickness is a multiplier on the renderers' tuned ink width: 1x sits in
// the middle of the slider (0.5–1.5), so default means "as tuned".
const DEFAULT_THICKNESS = 1.0;
// A brisk-but-watchable writing pace.
const DEFAULT_SPEED = 1.5;

/** Ink weight per engine + stroke combination, multiplied into thickness.
 * Normalizes how heavy 1x looks across combinations — the reference ribbon
 * width reads far lighter than the pen on the calligrapher engine, so it
 * gets a boost (and real boldness at the top of the slider). */
const INK_WEIGHT: Record<EngineId, Record<RendererKind, number>> = {
  graves: { pen: 1, ribbon: 1 },
  calligrapher: { pen: 1, ribbon: 2 },
};

/** Sampling bias behind each legibility setting: higher biases the models
 * toward their most probable strokes, so the hand gets neater. */
const LEGIBILITY = { low: 0.2, normal: 0.6, high: 0.9 } as const;
type Legibility = keyof typeof LEGIBILITY;

/** Ink palette; value null is "no color" (default ink / inherit). */
const RED_INK = "#b3261e";
const INK_COLORS: ReadonlyArray<{ name: string; value: string | null }> = [
  { name: "no color", value: null },
  { name: "blue", value: "#1e4fd8" },
  { name: "teal", value: "#0e7490" },
  { name: "green", value: "#2f6b3a" },
  { name: "red", value: RED_INK },
  { name: "sepia", value: "#7a4a21" },
  { name: "violet", value: "#6d28d9" },
];

/** Paper palette for the canvas; value null is the default card surface. */
const PAPER_COLORS: ReadonlyArray<{ name: string; value: string | null }> = [
  { name: "no color", value: null },
  { name: "ivory", value: "#f7f2e7" },
  { name: "parchment", value: "#f0e6cf" },
  { name: "mist", value: "#eef0f2" },
  { name: "rose", value: "#f8edee" },
  { name: "sage", value: "#edf2ea" },
  { name: "sky", value: "#e9f1f7" },
];

/** A shared color that isn't in a palette belongs on the custom swatch. */
function customSwatch(
  value: string | null | undefined,
  palette: ReadonlyArray<{ value: string | null }>,
): string | null {
  return value && !palette.some((swatch) => swatch.value === value) ? value : null;
}

// A share link (#/write?text=…&seed=…) carries a whole take. Parsed once
// per page load, it seeds the state below and queues the auto-write that
// fires when its engine reports ready.
const BOOT_TAKE = parseSharedTake(window.location.hash);

type Status = "loading" | "ready" | "warming" | "thinking" | "writing" | "paused" | "error";

/** One animation step: a polished point with its ink width. A stroke-index
 * change between consecutive steps means the pen lifted in between. */
interface PenStep {
  x: number;
  y: number;
  width: number;
  stroke: number;
}

/** Laid-out strokes for ribbon painting, with the layout scale the
 * ribbon's speed-to-width mapping needs. */
interface RibbonLayout {
  strokes: Array<Array<[number, number]>>;
  scale: number;
  totalPoints: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const offsetsRef = useRef<Array<[number, number, number]>>([]);
  const stepsRef = useRef<PenStep[]>([]);
  const ribbonRef = useRef<RibbonLayout | null>(null);
  const ribbonPathsRef = useRef<Array<Path2D | null>>([]);
  // `progress` is the replay clock in fractional steps; accumulating it per
  // frame (instead of measuring from a start time) lets the speed setting
  // change mid-write without the pen jumping.
  const penRef = useRef({ drawn: 0, progress: 0, lastTick: 0 });
  const speedRef = useRef(BOOT_TAKE?.speed ?? DEFAULT_SPEED);
  const rafRef = useRef(0);
  const alphabetRef = useRef<Set<string>>(new Set());
  const rendererRef = useRef<RendererKind>("pen");
  const ribbonFactorRef = useRef(1);
  const inkWeightRef = useRef(INK_WEIGHT.calligrapher);
  // Paint-time copy of the ink settings, so the rAF loop sees changes
  // without re-subscribing.
  const inkRef = useRef<{ color: string | null; thickness: number }>({
    color: BOOT_TAKE ? BOOT_TAKE.ink : RED_INK,
    thickness: BOOT_TAKE?.thickness ?? DEFAULT_THICKNESS,
  });
  // Paint-time copy of the paper, for resolving the "no color" ink.
  const paperRef = useRef<string | null>(BOOT_TAKE?.paper ?? null);
  // The engine whose ready event the UI is waiting for: lets the worker
  // handler drop announcements from a superseded activation (a quick
  // engine flip, or the boot engine racing a share link's).
  const engineRef = useRef<EngineId>(BOOT_TAKE?.engine ?? "calligrapher");
  // A share link's take, pending until its engine reports ready.
  const bootWriteRef = useRef<SharedTake | null>(BOOT_TAKE);

  const [status, setStatus] = useState<Status>("loading");
  const [note, setNote] = useState(
    BOOT_TAKE?.engine === "graves"
      ? "loading the longhand model (15 MB, one time)…"
      : "loading the calligrapher model (2.6 MB, one time)…",
  );
  const [text, setText] = useState(BOOT_TAKE?.text ?? "");
  const [legibility, setLegibility] = useState<Legibility>(BOOT_TAKE?.legibility ?? "normal");
  const [style, setStyle] = useState<number | null>(null);
  const [engine, setEngine] = useState<EngineId>(BOOT_TAKE?.engine ?? "calligrapher");
  const [descriptor, setDescriptor] = useState<EngineDescriptor | null>(null);
  const [seed, setSeed] = useState(BOOT_TAKE?.seed ?? 42);
  // "fresh" reshuffles the seed on every write (the classic new-take flow);
  // "pinned" reuses the one in the field, for dialing in a take to carry
  // into an app via the code panel. In the UI this is a chain-link lock
  // beside the seed field; editing the field locks it automatically.
  const [seedMode, setSeedMode] = useState<"fresh" | "pinned">("fresh");
  const [color, setColor] = useState<string | null>(BOOT_TAKE ? BOOT_TAKE.ink : RED_INK);
  const [customColor, setCustomColor] = useState(
    customSwatch(BOOT_TAKE?.ink, INK_COLORS) ?? DEFAULT_INK,
  );
  const [paper, setPaper] = useState<string | null>(BOOT_TAKE?.paper ?? null);
  const [customPaper, setCustomPaper] = useState(
    customSwatch(BOOT_TAKE?.paper, PAPER_COLORS) ?? "#f7f2e7",
  );
  const [thickness, setThickness] = useState(BOOT_TAKE?.thickness ?? DEFAULT_THICKNESS);
  const [speed, setSpeed] = useState(BOOT_TAKE?.speed ?? DEFAULT_SPEED);
  const [stroke, setStroke] = useState<RendererKind>("pen");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Bumped when "write" is tapped with nothing on the line and the caret
  // already there: keying the pen icon on it restarts the wiggle animation.
  const [penNudge, setPenNudge] = useState(0);
  // Lives here, not in CodeDialog: the dialog unmounts during generation,
  // and the platform choice should survive a rewrite.
  const [platform, setPlatform] = useState<Platform>("web");

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case "ready": {
          // A superseded activation (the self-started boot engine when a
          // share link wants the other one, or a quick engine flip): drop
          // it and let the wanted engine's ready win.
          if (message.engine.id !== engineRef.current) break;
          setDescriptor(message.engine);
          alphabetRef.current = new Set(message.engine.alphabet);
          ribbonFactorRef.current = message.engine.ribbonWidthFactor;
          inkWeightRef.current = INK_WEIGHT[message.engine.id];
          const boot = bootWriteRef.current;
          if (boot) {
            // A share link's take: its look wins over the engine defaults,
            // and the write it promised fires now, seed and all. The hash
            // was a launcher, not state — clean it so the address bar is
            // plain again (and the same link can be clicked twice).
            bootWriteRef.current = null;
            history.replaceState(null, "", location.pathname + location.search);
            rendererRef.current = boot.stroke ?? message.engine.renderer;
            setStroke(rendererRef.current);
            const nextStyle =
              boot.style !== null && message.engine.styles.includes(boot.style)
                ? boot.style
                : message.engine.defaultStyle;
            setStyle(nextStyle);
            const cleaned = [...boot.text]
              .filter((c) => alphabetRef.current.has(c))
              .join("")
              .slice(0, message.engine.maxTextLength);
            setText(cleaned);
            const nextSeed = boot.seed ?? Math.floor(Math.random() * 1_000_000);
            setSeed(nextSeed);
            if (cleaned.trim().length > 0) {
              worker.postMessage({
                type: "write",
                engine: message.engine.id,
                text: cleaned,
                bias: LEGIBILITY[boot.legibility],
                style: nextStyle,
                seed: nextSeed,
              } satisfies WriteRequest);
            }
          } else {
            // Each engine starts in its native ink look.
            rendererRef.current = message.engine.renderer;
            setStroke(message.engine.renderer);
            setStyle(message.engine.defaultStyle);
          }
          setStatus("ready");
          setNote("");
          break;
        }
        case "status":
          setStatus("warming");
          setNote(message.message);
          break;
        case "start":
          offsetsRef.current = [];
          stepsRef.current = [];
          ribbonRef.current = null;
          ribbonPathsRef.current = [];
          cancelAnimationFrame(rafRef.current);
          clearCanvas();
          setStatus("thinking");
          setNote("");
          break;
        case "offsets":
          offsetsRef.current.push(...message.batch);
          break;
        case "done":
          // The line is complete: lay it out for the active renderer and
          // only then let the pen replay it at writing pace.
          layout(offsetsRef.current);
          penRef.current = { drawn: 0, progress: 0, lastTick: performance.now() };
          setStatus("writing");
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(tick);
          break;
        case "error":
          setStatus("error");
          setNote(message.message);
          break;
      }
    };
    // The worker self-starts the calligrapher; a share link wanting the
    // other engine asks for it up front (the unwanted boot engine's ready
    // is dropped above).
    if (BOOT_TAKE && BOOT_TAKE.engine !== "calligrapher")
      worker.postMessage({ type: "engine", engine: BOOT_TAKE.engine } satisfies SelectEngineRequest);
    return () => {
      cancelAnimationFrame(rafRef.current);
      worker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ink settings restyle the finished line in place: re-lay it out with the
  // new width and repaint immediately (or, mid-animation, let the running
  // loop repaint from scratch at its current pace). Stroke type re-layouts
  // the same offsets through the other renderer's pipeline. Paper is here
  // because the "no color" ink resolves against it.
  useEffect(() => {
    rendererRef.current = stroke;
    inkRef.current = { color, thickness };
    paperRef.current = paper;
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, thickness, stroke, paper]);

  // The canvas is sized by CSS, so rotation, a window resize, or coming
  // back from the build page (the router hides the studio, which zeroes
  // the canvas) changes it under a bitmap laid out for the old size;
  // re-fit the line when its size actually changes. Re-registered per
  // status so refit sees the current one; the first observer callback is
  // the initial measurement, not a change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) {
        initial = false;
        return;
      }
      refit();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // The line starts empty, so put the caret on it: load, type, Enter.
  // Only where that's the natural flow — a coarse pointer means a phone,
  // where autofocus throws the keyboard over half the studio, and a cold
  // load on #/build has the studio mounted but display:none (offsetParent
  // is null there), where focus would land on an invisible field.
  useEffect(() => {
    const input = textInputRef.current;
    if (input && input.offsetParent !== null && matchMedia("(pointer: fine)").matches)
      input.focus();
  }, []);

  // Share links can also land as same-page navigations (pasted over the
  // current URL, or clicked inside the guide): apply the take live. The
  // engine is re-requested even when it's already active — activate()
  // re-announces ready, and the ready handler is where a queued take
  // fires — so both paths write through the exact same door.
  useEffect(() => {
    const onHashChange = () => {
      const take = parseSharedTake(window.location.hash);
      if (!take) return;
      setText(take.text);
      setLegibility(take.legibility);
      setColor(take.ink);
      const inkSwatch = customSwatch(take.ink, INK_COLORS);
      if (inkSwatch) setCustomColor(inkSwatch);
      setPaper(take.paper);
      const paperSwatch = customSwatch(take.paper, PAPER_COLORS);
      if (paperSwatch) setCustomPaper(paperSwatch);
      setThickness(take.thickness);
      setSpeed(take.speed);
      speedRef.current = take.speed;
      if (take.engine !== engineRef.current) {
        // Same drill as switchEngine: the old line can't be re-laid-out
        // by the new renderer.
        offsetsRef.current = [];
        setStatus("loading");
        setNote("");
      }
      setEngine(take.engine);
      engineRef.current = take.engine;
      bootWriteRef.current = take;
      workerRef.current?.postMessage({
        type: "engine",
        engine: take.engine,
      } satisfies SelectEngineRequest);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /** Re-lay-out the finished line for the current canvas size and settings,
   * then repaint (or, mid-animation, let the running loop repaint). */
  function refit() {
    // Hidden behind the build page: the canvas measures 0, so a layout now
    // would cache garbage. The ResizeObserver refits again on return.
    if (!canvasRef.current || canvasRef.current.clientWidth === 0) return;
    ribbonPathsRef.current = ribbonPathsRef.current.map(() => null);
    if (
      (status !== "ready" && status !== "writing" && status !== "paused") ||
      offsetsRef.current.length === 0
    )
      return;
    layout(offsetsRef.current);
    clearCanvas();
    penRef.current.drawn = 0;
    if (status === "writing") return; // the running loop repaints
    const canvas = canvasRef.current;
    const total =
      rendererRef.current === "ribbon"
        ? (ribbonRef.current?.totalPoints ?? 0)
        : stepsRef.current.length;
    if (!canvas || total === 0) return;
    // Paused repaints stop where the pen stopped; finished lines in full.
    const limit =
      status === "paused" ? Math.min(Math.floor(penRef.current.progress), total) : total;
    const context = canvas.getContext("2d")!;
    if (rendererRef.current === "ribbon") paintRibbon(context, limit);
    else paintPen(context, limit);
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const context = canvas.getContext("2d")!;
    context.scale(dpr, dpr);
    context.lineCap = "round";
    context.lineJoin = "round";
  }

  /** Fill the canvas: scale the line's final bounds to span the available
   * space (width or height, whichever binds first) and center it. */
  function fitToCanvas(line: ReturnType<typeof offsetsToLine>) {
    const canvas = canvasRef.current!;
    const bounds = lineBounds(line);
    const inkWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const inkHeight = Math.max(bounds.maxY - bounds.minY, 1);
    const scale = Math.min(
      (canvas.clientWidth - 2 * MARGIN_X) / inkWidth,
      Math.min(canvas.clientHeight - 2 * MARGIN_Y, canvas.clientHeight * MAX_INK_HEIGHT) /
        inkHeight,
    );
    const placed = transformLine(line, {
      scale,
      translateX: (canvas.clientWidth - inkWidth * scale) / 2 - bounds.minX * scale,
      translateY: canvas.clientHeight / 2 - (bounds.minY + inkHeight / 2) * scale,
    });
    return { placed, scale };
  }

  /** Prepare the finished line for the active renderer's animation. */
  function layout(offsets: Array<[number, number, number]>) {
    const canvas = canvasRef.current;
    if (!canvas || offsets.length === 0) return;

    if (rendererRef.current === "ribbon") {
      // The calligrapher look: unsmoothed strokes, each painted as a filled
      // speed-shaped ribbon. Unlike the reference we level the baseline —
      // leveling is a pure rotation, so segment lengths and therefore the
      // ribbon's speed-shaped widths are untouched, and the graves model's
      // uphill drift (which the pen path already corrects) stays out.
      const { placed, scale } = fitToCanvas(alignLine(offsetsToLine(offsets)));
      const strokes = placed.strokes.map((stroke) => stroke.points);
      ribbonRef.current = {
        strokes,
        scale,
        totalPoints: strokes.reduce((sum, points) => sum + points.length, 0),
      };
      ribbonPathsRef.current = strokes.map(() => null);
      return;
    }

    // The pen look: smooth, level the baseline, then speed-based widths.
    const { placed, scale } = fitToCanvas(polishLine(offsetsToLine(offsets)));
    const widths = penWidths(placed, {
      base: PEN_WIDTH_PER_SCALE * scale * inkRef.current.thickness * inkWeightRef.current.pen,
    });
    stepsRef.current = placed.strokes.flatMap((stroke, strokeIndex) =>
      stroke.points.map(([x, y], pointIndex) => ({
        x,
        y,
        width: widths[strokeIndex]![pointIndex]!,
        stroke: strokeIndex,
      })),
    );
  }

  function paintPen(context: CanvasRenderingContext2D, limit: number) {
    const steps = stepsRef.current;
    const pen = penRef.current;
    const ink = inkRef.current.color ?? defaultInk(paperRef.current);
    context.strokeStyle = ink;
    context.fillStyle = ink;
    const mid = (a: PenStep, b: PenStep): [number, number] => [(a.x + b.x) / 2, (a.y + b.y) / 2];
    while (pen.drawn < limit) {
      const step = steps[pen.drawn]!;
      const previous = pen.drawn > 0 ? steps[pen.drawn - 1]! : null;
      if (!previous || previous.stroke !== step.stroke) {
        // Pen touchdown: a dot, so single-point strokes still leave ink.
        context.beginPath();
        context.arc(step.x, step.y, step.width / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        // Quadratic through segment midpoints, with the sample as control
        // point: consecutive segments join tangent-continuously, so the
        // polyline corners that show at high layout scales disappear.
        const before = pen.drawn > 1 ? steps[pen.drawn - 2]! : null;
        const next = steps[pen.drawn + 1];
        context.lineWidth = (previous.width + step.width) / 2;
        context.beginPath();
        if (before && before.stroke === step.stroke) {
          context.moveTo(...mid(before, previous));
          context.quadraticCurveTo(previous.x, previous.y, ...mid(previous, step));
        } else {
          // First segment of the stroke starts at the touchdown itself.
          context.moveTo(previous.x, previous.y);
          context.lineTo(...mid(previous, step));
        }
        if (!next || next.stroke !== step.stroke) {
          // Last segment of the stroke: finish the trailing half.
          context.lineTo(step.x, step.y);
        }
        context.stroke();
      }
      pen.drawn++;
    }
  }

  /** Ribbons are closed outline fills, so each frame repaints the line:
   * finished strokes from cached paths, the growing stroke rebuilt. */
  function paintRibbon(context: CanvasRenderingContext2D, limit: number) {
    const canvas = canvasRef.current!;
    const line = ribbonRef.current;
    if (!line) return;
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    context.fillStyle = inkRef.current.color ?? defaultInk(paperRef.current);
    let remaining = limit;
    for (let index = 0; index < line.strokes.length && remaining > 0; index++) {
      const points = line.strokes[index]!;
      const take = Math.min(points.length, remaining);
      remaining -= take;
      if (take < 2) continue; // the reference leaves single points blank
      let path = take === points.length ? ribbonPathsRef.current[index] : null;
      if (!path) {
        const d = ribbonPath(
          points.slice(0, take),
          line.scale,
          RIBBON_WIDTH *
            ribbonFactorRef.current *
            inkRef.current.thickness *
            inkWeightRef.current.ribbon,
        );
        if (!d) continue;
        path = new Path2D(d);
        if (take === points.length) ribbonPathsRef.current[index] = path;
      }
      context.fill(path);
    }
    penRef.current.drawn = limit;
  }

  function tick() {
    const canvas = canvasRef.current;
    const pen = penRef.current;
    const total =
      rendererRef.current === "ribbon"
        ? (ribbonRef.current?.totalPoints ?? 0)
        : stepsRef.current.length;
    const now = performance.now();
    pen.progress += ((now - pen.lastTick) / DT_MS) * speedRef.current;
    pen.lastTick = now;
    if (canvas && total > 0) {
      const context = canvas.getContext("2d")!;
      const limit = Math.min(Math.floor(pen.progress), total);
      if (rendererRef.current === "ribbon") paintRibbon(context, limit);
      else paintPen(context, limit);
    }
    if (pen.drawn >= total) {
      setStatus("ready");
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function switchEngine(next: EngineId) {
    if (next === engine) return;
    setEngine(next);
    engineRef.current = next;
    bootWriteRef.current = null; // the user took over; drop a pending shared write
    setStyle(null);
    // The old line can't be re-laid-out by the new renderer, so stop the
    // settings effect from trying.
    offsetsRef.current = [];
    setStatus("loading");
    setNote("");
    workerRef.current?.postMessage({ type: "engine", engine: next });
  }

  /** Generate and write the line. A fresh seed by default (every write is
   * a new take); a pinned seed reproduces the exact take, which is what
   * the code panel hands to the SDKs. */
  function write() {
    const supported = alphabetRef.current;
    const cleaned = [...text].filter((c) => supported.has(c)).join("");
    if (cleaned !== text) {
      setText(cleaned);
      setNote("dropped characters this engine can't write");
    }
    if (cleaned.trim().length === 0) {
      // An empty write is a nudge, not an error: aim the user at the line.
      // First tap puts the caret there; with the caret already there (the
      // button's mousedown doesn't steal focus), wag the pen instead.
      const input = textInputRef.current;
      if (input && document.activeElement !== input) input.focus();
      else setPenNudge((nudge) => nudge + 1);
      return;
    }
    const nextSeed = seedMode === "pinned" ? seed : Math.floor(Math.random() * 1_000_000);
    setSeed(nextSeed);
    const request: WriteRequest = {
      type: "write",
      engine,
      text: cleaned,
      bias: LEGIBILITY[legibility],
      style,
      seed: nextSeed,
    };
    workerRef.current?.postMessage(request);
  }

  /** Play/pause: freeze the pen mid-line, pick up where it stopped, or —
   * once the line is finished — write it again from the start. */
  function togglePlayback() {
    if (offsetsRef.current.length === 0) return;
    if (status === "writing") {
      cancelAnimationFrame(rafRef.current);
      setStatus("paused");
      return;
    }
    if (status === "paused") {
      penRef.current.lastTick = performance.now();
      setStatus("writing");
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    // Finished line: rewind and let the pen write it again.
    clearCanvas();
    penRef.current = { drawn: 0, progress: 0, lastTick: performance.now() };
    setStatus("writing");
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  /** The current look, resolved for the exporters (same formulas layout()
   * and the painters use, minus the canvas-fit scale). */
  function exportStyle(): ExportStyle {
    return {
      renderer: rendererRef.current,
      ink: inkRef.current.color ?? defaultInk(paper),
      paper,
      penBasePerScale:
        PEN_WIDTH_PER_SCALE * inkRef.current.thickness * inkWeightRef.current.pen,
      ribbonWidth:
        RIBBON_WIDTH *
        ribbonFactorRef.current *
        inkRef.current.thickness *
        inkWeightRef.current.ribbon,
      msPerStep: DT_MS / speedRef.current,
    };
  }

  /** The studio's current settings, shaped for the snippet generators. */
  function snippetParams(): SnippetParams {
    return {
      engine,
      text,
      bias: LEGIBILITY[legibility],
      legibility,
      style,
      seed,
      renderer: stroke,
      thickness,
      speed,
      ink: color,
      paper,
    };
  }

  /** Copy a link that carries the whole take. Whoever opens it gets this
   * exact line written for them — same settings, same seed, same strokes. */
  async function share() {
    const url = buildShareUrl(snippetParams());
    try {
      await navigator.clipboard.writeText(url);
      setNote("link copied · opening it writes this exact take");
    } catch {
      setNote(url); // no clipboard access: surface the link itself
    }
  }

  const busy = status === "loading" || status === "warming";
  const options = styleOptions(descriptor);
  const styleLabel = options.find((option) => option.id === style)?.label ?? "style";
  const fmt = (value: number) => String(Number(value.toFixed(2)));

  const swatchBase =
    "size-6 shrink-0 cursor-pointer rounded-full border border-foreground/20 sm:size-5";
  const swatchSelected = "ring-2 ring-foreground ring-offset-2 ring-offset-muted";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <header>
        <div className="flex items-center justify-between gap-4">
          {/* Lowercase as a wordmark, like the rest of the studio's voice;
              in prose (the guide, this subtitle) the name stays a normal
              capitalized noun. */}
          <h1 className="text-2xl font-semibold tracking-tight">longhand</h1>
          <a
            href="#/build"
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/80 px-3 py-1.5 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground dark:bg-background/40"
          >
            <CodeIcon className="size-3.5" aria-hidden />
            build with it
          </a>
        </div>
        {/* Below the wordmark row, so it can run the full width. */}
        <p className="mt-1 text-sm text-muted-foreground">
          AI handwriting synthesis in your browser. export in any format or build with the
          SDK, all free
        </p>
      </header>

      {/* The paper: you type on its first line and the handwriting appears
          beneath your words. Below the ink — in real layout, so ink can
          never run into it — a strip with the status line, the playback
          control, and the take's three exits (share, code, export). The
          strip's height is fixed so the canvas doesn't shift when buttons
          come and go. */}
      <div
        className="overflow-hidden rounded-3xl bg-white shadow-sm dark:bg-card"
        style={paper ? { background: paper } : undefined}
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          {/* The pen at the margin, dipped in the chosen ink (like the
              caret, and like the typed words themselves — the ink is the
              one thing guaranteed legible on this paper). With "no color"
              on a chosen paper, resolve against the paper like the painters
              do; on the default card, inherit so the theme keeps working. */}
          <PenLineIcon
            key={penNudge}
            className={cn("size-4 shrink-0 text-muted-foreground", penNudge > 0 && "pen-wiggle")}
            style={{ color: color ?? (paper ? defaultInk(paper) : undefined) }}
            aria-hidden
          />
          <Input
            ref={textInputRef}
            className="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0.5 text-base focus-visible:ring-0 md:text-base dark:bg-transparent"
            style={{
              color: color ?? (paper ? defaultInk(paper) : undefined),
              caretColor: color ?? (paper ? defaultInk(paper) : undefined),
            }}
            value={text}
            maxLength={descriptor?.maxTextLength ?? 75}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && !busy && write()}
            placeholder="type something to write…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {/* Same chip treatment as the action buttons on the bottom edge:
              the bg-card surface keeps it legible on any paper color. The
              mousedown preventDefault keeps the click from stealing focus,
              so the caret stays on the line for the next edit — and an
              empty tap can tell "focus the line" from "wag the pen". */}
          <Button
            variant="outline"
            className="rounded-full bg-card/90 dark:bg-card/90 dark:hover:bg-accent"
            onMouseDown={(event) => event.preventDefault()}
            onClick={write}
            disabled={busy}
            title="every write is a new take"
          >
            write
          </Button>
        </div>
        <canvas
          ref={canvasRef}
          className="block h-[clamp(140px,20vh,180px)] w-full sm:h-[clamp(170px,30vh,250px)]"
        />
        <div className="flex h-12 items-center gap-3 px-3 pb-1">
          {(status === "ready" || status === "writing" || status === "paused") &&
            offsetsRef.current.length > 0 && (
              <Button
                variant="outline"
                className={chipClass}
                title={status === "writing" ? "pause" : "play"}
                aria-label={status === "writing" ? "pause" : "play"}
                onClick={togglePlayback}
              >
                {status === "writing" ? <PauseIcon /> : <PlayIcon />}
                <ChipLabel>{status === "writing" ? "pause" : "play"}</ChipLabel>
              </Button>
            )}
          <p
            role="status"
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              status === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {note ||
              (status === "thinking"
                ? "thinking…"
                : status === "writing"
                  ? "writing…"
                  : status === "paused"
                    ? "paused"
                    : "")}
          </p>
          {(status === "ready" || status === "writing" || status === "paused") &&
            offsetsRef.current.length > 0 && (
              <>
                <Button
                  variant="outline"
                  className={chipClass}
                  title="copy a link that writes this take"
                  aria-label="share this take"
                  onClick={share}
                >
                  <Share2Icon />
                  <ChipLabel>share</ChipLabel>
                </Button>
                <CodeDialog
                  params={snippetParams()}
                  platform={platform}
                  onPlatformChange={setPlatform}
                />
                <ExportDialog
                  text={text}
                  getOffsets={() => offsetsRef.current}
                  getStyle={exportStyle}
                />
              </>
            )}
        </div>
      </div>

      <Collapsible
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        className="rounded-3xl bg-[oklch(0.93_0_0)] shadow-sm dark:bg-[oklch(0.23_0_0)]"
      >
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-sm">
          <span className="font-medium">options</span>
          {/* The collapsed state's whole job: a one-line readout of the
              settings. Open, the full controls say the same thing, so the
              readout fades away on the panel's own 200ms clock. */}
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground transition-opacity duration-200 group-data-panel-open:opacity-0">
            {descriptor?.label ?? "loading…"} · {styleLabel} · {stroke} ·{" "}
            <span
              className="inline-block size-[11px] rounded-full border border-foreground/20 bg-foreground align-[-1.5px]"
              style={color ? { background: color } : undefined}
              aria-hidden
            />{" "}
            · legibility {legibility} · thickness {fmt(thickness)}× · speed {fmt(speed)}×
          </span>
          <ChevronDownIcon
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-4 pt-3.5 pb-4">
            <div className="grid gap-x-10 gap-y-3.5 sm:grid-cols-2">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">model</span>
                <Segmented
                  aria-label="model"
                  options={[
                    { value: "graves", label: "longhand" },
                    { value: "calligrapher", label: "calligrapher" },
                  ]}
                  value={engine}
                  onChange={switchEngine}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">style</span>
                <StylePicker options={options} value={style} onChange={setStyle} />
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">legibility</span>
                <Segmented
                  aria-label="legibility"
                  options={(Object.keys(LEGIBILITY) as Legibility[]).map((level) => ({
                    value: level,
                    label: level,
                  }))}
                  value={legibility}
                  onChange={setLegibility}
                />
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">speed</span>
                <Slider
                  className="min-w-0 flex-1"
                  aria-label="speed"
                  min={0.25}
                  max={4}
                  step={0.25}
                  value={speed}
                  onValueChange={(value) => {
                    const next = value as number;
                    setSpeed(next);
                    speedRef.current = next;
                  }}
                />
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">thickness</span>
                <Slider
                  className="min-w-0 flex-1"
                  aria-label="thickness"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={thickness}
                  onValueChange={(value) => setThickness(value as number)}
                />
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">stroke</span>
                <Segmented
                  aria-label="stroke type"
                  options={[
                    { value: "pen", label: "pen" },
                    { value: "ribbon", label: "ribbon" },
                  ]}
                  value={stroke}
                  onChange={setStroke}
                />
              </div>
              {/* Eight fixed-size swatches only fit beside their label in a
                  full-width (md) grid column; below that each palette takes
                  a whole row, and on phones the swatches shrink a step so
                  the label still fits. */}
              <div className="flex items-center gap-3 text-sm text-muted-foreground sm:col-span-2 md:col-span-1">
                <span className="w-16 shrink-0">ink</span>
                <div
                  role="radiogroup"
                  aria-label="ink color"
                  className="flex flex-1 items-center justify-between gap-1 sm:flex-none sm:justify-start sm:gap-2"
                >
                  {INK_COLORS.map((swatch) => (
                    <button
                      key={swatch.name}
                      type="button"
                      role="radio"
                      aria-checked={swatch.value === color}
                      aria-label={`ink color: ${swatch.name}`}
                      title={swatch.name}
                      className={cn(
                        swatchBase,
                        swatch.value === null && "swatch-none",
                        swatch.value === color && swatchSelected,
                      )}
                      style={swatch.value ? { background: swatch.value } : undefined}
                      onClick={() => setColor(swatch.value)}
                    />
                  ))}
                  <input
                    type="color"
                    className={cn(swatchBase, "swatch-custom", color === customColor && swatchSelected)}
                    aria-label="ink color: custom"
                    title="custom color"
                    value={customColor}
                    onClick={() => setColor(customColor)}
                    onChange={(event) => {
                      setCustomColor(event.target.value);
                      setColor(event.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground sm:col-span-2 md:col-span-1">
                <span className="w-16 shrink-0">paper</span>
                <div
                  role="radiogroup"
                  aria-label="paper color"
                  className="flex flex-1 items-center justify-between gap-1 sm:flex-none sm:justify-start sm:gap-2"
                >
                  {PAPER_COLORS.map((swatch) => (
                    <button
                      key={swatch.name}
                      type="button"
                      role="radio"
                      aria-checked={swatch.value === paper}
                      aria-label={`paper color: ${swatch.name}`}
                      title={swatch.name}
                      className={cn(
                        swatchBase,
                        swatch.value === null && "swatch-none",
                        swatch.value === paper && swatchSelected,
                      )}
                      style={swatch.value ? { background: swatch.value } : undefined}
                      onClick={() => setPaper(swatch.value)}
                    />
                  ))}
                  <input
                    type="color"
                    className={cn(swatchBase, "swatch-custom", paper === customPaper && swatchSelected)}
                    aria-label="paper color: custom"
                    title="custom color"
                    value={customPaper}
                    onClick={() => setPaper(customPaper)}
                    onChange={(event) => {
                      setCustomPaper(event.target.value);
                      setPaper(event.target.value);
                    }}
                  />
                </div>
              </div>
              {/* The take's identity, last: it's the most technical dial.
                  Chain closed, the same seed rewrites the same strokes (here
                  and in the SDKs); chain broken, every write rolls a new
                  one. Typing a seed closes the chain. */}
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">seed</span>
                <Input
                  className="h-7 w-24 rounded-full bg-white/80 px-3 text-xs shadow-xs md:text-xs dark:bg-background/40"
                  aria-label="seed"
                  inputMode="numeric"
                  autoComplete="off"
                  value={String(seed)}
                  onChange={(event) => {
                    // Full UInt32 range: a seed minted by the Swift SDK
                    // must round-trip into the studio unchanged.
                    const digits = event.target.value.replace(/\D/g, "").slice(0, 10);
                    setSeed(Math.min(digits === "" ? 0 : Number(digits), 4294967295));
                    setSeedMode("pinned");
                  }}
                />
                <button
                  type="button"
                  aria-pressed={seedMode === "pinned"}
                  aria-label="lock seed"
                  title={
                    seedMode === "pinned"
                      ? "locked: every write reuses this seed"
                      : "unlocked: every write rolls a new seed"
                  }
                  className={cn(
                    "cursor-pointer rounded-full p-1.5 transition-colors",
                    seedMode === "pinned"
                      ? "bg-white/80 text-foreground shadow-xs dark:bg-background/40"
                      : "hover:text-foreground",
                  )}
                  onClick={() => setSeedMode(seedMode === "pinned" ? "fresh" : "pinned")}
                >
                  {seedMode === "pinned" ? (
                    <LinkIcon className="size-3.5" aria-hidden />
                  ) : (
                    <UnlinkIcon className="size-3.5" aria-hidden />
                  )}
                </button>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <footer className="flex items-center gap-1 text-xs text-muted-foreground/80">
        <span>
          seed {seed} · no servers involved · <span className="italic">work in progress</span>
        </span>
        <ThemeToggle onApply={refit} />
      </footer>
    </main>
  );
}
