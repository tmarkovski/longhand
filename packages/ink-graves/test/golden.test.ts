import { describe, expect, it } from "vitest";
import { Cell, MAX_CHARS } from "../src/cell.js";
import { GravesModel } from "../src/engine.js";
import { loadAssets, loadGolden, worstDeviation, type GoldenCase } from "./helpers.js";

const ATOL = 2e-3;
const RTOL = 2e-2;

const assets = loadAssets();

function runCase(golden: GoldenCase) {
  const cell = new Cell(assets);
  const state = cell.initialState();
  const params = cell.newMdnParams();
  const chars = new Int32Array(MAX_CHARS);
  chars.set(golden.encoded);

  const failures: string[] = [];
  let argmaxMismatches = 0;

  golden.steps.forEach((expected, t) => {
    const [dx, dy, eos] = golden.inputs[t]!;
    cell.step(state, dx, dy, eos, chars, golden.charLen);
    cell.mdnParse(state.h3, golden.bias, params);

    const checks: Array<[string, ArrayLike<number>, ArrayLike<number>]> = [
      ["kappa", state.kappa, expected.kappa],
      ["phi", state.phi, expected.phi],
      ["window", state.w, expected.window],
      ["pi", params.pi, expected.pi],
      ["muX", params.muX, expected.muX],
      ["muY", params.muY, expected.muY],
      ["sigmaX", params.sigmaX, expected.sigmaX],
      ["sigmaY", params.sigmaY, expected.sigmaY],
      ["rho", params.rho, expected.rho],
      ["eos", [params.eos], [expected.eos]],
    ];
    for (const [label, actual, want] of checks) {
      const worst = worstDeviation(actual, want, ATOL, RTOL);
      if (worst.score > 1) {
        failures.push(
          `step ${t} ${label}[${worst.index}]: got ${worst.actual}, want ${worst.expected} (score ${worst.score.toFixed(2)})`,
        );
      }
    }

    let argmax = 0;
    for (let u = 1; u < MAX_CHARS; u++) {
      if (state.phi[u]! > state.phi[argmax]!) argmax = u;
    }
    if (argmax !== expected.phiArgmax) argmaxMismatches++;
  });

  return { failures, argmaxMismatches };
}

describe("golden parity with the MLX reference", () => {
  for (const name of ["unprimed-bias075", "primed9-bias10"]) {
    it(`matches ${name} within tolerance`, () => {
      const golden = loadGolden(name);
      const model = new GravesModel(assets);
      expect(Array.from(model.encode(golden.charsText))).toEqual(golden.encoded);

      const { failures, argmaxMismatches } = runCase(golden);
      expect(failures.slice(0, 10), `${failures.length} deviations`).toEqual([]);
      expect(argmaxMismatches).toBeLessThanOrEqual(1);
    });
  }
});
