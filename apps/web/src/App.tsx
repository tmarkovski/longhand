import { useEffect, useRef, useState } from "react";
import { lineBounds, offsetsToLine, transformLine } from "@longhand/ink-core";
import { alignLine, penWidths, polishLine, ribbonPath, RIBBON_WIDTH } from "@longhand/ink-render";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import StylePicker, { styleOptions } from "./StylePicker.js";
import type {
  EngineDescriptor,
  EngineId,
  RendererKind,
  WorkerEvent,
  WriteRequest,
} from "./protocol.js";

const DT_MS = 8; // one model timestep of pen time
const MARGIN_X = 32;
const MARGIN_Y = 24;
// Pen ink weight per unit of layout scale, so ink gets heavier as a line
// scales up to fill the canvas (the ribbon's width already rides the
// layout scale the same way). 2.2px at the old fixed 1.6 scale.
const PEN_WIDTH_PER_SCALE = 2.2 / 1.6;

// The page's ink color (matches the CSS text color). "no color" paints with
// this, and an SVG export would omit fill/stroke entirely so the paths
// inherit from wherever they're embedded.
const DEFAULT_INK = "#1c1c28";

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
const INK_COLORS: ReadonlyArray<{ name: string; value: string | null }> = [
  { name: "no color", value: null },
  { name: "blue", value: "#1e4fd8" },
  { name: "teal", value: "#0e7490" },
  { name: "green", value: "#2f6b3a" },
  { name: "red", value: "#b3261e" },
  { name: "sepia", value: "#7a4a21" },
  { name: "violet", value: "#6d28d9" },
];

