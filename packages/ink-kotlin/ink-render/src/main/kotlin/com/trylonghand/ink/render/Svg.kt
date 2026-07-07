/// Standalone SVG documents from ink lines, ported from
/// packages/ink-render/src/svg.ts. One entry point with a renderer switch
/// mirroring the app's pen/ribbon split: "pen" strokes polylines with
/// speed-based widths, "ribbon" fills the calligrapher's outline polygons
/// from `ribbonPath`.
///
/// Output is tightly cropped and, by default, transparent-background
/// `currentColor` ink so the consuming CSS picks the color (when the SVG
/// is inlined; inside an <img> it falls back to black). Exports pass
/// explicit `ink`/`background` so the file looks right anywhere.

package com.trylonghand.ink.render

import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.Vec2
import com.trylonghand.ink.core.lineBounds
import com.trylonghand.ink.core.transformLine
import java.util.Locale
import kotlin.math.hypot
import kotlin.math.max

/** Which ink look to draw; matches the engine's renderer in the app. */
public enum class InkRenderer {
    pen,
    ribbon,
}

public data class LineSvgOptions(
    var renderer: InkRenderer,
    /** Model-to-display scale applied while laying out the line. */
    var scale: Double,
    /** Whitespace around the ink, in display units. */
    var padding: Double = 6.0,
    /** Ink paint. `currentColor` inherits when inlined. */
    var ink: String = "currentColor",
    /** Background paint; null (transparent) by default. */
    var background: String? = null,
    /** Pen look: pen width options. */
    var pen: PenWidthOptions = PenWidthOptions(),
    /** Pen look: the run quantization step. */
    var widthStep: Double = defaultWidthStep,
    /** Ribbon look: nominal ribbon width. */
    var ribbonWidth: Double = ribbonWidthDefault,
)

/** A line laid out for serialization: placed ink plus the crop size. */
public data class LineLayout(
    val placed: List<InkStroke>,
    val width: Double,
    val height: Double,
)

/**
 * Lay the line out at `scale`, cropped to the ink plus `padding`.
 * An empty line collapses to a padding-sized empty layout.
 */
public fun layoutLine(strokes: List<InkStroke>, scale: Double, padding: Double): LineLayout {
    val bounds = lineBounds(strokes)
        ?: return LineLayout(placed = strokes, width = 2 * padding, height = 2 * padding)
    val placed = transformLine(
        strokes,
        scale = scale,
        translateX = padding - bounds.minX * scale,
        translateY = padding - bounds.minY * scale,
    )
    return LineLayout(
        placed = placed,
        width = bounds.width * scale + 2 * padding,
        height = bounds.height * scale + 2 * padding,
    )
}

// SVG can't vary width along one path, so pen segments are grouped into
// runs of similar width and each run becomes a path. Coarse enough to keep
// files small, fine enough that the steps are invisible at dropdown size.
public const val defaultWidthStep: Double = 0.2

/**
 * One constant-width polyline run, with the point-count timing an
 * animated serialization needs: global point indices are pen time.
 */
public data class PenRun(
    var points: List<Vec2>,
    var width: Double,
    /** Global index (across all strokes) of the run's first point. */
    var startIndex: Int,
    /** Global index of the run's last point. */
    var endIndex: Int,
    /** Geometric polyline length. */
    var length: Double,
)

/** A stroke rendered for SVG: a touchdown dot plus width-bucketed runs. */
public data class PenStrokeParts(
    var touchdown: Touchdown,
    var runs: List<PenRun>,
) {
    /** The touchdown dot (Swift models this as a labeled tuple). */
    public data class Touchdown(
        val x: Double,
        val y: Double,
        val r: Double,
        val index: Int,
    )
}

/**
 * Split each stroke into constant-width runs (shared by the static and
 * animated serializers).
 */
