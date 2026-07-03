import { useEffect, useRef, useState } from "react";
import type { WorkerEvent, WriteRequest } from "./protocol.js";

const DT_MS = 8; // one model timestep of pen time
const SCALE = 1.6;
const PEN_START: [number, number] = [32, 150];

type Status = "loading" | "ready" | "warming" | "writing" | "error";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const queueRef = useRef<Array<[number, number, number]>>([]);
  const penRef = useRef({ x: 0, y: 0, lifted: true, drawn: 0, startedAt: 0 });
  const doneRef = useRef(false);
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
        case "start": {
          queueRef.current = [];
          doneRef.current = false;
          penRef.current = {
            x: PEN_START[0],
            y: PEN_START[1],
            lifted: true,
            drawn: 0,
            startedAt: performance.now(),
          };
          clearCanvas();
          setStatus("writing");
          setNote("");
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(tick);
          break;
        }
        case "offsets":
          queueRef.current.push(...message.batch);
          break;
        case "done":
          doneRef.current = true;
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
    context.lineWidth = 2.1;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#1c1c28";
  }

  function tick() {
    const canvas = canvasRef.current;
    const pen = penRef.current;
    const queue = queueRef.current;
    if (canvas) {
      const context = canvas.getContext("2d")!;
      const targetSteps = Math.floor((performance.now() - pen.startedAt) / DT_MS);
      const limit = Math.min(targetSteps, queue.length);
      while (pen.drawn < limit) {
        const [dx, dy, eos] = queue[pen.drawn];
        const nextX = pen.x + dx * SCALE;
        const nextY = pen.y - dy * SCALE;
        if (!pen.lifted) {
          context.beginPath();
          context.moveTo(pen.x, pen.y);
          context.lineTo(nextX, nextY);
          context.stroke();
        }
        pen.x = nextX;
        pen.y = nextY;
        pen.lifted = eos === 1;
        pen.drawn++;
      }
    }
    if (doneRef.current && pen.drawn >= queueRef.current.length) {
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
            min={0.1}
            max={1.5}
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
        {note || (status === "writing" ? "writing…" : " ")}
      </p>

      <footer>
        seed {seed} · no servers involved · <span className="wip">work in progress</span>
      </footer>
    </main>
  );
}
