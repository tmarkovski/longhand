/// End-to-end engine behavior, ported from
/// packages/ink-graves/test/engine.test.ts.

import Foundation
import InkGraves
import Testing

@Suite struct EngineTests {
    let model = try! GravesModel(assets: Fixtures.assets)

    @Test func writesAnUnprimedLineAndTerminatesNaturally() throws {
        let offsets = try model.write("hello world", bias: 0.75, seed: 42)
        #expect(offsets.count > 100)
        #expect(offsets.count < 40 * "hello world".count)
        for offset in offsets {
            #expect(offset.dx.isFinite)
            #expect(offset.dy.isFinite)
        }
        // eos=1 marks the last point of a stroke; a legible line has several.
        let strokeCount = offsets.filter(\.eos).count
        #expect(strokeCount > 3)
    }

    @Test func isDeterministicPerSeedAndVariesAcrossSeeds() throws {
        let first = try model.write("hello", bias: 0.75, seed: 7)
        let second = try model.write("hello", bias: 0.75, seed: 7)
        let different = try model.write("hello", bias: 0.75, seed: 8)
        #expect(first == second)
        #expect(first != different)
    }

    @Test func writesWithStylePriming() throws {
        let offsets = try model.write("hello", bias: 0.75, style: 9, seed: 42)
        #expect(offsets.count > 40)
        #expect(offsets.allSatisfy { $0.dx.isFinite && $0.dy.isFinite })
    }

    @Test func rejectsUnknownStylesAndOverLongText() {
        #expect(throws: GravesError.self) {
            try model.writer("hi", style: 99)
        }
        #expect(throws: GravesError.self) {
            try model.writer(String(repeating: "x", count: 200))
        }
    }

    @Test func sustainsAtLeast125StepsPerSecond() throws {
        let writer = try model.writer(
            "the quick brown fox jumps over the lazy dog then keeps on going",
            bias: 0.75,
            seed: 1
        )
        for _ in 0 ..< 30 { _ = writer.step() } // warmup
        let clock = ContinuousClock()
        var steps = 0
        let elapsed = clock.measure {
            while steps < 600, writer.step() != nil { steps += 1 }
        }
        let stepsPerSecond = Double(steps) / max(elapsed.seconds, 1e-9)
        print("engine speed: \(Int(stepsPerSecond)) steps/sec over \(steps) steps")
        #expect(stepsPerSecond > 125)
    }
}

private extension Duration {
    var seconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) + Double(attoseconds) / 1e18
    }
}