type Status = "loading" | "ready" | "warming" | "thinking" | "writing" | "error";

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
  const workerRef = useRef<Worker | null>(null);
  const offsetsRef = useRef<Array<[number, number, number]>>([]);
  const stepsRef = useRef<PenStep[]>([]);
  const ribbonRef = useRef<RibbonLayout | null>(null);
  const ribbonPathsRef = useRef<Array<Path2D | null>>([]);
  // `progress` is the replay clock in fractional steps; accumulating it per
  // frame (instead of measuring from a start time) lets the speed setting
  // change mid-write without the pen jumping.
  const penRef = useRef({ drawn: 0, progress: 0, lastTick: 0 });
  const speedRef = useRef(DEFAULT_SPEED);
  const rafRef = useRef(0);
  const alphabetRef = useRef<Set<string>>(new Set());
  const rendererRef = useRef<RendererKind>("pen");
  const ribbonFactorRef = useRef(1);
  const inkWeightRef = useRef(INK_WEIGHT.calligrapher);
  // Paint-time copy of the ink settings, so the rAF loop sees changes
  // without re-subscribing.
  const inkRef = useRef<{ color: string | null; thickness: number }>({
    color: null,
    thickness: DEFAULT_THICKNESS,
  });

  const [status, setStatus] = useState<Status>("loading");
  const [note, setNote] = useState("loading the calligrapher model (2.6 MB, one time)…");
  const [text, setText] = useState("a line of ink, thinking as it goes");
  const [legibility, setLegibility] = useState<Legibility>("normal");
  const [style, setStyle] = useState<number | null>(null);
  const [engine, setEngine] = useState<EngineId>("calligrapher");
  const [descriptor, setDescriptor] = useState<EngineDescriptor | null>(null);
  const [seed, setSeed] = useState(42);
  const [color, setColor] = useState<string | null>(null);
  const [customColor, setCustomColor] = useState(DEFAULT_INK);
  const [thickness, setThickness] = useState(DEFAULT_THICKNESS);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [stroke, setStroke] = useState<RendererKind>("pen");
  const [optionsOpen, setOptionsOpen] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          setDescriptor(message.engine);
          alphabetRef.current = new Set(message.engine.alphabet);
          ribbonFactorRef.current = message.engine.ribbonWidthFactor;
          inkWeightRef.current = INK_WEIGHT[message.engine.id];
          // Each engine starts in its native ink look.
          rendererRef.current = message.engine.renderer;
          setStroke(message.engine.renderer);
          setStyle(message.engine.defaultStyle);
          setStatus("ready");
          setNote("");
          break;
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
    return () => {
      cancelAnimationFrame(rafRef.current);
      worker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ink settings restyle the finished line in place: re-lay it out with the
  // new width and repaint immediately (or, mid-animation, let the running
  // loop repaint from scratch at its current pace). Stroke type re-layouts
  // the same offsets through the other renderer's pipeline.
  useEffect(() => {
    rendererRef.current = stroke;
    inkRef.current = { color, thickness };
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, thickness, stroke]);

  // The canvas is sized by CSS, so rotation or a window resize changes it
  // under a bitmap laid out for the old size; re-fit the line when that
  // happens. Re-registered per status so refit sees the current one.
  useEffect(() => {
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  /** Re-lay-out the finished line for the current canvas size and settings,
   * then repaint (or, mid-animation, let the running loop repaint). */
  function refit() {
    ribbonPathsRef.current = ribbonPathsRef.current.map(() => null);
    if ((status !== "ready" && status !== "writing") || offsetsRef.current.length === 0) return;
    layout(offsetsRef.current);
    clearCanvas();
    penRef.current.drawn = 0;
    if (status !== "ready") return;
    const canvas = canvasRef.current;
    const total =
      rendererRef.current === "ribbon"
        ? (ribbonRef.current?.totalPoints ?? 0)
        : stepsRef.current.length;
    if (!canvas || total === 0) return;
    const context = canvas.getContext("2d")!;
    if (rendererRef.current === "ribbon") paintRibbon(context, total);
    else paintPen(context, total);
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
      (canvas.clientHeight - 2 * MARGIN_Y) / inkHeight,
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
    const ink = inkRef.current.color ?? DEFAULT_INK;
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
    context.fillStyle = inkRef.current.color ?? DEFAULT_INK;
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
    setStyle(null);
    // The old line can't be re-laid-out by the new renderer, so stop the
    // settings effect from trying.
    offsetsRef.current = [];
    setStatus("loading");
    setNote("");
    workerRef.current?.postMessage({ type: "engine", engine: next });
  }

  /** Generate and write the line. Every write draws a fresh seed (write and
   * shuffle used to be separate buttons); the seed lands in state so a share
   * link can reproduce the exact take. */
  function write() {
    const supported = alphabetRef.current;
    const cleaned = [...text].filter((c) => supported.has(c)).join("");
    if (cleaned !== text) {
      setText(cleaned);
      setNote("dropped characters this engine can't write");
    }
    if (cleaned.trim().length === 0) return;
    const nextSeed = Math.floor(Math.random() * 1_000_000);
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

  /** Rewind the finished line and let the pen write it again. */
  function replay() {
    if (offsetsRef.current.length === 0) return;
    clearCanvas();
    penRef.current = { drawn: 0, progress: 0, lastTick: performance.now() };
    setStatus("writing");
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  const busy = status === "loading" || status === "warming";
  const options = styleOptions(descriptor);
  const styleLabel = options.find((option) => option.id === style)?.label ?? "style";
  const fmt = (value: number) => String(Number(value.toFixed(2)));

  const swatchBase =
    "size-7 shrink-0 cursor-pointer rounded-full border border-foreground/20 sm:size-5";
  const swatchSelected = "ring-2 ring-foreground ring-offset-2 ring-offset-card";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Longhand</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          handwriting, alive. every stroke generated in your browser
        </p>
      </header>

      <div className="relative">
        <canvas
          ref={canvasRef}
          className="block h-[clamp(150px,24vh,210px)] w-full rounded-xl border bg-card shadow-xs sm:h-[clamp(200px,38vh,300px)]"
        />
        {(status === "ready" || status === "writing") && offsetsRef.current.length > 0 && (
          <Button
            variant="outline"
            size="icon"
            className="absolute right-3 bottom-3 rounded-full bg-card/90"
            title="replay"
            aria-label="replay"
            onClick={replay}
          >
            <RotateCcwIcon />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-0 flex-1 basis-56"
          value={text}
          maxLength={descriptor?.maxTextLength ?? 75}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !busy && write()}
          placeholder="type something to write…"
        />
        <Button
          className="max-sm:flex-1"
          onClick={write}
          disabled={busy}
          title="every write is a new take"
        >
          write
        </Button>
      </div>

      <Collapsible
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        className="rounded-xl border bg-card shadow-xs"
      >
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-sm">
          <span className="font-medium">options</span>
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
            {descriptor?.label ?? "loading…"} · {styleLabel} · {stroke} ·{" "}
            <span
              className="inline-block size-[11px] rounded-full border border-foreground/20 align-[-1.5px]"
              style={{ background: color ?? DEFAULT_INK }}
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
          <div className="flex flex-col gap-4 border-t px-4 pt-3.5 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={engine}
                onValueChange={(value) => switchEngine(value as EngineId)}
                items={{ graves: "longhand engine", calligrapher: "calligrapher engine" }}
              >
                <SelectTrigger
                  className="engine-select max-sm:w-full"
                  aria-label="handwriting engine"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="graves">longhand engine</SelectItem>
                  <SelectItem value="calligrapher">calligrapher engine</SelectItem>
                </SelectContent>
              </Select>
              <StylePicker options={options} value={style} onChange={setStyle} />
            </div>

            <div className="grid gap-x-10 gap-y-3.5 sm:grid-cols-2">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="w-16 shrink-0">legibility</span>
                <div
                  role="radiogroup"
                  aria-label="legibility"
                  className="inline-flex rounded-lg border border-input p-0.5 max-sm:flex-1"
                >
                  {(Object.keys(LEGIBILITY) as Legibility[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={legibility === level}
                      className={cn(
                        "cursor-pointer rounded-md px-3 py-1 text-sm transition-colors max-sm:flex-1",
                        legibility === level
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setLegibility(level)}
                    >
                      {level}
                    </button>
                  ))}
                </div>
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
                <span className="w-16 shrink-0">stroke</span>
                <div
                  role="radiogroup"
                  aria-label="stroke type"
                  className="inline-flex rounded-lg border border-input p-0.5 max-sm:flex-1"
                >
                  {(["pen", "ribbon"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={stroke === kind}
                      className={cn(
                        "cursor-pointer rounded-md px-3 py-1 text-sm transition-colors max-sm:flex-1",
                        stroke === kind
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setStroke(kind)}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
              </div>
              {/* On phones the labelled row can't fit eight fixed-size
                  swatches, so the label hides and the palette spans the
                  row (the radiogroup keeps its accessible name). */}
              <div className="flex items-center gap-3 text-sm text-muted-foreground sm:col-span-2">
                <span className="w-16 shrink-0 max-sm:hidden">ink</span>
                <div
                  role="radiogroup"
                  aria-label="ink color"
                  className="flex flex-1 items-center justify-between gap-2 sm:flex-none sm:justify-start"
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
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <p
        className={cn(
          "min-h-5 text-sm",
          status === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {note ||
          (status === "thinking" ? "thinking…" : status === "writing" ? "writing…" : " ")}
      </p>

      <footer className="text-xs text-muted-foreground/80">
        seed {seed} · no servers involved · <span className="italic">work in progress</span>
      </footer>
    </main>
  );
}
