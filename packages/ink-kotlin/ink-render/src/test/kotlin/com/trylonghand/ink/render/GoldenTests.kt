/// Smoothing and alignment against the scipy/numpy goldens the TS package
/// uses — the same authority chain: reference draw.py -> scipy fixtures ->
/// each port.

package com.trylonghand.ink.render

import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.Vec2
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GoldenTests {
    @Test
    fun savgolMatchesScipyAtEveryStrokeLength() {
        val golden = loadScipyGolden()
        for (fixture in golden.savgol) {
            // x and -x through one stroke exercises both coordinate tracks.
            val line = listOf(InkStroke(points = fixture.input.map { Vec2(it, -it) }))
            val smoothed = smoothLine(line)[0].points
            assertEquals(fixture.expected.size, smoothed.size)
            for ((point, expected) in smoothed.zip(fixture.expected)) {
                assertTrue(abs(point.x - expected) < 1e-6)
                assertTrue(abs(point.y + expected) < 1e-6)
            }
        }
    }

    @Test
    fun alignMatchesTheReference() {
        val golden = loadScipyGolden()
        val aligned = alignLine(strokesOf(listOf(golden.align.input)))[0].points
        for ((point, expected) in aligned.zip(golden.align.expected)) {
            assertTrue(abs(point.x - expected[0]) < 1e-5)
            assertTrue(abs(point.y - expected[1]) < 1e-5)
        }
    }

    @Test
    fun smoothingPreservesStrokeStructure() {
        val line = listOf(
            InkStroke(points = (0 until 8).map { Vec2(it.toDouble(), (it % 2).toDouble()) }),
            InkStroke(points = listOf(Vec2(10.0, 10.0))),
        )
        val smoothed = smoothLine(line)
        assertEquals(2, smoothed.size)
        assertEquals(8, smoothed[0].points.size)
        assertEquals(1, smoothed[1].points.size)
    }

    @Test
    fun alignLeavesDegenerateLinesUntouched() {
        val dot = listOf(InkStroke(points = listOf(Vec2(5.0, 5.0))))
        assertEquals(dot, alignLine(dot))
        val vertical = listOf(InkStroke(points = listOf(Vec2(2.0, 0.0), Vec2(2.0, 10.0), Vec2(2.0, 20.0))))
        assertEquals(vertical, alignLine(vertical))
    }
}
