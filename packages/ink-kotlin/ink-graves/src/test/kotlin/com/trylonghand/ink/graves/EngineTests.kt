/// End-to-end engine behavior, ported from
/// packages/ink-graves/test/engine.test.ts.

package com.trylonghand.ink.graves

import kotlin.math.max
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class EngineTests {
    private val model = GravesModel(Fixtures.assets)

    @Test
    fun writesAnUnprimedLineAndTerminatesNaturally() {
        val offsets = model.write("hello world", bias = 0.75, seed = 42u)
        assertTrue(offsets.size > 100)
        assertTrue(offsets.size < 40 * "hello world".length)
        for (offset in offsets) {
            assertTrue(offset.dx.isFinite())
            assertTrue(offset.dy.isFinite())
        }
        // eos=1 marks the last point of a stroke; a legible line has several.
        val strokeCount = offsets.count { it.eos }
        assertTrue(strokeCount > 3)
    }

    @Test
    fun isDeterministicPerSeedAndVariesAcrossSeeds() {
        val first = model.write("hello", bias = 0.75, seed = 7u)
        val second = model.write("hello", bias = 0.75, seed = 7u)
        val different = model.write("hello", bias = 0.75, seed = 8u)
        assertEquals(first, second)
        assertNotEquals(first, different)
    }

    @Test
    fun writesWithStylePriming() {
        val offsets = model.write("hello", bias = 0.75, style = 9, seed = 42u)
        assertTrue(offsets.size > 40)
        assertTrue(offsets.all { it.dx.isFinite() && it.dy.isFinite() })
    }

    @Test
    fun rejectsUnknownStylesAndOverLongText() {
        assertFailsWith<GravesError> {
            model.writer("hi", style = 99)
        }
        assertFailsWith<GravesError> {
            model.writer("x".repeat(200))
        }
    }

    /**
     * Real-time streaming needs 125 steps/sec (the web app reveals one
     * step per 8ms). The graves cell's matrix loops are plain Kotlin, but
     * the JIT-compiled saxpy inner loop clears the bar comfortably.
     */
    @Test
    fun sustainsAtLeast125StepsPerSecond() {
        val writer = model.writer(
            "the quick brown fox jumps over the lazy dog then keeps on going",
            bias = 0.75,
            seed = 1u,
        )
        repeat(30) { writer.step() } // warmup
        var steps = 0
        val start = System.nanoTime()
        while (steps < 600 && writer.step() != null) steps += 1
        val elapsed = (System.nanoTime() - start) / 1e9
        val stepsPerSecond = steps / max(elapsed, 1e-9)
        println("engine speed: ${stepsPerSecond.toInt()} steps/sec over $steps steps")
        assertTrue(stepsPerSecond > 125)
    }
}
