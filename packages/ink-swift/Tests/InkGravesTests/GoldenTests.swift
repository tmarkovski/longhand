/// Golden parity with the MLX reference, ported from
/// packages/ink-graves/test/golden.test.ts: teacher-force the recorded
/// inputs through the cell and compare every attention and MDN output per
/// timestep against the recorded MLX values.

import Foundation
import InkGraves
import Testing

private let ATOL = 2e-3
private let RTOL = 2e-2

@Suite struct GoldenTests {
    @Test func parsesTheSharedWeightsContainer() throws {
        let assets = Fixtures.assets
        #expect(assets.alphabet.count == Cell.alphabetSize)
        // maxCharLen is the training-time text limit (75), unrelated to the
        // cell's 120-slot phi buffer.
        #expect(assets.maxCharLen > 0)
        #expect(!assets.styles.isEmpty)
        let lstm1 = try #require(assets.tensors["lstm1_kernel"])
        #expect(lstm1.shape == [476, 1600])
        #expect(lstm1.data.count == 476 * 1600)
    }

    @Test(arguments: ["unprimed-bias075", "primed9-bias10"])
    func matchesGoldenWithinTolerance(_ name: String) throws {
        let golden = try loadGolden(name)
        let model = try GravesModel(assets: Fixtures.assets)
        #expect(model.encode(golden.charsText) == golden.encoded)

        let cell = try Cell(assets: Fixtures.assets)
        let state = cell.initialState()
        let params = cell.newMdnParams()
        var chars = [Int32](repeating: 0, count: Cell.maxChars)
        chars.replaceSubrange(0 ..< golden.encoded.count, with: golden.encoded)

        var failures: [String] = []
        var argmaxMismatches = 0

        for (t, expected) in golden.steps.enumerated() {
            let input = golden.inputs[t]
            cell.step(state, dx: input[0], dy: input[1], eos: input[2], chars: chars, charLength: golden.charLen)
            cell.mdnParse(h3: state.h3, bias: golden.bias, into: params)

            let checks: [(label: String, actual: [Float], expected: [Float])] = [
                ("kappa", state.kappa, expected.kappa),
                ("phi", state.phi, expected.phi),
                ("window", state.w, expected.window),
                ("pi", params.pi, expected.pi),
                ("muX", params.muX, expected.muX),
                ("muY", params.muY, expected.muY),
                ("sigmaX", params.sigmaX, expected.sigmaX),
                ("sigmaY", params.sigmaY, expected.sigmaY),
                ("rho", params.rho, expected.rho),
                ("eos", [params.eos], [expected.eos]),
            ]
            for check in checks {
                let worst = worstDeviation(check.actual, check.expected, atol: ATOL, rtol: RTOL)
                if worst.score > 1 {
                    failures.append(
                        "step \(t) \(check.label)[\(worst.index)]: got \(worst.actual), "
                            + "want \(worst.expected) (score \(String(format: "%.2f", worst.score)))"
                    )
                }
            }

            var argmax = 0
            for u in 1 ..< Cell.maxChars where state.phi[u] > state.phi[argmax] {
                argmax = u
            }
            if argmax != expected.phiArgmax { argmaxMismatches += 1 }
        }

        #expect(failures.isEmpty, "\(failures.count) deviations: \(failures.prefix(10).joined(separator: "; "))")
        #expect(argmaxMismatches <= 1)
    }
}
