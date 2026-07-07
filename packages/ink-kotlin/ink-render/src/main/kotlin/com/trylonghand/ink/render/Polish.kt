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

package com.trylonghand.ink.render

import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.Vec2
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// Vec2 arithmetic mirroring Swift's SIMD2<Double>: element-wise add and
// subtract, scalar multiply.
internal operator fun Vec2.plus(other: Vec2): Vec2 = Vec2(x + other.x, y + other.y)
internal operator fun Vec2.minus(other: Vec2): Vec2 = Vec2(x - other.x, y - other.y)
internal operator fun Double.times(vector: Vec2): Vec2 = Vec2(this * vector.x, this * vector.y)

/// Savitzky-Golay smoothing kernel, window 7 / polyorder 3 (savgol_coeffs).
private val sgKernel: List<Double> = listOf(-2, 3, 6, 7, 6, 3, -2).map { it.toDouble() / 21 }
private const val sgHalf = 3

/// savgol_filter(values, 7, 3, mode="nearest") — edges clamp to endpoints.
private fun savgol(values: List<Double>): List<Double> {
    val n = values.size
    val out = MutableList(n) { 0.0 }
    for (i in 0 until n) {
        var sum = 0.0
        for (k in -sgHalf..sgHalf) {
            val j = min(max(i + k, 0), n - 1)
            sum += sgKernel[k + sgHalf] * values[j]
        }
        out[i] = sum
    }
    return out
}

/**
 * Smooth each stroke's x and y tracks independently. Removes the sampling
 * jitter that makes raw model output look shaky, while pen-up gaps stay
 * exactly where the model put them.
 */
public fun smoothLine(strokes: List<InkStroke>): List<InkStroke> =
    strokes.map { stroke ->
        val xs = savgol(stroke.points.map { it.x })
        val ys = savgol(stroke.points.map { it.y })
        InkStroke(points = (0 until xs.size).map { Vec2(xs[it], ys[it]) })
    }

/**
 * Level the baseline: least-squares fit of y over x across every point,
 * then rotate the whole line so the fitted slope becomes horizontal.
 * This is what removes the model's uphill/downhill drift. Matches the
 * reference `_align` exactly, including its scalar offset subtraction
 * (a translation later normalized away by layout).
 */
public fun alignLine(strokes: List<InkStroke>): List<InkStroke> {
    var n = 0.0
    var sx = 0.0
    var sy = 0.0
    var sxx = 0.0
    var sxy = 0.0
    for (stroke in strokes) {
        for (point in stroke.points) {
            n += 1
            sx += point.x
            sy += point.y
            sxx += point.x * point.x
            sxy += point.x * point.y
        }
    }
    val denom = n * sxx - sx * sx
    if (n < 2 || abs(denom) < 1e-9) return strokes
    val slope = (n * sxy - sx * sy) / denom
    val offset = (sy - slope * sx) / n
    val theta = atan(slope)
    val cosT = cos(theta)
    val sinT = sin(theta)
    return strokes.map { stroke ->
        InkStroke(points = stroke.points.map { point ->
            Vec2(
                point.x * cosT + point.y * sinT - offset,
                point.y * cosT - point.x * sinT - offset,
            )
        })
    }
}

/** Smoothing then alignment — the standard polish for a finished line. */
public fun polishLine(strokes: List<InkStroke>): List<InkStroke> =
    alignLine(smoothLine(strokes))

public data class PenWidthOptions(
    /** Nominal width at reference pen speed. */
    var base: Double = 2.0,
    /** Width floor (fast strokes). Defaults to 0.55 × base. */
    var min: Double? = null,
    /** Width ceiling (slow, deliberate strokes). Defaults to 1.45 × base. */
    var max: Double? = null,
    /**
     * Pen speed (units per timestep) that maps to `base` width. Defaults
     * to the line's median segment length, so width adapts to the writing
     * scale.
     */
    var refSpeed: Double? = null,
    /** EMA factor for speed smoothing, 0–1; higher follows speed faster. */
    var smoothing: Double = 0.35,
)

/**
 * Per-point pen widths from pen speed: ink runs thin where the pen moves
 * fast and pools where it slows, with a slight taper at stroke ends where
 * the pen lands and lifts. Points are one model timestep apart, so segment
 * length *is* speed. Returns one width per point, per stroke.
 */
public fun penWidths(strokes: List<InkStroke>, options: PenWidthOptions = PenWidthOptions()): List<List<Double>> {
    val base = options.base
    val minWidth = options.min ?: 0.55 * base
    val maxWidth = options.max ?: 1.45 * base
    val smoothing = options.smoothing

    val segmentLengths = mutableListOf<Double>()
    for (stroke in strokes) {
        for (i in 1 until max(stroke.points.size, 1)) {
            val delta = stroke.points[i] - stroke.points[i - 1]
            segmentLengths.add(hypot(delta.x, delta.y))
        }
    }
    var refSpeed = options.refSpeed ?: median(segmentLengths)
    if (refSpeed == 0.0) refSpeed = 1.0

    return strokes.map { stroke ->
        val count = stroke.points.size
        val widths = MutableList(count) { 0.0 }
        var ema = refSpeed
        for (i in 0 until count) {
            val prev = stroke.points[max(i - 1, 0)]
            val here = stroke.points[i]
            val speed = if (i == 0) refSpeed else hypot(here.x - prev.x, here.y - prev.y)
            ema = smoothing * speed + (1 - smoothing) * ema
            // Hyperbolic falloff: base at refSpeed, thicker when slower,
            // thinner when faster, clamped to keep the line readable at
            // the extremes.
            val width = base * ((1.5 * refSpeed) / (0.5 * refSpeed + ema))
            widths[i] = min(max(width, minWidth), maxWidth)
        }
        if (count >= 4) {
            widths[0] *= 0.7
            widths[1] *= 0.88
            widths[count - 2] *= 0.88
            widths[count - 1] *= 0.7
        }
        widths
    }
}

private fun median(values: List<Double>): Double {
    if (values.isEmpty()) return 0.0
    val sorted = values.sorted()
    val mid = sorted.size / 2
    return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2
}
