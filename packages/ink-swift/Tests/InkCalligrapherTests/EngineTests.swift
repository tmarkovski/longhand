/// End-to-end calligrapher engine behavior, mirroring the spirit of the
/// graves engine tests.

import Foundation
import InkCalligrapher
import InkCore
import Testing

@Suite struct EngineTests {
    let model = try! CalligrapherModel(assets: Fixtures.assets)

    @Test func writesALineAndTerminatesNaturally() throws {
        let offsets = try model.write("hello world", seed: 42)
        #expect(offsets.count > 50)
        #expect(offsets.count <= 40 * "hello world".count)
        #expect(offsets.allSatisfy { $0.dx.isFinite && $0.dy.isFinite })
        #expect(offsets.filter(\.eos).count > 3)
    }

    @Test func isDeterministicPerSeedIncludingRandomStyle() throws {
        // style nil draws the style from the seed, so it must reproduce too.
        let first = try model.write("hello", seed: 7)
        let second = try model.write("hello", seed: 7)
        let different = try model.write("hello", seed: 8)
        #expect(first == second)
        #expect(first != different)
    }

    @Test func encodesWithMarkersAndUnknownFallback() {
        #expect(model.encode("hi") == [2, 30, 13, 3])
        #expect(model.encode("h~i") == [2, 30, 1, 13, 3])
        #expect(model.supports("h"))
        #expect(!model.supports("~"))
        #expect(model.styles.count == 80)
    }

    @Test func rejectsUnknownStyles() {
        #expect(throws: CalligrapherError.self) {
            try model.writer("hi", style: 99)
        }
    }

    /// Real-time streaming needs 125 steps/sec (the web app reveals one
    /// step per 8ms). Debug builds run -Onone (no unsafeFlags in a
    /// remotely-consumable manifest), which misses the bar by design, so
    /// the gate only exists in release runs: `swift test -c release`.
    #if !DEBUG
    @Test func sustainsAtLeast125StepsPerSecond() throws {
        let writer = try model.writer(
            "the quick brown fox jumps over the lazy dog then keeps on going",
            bias: 0.75,
            style: 3,
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
    #endif
}

private extension Duration {
    var seconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) + Double(attoseconds) * 1e-18
    }
}
