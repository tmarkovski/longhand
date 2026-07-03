/**
 * Runs the vendored original engine (vendor/calligrapher-ai/
 * engine.pretty.js) inside Node with a stub DOM, exposing its internal
 * functions so tests can drive the exact reference computation with a
 * seeded random stream and compare the TS port against it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type F32 = Float32Array;

export interface ReferenceEngine {
  /** Weight map `$` from d.bin (populated once loading settles). */
  getWeights: () => Record<string, F32> | undefined;
  /** Set the global encoded-text matrix `er` the attention reads. */
  setEr: (matrix: F32) => void;
  /** Text encoder A: encoded ids (with start/end markers) -> (n, 256). */
  A: (ids: F32) => F32;
  /** One network step: (input3, state) -> [mdnOutputs121, termination1]. */
  F: (input: F32, state: Record<string, F32>) => [F32, F32];
  /** Sample an offset from raw MDN outputs (reads bias from the stub DOM). */
  U: (outputs: F32) => F32;
  /** Reference matvec / add, for building the style vector like E does. */
  m: (x: F32, weights: F32) => F32;
  u: (a: F32, b: F32) => F32;
  H: Record<string, number>;
  /** Bias the reference's U() reads from its bias-slider stub. */
  setBias: (bias: number) => void;
  /**
   * Replace the uniform source behind the reference's captured
   * `R = Math.random` alias (pass null to restore true randomness).
   */
  setUniform: (uniform: (() => number) | null) => void;
}

export function loadReference(): ReferenceEngine {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const script = readFileSync(`${here}/../../../vendor/calligrapher-ai/engine.pretty.js`, "utf8");
  const model = readFileSync(`${here}/../../../vendor/calligrapher-ai/d.bin`);
  const buffer = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength);

  const elements = new Map<string, Record<string, unknown>>();
  const element = (): Record<string, unknown> => ({
    value: "0.75",
    style: {},
    innerHTML: "",
    lastChild: null,
    addEventListener: () => {},
    appendChild: () => {},
    removeChild: () => {},
    remove: () => {},
    width: { baseVal: { value: 1240 } },
    height: { baseVal: { value: 560 } },
  });
  const documentStub = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElementNS: () => element(),
  };
  const windowStub = {
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };
  const fetchStub = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(buffer) });

  // The script captures `R = Math.random` at eval time, so the seedable
  // source must be behind the alias before the script runs.
  let uniform: (() => number) | null = null;
  const mathStub = Object.create(Math) as Math;
  mathStub.random = () => (uniform ? uniform() : Math.random());

  const factory = new Function(
    "document",
    "window",
    "performance",
    "fetch",
    "setInterval",
    "clearTimeout",
    "Math",
    `${script}
     return { getWeights: () => $, setEr: (x) => { er = x; }, A, F, U, m, u, H };`,
  );
  const internals = factory(documentStub, windowStub, performance, fetchStub, () => 0, () => {}, mathStub);
  return {
    ...internals,
    setBias: (bias: number) => {
      documentStub.getElementById("bias-slider")!.value = String(bias);
    },
    setUniform: (next: (() => number) | null) => {
      uniform = next;
    },
  } as ReferenceEngine;
}

/** Wait until the reference's chunked weight parse has finished. */
export async function referenceReady(reference: ReferenceEngine): Promise<void> {
  for (let i = 0; i < 1000 && !reference.getWeights(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!reference.getWeights()) throw new Error("reference weights never loaded");
}

/**
 * The reference page's write loop (its E/g functions minus DOM and
 * layout): sample until the termination head fires or the step budget
 * runs out, discarding the terminating sample. `uniform` replaces
 * Math.random for the duration, making the run reproducible.
 */
export function referenceWrite(
  reference: ReferenceEngine,
  text: string,
  options: { style: number | null; bias: number; uniform: () => number },
): Array<[number, number, number]> {
  const weights = reference.getWeights();
  if (!weights) throw new Error("reference not loaded");
  reference.setUniform(options.uniform);
  try {
    reference.setBias(options.bias);
    const styleIndex =
      options.style ?? Math.floor((weights.g!.length / 64) * options.uniform());

    const ids = Float32Array.from([
      2,
      ...[...text].map((character) => reference.H[character] ?? 1),
      3,
    ]);
    reference.setEr(reference.A(ids));

    const gridCols = ids.length + 1;
    const grid = new Float32Array(10 * gridCols);
    for (let row = 0; row < 10; row++) {
      for (let column = 0; column < gridCols; column++) grid[row * gridCols + column] = column - 0.5;
    }
    const styleVector = weights.g!.slice(64 * styleIndex, 64 * (styleIndex + 1));
    const state: Record<string, Float32Array> = {
      a: weights.d!,
      b: weights.o!,
      c: weights.e!,
      d: weights.m!,
      e: weights.x!,
      f: weights.a!,
      w: weights.T!,
      k: new Float32Array(10),
      u: grid,
      z: reference.u(reference.m(styleVector, weights.k!), weights.R!),
    };

    const offsets: Array<[number, number, number]> = [];
    let input: F32 = Float32Array.from([0, 0, 1]);
    for (let step = 1; ; step++) {
      const [outputs, termination] = reference.F(input, state);
      const sample = reference.U(outputs);
      if (step > 40 * text.length || termination[0]! > 0.5) break;
      offsets.push([sample[0]!, sample[1]!, sample[2]!]);
      input = sample;
    }
    return offsets;
  } finally {
    reference.setUniform(null);
  }
}
