package com.trylonghand.ink.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GeometryTests {
    @Test
    fun foldsOffsetsIntoStrokesWithYFlip() {
        val offsets = listOf(
            StrokeOffset(dx = 1.0, dy = 1.0, eos = false),
            StrokeOffset(dx = 1.0, dy = -1.0, eos = true),
            StrokeOffset(dx = 2.0, dy = 0.0, eos = false),
        )
        val strokes = offsetsToLine(offsets)
        assertEquals(
            listOf(
                InkStroke(listOf(Vec2(1.0, -1.0), Vec2(2.0, 0.0))),
                InkStroke(listOf(Vec2(4.0, 0.0))),
            ),
            strokes,
        )
        assertEquals(Bounds(minX = 1.0, minY = -1.0, maxX = 4.0, maxY = 0.0), lineBounds(strokes))
    }

    @Test
    fun emptyLineHasNoBounds() {
        assertTrue(offsetsToLine(emptyList()).isEmpty())
        assertNull(lineBounds(emptyList()))
    }
}
