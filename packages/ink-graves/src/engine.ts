/**
 * High-level generation API over the Cell, mirroring the reference
 * Generator/HandStream semantics: optional style priming, autoregressive
 * sampling with bias sharpening, and attention-based termination.
 */

import type { StrokeOffset } from "@longhand/ink-core";
import { Cell, MAX_CHARS } from "./cell.js";
import type { CellState, MdnParams } from "./cell.js";
import { Rng } from "./rng.js";
import type { ModelAssets } from "./weights.js";

export const STEPS_PER_CHARACTER = 40;

export interface WriteOptions {
  /** Legibility / sampling sharpness. 0 = wild, ~1 = neat. Default 0.5. */
  bias?: number;
  /** Style id (0-12) to prime with, or null for the model's freehand. */
  style?: number | null;
  /** RNG seed; same inputs + seed reproduce the exact same strokes. */
  seed?: number;
}

export class GravesModel {
  readonly assets: ModelAssets;
  private readonly cell: Cell;
  private readonly charToIndex: Map<string, number>;

  constructor(assets: ModelAssets) {
    this.assets = assets;
    this.cell = new Cell(assets);
    this.charToIndex = new Map(assets.alphabet.map((character, index) => [character, index]));
  }

  /** Encode text to alphabet indices with the trailing 0 terminator. */
  encode(text: string): Int32Array {
    const encoded = new Int32Array(text.length + 1);
    for (let i = 0; i < text.length; i++) {
      encoded[i] = this.charToIndex.get(text[i]!) ?? 0;
    }
    return encoded;
  }

  /** Characters the model was trained on. Anything else must be substituted. */
  supports(character: string): boolean {
    return this.charToIndex.has(character);
  }

  writer(text: string, options: WriteOptions = {}): GravesWriter {
    return new GravesWriter(this, this.cell, text, options);
  }

  /** Generate a full line synchronously. */
  write(text: string, options: WriteOptions = {}): StrokeOffset[] {
    return this.writer(text, options).run();
  }
}

export class GravesWriter {
  readonly text: string;
  readonly bias: number;
  private readonly cell: Cell;
  private readonly rng: Rng;
  private readonly state: CellState;
  private readonly chars: Int32Array;
  private readonly charLength: number;
  private readonly params: MdnParams;
  private lastInput: [number, number, number] = [0, 0, 1];
  private isDone = false;

  constructor(model: GravesModel, cell: Cell, text: string, options: WriteOptions) {
    const { bias = 0.5, style = null, seed = 0 } = options;
    this.text = text;
    this.bias = bias;
    this.cell = cell;
    this.rng = new Rng(seed);
    this.state = cell.initialState();
    this.params = cell.newMdnParams();

    let encoded: Int32Array;
    let primeStrokes: Float32Array | null = null;
    if (style !== null) {
      const styleInfo = model.assets.styles.find((s) => s.id === style);
      if (!styleInfo) throw new Error(`unknown style ${style}`);
      const tensor = model.assets.tensors.get(styleInfo.tensor);
      if (!tensor) throw new Error(`missing style tensor ${styleInfo.tensor}`);
      primeStrokes = tensor.data;
      encoded = model.encode(styleInfo.primer + " " + text);
    } else {
      encoded = model.encode(text);
    }
    if (encoded.length > MAX_CHARS) {
      throw new Error(`encoded text length ${encoded.length} exceeds ${MAX_CHARS}`);
    }
    this.chars = new Int32Array(MAX_CHARS);
    this.chars.set(encoded);
    this.charLength = encoded.length;

    if (primeStrokes) this.prime(primeStrokes);
  }

  /**
   * Teacher-force the style's pen data through the cell, then draw the
   * first free-run input from the primed state (it is consumed as input,
   * never emitted — matching the reference).
   */
  private prime(strokes: Float32Array): void {
    const steps = strokes.length / 3;
    for (let t = 0; t < steps; t++) {
      this.cell.step(
        this.state,
        strokes[3 * t]!,
        strokes[3 * t + 1]!,
        strokes[3 * t + 2]!,
        this.chars,
        this.charLength,
      );
    }
    this.cell.mdnParse(this.state.h3, this.bias, this.params);
    this.lastInput = this.cell.mdnSample(this.params, this.rng);
  }

  get done(): boolean {
    return this.isDone;
  }

  /** Advance one timestep. Returns the sampled offset, or null once done. */
  step(): StrokeOffset | null {
    if (this.isDone) return null;
    const [dx, dy, eos] = this.lastInput;
    this.cell.step(this.state, dx, dy, eos, this.chars, this.charLength);
    this.cell.mdnParse(this.state.h3, this.bias, this.params);
    const offset = this.cell.mdnSample(this.params, this.rng);
    this.lastInput = offset;

    // Termination mirrors Generator._flush: attention argmax past the end,
    // or on the final character while the pen lifts.
    const phi = this.state.phi;
    let argmax = 0;
    let best = phi[0]!;
    for (let u = 1; u < MAX_CHARS; u++) {
      if (phi[u]! > best) {
        best = phi[u]!;
        argmax = u;
      }
    }
    const pastFinal = argmax >= this.charLength;
    const finalWithEos = argmax >= this.charLength - 1 && offset[2] === 1;
    if (pastFinal || finalWithEos) this.isDone = true;

    return offset;
  }

  /** Run to termination (or the step budget) and return all offsets. */
  run(maxSteps: number = STEPS_PER_CHARACTER * this.text.length): StrokeOffset[] {
    const offsets: StrokeOffset[] = [];
    for (let t = 0; t < maxSteps; t++) {
      const offset = this.step();
      if (offset === null) break;
      offsets.push(offset);
    }
    return offsets;
  }
}
