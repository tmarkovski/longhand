/// Number-for-number parity with the TS ink-render package over a fixed
/// fixture line: polish, pen widths, layout, run bucketing, and ribbon
/// outlines. The math is a transliteration in double precision, so the
/// tight tolerance only absorbs libm differences between JS and the JVM.

package com.trylonghand.ink.render

import kotlin.math.abs
import kotlin.math.max
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val tolerance = 1e-8

class ParityTests {
    @Test
    fun polishedLineMatches() {
        val parity = loadRenderParity()
        val polished = polishLine(strokesOf(parity.line))
        assertTrue(worstDeviation(polished, parity.polished) < tolerance)
    }

    @Test
    fun penWidthsMatch() {
        val parity = loadRenderParity()
        val widths = penWidths(strokesOf(parity.line))
        assertEquals(parity.penWidths.size, widths.size)
        for ((actual, expected) in widths.zip(parity.penWidths)) {
            assertEquals(expected.size, actual.size)
            for ((a, e) in actual.zip(expected)) {
                assertTrue(abs(a - e) < tolerance)
            }
        }
    }

    @Test
    fun layoutMatches() {
        val parity = loadRenderParity()
        val layout = layoutLine(strokesOf(parity.line), scale = 3.0, padding = 6.0)
        assertTrue(abs(layout.width - parity.layout.width) < tolerance)
        assertTrue(abs(layout.height - parity.layout.height) < tolerance)
        assertTrue(worstDeviation(layout.placed, parity.layout.placed) < tolerance)
    }

    @Test
    fun penRunBucketingMatches() {
        val parity = loadRenderParity()
        val layout = layoutLine(strokesOf(parity.line), scale = 3.0, padding = 6.0)
        val strokes = penStrokes(layout.placed)
        assertEquals(parity.penRuns.size, strokes.size)
        for ((stroke, expected) in strokes.zip(parity.penRuns)) {
            assertTrue(abs(stroke.touchdown.x - expected.touchdown.x) < tolerance)
            assertTrue(abs(stroke.touchdown.y - expected.touchdown.y) < tolerance)
            assertTrue(abs(stroke.touchdown.r - expected.touchdown.r) < tolerance)
            assertEquals(expected.touchdown.index, stroke.touchdown.index)
            assertEquals(expected.runs.size, stroke.runs.size)
            for ((run, expectedRun) in stroke.runs.zip(expected.runs)) {
                assertTrue(abs(run.width - expectedRun.width) < tolerance)
                assertEquals(expectedRun.startIndex, run.startIndex)
                assertEquals(expectedRun.endIndex, run.endIndex)
                assertEquals(expectedRun.pointCount, run.points.size)
                assertTrue(abs(run.length - expectedRun.length) < tolerance)
            }
        }
    }

    @Test
    fun ribbonOutlinesMatch() {
        val parity = loadRenderParity()
        val layout = layoutLine(strokesOf(parity.line), scale = 3.0, padding = 6.0)
        assertEquals(parity.ribbons.size, layout.placed.size)
        for ((stroke, expected) in layout.placed.zip(parity.ribbons)) {
            val outline = ribbonOutline(stroke.points, scale = 3.0)
            if (expected == null) {
                assertNull(outline, "TS skipped this stroke; Kotlin must too")
                continue
            }
            val actual = assertNotNull(outline)
            var worst = 0.0
            for ((edge, expectedEdge) in listOf(actual.top to expected.top, actual.bottom to expected.bottom)) {
                assertEquals(expectedEdge.size, edge.size)
                for ((point, expectedPoint) in edge.zip(expectedEdge)) {
                    worst = max(worst, max(abs(point.x - expectedPoint[0]), abs(point.y - expectedPoint[1])))
                }
            }
            assertTrue(worst < tolerance)
        }
    }
}
