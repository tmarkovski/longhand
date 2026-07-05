/// Smoothing and alignment against the scipy/numpy goldens the TS package
/// uses — the same authority chain: reference draw.py -> scipy fixtures ->
/// each port.

import Foundation
import InkCore
import InkRender
import Testing

@Suite struct GoldenTests {
    @Test func savgolMatchesScipyAtEveryStrokeLength() throws {
        let golden = try loadScipyGolden()
        for fixture in golden.savgol {
            // x and -x through one stroke exercises both coordinate tracks.
            let line = [InkStroke(points: fixture.input.map { SIMD2($0, -$0) })]
            let smoothed = smoothLine(line)[0].points
            #expect(smoothed.count == fixture.expected.count)
            for (point, expected) in zip(smoothed, fixture.expected) {
                #expect(abs(point.x - expected) < 1e-6)
                #expect(abs(point.y + expected) < 1e-6)
            }
        }
    }

    @Test func alignMatchesTheReference() throws {
        let golden = try loadScipyGolden()
        let aligned = alignLine(strokesOf([golden.align.input]))[0].points
        for (point, expected) in zip(aligned, golden.align.expected) {
            #expect(abs(point.x - expected[0]) < 1e-5)
            #expect(abs(point.y - expected[1]) < 1e-5)
        }
    }

    @Test func smoothingPreservesStrokeStructure() {
        let line = [
            InkStroke(points: (0 ..< 8).map { SIMD2(Double($0), Double($0 % 2)) }),
            InkStroke(points: [SIMD2(10, 10)]),
        ]
        let smoothed = smoothLine(line)
        #expect(smoothed.count == 2)
        #expect(smoothed[0].points.count == 8)
        #expect(smoothed[1].points.count == 1)
    }

    @Test func alignLeavesDegenerateLinesUntouched() {
        let dot = [InkStroke(points: [SIMD2(5, 5)])]
        #expect(alignLine(dot) == dot)
        let vertical = [InkStroke(points: [SIMD2(2, 0), SIMD2(2, 10), SIMD2(2, 20)])]
        #expect(alignLine(vertical) == vertical)
    }
}