public fun penStrokes(
    placed: List<InkStroke>,
    pen: PenWidthOptions = PenWidthOptions(),
    widthStep: Double = defaultWidthStep,
): List<PenStrokeParts> {
    val widths = penWidths(placed, options = pen)

    var globalIndex = 0
    return placed.mapIndexed { strokeIndex, stroke ->
        val first = stroke.points[0]
        val runs = mutableListOf<PenRun>()
        var run = mutableListOf<Vec2>()
        var runWidth = 0.0
        var runStart = 0
        var runLength = 0.0
        fun flush(endIndex: Int) {
            if (run.size > 1) {
                runs.add(PenRun(
                    points = run,
                    width = runWidth,
                    startIndex = runStart,
                    endIndex = endIndex,
                    length = runLength,
                ))
            }
            run = mutableListOf()
            runLength = 0.0
        }
        for (i in 1 until stroke.points.size) {
            val here = stroke.points[i]
            val previous = stroke.points[i - 1]
            val segment = (widths[strokeIndex][i - 1] + widths[strokeIndex][i]) / 2
            val bucket = max(widthStep, Math.round(segment / widthStep) * widthStep)
            if (run.isEmpty() || bucket != runWidth) {
                flush(globalIndex + i - 1)
                run.add(previous)
                runWidth = bucket
                runStart = globalIndex + i - 1
            }
            run.add(here)
            runLength += hypot(here.x - previous.x, here.y - previous.y)
        }
        flush(globalIndex + stroke.points.size - 1)
        val parts = PenStrokeParts(
            touchdown = PenStrokeParts.Touchdown(
                x = first.x, y = first.y, r = widths[strokeIndex][0] / 2, index = globalIndex,
            ),
            runs = runs,
        )
        globalIndex += stroke.points.size
        parts
    }
}

/**
 * Serialize one line into a self-contained SVG document, laid out at
 * `scale` and cropped to the ink plus `padding`.
 */
public fun lineToSvg(strokes: List<InkStroke>, options: LineSvgOptions): String {
    val layout = layoutLine(strokes, scale = options.scale, padding = options.padding)

    val ribbon = options.renderer == InkRenderer.ribbon
    val parts = if (ribbon) {
        ribbonParts(layout.placed, scale = options.scale, width = options.ribbonWidth)
    } else {
        penPartStrings(
            penStrokes(layout.placed, pen = options.pen, widthStep = options.widthStep),
            ink = options.ink,
        )
    }
    // Ribbons are filled outlines; pen runs are stroked centerlines.
    val paint = if (ribbon) {
        "fill=\"${options.ink}\" stroke=\"none\""
    } else {
        "fill=\"none\" stroke=\"${options.ink}\" stroke-linecap=\"round\" stroke-linejoin=\"round\""
    }
    val backdrop = options.background?.let {
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

/// Static markup for pen strokes: a dot and a path per run.
private fun penPartStrings(strokes: List<PenStrokeParts>, ink: String): List<String> {
    val parts = mutableListOf<String>()
    for (stroke in strokes) {
        val (x, y, r, _) = stroke.touchdown
        parts.add(
            "<circle cx=\"${String.format(Locale.ROOT, "%.1f", x)}\" " +
                "cy=\"${String.format(Locale.ROOT, "%.1f", y)}\" " +
                "r=\"${String.format(Locale.ROOT, "%.2f", r)}\" fill=\"$ink\" stroke=\"none\"/>"
        )
        for (run in stroke.runs) {
            val d = run.points.joinToString(" L ") {
                "${String.format(Locale.ROOT, "%.1f", it.x)} ${String.format(Locale.ROOT, "%.1f", it.y)}"
            }
            parts.add("<path d=\"M $d\" stroke-width=\"${String.format(Locale.ROOT, "%.2f", run.width)}\"/>")
        }
    }
    return parts
}

/// One filled outline path per stroke; sub-two-point strokes draw nothing.
private fun ribbonParts(placed: List<InkStroke>, scale: Double, width: Double): List<String> {
    val parts = mutableListOf<String>()
    for (stroke in placed) {
        val d = ribbonPath(stroke.points, scale = scale, width = width)
        if (d != null) {
            parts.add("<path d=\"$d\"/>")
        }
    }
    return parts
}
