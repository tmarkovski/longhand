/**
 * The Graves handwriting cell: 3 stacked LSTMs + Gaussian window attention
 * + mixture density head. A line-by-line port of the MLX reference
 * (graves_handwriting_mlx/model.py and modules.py); concat row orders must
 * match the saved kernel layouts exactly:
 *
 *   lstm1 rows:     [w_prev(73), x(3), h1_prev(400)]          -> (476, 1600)
 *   attention rows: [w_prev(73), x(3), h1(400)]               -> (476, 30)
 *   lstm2 rows:     [x(3), h1(400), w(73), h2_prev(400)]      -> (876, 1600)
 *   lstm3 rows:     [x(3), h2(400), w(73), h3_prev(400)]      -> (876, 1600)
 *   gmm rows:       [h3(400)]                                 -> (400, 121)
 *
 * Everything is batch-size 1 and allocation-free per step.
 */

import type { ModelAssets } from "./weights.js";
import type { Rng } from "./rng.js";

export const HIDDEN = 400;
export const ATTENTION_MIXTURES = 10;
export const OUTPUT_MIXTURES = 20;
export const ALPHABET_SIZE = 73;
export const MAX_CHARS = 120;

const GATES = 4 * HIDDEN;
const EPSILON = 1e-8;
const SIGMA_FLOOR = 1e-4;

export interface CellState {
  h1: Float32Array;
  c1: Float32Array;
  h2: Float32Array;
  c2: Float32Array;
  h3: Float32Array;
  c3: Float32Array;
  kappa: Float32Array;
  w: Float32Array;
  phi: Float32Array;
}

export interface MdnParams {
  pi: Float32Array;
  muX: Float32Array;
  muY: Float32Array;
  sigmaX: Float32Array;
  sigmaY: Float32Array;
  rho: Float32Array;
  eos: number;
}

function sigmoid(v: number): number {
  return 1 / (1 + Math.exp(-v));
}

function softplus(v: number): number {
  return v > 30 ? v : Math.log1p(Math.exp(v));
}

/** y += x @ kernel[rowOffset : rowOffset + xLength], kernel row-major (rows, nOut). */
function accumulate(
  y: Float32Array,
  kernel: Float32Array,
  rowOffset: number,
  nOut: number,
  x: Float32Array,
  xLength: number,
): void {
  for (let i = 0; i < xLength; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const base = (rowOffset + i) * nOut;
    for (let j = 0; j < nOut; j++) y[j] += kernel[base + j] * xi;
  }
}

/** In-place LSTM update from a fused gate buffer, TF gate order (i, j, f, o). */
function applyLstm(gates: Float32Array, hidden: Float32Array, cell: Float32Array): void {
  for (let m = 0; m < HIDDEN; m++) {
    const inputGate = sigmoid(gates[m]);
    const candidate = Math.tanh(gates[HIDDEN + m]);
    const forgetGate = sigmoid(gates[2 * HIDDEN + m]);
    const outputGate = sigmoid(gates[3 * HIDDEN + m]);
    const newCell = forgetGate * cell[m] + inputGate * candidate;
    cell[m] = newCell;
    hidden[m] = outputGate * Math.tanh(newCell);
  }
}

export class Cell {
  private readonly k1: Float32Array;
  private readonly b1: Float32Array;
  private readonly k2: Float32Array;
  private readonly b2: Float32Array;
  private readonly k3: Float32Array;
  private readonly b3: Float32Array;
  private readonly kAtt: Float32Array;
  private readonly bAtt: Float32Array;
  private readonly kGmm: Float32Array;
  private readonly bGmm: Float32Array;

  // Per-step scratch, reused across calls.
  private readonly gates = new Float32Array(GATES);
  private readonly attRaw = new Float32Array(3 * ATTENTION_MIXTURES);
  private readonly gmmRaw = new Float32Array(6 * OUTPUT_MIXTURES + 1);
  private readonly windowScratch = new Float32Array(ALPHABET_SIZE);
  private readonly inputScratch = new Float32Array(3);

  constructor(assets: ModelAssets) {
    const tensor = (name: string): Float32Array => {
      const found = assets.tensors.get(name);
      if (!found) throw new Error(`missing tensor ${name}`);
      return found.data;
    };
    this.k1 = tensor("lstm1_kernel");
    this.b1 = tensor("lstm1_bias");
    this.k2 = tensor("lstm2_kernel");
    this.b2 = tensor("lstm2_bias");
    this.k3 = tensor("lstm3_kernel");
    this.b3 = tensor("lstm3_bias");
    this.kAtt = tensor("attention_weights");
    this.bAtt = tensor("attention_biases");
    this.kGmm = tensor("gmm_weights");
    this.bGmm = tensor("gmm_biases");
  }

  initialState(): CellState {
    return {
      h1: new Float32Array(HIDDEN),
      c1: new Float32Array(HIDDEN),
      h2: new Float32Array(HIDDEN),
      c2: new Float32Array(HIDDEN),
      h3: new Float32Array(HIDDEN),
      c3: new Float32Array(HIDDEN),
      kappa: new Float32Array(ATTENTION_MIXTURES),
      w: new Float32Array(ALPHABET_SIZE),
      phi: new Float32Array(MAX_CHARS),
    };
  }

  newMdnParams(): MdnParams {
    return {
      pi: new Float32Array(OUTPUT_MIXTURES),
      muX: new Float32Array(OUTPUT_MIXTURES),
      muY: new Float32Array(OUTPUT_MIXTURES),
      sigmaX: new Float32Array(OUTPUT_MIXTURES),
      sigmaY: new Float32Array(OUTPUT_MIXTURES),
      rho: new Float32Array(OUTPUT_MIXTURES),
      eos: 0,
    };
  }

