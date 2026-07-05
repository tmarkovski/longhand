/// Number-for-number parity with the TS ink-render package over a fixed
/// fixture line: polish, pen widths, layout, run bucketing, and ribbon
/// outlines. The math is a transliteration in double precision, so the
/// tight tolerance only absorbs libm differences between JS and Darwin.

import Foundation
import InkCore
import InkRender
import Testing

private let tolerance = 1e-8

@Suite struct ParityTests {
    @Test func polishedLineMatches() throws {
        let parity = try loadRenderParity()
        let polished = polishLine(strokesOf(parity.line))
        #expect(worstDeviation(polished, parity.polished) < tolerance)
    }

    @Test func penWidthsMatch() throws {
        let parity = try loadRenderParity()
        let widths = penWidths(strokesOf(parity.line))
        #expect(widths.count == parity.penWidths.count)
        for (actual, expected) in zip(widths, parity.penWidths) {
            #expect(actual.count == expected.count)
            for (a, e) in zip(actual, expected) {
                #expect(abs(a - e) < tolerance)
            }
        }
    }

    @Test func layoutMatches() throws {
        let parity = try loadRenderParity()
        let layout = layoutLine(strokesOf(parity.line), scale: 3, padding: 6)
        #expect(abs(layout.width - parity.layout.width) < tolerance)
        #expect(abs(layout.height - parity.layout.height) < tolerance)
        #expect(worstDeviation(layout.placed, parity.layout.placed) < tolerance)
    }

    @Test func penRunBucketingMatches() throws {
        let parity = try loadRenderParity()
        let layout = layoutLine(strokesOf(parity.line), scale: 3, padding: 6)
        let strokes = penStrokes(layout.placed)
        #expect(strokes.count == parity.penRuns.count)
        for (stroke, expected) in zip(strokes, parity.penRuns) {
            #expect(abs(stroke.touchdown.x - expected.touchdown.x) < tolerance)
            #expect(abs(stroke.touchdown.y - expected.touchdown.y) < tolerance)
            #expect(abs(stroke.touchdown.r - expected.touchdown.r) < tolerance)
            #expect(stroke.touchdown.index == expected.touchdown.index)
            #expect(stroke.runs.count == expected.runs.count)
            for (run, expectedRun) in zip(stroke.runs, expected.runs) {
                #expect(abs(run.width - expectedRun.width) < tolerance)
                #expect(run.startIndex == expectedRun.startIndex)
                #expect(run.endIndex == expectedRun.endIndex)
                #expect(run.points.count == expectedRun.pointCount)
                #expect(abs(run.length - expectedRun.length) < tolerance)
            }
        }
    }

    @Test func ribbonOutlinesMatch() throws {
        let parity = try loadRenderParity()
        let layout = layoutLine(strokesOf(parity.line), scale: 3, padding: 6)
        #expect(layout.placed.count == parity.ribbons.count)
        for (stroke, expected) in zip(layout.placed, parity.ribbons) {
            let outline = ribbonOutline(stroke.points, scale: 3)
            guard let expected else {
                #expect(outline == nil, "TS skipped this stroke; Swift must too")
                continue
            }
            let actual = try #require(outline)
            var worst = 0.0
            for (edge, expectedEdge) in [(actual.top, expected.top), (actual.bottom, expected.bottom)] {
                #expect(edge.count == expectedEdge.count)
                for (point, expectedPoint) in zip(edge, expectedEdge) {
                    worst = max(worst, abs(point.x - expectedPoint[0]), abs(point.y - expectedPoint[1]))
                }
            }
            #expect(worst < tolerance)
        }
    }
}
