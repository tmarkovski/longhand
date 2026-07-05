/// The stroke IR shared by engines and renderers, ported from
/// packages/ink-core/src/index.ts. Coordinates are screen-space (y grows
/// downward); points are one model timestep apart.

import Foundation

public struct InkStroke: Equatable, Sendable {
    /// Absolute (x, y) positions, one per model timestep.
    public var points: [SIMD2<Double>]

    public init(points: [SIMD2<Double>]) {
        self.points = points
    }
}

/// Fold raw (Δx, Δy, eos) offsets into absolute screen-space strokes.
/// The model's y grows upward, so it is flipped here. eos marks the last
/// point of a stroke; the next point begins a new one.
public func offsetsToLine(_ offsets: [StrokeOffset]) -> [InkStroke] {
    var strokes: [InkStroke] = []
    var points: [SIMD2<Double>] = []
    var x = 0.0
    var y = 0.0
    for offset in offsets {
        x += offset.dx
        y -= offset.dy
        points.append(SIMD2(x, y))
        if offset.eos {
            strokes.append(InkStroke(points: points))
            points = []
        }
    }
    if !points.isEmpty { strokes.append(InkStroke(points: points)) }
    return strokes
}

public struct Bounds: Equatable, Sendable {
    public let minX: Double
    public let minY: Double
    public let maxX: Double
    public let maxY: Double

    public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }

    public var width: Double { maxX - minX }
    public var height: Double { maxY - minY }
}

/// Bounding box of a line, or nil when it has no points.
public func lineBounds(_ strokes: [InkStroke]) -> Bounds? {
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    for stroke in strokes {
        for point in stroke.points {
            minX = min(minX, point.x)
            minY = min(minY, point.y)
            maxX = max(maxX, point.x)
            maxY = max(maxY, point.y)
        }
    }
    guard minX <= maxX else { return nil }
    return Bounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
}