  /**
   * One timestep. Mutates `state` in place. `chars` holds alphabet indices
   * (the encoded text, zero-padded); `charLength` is the true encoded length.
   */
  step(state: CellState, dx: number, dy: number, eos: number, chars: Int32Array, charLength: number): void {
    const x = this.inputScratch;
    x[0] = dx;
    x[1] = dy;
    x[2] = eos;
    const { gates, attRaw } = this;

    // LSTM 1: [w_prev, x, h1_prev]
    gates.set(this.b1);
    accumulate(gates, this.k1, 0, GATES, state.w, ALPHABET_SIZE);
    accumulate(gates, this.k1, ALPHABET_SIZE, GATES, x, 3);
    accumulate(gates, this.k1, ALPHABET_SIZE + 3, GATES, state.h1, HIDDEN);
    applyLstm(gates, state.h1, state.c1);

    // Attention: [w_prev, x, h1] -> softplus -> (alpha, beta, kappa step)
    attRaw.set(this.bAtt);
    accumulate(attRaw, this.kAtt, 0, 30, state.w, ALPHABET_SIZE);
    accumulate(attRaw, this.kAtt, ALPHABET_SIZE, 30, x, 3);
    accumulate(attRaw, this.kAtt, ALPHABET_SIZE + 3, 30, state.h1, HIDDEN);
    for (let i = 0; i < 30; i++) attRaw[i] = softplus(attRaw[i]);
    for (let k = 0; k < ATTENTION_MIXTURES; k++) {
      state.kappa[k] += attRaw[20 + k] / 25.0;
      if (attRaw[10 + k] < 0.01) attRaw[10 + k] = 0.01; // beta floor
    }
    for (let u = 0; u < MAX_CHARS; u++) {
      let sum = 0;
      for (let k = 0; k < ATTENTION_MIXTURES; k++) {
        const diff = state.kappa[k] - u;
        sum += attRaw[k] * Math.exp(-(diff * diff) / attRaw[10 + k]);
      }
      state.phi[u] = sum;
    }
    this.windowScratch.fill(0);
    for (let u = 0; u < charLength; u++) {
      this.windowScratch[chars[u]] += state.phi[u];
    }
    state.w.set(this.windowScratch);

    // LSTM 2: [x, h1, w, h2_prev]
    gates.set(this.b2);
    accumulate(gates, this.k2, 0, GATES, x, 3);
    accumulate(gates, this.k2, 3, GATES, state.h1, HIDDEN);
    accumulate(gates, this.k2, 3 + HIDDEN, GATES, state.w, ALPHABET_SIZE);
    accumulate(gates, this.k2, 3 + HIDDEN + ALPHABET_SIZE, GATES, state.h2, HIDDEN);
    applyLstm(gates, state.h2, state.c2);

    // LSTM 3: [x, h2, w, h3_prev]
    gates.set(this.b3);
    accumulate(gates, this.k3, 0, GATES, x, 3);
    accumulate(gates, this.k3, 3, GATES, state.h2, HIDDEN);
    accumulate(gates, this.k3, 3 + HIDDEN, GATES, state.w, ALPHABET_SIZE);
    accumulate(gates, this.k3, 3 + HIDDEN + ALPHABET_SIZE, GATES, state.h3, HIDDEN);
    applyLstm(gates, state.h3, state.c3);
  }

  /**
   * MDN head with the Graves bias (sharpness) trick. Matches the reference:
   * pi logits scaled by (1 + bias), log-sigmas shifted down by bias, then
   * pi and eos snapped to zero below 0.01 (pi is NOT renormalized).
   */
  mdnParse(h3: Float32Array, bias: number, out: MdnParams): MdnParams {
    const raw = this.gmmRaw;
    raw.set(this.bGmm);
    accumulate(raw, this.kGmm, 0, raw.length, h3, HIDDEN);

    const M = OUTPUT_MIXTURES;
    let maxLogit = -Infinity;
    for (let m = 0; m < M; m++) {
      const logit = raw[m] * (1 + bias);
      out.pi[m] = logit;
      if (logit > maxLogit) maxLogit = logit;
    }
    let total = 0;
    for (let m = 0; m < M; m++) {
      const value = Math.exp(out.pi[m] - maxLogit);
      out.pi[m] = value;
      total += value;
    }
    for (let m = 0; m < M; m++) {
      const p = out.pi[m] / total;
      out.pi[m] = p < 0.01 ? 0 : p;
      out.sigmaX[m] = Math.max(Math.exp(raw[M + m] - bias), SIGMA_FLOOR);
      out.sigmaY[m] = Math.max(Math.exp(raw[2 * M + m] - bias), SIGMA_FLOOR);
      const tanhRho = Math.tanh(raw[3 * M + m]);
      out.rho[m] = Math.min(Math.max(tanhRho, EPSILON - 1), 1 - EPSILON);
      out.muX[m] = raw[4 * M + m];
      out.muY[m] = raw[5 * M + m];
    }
    const eosProb = Math.min(Math.max(sigmoid(raw[6 * M]), EPSILON), 1 - EPSILON);
    out.eos = eosProb < 0.01 ? 0 : eosProb;
    return out;
  }

  /** Draw one (Δx, Δy, eos) from parsed MDN params. */
  mdnSample(params: MdnParams, rng: Rng): [number, number, number] {
    const component = rng.categorical(params.pi);
    const z1 = rng.normal();
    const z2 = rng.normal();
    const rho = params.rho[component];
    const dx = params.muX[component] + params.sigmaX[component] * z1;
    const dy =
      params.muY[component] +
      params.sigmaY[component] * (rho * z1 + Math.sqrt(Math.max(1 - rho * rho, 0)) * z2);
    const eos = rng.uniform() < params.eos ? 1 : 0;
    return [dx, dy, eos];
  }
}
