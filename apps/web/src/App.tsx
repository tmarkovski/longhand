import { useEffect, useRef, useState } from "react";
import { lineBounds, offsetsToLine, transformLine } from "@longhand/ink-core";
import { penWidths, polishLine } from "@longhand/ink-render";
import type { WorkerEvent, WriteRequest } from "./protocol.js";

const DT_MS = 8; // one model timestep of pen time
const MAX_SCALE = 1.6;
const MARGIN_X = 32;
const BASE_WIDTH = 2.2;

type Status = "loading" | "ready" | "warming" | "thinking" | "writing" | "error";

/** One animation step: a polished point with its ink width. A stroke-index
 * change between consecutive steps means the pen lifted in between. */
interface PenStep {
  x: number;
  y: number;
  width: number;
  stroke: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const offsetsRef = useRef<Array<[number, number, number]>>([]);
  const stepsRef = useRef<PenStep[]>([]);
  const penRef = useRef({ drawn: 0, startedAt: 0 });
  const rafRef = useRef(0);
  const alphabetRef = useRef<Set<string>>(new Set());

  const [status, setStatus] = useState<Status>("loading");
  const [note, setNote] = useState("loading the model (15 MB, one time)…");
  const [text, setText] = useState("a line of ink, thinking as it goes");
  const [bias, setBias] = useState(0.75);
  const [style, setStyle] = useState<number | null>(null);
  const [styles, setStyles] = useState<number[]>([]);
  const [seed, setSeed] = useState(42);

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          setStyles(message.styles);
          alphabetRef.current = new Set(message.alphabet);
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
          cancelAnimationFrame(rafRef.current);
          clearCanvas();
          setStatus("thinking");
          setNote("");
          break;
        case "offsets":
          offsetsRef.current.push(...message.batch);
          break;
        case "done":
          // The line is complete: smooth it, level its baseline, lay it out,
          // and only then let the pen replay it at writing pace.
          stepsRef.current = layoutSteps(offsetsRef.current);
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
    context.strokeStyle = "#1c1c28";
    context.fillStyle = "#1c1c28";
  }

  /** Polish the raw offsets and fit the result to the canvas. */
  function layoutSteps(offsets: Array<[number, number, number]>): PenStep[] {
    const canvas = canvasRef.current;
    if (!canvas || offsets.length === 0) return [];
    const line = polishLine(offsetsToLine(offsets));
    const bounds = lineBounds(line);
    const inkWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const inkHeight = Math.max(bounds.maxY - bounds.minY, 1);
    const scale = Math.min(
      MAX_SCALE,
      (canvas.clientWidth - 2 * MARGIN_X) / inkWidth,
      (canvas.clientHeight - 24) / inkHeight,
    );
    const placed = transformLine(line, {
      scale,
      translateX: MARGIN_X - bounds.minX * scale,
      translateY: canvas.clientHeight / 2 - (bounds.minY + inkHeight / 2) * scale,
    });
    const widths = penWidths(placed, { base: BASE_WIDTH });
    return placed.strokes.flatMap((stroke, strokeIndex) =>
      stroke.points.map(([x, y], pointIndex) => ({
        x,
        y,
        width: widths[strokeIndex]![pointIndex]!,
        stroke: strokeIndex,
      })),
    );
  }

  function tick() {
    const canvas = canvasRef.current;
    const steps = stepsRef.current;
    const pen = penRef.current;
    if (canvas && steps.length > 0) {
      const context = canvas.getContext("2d")!;
      const targetSteps = Math.floor((performance.now() - pen.startedAt) / DT_MS);
      const limit = Math.min(targetSteps, steps.length);
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
    if (pen.drawn >= steps.length) {
      setStatus("ready");
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function write(nextSeed: number = seed) {
    const supported = alphabetRef.current;
    const cleaned = [...text].filter((c) => supported.has(c)).join("");
    if (cleaned !== text) {
      setText(cleaned);
      setNote("dropped characters the model can't write (no Q, X, Z…)");
    }
    if (cleaned.trim().length === 0) return;
    const request: WriteRequest = { type: "write", text: cleaned, bias, style, seed: nextSeed };
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
          maxLength={75}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !busy && write()}
          placeholder="type something to write…"
        />
        <select
          value={style === null ? "freehand" : String(style)}
          onChange={(event) =>
            setStyle(event.target.value === "freehand" ? null : Number(event.target.value))
          }
        >
          <option value="freehand">freehand</option>
          {styles.map((id) => (
            <option key={id} value={id}>
              style {id}
            </option>
          ))}
        </select>
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
        <button onClick={() => write()} disabled={busy}>
          write
        </button>
        <button onClick={shuffle} disabled={busy} title="new seed, same everything else">
          shuffle
        </button>
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
