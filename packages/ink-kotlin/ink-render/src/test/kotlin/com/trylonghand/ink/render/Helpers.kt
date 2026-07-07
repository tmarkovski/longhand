/// Fixtures shared with the TS ink-render package: test/golden.json pins
/// smoothing/alignment to scipy/numpy, and test/goldens/swift-parity.json
/// (dumped by scripts/export_swift_goldens.ts) carries the TS package's
/// own geometry outputs over to this port.

package com.trylonghand.ink.render

import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.Vec2
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val repoRoot = File(System.getProperty("longhand.repoRoot"))

private val json = Json { ignoreUnknownKeys = true }

fun fixtureText(relativePath: String, hint: String): String {
    val file = repoRoot.resolve(relativePath)
    if (!file.exists()) error("missing ${file.path} — $hint")
    return file.readText()
}

@Serializable
data class ScipyGolden(
    val savgol: List<Savgol>,
    val align: Align,
) {
    @Serializable
    data class Savgol(val input: List<Double>, val expected: List<Double>)

    @Serializable
    data class Align(val input: List<List<Double>>, val expected: List<List<Double>>)
}

fun loadScipyGolden(): ScipyGolden = json.decodeFromString(
    fixtureText(
        "packages/ink-render/test/golden.json",
        hint = "committed with the TS ink-render package",
    )
)

@Serializable
data class RenderParity(
    val line: List<List<List<Double>>>,
    val polished: List<List<List<Double>>>,
    val penWidths: List<List<Double>>,
    val layout: Layout,
    val penRuns: List<StrokeParts>,
    val ribbons: List<Ribbon?>,
) {
    @Serializable
    data class Layout(
        val width: Double,
        val height: Double,
        val placed: List<List<List<Double>>>,
    )

    @Serializable
    data class Touchdown(
        val x: Double,
        val y: Double,
        val r: Double,
        val index: Int,
    )

    @Serializable
    data class Run(
        val width: Double,
        val startIndex: Int,
        val endIndex: Int,
        val length: Double,
        val pointCount: Int,
    )

    @Serializable
    data class StrokeParts(
        val touchdown: Touchdown,
        val runs: List<Run>,
    )

    @Serializable
    data class Ribbon(
        val top: List<List<Double>>,
        val bottom: List<List<Double>>,
    )
}

fun loadRenderParity(): RenderParity = json.decodeFromString(
    fixtureText(
        "packages/ink-render/test/goldens/swift-parity.json",
        hint = "run scripts/export_swift_goldens.ts in packages/ink-render",
    )
)

fun strokesOf(raw: List<List<List<Double>>>): List<InkStroke> =
    raw.map { stroke ->
        InkStroke(points = stroke.map { Vec2(it[0], it[1]) })
    }

/**
 * Worst absolute coordinate deviation between two lines (must have
 * identical structure; returns infinity on shape mismatch).
 */
fun worstDeviation(actual: List<InkStroke>, expected: List<List<List<Double>>>): Double {
    if (actual.size != expected.size) return Double.POSITIVE_INFINITY
    var worst = 0.0
    for ((stroke, expectedPoints) in actual.zip(expected)) {
        if (stroke.points.size != expectedPoints.size) return Double.POSITIVE_INFINITY
        for ((point, expectedPoint) in stroke.points.zip(expectedPoints)) {
            worst = max(worst, max(abs(point.x - expectedPoint[0]), abs(point.y - expectedPoint[1])))
        }
    }
    return worst
}
