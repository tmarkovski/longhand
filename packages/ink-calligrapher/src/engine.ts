/**
 * Generation API over the calligrapher cell, mirroring the reference
 * page's write loop: encode [START, ...text, END], condition on one of
 * the 80 learned style vectors (or a seed-picked random one), then
 * autoregressively sample until the attention head signals the text is
 * exhausted or the step budget runs out. The terminating step's sample
 * is discarded, exactly like the reference.
 */

import type { InkEngine, StrokeOffset } from "@longhand/ink-core";
import { CalligrapherCell } from "./cell.js";
import type { CellState } from "./cell.js";
import { ALPHABET, CHAR_TO_ID, END, START, UNKNOWN } from "./charmap.js";
import { Rng } from "./rng.js";
import type { CalligrapherAssets } from "./weights.js";

export const STEPS_PER_CHARACTER = 40;

/**
 * The model has 80 learned styles, but many are near-duplicates or rough;
 * calligrapher.ai's own picker exposes only these (plus random), so ours
 * does too. The engine itself accepts any id 0-79.
 */
export const EXPOSED_STYLES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface WriteOptions {
  /** Legibility / sampling sharpness. Reference default 0.75. */
  bias?: number;
  /** Style id (0-79), or null for a seed-picked random style. */
  style?: number | null;
  /** RNG seed; same inputs + seed reproduce the exact same strokes. */
  seed?: number;
}

export class CalligrapherModel implements InkEngine {
  readonly assets: CalligrapherAssets;
  readonly alphabet: readonly string[] = ALPHABET;
  private readonly cell: CalligrapherCell;

  constructor(assets: CalligrapherAssets) {
    this.assets = assets;
    this.cell = new CalligrapherCell(assets);
  }

  get styles(): number[] {
    return Array.from({ length: this.assets.styleCount }, (_, i) => i);
  }

  /** Encode text to model ids, wrapped in start/end markers. */
  encode(text: string): Int32Array {
    const encoded = new Int32Array(text.length + 2);
    encoded[0] = START;
    for (let i = 0; i < text.length; i++) {
      encoded[i + 1] = CHAR_TO_ID.get(text[i]!) ?? UNKNOWN;
    }
    encoded[text.length + 1] = END;
    return encoded;
  }

  supports(character: string): boolean {
    return CHAR_TO_ID.has(character);
  }

  writer(text: string, options: WriteOptions = {}): CalligrapherWriter {
    return new CalligrapherWriter(this, this.cell, text, options);
  }

  /** Generate a full line synchronously. */
  write(text: string, options: WriteOptions = {}): StrokeOffset[] {
    const writer = this.writer(text, options);
    const offsets: StrokeOffset[] = [];
    for (;;) {
      const offset = writer.step();
      if (offset === null) break;
      offsets.push(offset);
    }
    return offsets;
  }
}

export class CalligrapherWriter {
  readonly text: string;
  readonly bias: number;
  readonly style: number;
  private readonly cell: CalligrapherCell;
  private readonly rng: Rng;
  private readonly state: CellState;
  private readonly encoded: Float32Array;
  private readonly charCount: number;
  private readonly maxSteps: number;
  private lastInput: Float32Array = Float32Array.from([0, 0, 1]);
  private steps = 0;
  private isDone = false;

  constructor(model: CalligrapherModel, cell: CalligrapherCell, text: string, options: WriteOptions) {
    const { bias = 0.75, style = null, seed = 0 } = options;
    this.text = text;
    this.bias = bias;
    this.cell = cell;
    this.rng = new Rng(seed);
    // The reference picks a random style with one uniform draw before
    // anything else; matching that keeps null-style runs reproducible.
    this.style =
      style !== null ? style : Math.floor(model.assets.styleCount * this.rng.uniform());
    if (this.style < 0 || this.style >= model.assets.styleCount) {
      throw new Error(`unknown style ${this.style}`);
    }

    const ids = model.encode(text);
    this.charCount = ids.length;
    this.encoded = cell.encodeText(ids);
    this.state = cell.initialState(this.charCount, this.style);
    this.maxSteps = STEPS_PER_CHARACTER * text.length;
  }

  get done(): boolean {
    return this.isDone;
  }

  /** Advance one timestep. Returns the sampled offset, or null once done. */
  step(): StrokeOffset | null {
    if (this.isDone) return null;
    const { output, termination } = this.cell.step(
      this.state,
      this.lastInput,
      this.encoded,
      this.charCount,
    );
    const offset = this.cell.sample(output, this.bias, this.rng);
    this.steps += 1;
    if (this.steps > this.maxSteps || termination > 0.5) {
      this.isDone = true;
      return null;
    }
    this.lastInput = offset;
    return [offset[0]!, offset[1]!, offset[2]!];
  }
}
