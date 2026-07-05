/// Ribbon rendering, the calligrapher engine's ink look, ported from
/// packages/ink-render/src/ribbon.ts (itself from the vendored
/// calligrapher.ai reference, functions `q` and `B`): each stroke becomes
/// one closed outline polygon whose half-width follows smoothed pen speed
/// (ink pools where the pen is slow), rounded with soft cubic segments,
/// and filled.
///
/// Input points are display-space (already laid out); `scale` is the
/// layout's model-to-display scale so the speed normalization matches the
/// reference regardless of canvas size. `ribbonPath` serializes to an SVG
/// path string; `ribbonSegments` exposes the same cubic geometry for
/// native path types (CGPath, SwiftUI Path).

import Foundation
import InkCore

/// Reference default for its stroke-width slider.
public let ribbonWidthDefault = 0.75

/// Per-point pen speeds: segment lengths smoothed over a ±2 window.
private func smoothedSpeeds(_ points: [SIMD2<Double>]) -> [Double] {
    var lengths = [Double](repeating: 0, count: points.count)
    for i in 0 ..< points.count {
        let from = points[i == 0 ? 0 : i - 1]
        let to = points[i == 0 ? 1 : i]
        let delta = to - from
        lengths[i] = (delta.x * delta.x + delta.y * delta.y).squareRoot()
    }
    var smoothed = [Double](repeating: 0, count: lengths.count)
    for i in 0 ..< lengths.count {
        let start = max(i - 2, 0)
        let end = min(i + 3, lengths.count)
        var sum = 0.0
        for j in start ..< end { sum += lengths[j] }
        smoothed[i] = sum / Double(end - start)
    }
    return smoothed
}

/// The ribbon's two edges, one point pair per input point.
public struct RibbonOutline: Sendable {
    public var top: [SIMD2<Double>]
    public var bottom: [SIMD2<Double>]
}

/// Compute the ribbon's edge points for one stroke — the geometry behind
/// `ribbonPath`, exposed so exporters can measure the ribbon's extent
/// (e.g. to size a reveal mask). Returns nil below two points.
public func ribbonOutline(
    _ points: [SIMD2<Double>],
    scale: Double,
    width: Double = ribbonWidthDefault
) -> RibbonOutline? {
    if points.count < 2 { return nil }
    let speeds = smoothedSpeeds(points)

    var top: [SIMD2<Double>] = []
    var bottom: [SIMD2<Double>] = []
    top.reserveCapacity(points.count)
    bottom.reserveCapacity(points.count)
    for i in 0 ..< points.count {
        let tangent: SIMD2<Double>
        if i == 0 {
            tangent = points[1] - points[0]
        } else if i == points.count - 1 {
            tangent = points[i] - points[i - 1]
        } else {
            tangent = points[i + 1] - points[i - 1]
        }
        let norm = max((tangent.x * tangent.x + tangent.y * tangent.y).squareRoot(), 14)
        let speed = speeds[i] / scale
        let nx = (width * (-tangent.y / norm)) / speed
        let ny = (width * (tangent.x / norm)) / speed
        top.append(points[i] + SIMD2(2 * nx, 2 * ny))
        bottom.append(points[i] - SIMD2(2 * nx, 2 * ny))
    }
    return RibbonOutline(top: top, bottom: bottom)
}

/// One soft cubic segment of the closed ribbon outline.
public struct RibbonSegment: Sendable {
    public let control1: SIMD2<Double>
    public let control2: SIMD2<Double>
    public let end: SIMD2<Double>
}

/// The ribbon outline as closed cubic geometry: top edge forward, bottom
/// edge back, one Catmull-Rom-flavored cubic per outline point (the last
/// segment returns to `start`).
public func ribbonSegments(_ outline: RibbonOutline) -> (start: SIMD2<Double>, segments: [RibbonSegment]) {
    let outlinePoints = outline.top + outline.bottom.reversed()
    let count = outlinePoints.count
    var segments: [RibbonSegment] = []
    segments.reserveCapacity(count)
    for i in 0 ..< count {
        let before = outlinePoints[(i - 1 + count) % count]
        let here = outlinePoints[i]
        let next = outlinePoints[(i + 1) % count]
        let after = outlinePoints[(i + 2) % count]
        segments.append(RibbonSegment(
            control1: here + 0.2 * (next - before),
            control2: next - 0.2 * (after - here),
            end: next
        ))
    }
    return (start: outlinePoints[0], segments: segments)
}

/// Build the filled-outline SVG path for one stroke. Returns nil for
/// strokes of fewer than two points (the reference draws nothing for
/// those).
public func ribbonPath(
    _ points: [SIMD2<Double>],
    scale: Double,
    width: Double = ribbonWidthDefault
) -> String? {
    guard let outline = ribbonOutline(points, scale: scale, width: width) else { return nil }
    let (start, segments) = ribbonSegments(outline)

    func fmt(_ value: Double) -> String { String(format: "%.2f", value) }
    var parts = ["M \(fmt(start.x)),\(fmt(start.y))"]
    for segment in segments {
        parts.append(
            "C \(fmt(segment.control1.x)) \(fmt(segment.control1.y)), " +
            "\(fmt(segment.control2.x)) \(fmt(segment.control2.y)), " +
            "\(fmt(segment.end.x)) \(fmt(segment.end.y))"
        )
    }
    return parts.joined(separator: " ")
}
