/// Post-processing that turns raw model strokes into ink worth looking at,
/// ported from packages/ink-render/src/index.ts: per-stroke Savitzky-Golay
/// smoothing, least-squares baseline alignment, and speed-based pen widths.
/// Pure geometry over the InkCore IR — no UI framework, so canvases,
/// exporters, and scripts all share one pipeline.
///
/// `smoothLine` and `alignLine` port `_denoise` and `_align` from the
/// reference implementation (graves-handwriting-mlx `draw.py`) and are
/// golden-tested against scipy/numpy outputs (the same fixtures as the TS
/// package). Both are orientation-agnostic, so they work on screen-space
/// (y-down) lines as-is.

import Foundation
import InkCore

/// Savitzky-Golay smoothing kernel, window 7 / polyorder 3 (savgol_coeffs).
private let sgKernel: [Double] = [-2, 3, 6, 7, 6, 3, -2].map { Double($0) / 21 }
private let sgHalf = 3

/// savgol_filter(values, 7, 3, mode="nearest") — edges clamp to endpoints.
private func savgol(_ values: [Double]) -> [Double] {
    let n = values.count
    var out = [Double](repeating: 0, count: n)
    for i in 0 ..< n {
        var sum = 0.0
        for k in -sgHalf ... sgHalf {
            let j = min(max(i + k, 0), n - 1)
            sum += sgKernel[k + sgHalf] * values[j]
        }
        out[i] = sum
    }
    return out
}

/// Smooth each stroke's x and y tracks independently. Removes the sampling
/// jitter that makes raw model output look shaky, while pen-up gaps stay
/// exactly where the model put them.
public func smoothLine(_ strokes: [InkStroke]) -> [InkStroke] {
    strokes.map { stroke in
        let xs = savgol(stroke.points.map(\.x))
        let ys = savgol(stroke.points.map(\.y))
        return InkStroke(points: (0 ..< xs.count).map { SIMD2(xs[$0], ys[$0]) })
    }
}

/// Level the baseline: least-squares fit of y over x across every point,
/// then rotate the whole line so the fitted slope becomes horizontal.
/// This is what removes the model's uphill/downhill drift. Matches the
/// reference `_align` exactly, including its scalar offset subtraction
/// (a translation later normalized away by layout).
public func alignLine(_ strokes: [InkStroke]) -> [InkStroke] {
    var n = 0.0
    var sx = 0.0
    var sy = 0.0
    var sxx = 0.0
    var sxy = 0.0
    for stroke in strokes {
        for point in stroke.points {
            n += 1
            sx += point.x
            sy += point.y
            sxx += point.x * point.x
            sxy += point.x * point.y
        }
    }
    let denom = n * sxx - sx * sx
    if n < 2 || abs(denom) < 1e-9 { return strokes }
    let slope = (n * sxy - sx * sy) / denom
    let offset = (sy - slope * sx) / n
    let theta = atan(slope)
    let cosT = cos(theta)
    let sinT = sin(theta)
    return strokes.map { stroke in
        InkStroke(points: stroke.points.map { point in
            SIMD2(
                point.x * cosT + point.y * sinT - offset,
                point.y * cosT - point.x * sinT - offset
            )
        })
    }
}

/// Smoothing then alignment — the standard polish for a finished line.
public func polishLine(_ strokes: [InkStroke]) -> [InkStroke] {
    alignLine(smoothLine(strokes))
}

public struct PenWidthOptions: Sendable {
    /// Nominal width at reference pen speed.
    public var base: Double
    /// Width floor (fast strokes). Defaults to 0.55 × base.
    public var min: Double?
    /// Width ceiling (slow, deliberate strokes). Defaults to 1.45 × base.
    public var max: Double?
    /// Pen speed (units per timestep) that maps to `base` width. Defaults
    /// to the line's median segment length, so width adapts to the writing
    /// scale.
    public var refSpeed: Double?
    /// EMA factor for speed smoothing, 0–1; higher follows speed faster.
    public var smoothing: Double

    public init(
        base: Double = 2,
        min: Double? = nil,
        max: Double? = nil,
        refSpeed: Double? = nil,
        smoothing: Double = 0.35
    ) {
        self.base = base
        self.min = min
        self.max = max
        self.refSpeed = refSpeed
        self.smoothing = smoothing
    }
}

/// Per-point pen widths from pen speed: ink runs thin where the pen moves
/// fast and pools where it slows, with a slight taper at stroke ends where
/// the pen lands and lifts. Points are one model timestep apart, so segment
/// length *is* speed. Returns one width per point, per stroke.
public func penWidths(_ strokes: [InkStroke], options: PenWidthOptions = PenWidthOptions()) -> [[Double]] {
    let base = options.base
    let minWidth = options.min ?? 0.55 * base
    let maxWidth = options.max ?? 1.45 * base
    let smoothing = options.smoothing

    var segmentLengths: [Double] = []
    for stroke in strokes {
        for i in 1 ..< Swift.max(stroke.points.count, 1) {
            let delta = stroke.points[i] - stroke.points[i - 1]
            segmentLengths.append(hypot(delta.x, delta.y))
        }
    }
    var refSpeed = options.refSpeed ?? median(segmentLengths)
    if refSpeed == 0 { refSpeed = 1 }

    return strokes.map { stroke in
        let count = stroke.points.count
        var widths = [Double](repeating: 0, count: count)
        var ema = refSpeed
        for i in 0 ..< count {
            let prev = stroke.points[Swift.max(i - 1, 0)]
            let here = stroke.points[i]
            let speed = i == 0 ? refSpeed : hypot(here.x - prev.x, here.y - prev.y)
            ema = smoothing * speed + (1 - smoothing) * ema
            // Hyperbolic falloff: base at refSpeed, thicker when slower,
            // thinner when faster, clamped to keep the line readable at
            // the extremes.
            let width = base * ((1.5 * refSpeed) / (0.5 * refSpeed + ema))
            widths[i] = Swift.min(Swift.max(width, minWidth), maxWidth)
        }
        if count >= 4 {
            widths[0] *= 0.7
            widths[1] *= 0.88
            widths[count - 2] *= 0.88
            widths[count - 1] *= 0.7
        }
        return widths
    }
}

private func median(_ values: [Double]) -> Double {
    if values.isEmpty { return 0 }
    let sorted = values.sorted()
    let mid = sorted.count / 2
    return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
