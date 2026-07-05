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
}
