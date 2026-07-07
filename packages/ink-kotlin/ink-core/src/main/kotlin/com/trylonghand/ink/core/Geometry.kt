/// The stroke IR shared by engines and renderers, ported from
/// packages/ink-core/src/index.ts. Coordinates are screen-space (y grows
/// downward); points are one model timestep apart.

package com.trylonghand.ink.core

public data class Vec2(val x: Double, val y: Double)

public data class InkStroke(
    /** Absolute (x, y) positions, one per model timestep. */
    val points: List<Vec2>,
)

/**
 * Fold raw (Δx, Δy, eos) offsets into absolute screen-space strokes.
 * The model's y grows upward, so it is flipped here. eos marks the last
 * point of a stroke; the next point begins a new one.
 */
public fun offsetsToLine(offsets: List<StrokeOffset>): List<InkStroke> {
    val strokes = mutableListOf<InkStroke>()
    var points = mutableListOf<Vec2>()
    var x = 0.0
    var y = 0.0
    for (offset in offsets) {
        x += offset.dx
        y -= offset.dy
        points.add(Vec2(x, y))
        if (offset.eos) {
            strokes.add(InkStroke(points))
            points = mutableListOf()
        }
    }
    if (points.isNotEmpty()) strokes.add(InkStroke(points))
    return strokes
}

/** Scale then translate every point (returns a new line). */
public fun transformLine(
    strokes: List<InkStroke>,
    scale: Double = 1.0,
    translateX: Double = 0.0,
    translateY: Double = 0.0,
): List<InkStroke> = strokes.map { stroke ->
    InkStroke(stroke.points.map { point ->
        Vec2(point.x * scale + translateX, point.y * scale + translateY)
    })
}

public data class Bounds(
    val minX: Double,
    val minY: Double,
    val maxX: Double,
    val maxY: Double,
) {
    val width: Double get() = maxX - minX
    val height: Double get() = maxY - minY
}

/** Bounding box of a line, or null when it has no points. */
public fun lineBounds(strokes: List<InkStroke>): Bounds? {
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    for (stroke in strokes) {
        for (point in stroke.points) {
            minX = minOf(minX, point.x)
            minY = minOf(minY, point.y)
            maxX = maxOf(maxX, point.x)
            maxY = maxOf(maxY, point.y)
        }
    }
    if (minX > maxX) return null
    return Bounds(minX = minX, minY = minY, maxX = maxX, maxY = maxY)
}
