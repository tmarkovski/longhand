import { useEffect, useRef, useState } from "react";
import { lineBounds, offsetsToLine, transformLine } from "@longhand/ink-core";
import { penWidths, polishLine, ribbonPath, RIBBON_WIDTH } from "@longhand/ink-render";
import StylePicker, { styleOptions } from "./StylePicker.js";
import type { EngineDescriptor, EngineId, WorkerEvent, WriteRequest } from "./protocol.js";

const DT_MS = 8; // one model timestep of pen time
const MAX_SCALE = 1.6;
const MARGIN_X = 32;
const BASE_WIDTH = 2.2;
// The calligrapher model's units are ~3x smaller than the graves model's,
// so ribbon layout allows the reference site's larger cap (11 at its
// 1240px design width) instead of the pen renderer's 1.6.
const RIBBON_MAX_SCALE_PER_PX = 11 / 1240;

// The page's ink color (matches the CSS text color). "no color" paints with
// this, and an SVG export would omit fill/stroke entirely so the paths
// inherit from wherever they're embedded.
const DEFAULT_INK = "#1c1c28";

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
  const penRef = useRef({ drawn: 0, startedAt: 0 });
  const rafRef = useRef(0);
  const alphabetRef = useRef<Set<string>>(new Set());
  const rendererRef = useRef<"pen" | "ribbon">("pen");
  // Paint-time copy of the ink settings, so the rAF loop sees changes
  // without re-subscribing.
  const inkRef = useRef<{ color: string | null; thickness: number }>({
    color: null,
    thickness: 1,
  });

  const [status, setStatus] = useState<Status>("loading");
  const [note, setNote] = useState("loading the model (15 MB, one time)…");
  const [text, setText] = useState("a line of ink, thinking as it goes");
  const [bias, setBias] = useState(0.75);
  const [style, setStyle] = useState<number | null>(null);
  const [engine, setEngine] = useState<EngineId>("graves");
  const [descriptor, setDescriptor] = useState<EngineDescriptor | null>(null);
  const [seed, setSeed] = useState(42);
  const [color, setColor] = useState<string | null>(null);
  const [thickness, setThickness] = useState(1);

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          setDescriptor(message.engine);
          alphabetRef.current = new Set(message.engine.alphabet);
          rendererRef.current = message.engine.renderer;
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
          penRef.current = { drawn: 0, startedAt: performance.now() };
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
  // loop repaint from scratch at its current pace).
  useEffect(() => {
    inkRef.current = { color, thickness };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, thickness]);

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

  /** Fit a line to the canvas; returns the placed line and its scale. */
  function fitToCanvas(line: ReturnType<typeof offsetsToLine>, maxScale: number) {
    const canvas = canvasRef.current!;
    const bounds = lineBounds(line);
    const inkWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const inkHeight = Math.max(bounds.maxY - bounds.minY, 1);
    const scale = Math.min(
      maxScale,
      (canvas.clientWidth - 2 * MARGIN_X) / inkWidth,
      (canvas.clientHeight - 24) / inkHeight,
    );
    const placed = transformLine(line, {
      scale,
      translateX: MARGIN_X - bounds.minX * scale,
      translateY: canvas.clientHeight / 2 - (bounds.minY + inkHeight / 2) * scale,
    });
    return { placed, scale };
  }

  /** Prepare the finished line for the active renderer's animation. */
  function layout(offsets: Array<[number, number, number]>) {
    const canvas = canvasRef.current;
    if (!canvas || offsets.length === 0) return;

    if (rendererRef.current === "ribbon") {
      // The calligrapher look: raw strokes (no smoothing or leveling),
      // each painted as a filled speed-shaped ribbon.
      const { placed, scale } = fitToCanvas(
        offsetsToLine(offsets),
        RIBBON_MAX_SCALE_PER_PX * canvas.clientWidth,
      );
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
    const { placed } = fitToCanvas(polishLine(offsetsToLine(offsets)), MAX_SCALE);
    const widths = penWidths(placed, { base: BASE_WIDTH * inkRef.current.thickness });
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
    while (pen.drawn < limit) {
      const step = steps[pen.drawn]!;
      const previous = pen.drawn > 0 ? steps[pen.drawn - 1]! : null;
      if (previous && previous.stroke === step.stroke) {
        context.lineWidth = (previous.width + step.width) / 2;
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(step.x, step.y);
        context.stroke();
      } else {
        // Pen touchdown: a dot, so single-point strokes still leave ink.
        context.beginPath();
        context.arc(step.x, step.y, step.width / 2, 0, Math.PI * 2);
        context.fill();
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
        const d = ribbonPath(points.slice(0, take), line.scale, RIBBON_WIDTH * inkRef.current.thickness);
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
    if (canvas && total > 0) {
      const context = canvas.getContext("2d")!;
      const targetSteps = Math.floor((performance.now() - pen.startedAt) / DT_MS);
      const limit = Math.min(targetSteps, total);
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

  function write(nextSeed: number = seed) {
    const supported = alphabetRef.current;
    const cleaned = [...text].filter((c) => supported.has(c)).join("");
    if (cleaned !== text) {
      setText(cleaned);
      setNote("dropped characters this engine can't write");
    }
    if (cleaned.trim().length === 0) return;
    const request: WriteRequest = {
      type: "write",
      engine,
      text: cleaned,
      bias,
      style,
      seed: nextSeed,
    };
    workerRef.current?.postMessage(request);
  }

  function shuffle() {
    const nextSeed = Math.floor(Math.random() * 1_000_000);
    setSeed(nextSeed);
    write(nextSeed);
  }

  const busy = status === "loading" || status === "warming";

  return (
    <main className="page">
      <header>
        <h1>Longhand</h1>
        <p className="tagline">handwriting, alive. every stroke generated in your browser</p>
      </header>

      <canvas ref={canvasRef} className="paper" />

      <div className="controls">
        <input
          className="text"
          value={text}
          maxLength={descriptor?.maxTextLength ?? 75}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !busy && write()}
          placeholder="type something to write…"
        />
        <select
          className="engine-select"
          value={engine}
          onChange={(event) => switchEngine(event.target.value as EngineId)}
          title="handwriting engine"
          aria-label="handwriting engine"
        >
          <option value="graves">longhand engine</option>
          <option value="calligrapher">calligrapher engine</option>
        </select>
        <StylePicker options={styleOptions(descriptor)} value={style} onChange={setStyle} />
        <button onClick={() => write()} disabled={busy}>
          write
        </button>
        <button onClick={shuffle} disabled={busy} title="new seed, same everything else">
          shuffle
        </button>
      </div>

      <div className="settings">
        <label className="slider">
          legibility
          <input
            type="range"
            min={0.15}
            max={1.0}
            step={0.05}
            value={bias}
            onChange={(event) => setBias(Number(event.target.value))}
          />
        </label>
        <label className="slider">
          thickness
          <input
            type="range"
            min={0.3}
            max={2.0}
            step={0.05}
            value={thickness}
            onChange={(event) => setThickness(Number(event.target.value))}
          />
        </label>
        <div className="palette" role="radiogroup" aria-label="ink color">
          {INK_COLORS.map((swatch) => (
            <button
              key={swatch.name}
              type="button"
              role="radio"
              aria-checked={swatch.value === color}
              aria-label={`ink color: ${swatch.name}`}
              title={swatch.name}
              className={
                "swatch" +
                (swatch.value === null ? " swatch-none" : "") +
                (swatch.value === color ? " selected" : "")
              }
              style={swatch.value ? { background: swatch.value } : undefined}
              onClick={() => setColor(swatch.value)}
            />
          ))}
        </div>
      </div>

      <p className={`note ${status === "error" ? "error" : ""}`}>
        {note ||
          (status === "thinking" ? "thinking…" : status === "writing" ? "writing…" : " ")}
      </p>

      <footer>
        seed {seed} · no servers involved · <span className="wip">work in progress</span>
      </footer>
    </main>
  );
}
