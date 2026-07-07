/// SVG serialization behavior, mirroring the TS package's tests: crop,
/// per-renderer markup shape, width quantization, and the animated
/// document's reveal structure.

package com.trylonghand.ink.render

import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.Vec2
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/// A wavy stroke plus a single-point stroke (a pen tap) — the same
/// fixture as the TS tests.
private val fixtureLine: List<InkStroke> = listOf(
    InkStroke(points = (0 until 12).map { Vec2(it * 2.0, (it % 3) - 1.0) }),
    InkStroke(points = listOf(Vec2(30.0, 0.0))),
)

private fun occurrences(needle: String, text: String): Int =
    text.split(needle).size - 1

class SvgTests {
    @Test
    fun cropsTheViewBoxToTheInkPlusPadding() {
        val svg = lineToSvg(fixtureLine, LineSvgOptions(renderer = InkRenderer.pen, scale = 2.0, padding = 5.0))
        // Ink spans x 0..30, y -1..1 → 30·2 + 2·5 by 2·2 + 2·5.
        assertTrue(svg.contains("viewBox=\"0 0 70.0 14.0\""))
    }

    @Test
    fun penDrawsQuantizedRunsAndTouchdownDots() {
        val svg = lineToSvg(fixtureLine, LineSvgOptions(renderer = InkRenderer.pen, scale = 2.0))
        assertTrue(svg.contains("fill=\"none\" stroke=\"currentColor\""))
        assertEquals(2, occurrences("<circle ", svg))
        val widths = Regex("stroke-width=\"([\\d.]+)\"")
            .findAll(svg)
            .mapNotNull { it.groupValues[1].toDoubleOrNull() }
            .toList()
        assertTrue(widths.isNotEmpty())
        // Every run width sits on the 0.2 quantization grid.
        for (width in widths) {
            assertTrue(abs((width * 10) % 2) < 1e-6)
        }
    }

    @Test
    fun ribbonFillsOneOutlinePerStrokeSkippingSinglePoints() {
        val svg = lineToSvg(fixtureLine, LineSvgOptions(renderer = InkRenderer.ribbon, scale = 2.0))
        assertTrue(svg.contains("fill=\"currentColor\" stroke=\"none\""))
        assertEquals(1, occurrences("<path ", svg))
        assertFalse(svg.contains("stroke-width"))
    }

    @Test
    fun animatedPenRevealsRunsWithSharedCycleTiming() {
        val options = AnimatedSvgOptions(
            line = LineSvgOptions(renderer = InkRenderer.pen, scale = 2.0),
            msPerStep = 8.0,
        )
        val svg = lineToAnimatedSvg(fixtureLine, options)
        // 13 points × 8ms + 350 lead + 1600 hold.
        assertTrue(svg.contains("dur=\"2054ms\""))
        assertTrue(svg.contains("repeatCount=\"indefinite\""))
        assertTrue(svg.contains("attributeName=\"stroke-dashoffset\""))
        // Touchdown dots pop in discretely.
        assertEquals(2, occurrences("calcMode=\"discrete\"", svg))
        // Every keyTimes list spans the full cycle.
        for (match in Regex("keyTimes=\"([^\"]*)\"").findAll(svg)) {
            val keyTimes = match.groupValues[1]
            assertTrue(keyTimes.startsWith("0;"))
            assertTrue(keyTimes.endsWith(";1"))
        }
    }

    @Test
    fun animatedRibbonMasksEachMultiPointStroke() {
        val options = AnimatedSvgOptions(
            line = LineSvgOptions(renderer = InkRenderer.ribbon, scale = 2.0),
            msPerStep = 8.0,
            loop = false,
        )
        val svg = lineToAnimatedSvg(fixtureLine, options)
        assertEquals(1, occurrences("<mask ", svg))
        assertTrue(svg.contains("mask=\"url(#reveal0)\""))
        assertTrue(svg.contains("repeatCount=\"1\" fill=\"freeze\""))
    }
}
