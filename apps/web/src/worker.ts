/**
 * Engine worker: loads handwriting engines on demand, then turns write
 * requests into streamed batches of stroke offsets. Everything heavy
 * (weight parsing, style priming, sampling) happens here so the page
 * never janks. Engines are cached after first load, so switching back
 * and forth is instant.
 */

import type { InkEngine } from "@longhand/ink-core";
import {
  GravesModel,
  parseModelAssets,
  STEPS_PER_CHARACTER as GRAVES_STEPS,
} from "@longhand/ink-graves";
import {
  ALPHABET as CALLIGRAPHER_ALPHABET,
  CalligrapherModel,
  EXPOSED_STYLES,
  parseCalligrapherWeights,
  STEPS_PER_CHARACTER as CALLIGRAPHER_STEPS,
} from "@longhand/ink-calligrapher";
import type { EngineDescriptor, EngineId, WorkerEvent, WorkerRequest } from "./protocol.js";

const post = (event: WorkerEvent): void => self.postMessage(event);

interface LoadedEngine {
  engine: InkEngine;
  descriptor: EngineDescriptor;
  stepsPerCharacter: number;
  /** True when styled writes prime synchronously (worth a status note). */
  warmsUp: boolean;
}

interface EngineSpec {
  url: string;
  loadingNote: string;
  build(buffer: ArrayBuffer): LoadedEngine;
}

const SPECS: Record<EngineId, EngineSpec> = {
  graves: {
    url: "/model/graves-v1.bin",
    loadingNote: "loading the longhand model (15 MB, one time)…",
    build(buffer) {
      const model = new GravesModel(parseModelAssets(buffer));
      return {
        engine: model,
        stepsPerCharacter: GRAVES_STEPS,
        warmsUp: true,
        descriptor: {
          id: "graves",
          label: "longhand",
          renderer: "pen",
          ribbonWidthFactor: 3,
          styles: model.styles,
          alphabet: model.assets.alphabet,
          nullStyleLabel: "freehand",
          defaultStyle: null,
          maxTextLength: 75,
        },
      };
    },
  },
  calligrapher: {
    url: "/model/calligrapher-v1.bin",
    loadingNote: "loading the calligrapher model (2.6 MB, one time)…",
    build(buffer) {
      const model = new CalligrapherModel(parseCalligrapherWeights(buffer));
      return {
        engine: model,
        stepsPerCharacter: CALLIGRAPHER_STEPS,
        warmsUp: false,
        descriptor: {
          id: "calligrapher",
          label: "calligrapher",
          // The model was tuned for the ribbon look, but the app's default
          // ink is the pen; ribbon stays one toggle away.
          renderer: "pen",
          ribbonWidthFactor: 1,
          styles: [...EXPOSED_STYLES],
          alphabet: [...CALLIGRAPHER_ALPHABET],
          // No freehand equivalent: the model always writes with a style,
          // so there's no null option and style 2 is the default.
          nullStyleLabel: null,
          defaultStyle: 2,
          maxTextLength: 90,
        },
      };
    },
  },
};

const loaded = new Map<EngineId, Promise<LoadedEngine>>();
let jobId = 0;

function load(id: EngineId): Promise<LoadedEngine> {
  let pending = loaded.get(id);
  if (!pending) {
    pending = (async () => {
      const spec = SPECS[id];
      const response = await fetch(spec.url);
      if (!response.ok) throw new Error(`model fetch failed (HTTP ${response.status})`);
      return spec.build(await response.arrayBuffer());
    })();
    loaded.set(id, pending);
  }
  return pending;
}

async function activate(id: EngineId): Promise<LoadedEngine> {
  if (!loaded.has(id)) post({ type: "status", message: SPECS[id].loadingNote });
  const runtime = await load(id);
  post({ type: "ready", engine: runtime.descriptor });
  return runtime;
}

// Default engine, ready as soon as the worker boots.
activate("calligrapher").catch((error: unknown) =>
  post({ type: "error", message: String(error) }),
);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === "engine") {
    ++jobId; // a pending write for the old engine should stop streaming
    try {
      await activate(request.engine);
    } catch (error) {
      post({ type: "error", message: String(error) });
    }
    return;
  }

  if (request.type !== "write") return;
  const current = ++jobId;
  try {
    const runtime = await load(request.engine);
    if (current !== jobId) return;

    if (request.style !== null && runtime.warmsUp) {
      post({ type: "status", message: "warming up the style…" });
    }
    // Style priming happens synchronously inside writer(); a few seconds
    // for long primers, which is why it lives in this worker.
    const writer = runtime.engine.writer(request.text, {
      bias: request.bias,
      style: request.style,
      seed: request.seed,
    });
    post({ type: "start", jobId: current });

    const stepBudget = runtime.stepsPerCharacter * Math.max(request.text.length, 4);
    let produced = 0;
    while (!writer.done && produced < stepBudget && current === jobId) {
      const batch: Array<[number, number, number]> = [];
      for (let i = 0; i < 16 && produced < stepBudget; i++) {
        const offset = writer.step();
        if (offset === null) break;
        batch.push([offset[0], offset[1], offset[2]]);
        produced++;
      }
      if (batch.length > 0) post({ type: "offsets", jobId: current, batch });
      // Yield so a newer request can preempt between batches.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (current === jobId) post({ type: "done", jobId: current });
  } catch (error) {
    post({ type: "error", message: String(error) });
  }
};
