/// Stroke-stream parity with the TS engine (and through it, the vendored
/// calligrapher.ai reference): same seeds must produce the same number of
/// steps, identical pen bits, and near-identical coordinates. A divergent
/// mixture pick anywhere would desync the stream and fail loudly on count
/// or pen bits, so the tight coordinate tolerance only absorbs transcendental
/// rounding differences between JS and Swift.

import Foundation
import InkCalligrapher
import Testing

@Suite struct ParityTests {
    @Test func parsesTheSharedWeightsContainer() {
        let assets = Fixtures.assets
        #expect(assets.styleCount == 80)
        #expect(assets.sparse.keys.sorted() == ["l", "r", "w", "y"])
        #expect(assets.dense["g"]?.shape == [80, 64])
    }

    @Test func matchesTypeScriptStrokeStreams() throws {
        let model = try CalligrapherModel(assets: Fixtures.assets)
        for parityCase in try loadParityCases() {
            let offsets = try model.write(
                parityCase.text,
                bias: parityCase.bias,
                style: parityCase.style,
                seed: parityCase.seed
            )
            #expect(
                offsets.count == parityCase.offsets.count,
                "\(parityCase.text) seed \(parityCase.seed): \(offsets.count) steps vs TS \(parityCase.offsets.count)"
            )
            guard offsets.count == parityCase.offsets.count else { continue }

            var worst = 0.0
            var penMismatches = 0
            for (index, expected) in parityCase.offsets.enumerated() {
                let actual = offsets[index]
                worst = max(worst, abs(actual.dx - expected[0]), abs(actual.dy - expected[1]))
                if actual.eos != (expected[2] == 1) { penMismatches += 1 }
            }
            #expect(penMismatches == 0, "\(parityCase.text): \(penMismatches) pen-bit mismatches")
            #expect(worst < 1e-3, "\(parityCase.text): worst coordinate deviation \(worst)")
        }
    }
}
