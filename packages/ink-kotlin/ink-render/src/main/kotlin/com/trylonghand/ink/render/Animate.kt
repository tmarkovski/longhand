/// Self-contained animated SVG, ported from
/// packages/ink-render/src/animate.ts: the line draws itself in pen time,
/// holds, and loops. Pure SMIL — no scripts — so the file animates
/// anywhere an SVG renders live (inline, <img>, README embeds).
///
/// Points are one model timestep apart, so a point's global index *is* its
/// pen time; every element animates over one shared cycle with keyTimes
/// marking its window.
///
/// The pen look reveals its constant-width runs directly with the classic
/// stroke-dashoffset trick (touchdown dots pop in via discrete opacity).
/// The ribbon look is filled outlines, which dashes can't reveal, so each
/// stroke hides behind a mask whose white stroke traces the centerline —
/// sized from the ribbon's real extent — and the mask's dash animates.

package com.trylonghand.ink.render

import com.trylonghand.ink.core.InkStroke
import java.util.Locale
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

public data class AnimatedSvgOptions(
    var line: LineSvgOptions,
    /** Milliseconds of animation per model timestep (pen pace). */
    var msPerStep: Double,
    /** Beat before the pen touches down. */
    var leadMs: Double = 350.0,
    /** Hold on the finished line before looping. */
    var holdMs: Double = 1600.0,
    /** Loop forever (default) or play once and freeze. */
    var loop: Boolean = true,
)

/// toFixed(1)-style rounding with trailing-zero stripping ("3", "2.5").
private fun fmt(value: Double): String {
    val text = String.format(Locale.ROOT, "%.1f", value)
    return if (text.endsWith(".0")) text.dropLast(2) else text
}

/// toFixed(5)-style rounding with trailing-zero stripping ("0.00001").
private fun fmtTime(value: Double): String {
    var text = String.format(Locale.ROOT, "%.5f", value)
    while (text.endsWith("0")) text = text.dropLast(1)
    if (text.endsWith(".")) text = text.dropLast(1)
    return text
}

public fun lineToAnimatedSvg(strokes: List<InkStroke>, options: AnimatedSvgOptions): String {
    val lineOptions = options.line
    val layout = layoutLine(strokes, scale = lineOptions.scale, padding = lineOptions.padding)

    val totalPoints = layout.placed.fold(0) { acc, stroke -> acc + stroke.points.size }
    val cycleMs = options.leadMs + totalPoints * options.msPerStep + options.holdMs
    // A keyTime per point, clamped off the exact endpoints so every list
    // can start at 0 and end at 1.
    fun timeOf(index: Int): Double =
        min(max((options.leadMs + index * options.msPerStep) / cycleMs, 0.00001), 0.99999)
    val timing = if (options.loop) "repeatCount=\"indefinite\"" else "repeatCount=\"1\" fill=\"freeze\""

    fun animateOffset(values: List<Double>, keyTimes: List<Double>): String =
        "<animate attributeName=\"stroke-dashoffset\" dur=\"${fmt(cycleMs)}ms\" $timing " +
            "values=\"${values.joinToString(";") { fmt(it) }}\" " +
            "keyTimes=\"${keyTimes.joinToString(";") { fmtTime(it) }}\"/>"

    val ribbon = lineOptions.renderer == InkRenderer.ribbon
    val parts = if (ribbon) {
        ribbonAnimatedParts(
            layout, scale = lineOptions.scale, ribbonWidth = lineOptions.ribbonWidth,
            timeOf = ::timeOf, animateOffset = ::animateOffset,
        )
    } else {
        penAnimatedParts(
            layout.placed, pen = lineOptions.pen, widthStep = lineOptions.widthStep,
            ink = lineOptions.ink, cycleMs = cycleMs, timing = timing,
            timeOf = ::timeOf, animateOffset = ::animateOffset,
        )
    }

    val paint = if (ribbon) {
        "fill=\"${lineOptions.ink}\" stroke=\"none\""
    } else {
        "fill=\"none\" stroke=\"${lineOptions.ink}\" stroke-linecap=\"round\" stroke-linejoin=\"round\""
    }
    val backdrop = lineOptions.background?.let {
        "<rect width=\"100%\" height=\"100%\" fill=\"$it\"/>\n"
    } ?: ""

    return "<svg xmlns=\"http://www.w3.org/2000/svg\" " +
        "viewBox=\"0 0 ${String.format(Locale.ROOT, "%.1f", layout.width)} " +
        "${String.format(Locale.ROOT, "%.1f", layout.height)}\" " +
        "$paint role=\"img\">\n" +
        backdrop +
        parts.joinToString("\n") +
        "\n</svg>\n"
}

