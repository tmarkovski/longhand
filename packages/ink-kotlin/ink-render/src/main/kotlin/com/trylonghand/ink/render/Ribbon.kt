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
/// native path types (android.graphics.Path, java.awt.geom.Path2D).

package com.trylonghand.ink.render

import com.trylonghand.ink.core.Vec2
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** Reference default for its stroke-width slider. */
public const val ribbonWidthDefault: Double = 0.75

/// Per-point pen speeds: segment lengths smoothed over a ±2 window.
private fun smoothedSpeeds(points: List<Vec2>): List<Double> {
    val lengths = MutableList(points.size) { 0.0 }
    for (i in 0 until points.size) {
        val from = points[if (i == 0) 0 else i - 1]
        val to = points[if (i == 0) 1 else i]
        val delta = to - from
        lengths[i] = sqrt(delta.x * delta.x + delta.y * delta.y)
    }
    val smoothed = MutableList(lengths.size) { 0.0 }
    for (i in 0 until lengths.size) {
        val start = max(i - 2, 0)
        val end = min(i + 3, lengths.size)
        var sum = 0.0
        for (j in start until end) sum += lengths[j]
        smoothed[i] = sum / (end - start)
    }
    return smoothed
}

/** The ribbon's two edges, one point pair per input point. */
public data class RibbonOutline(
    var top: List<Vec2>,
    var bottom: List<Vec2>,
)

/**
 * Compute the ribbon's edge points for one stroke — the geometry behind
 * `ribbonPath`, exposed so exporters can measure the ribbon's extent
 * (e.g. to size a reveal mask). Returns null below two points.
 */
public fun ribbonOutline(
    points: List<Vec2>,
    scale: Double,
    width: Double = ribbonWidthDefault,
): RibbonOutline? {
    if (points.size < 2) return null
    val speeds = smoothedSpeeds(points)

    val top = ArrayList<Vec2>(points.size)
    val bottom = ArrayList<Vec2>(points.size)
    for (i in 0 until points.size) {
        val tangent: Vec2 = when (i) {
            0 -> points[1] - points[0]
            points.size - 1 -> points[i] - points[i - 1]
            else -> points[i + 1] - points[i - 1]
        }
        val norm = max(sqrt(tangent.x * tangent.x + tangent.y * tangent.y), 14.0)
        val speed = speeds[i] / scale
        val nx = (width * (-tangent.y / norm)) / speed
        val ny = (width * (tangent.x / norm)) / speed
        top.add(points[i] + Vec2(2 * nx, 2 * ny))
        bottom.add(points[i] - Vec2(2 * nx, 2 * ny))
    }
    return RibbonOutline(top = top, bottom = bottom)
}

/** One soft cubic segment of the closed ribbon outline. */
public data class RibbonSegment(
    val control1: Vec2,
    val control2: Vec2,
    val end: Vec2,
)

/**
 * The ribbon outline as closed cubic geometry (Swift returns this as a
 * labeled tuple): the outline's start point plus its cubic segments.
 */
public data class RibbonGeometry(
    val start: Vec2,
    val segments: List<RibbonSegment>,
)

/**
 * The ribbon outline as closed cubic geometry: top edge forward, bottom
 * edge back, one Catmull-Rom-flavored cubic per outline point (the last
 * segment returns to `start`).
 */
public fun ribbonSegments(outline: RibbonOutline): RibbonGeometry {
    val outlinePoints = outline.top + outline.bottom.reversed()
    val count = outlinePoints.size
    val segments = ArrayList<RibbonSegment>(count)
    for (i in 0 until count) {
        val before = outlinePoints[(i - 1 + count) % count]
        val here = outlinePoints[i]
        val next = outlinePoints[(i + 1) % count]
        val after = outlinePoints[(i + 2) % count]
        segments.add(RibbonSegment(
            control1 = here + 0.2 * (next - before),
            control2 = next - 0.2 * (after - here),
            end = next,
        ))
    }
    return RibbonGeometry(start = outlinePoints[0], segments = segments)
}

/**
 * Build the filled-outline SVG path for one stroke. Returns null for
 * strokes of fewer than two points (the reference draws nothing for
 * those).
 */
public fun ribbonPath(
    points: List<Vec2>,
    scale: Double,
    width: Double = ribbonWidthDefault,
): String? {
    val outline = ribbonOutline(points, scale = scale, width = width) ?: return null
    val (start, segments) = ribbonSegments(outline)

    fun fmt(value: Double): String = String.format(Locale.ROOT, "%.2f", value)
    val parts = mutableListOf("M ${fmt(start.x)},${fmt(start.y)}")
    for (segment in segments) {
        parts.add(
            "C ${fmt(segment.control1.x)} ${fmt(segment.control1.y)}, " +
                "${fmt(segment.control2.x)} ${fmt(segment.control2.y)}, " +
                "${fmt(segment.end.x)} ${fmt(segment.end.y)}"
        )
    }
    return parts.joinToString(" ")
}
