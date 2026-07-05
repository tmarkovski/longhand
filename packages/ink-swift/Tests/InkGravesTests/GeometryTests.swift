import InkCore
import Testing

@Suite struct GeometryTests {
    @Test func foldsOffsetsIntoStrokesWithYFlip() {
        let offsets = [
            StrokeOffset(dx: 1, dy: 1, eos: false),
            StrokeOffset(dx: 1, dy: -1, eos: true),
            StrokeOffset(dx: 2, dy: 0, eos: false),
        ]
        let strokes = offsetsToLine(offsets)
        #expect(strokes == [
            InkStroke(points: [SIMD2(1, -1), SIMD2(2, 0)]),
            InkStroke(points: [SIMD2(4, 0)]),
        ])
        #expect(lineBounds(strokes) == Bounds(minX: 1, minY: -1, maxX: 4, maxY: 0))
    }

    @Test func emptyLineHasNoBounds() {
        #expect(offsetsToLine([]).isEmpty)
        #expect(lineBounds([]) == nil)
    }
}
