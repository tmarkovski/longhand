/**
 * Drift guard: the committed q8 asset against the f32 reference fixture
 * regenerated from the MLX submodule. The golden tests only read the
 * fixture now (MLX parity tolerances exclude quantization noise), so this
 * suite is what still fails the build if the committed weights stop
 * matching the submodule — the role the golden tests played when the
 * shipped asset was itself f32.
 */
import { describe, expect, it } from "vitest";
import { Cell, MAX_CHARS } from "../src/cell.js";
import { GravesModel } from "../src/engine.js";
import { loadAssets, loadReferenceAssets } from "./helpers.js";

const shipped = loadAssets();
const reference = loadReferenceAssets();

const QUANTIZED = [
  "lstm1_kernel",
  "lstm2_kernel",
  "lstm3_kernel",
  "attention_weights",
  "gmm_weights",
];
const BIASES = ["lstm1_bias", "lstm2_bias", "lstm3_bias", "attention_biases", "gmm_biases"];

describe("committed q8 asset vs the MLX reference", () => {
  it("quantized matrices agree within per-column rounding error", () => {
    for (const name of QUANTIZED) {
      const dequant = shipped.tensors.get(name)!;
      const exact = reference.tensors.get(name)!;
      expect(dequant.shape, name).toEqual(exact.shape);
      const [rows, cols] = exact.shape as [number, number];

      // Symmetric q8 rounds to scale = absmax/127 per column, so a
      // faithful quantization of these exact weights lands within scale/2
      // (plus a hair of f32 rounding in the exporter's divide/multiply;
      // measured worst case 0.500004, while real drift lands far above 1).
      const absmax = new Float64Array(cols);
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          const magnitude = Math.abs(exact.data[i]!);
          if (magnitude > absmax[c]!) absmax[c] = magnitude;
        }
      }
      let violations = 0;
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          const allowed = (absmax[c]! / 127) * 0.5001 + 1e-9;
          if (Math.abs(dequant.data[i]! - exact.data[i]!) > allowed) violations++;
        }
      }
      expect(violations, `${name}: values outside q8 rounding error`).toBe(0);
    }
  });

  it("biases are bit-identical", () => {
    for (const name of BIASES) {
      expect(shipped.tensors.get(name)!.data, name).toEqual(reference.tensors.get(name)!.data);
    }
  });

  // Shortest, median, and longest primers; a wrong bake (or drifted
  // weights) throws the recomputed state off by ~1, not 1e-5.
  it.each([7, 3, 11])("baked primed state for style %i rebakes from the reference strokes", (id) => {
    const model = new GravesModel(shipped);
    const cell = new Cell(shipped);
    const styleInfo = shipped.styles.find((s) => s.id === id)!;
    const baked = shipped.tensors.get(styleInfo.primed!)!.data;
    const strokes = reference.tensors.get(`style_${id}`)!.data;

    const encoded = model.encode(styleInfo.primer);
    const chars = new Int32Array(MAX_CHARS);
    chars.set(encoded);
    const state = cell.initialState();
    for (let t = 0; t < strokes.length / 3; t++) {
      cell.step(state, strokes[3 * t]!, strokes[3 * t + 1]!, strokes[3 * t + 2]!, chars, encoded.length);
    }

    const slices = [state.h1, state.c1, state.h2, state.c2, state.h3, state.c3, state.kappa, state.w];
    let offset = 0;
    let worst = 0;
    for (const slice of slices) {
      for (let i = 0; i < slice.length; i++) {
        worst = Math.max(worst, Math.abs(slice[i]! - baked[offset + i]!));
      }
      offset += slice.length;
    }
    expect(offset).toBe(baked.length);
    expect(worst, `style ${id}: worst |rebaked - committed|`).toBeLessThan(1e-3);
  });
});