private fun penAnimatedParts(
    placed: List<InkStroke>,
    pen: PenWidthOptions,
    widthStep: Double,
    ink: String,
    cycleMs: Double,
    timing: String,
    timeOf: (Int) -> Double,
    animateOffset: (List<Double>, List<Double>) -> String,
): List<String> {
    val parts = mutableListOf<String>()
    for (stroke in penStrokes(placed, pen = pen, widthStep = widthStep)) {
        val (x, y, r, index) = stroke.touchdown
        parts.add(
            "<circle cx=\"${fmt(x)}\" cy=\"${fmt(y)}\" r=\"${String.format(Locale.ROOT, "%.2f", r)}\" " +
                "fill=\"$ink\" stroke=\"none\" opacity=\"0\">" +
                "<animate attributeName=\"opacity\" dur=\"${fmt(cycleMs)}ms\" $timing calcMode=\"discrete\" " +
                "values=\"0;1;1\" keyTimes=\"0;${fmtTime(timeOf(index))};1\"/></circle>"
        )
        for (run in stroke.runs) {
            // Dash slack over the measured length hides coordinate-rounding
            // drift; the offset animates to exactly 0, so the run still
            // reveals in full.
            val dash = run.length * 1.02 + 0.5
            val d = run.points.joinToString(" L ") { "${fmt(it.x)} ${fmt(it.y)}" }
            parts.add(
                "<path d=\"M $d\" stroke-width=\"${String.format(Locale.ROOT, "%.2f", run.width)}\" " +
                    "stroke-dasharray=\"${fmt(dash)}\" stroke-dashoffset=\"${fmt(dash)}\">" +
                    animateOffset(
                        listOf(dash, dash, 0.0, 0.0),
                        listOf(0.0, timeOf(run.startIndex), timeOf(run.endIndex), 1.0),
                    ) +
                    "</path>"
            )
        }
    }
    return parts
}

private fun ribbonAnimatedParts(
    layout: LineLayout,
    scale: Double,
    ribbonWidth: Double,
    timeOf: (Int) -> Double,
    animateOffset: (List<Double>, List<Double>) -> String,
): List<String> {
    val parts = mutableListOf<String>()
    var globalIndex = 0
    for ((strokeIndex, stroke) in layout.placed.withIndex()) {
        val points = stroke.points
        val startIndex = globalIndex
        globalIndex += points.size
        val d = ribbonPath(points, scale = scale, width = ribbonWidth) ?: continue
        val edges = ribbonOutline(points, scale = scale, width = ribbonWidth) ?: continue

        // The mask stroke must cover the ribbon wherever the pen has
        // passed: width from the ribbon's widest point (plus slack for the
        // outline's soft cubic overshoot), dash length from the centerline.
        var maskWidth = 0.0
        val cumulative = mutableListOf(0.0)
        for (i in 0 until points.size) {
            val across = edges.top[i] - edges.bottom[i]
            maskWidth = max(maskWidth, hypot(across.x, across.y))
            if (i > 0) {
                val segment = points[i] - points[i - 1]
                cumulative.add(cumulative[i - 1] + hypot(segment.x, segment.y))
            }
        }
        maskWidth = maskWidth * 1.3 + 2
        val length = cumulative[points.size - 1]
        val dash = length * 1.02 + maskWidth
        // Resting a full mask-width past "nothing revealed" keeps the dash
        // edge's round cap from peeking out before the stroke starts.
        val hidden = dash + maskWidth

        // Offset keyframes sampled along the stroke, so the reveal follows
        // the pen's real pace (slow in curves, quick on links between
        // letters).
        val step = max(2, Math.round(points.size / 32.0).toInt())
        val values = mutableListOf(hidden, hidden)
        val keyTimes = mutableListOf(0.0, timeOf(startIndex))
        var i = step
        while (i < points.size - 1) {
            values.add(dash - cumulative[i])
            keyTimes.add(timeOf(startIndex + i))
            i += step
        }
        values.addAll(listOf(dash - length, dash - length))
        keyTimes.addAll(listOf(timeOf(startIndex + points.size - 1), 1.0))

        val centerline = points.joinToString(" L ") { "${fmt(it.x)} ${fmt(it.y)}" }
        parts.add(
            "<mask id=\"reveal$strokeIndex\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" " +
                "width=\"${String.format(Locale.ROOT, "%.1f", layout.width)}\" " +
                "height=\"${String.format(Locale.ROOT, "%.1f", layout.height)}\">" +
                "<path d=\"M $centerline\" fill=\"none\" stroke=\"#fff\" stroke-width=\"${fmt(maskWidth)}\" " +
                "stroke-linecap=\"round\" stroke-linejoin=\"round\" " +
                "stroke-dasharray=\"${fmt(dash)}\" stroke-dashoffset=\"${fmt(hidden)}\">" +
                animateOffset(values, keyTimes) +
                "</path></mask>"
        )
        parts.add("<path d=\"$d\" mask=\"url(#reveal$strokeIndex)\"/>")
    }
    return parts
}
