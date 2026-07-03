/**
 * The calligrapher network, transliterated from the vendored reference
 * (vendor/calligrapher-ai/engine.pretty.js) with readable names:
 *
 *   x(3) -> input projection + learned style vector
 *     -> LSTM1(256) -> Gaussian-window attention over a conv-encoded
 *        text matrix -> LSTM2(256) -> LSTM3(256), with sqrt(0.5)-scaled
 *        skip mixing between every stage
 *     -> 20-component bivariate MDN + pen bit (121 outputs)
 *
 * Attention also feeds a sigmoid "text exhausted" head whose output is
 * the generation termination signal (> 0.5 means stop).
 *
 * Every intermediate is stored in a Float32Array at exactly the points
 * the reference stores one, so outputs are bit-compatible with the
 * original given the same weights and random stream. The parity test
 * (test/parity.test.ts) runs the vendored JS to hold this to account.
 */

import type { CalligrapherAssets, SparseTensor } from "./weights.js";

export const HIDDEN = 256;
export const ATTENTION_MIXTURES = 10;
export const OUTPUT_MIXTURES = 20;
export const MDN_OUTPUTS = 121;

const SKIP = Math.sqrt(0.5);

export interface RandomSource {
  /** Uniform in [0, 1). */
  uniform(): number;
}

export interface CellState {
  h1: Float32Array;
  c1: Float32Array;
  h2: Float32Array;
  c2: Float32Array;
  h3: Float32Array;
  c3: Float32Array;
  /** Attention window from the previous step. */
  window: Float32Array;
  kappa: Float32Array;
  /** Attention grid positions: [-0.5, 0.5, ..., n - 0.5] (n+1 values). */
  grid: Float32Array;
  /** Style conditioning vector, added to every input projection. */
  z: Float32Array;
}

const map = (values: Float32Array, fn: (v: number) => number): Float32Array => {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = fn(values[i]!);
  return out;
};

const sigmoid = (values: Float32Array) => map(values, (v) => 1 / (1 + Math.exp(-v)));
const softplus = (values: Float32Array) => map(values, (v) => Math.log(1 + Math.exp(v)));
const tanh = (values: Float32Array) =>
  map(values, (v) => {
    const e = Math.exp(2 * v);
    return (e - 1) / (e + 1);
  });

const add = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + b[i]!;
  return out;
};

const mul = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! * b[i]!;
  return out;
};

const scale = (a: Float32Array, s: number): Float32Array => {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! * s;
  return out;
};

const softmax = (values: Float32Array): Float32Array => {
  const out = new Float32Array(values.length);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.exp(values[i]!);
    total += out[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
};

const concat = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** Dense matvec, weights laid out [input, output] row-major. */
const matvec = (x: Float32Array, weights: Float32Array, outDim: number): Float32Array => {
  const out = new Float32Array(outDim);
  const inDim = x.length;
  for (let o = 0; o < outDim; o++) {
    let sum = 0;
    for (let i = 0; i < inDim; i++) sum += x[i]! * weights[i * outDim + o]!;
    out[o] = sum;
  }
  return out;
};

const csrMatvec = (x: Float32Array, m: SparseTensor): Float32Array => {
  const out = new Float32Array(m.rows);
  for (let row = 0; row < m.rows; row++) {
    let sum = 0;
    const end = m.rowPtr[row + 1]!;
    for (let i = m.rowPtr[row]!; i < end; i++) sum += m.values[i]! * x[m.colIndex[i]!]!;
    out[row] = sum;
  }
  return out;
};

export class CalligrapherCell {
  private readonly assets: CalligrapherAssets;
  private readonly kernel1: SparseTensor;
  private readonly kernel2: SparseTensor;
  private readonly kernel3: SparseTensor;
  private readonly mixKernel: SparseTensor;

  constructor(assets: CalligrapherAssets) {
    this.assets = assets;
    this.kernel1 = this.sparse("y");
    this.kernel2 = this.sparse("w");
    this.kernel3 = this.sparse("r");
    this.mixKernel = this.sparse("l");
  }

  private dense(name: string): Float32Array {
    const tensor = this.assets.dense.get(name);
    if (!tensor) throw new Error(`missing tensor ${name}`);
    return tensor.data;
  }

  private sparse(name: string): SparseTensor {
    const tensor = this.assets.sparse.get(name);
    if (!tensor) throw new Error(`missing sparse tensor ${name}`);
    return tensor;
  }

  /**
   * Encode text ids into the attention memory: embedding lookup with one
   * pad row on each side, a width-3 conv + tanh over the embeddings, the
   * conv output concatenated back onto each embedding, then projected
   * 512 -> 256. Returns an (n, 256) row-major matrix.
   */
  encodeText(ids: Int32Array): Float32Array {
    const n = ids.length;
    const embedding = this.dense("s");
    const padded = new Int32Array(n + 2);
    padded.set(ids, 1);

    const embedded = new Float32Array((n + 2) * HIDDEN);
    for (let row = 0; row < n + 2; row++) {
      embedded.set(embedding.subarray(padded[row]! * HIDDEN, (padded[row]! + 1) * HIDDEN), row * HIDDEN);
    }

    const convKernel = this.dense("b");
    const conv = new Float32Array(n * HIDDEN);
    for (let row = 0; row < n; row++) {
      const window = embedded.subarray(row * HIDDEN, (row + 3) * HIDDEN);
      for (let out = 0; out < HIDDEN; out++) {
        let sum = 0;
        for (let i = 0; i < 3 * HIDDEN; i++) sum += window[i]! * convKernel[out + HIDDEN * i]!;
        conv[row * HIDDEN + out] = sum;
      }
    }
    const convBias = this.dense("t");
    for (let row = 0; row < n; row++) {
      for (let i = 0; i < HIDDEN; i++) conv[row * HIDDEN + i] = conv[row * HIDDEN + i]! + convBias[i]!;
    }
    const activated = tanh(conv);

    const projection = this.dense("j");
    const projectionBias = this.dense("E");
    const encoded = new Float32Array(n * HIDDEN);
    for (let row = 0; row < n; row++) {
      // Row = [embedding without pads | conv], projected 512 -> 256.
      const combined = concat(
        embedded.subarray((row + 1) * HIDDEN, (row + 2) * HIDDEN) as Float32Array,
        activated.subarray(row * HIDDEN, (row + 1) * HIDDEN) as Float32Array,
      );
      const projected = matvec(combined, projection, HIDDEN);
      for (let i = 0; i < HIDDEN; i++) encoded[row * HIDDEN + i] = projected[i]! + projectionBias[i]!;
    }
    return encoded;
  }

  /** Fresh state for a text of `n` encoded ids, conditioned on a style. */
  initialState(charCount: number, styleIndex: number): CellState {
    const styles = this.assets.dense.get("g")!;
    const styleVector = styles.data.subarray(styleIndex * 64, (styleIndex + 1) * 64) as Float32Array;
    const z = add(matvec(styleVector, this.dense("k"), HIDDEN), this.dense("R"));
    const grid = new Float32Array(charCount + 1);
    for (let i = 0; i <= charCount; i++) grid[i] = i - 0.5;
    return {
      c1: this.dense("d"),
      c2: this.dense("o"),
      c3: this.dense("e"),
      h1: this.dense("m"),
      h2: this.dense("x"),
      h3: this.dense("a"),
      window: this.dense("T"),
      kappa: new Float32Array(ATTENTION_MIXTURES),
      grid,
      z,
    };
  }

  private lstm(
    input: Float32Array,
    h: Float32Array,
    c: Float32Array,
    kernel: SparseTensor,
    bias: Float32Array,
  ): [Float32Array, Float32Array] {
    const gates = add(csrMatvec(concat(input, h), kernel), bias);
    const inGate = gates.slice(0, HIDDEN);
    const candidate = gates.slice(HIDDEN, 2 * HIDDEN);
    const forgetGate = gates.slice(2 * HIDDEN, 3 * HIDDEN);
    const outGate = gates.slice(3 * HIDDEN, 4 * HIDDEN);
    const cNext = add(mul(sigmoid(forgetGate), c), mul(sigmoid(inGate), tanh(candidate)));
    const hNext = mul(sigmoid(outGate), tanh(cNext));
    return [hNext, cNext];
  }

  /**
   * Gaussian-window attention (difference-of-sigmoids form): 10 mixtures
   * with monotonically advancing kappa, soft-attending over the encoded
   * text. Updates state.kappa and returns the new 256-dim window.
   */
  private attend(h2: Float32Array, state: CellState, encoded: Float32Array, charCount: number): Float32Array {
    const raw = add(matvec(h2, this.dense("h"), 3 * ATTENTION_MIXTURES), this.dense("n"));
    const alpha = softmax(raw.slice(0, ATTENTION_MIXTURES));
    const beta = softplus(raw.slice(ATTENTION_MIXTURES, 2 * ATTENTION_MIXTURES));
    const kappaStep = softplus(raw.slice(2 * ATTENTION_MIXTURES, 3 * ATTENTION_MIXTURES));
    const kappa = new Float32Array(ATTENTION_MIXTURES);
    for (let k = 0; k < ATTENTION_MIXTURES; k++) {
      kappa[k] = state.kappa[k]! + Math.fround(kappaStep[k]! / 15);
    }
    state.kappa = kappa;

    // phi[e] = sum_k alpha_k * (cdf_k(grid[e+1]) - cdf_k(grid[e]))
    const phi = new Float32Array(charCount);
    const cdf = new Float32Array(charCount + 1);
    for (let k = 0; k < ATTENTION_MIXTURES; k++) {
      for (let e = 0; e <= charCount; e++) {
        const centered = Math.fround(state.grid[e]! - kappa[k]!);
        cdf[e] = Math.fround(1 / (1 + Math.exp(-Math.fround(centered / beta[k]!))));
      }
      for (let e = 0; e < charCount; e++) {
        phi[e] = phi[e]! + Math.fround(alpha[k]! * Math.fround(cdf[e + 1]! - cdf[e]!));
      }
    }

    const window = new Float32Array(HIDDEN);
    for (let e = 0; e < charCount; e++) {
      const weight = phi[e]!;
      for (let i = 0; i < HIDDEN; i++) {
        window[i] = window[i]! + Math.fround(weight * encoded[e * HIDDEN + i]!);
      }
    }
    return window;
  }

  /**
   * One timestep. Consumes the previous offset [dx, dy, pen], mutates the
   * state, and returns the 121 raw MDN outputs plus the termination
   * probability (attention past the end of the text).
   */
  step(
    state: CellState,
    input: Float32Array,
    encoded: Float32Array,
    charCount: number,
  ): { output: Float32Array; termination: number } {
    let t = add(matvec(input, this.dense("i"), HIDDEN), this.dense("W"));
    t = scale(add(t, state.z), SKIP);

    const [h1, c1] = this.lstm(t, state.h1, state.c1, this.kernel1, this.dense("p"));
    state.h1 = h1;
    state.c1 = c1;
    t = scale(add(t, h1), SKIP);

    const [h2, c2] = this.lstm(concat(t, state.window), state.h2, state.c2, this.kernel2, this.dense("q"));
    state.h2 = h2;
    state.c2 = c2;

    const window = this.attend(h2, state, encoded, charCount);
    state.window = window;

    const mixed = tanh(add(csrMatvec(concat(h2, window), this.mixKernel), this.dense("Q")));
    t = scale(add(t, mixed), SKIP);

    const termination = sigmoid(add(matvec(window, this.dense("c"), 1), this.dense("u")))[0]!;

    const [h3, c3] = this.lstm(t, state.h3, state.c3, this.kernel3, this.dense("f"));
    state.h3 = h3;
    state.c3 = c3;
    t = scale(add(t, h3), SKIP);

    return { output: add(matvec(t, this.dense("z"), MDN_OUTPUTS), this.dense("v")), termination };
  }

  /**
   * Sample an offset from the 121 raw outputs. Random draws (order and
   * formulas) mirror the reference exactly: one uniform for the pen bit,
   * one Gumbel per mixture component, then four uniforms for the two
   * correlated normals.
   */
  sample(output: Float32Array, bias: number, rng: RandomSource): Float32Array {
    const penProbability = sigmoid(output.slice(120, 121))[0]!;
    const pen = rng.uniform() < penProbability ? 1 : 0;

    const pi = new Float32Array(OUTPUT_MIXTURES);
    const sigma = new Float32Array(2 * OUTPUT_MIXTURES);
    const rho = new Float32Array(OUTPUT_MIXTURES);
    const mu = new Float32Array(2 * OUTPUT_MIXTURES);
    for (let k = 0; k < OUTPUT_MIXTURES; k++) {
      pi[k] = output[6 * k]!;
      sigma[2 * k] = output[6 * k + 1]!;
      sigma[2 * k + 1] = output[6 * k + 2]!;
      rho[k] = output[6 * k + 3]!;
      mu[2 * k] = output[6 * k + 4]!;
      mu[2 * k + 1] = output[6 * k + 5]!;
    }

    const rhoT = tanh(rho);
    const sharpSigma = map(softplus(sigma), (v) => v / Math.exp(bias));
    let logPi = map(softmax(pi), Math.log);
    logPi = scale(logPi, 1 + bias);
    for (let k = 0; k < OUTPUT_MIXTURES; k++) {
      if (logPi[k]! < Math.log(0.02)) logPi[k] = logPi[k]! - 100;
    }

    // Gumbel-max over the sharpened log-weights.
    let best = -1e6;
    let pick = 0;
    for (let k = 0; k < OUTPUT_MIXTURES; k++) {
      const perturbed = logPi[k]! + -Math.log(-Math.log(rng.uniform()));
      if (perturbed > best) {
        best = perturbed;
        pick = k;
      }
    }

    const sx = sharpSigma[2 * pick]!;
    const sy = sharpSigma[2 * pick + 1]!;
    const r = rhoT[pick]!;
    const chol = Float32Array.from([sx, r * sy, 0, sy * Math.sqrt(1 - r * r)]);
    const noise = new Float32Array(2);
    for (let i = 0; i < 2; i++) {
      const u1 = 1 - rng.uniform();
      const u2 = 1 - rng.uniform();
      noise[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    const offset = add(mu.slice(2 * pick, 2 * pick + 2), matvec(noise, chol, 2));
    return Float32Array.from([offset[0]!, offset[1]!, pen]);
  }
}
