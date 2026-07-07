/// End-to-end calligrapher engine behavior, mirroring the spirit of the
/// graves engine tests.

package com.trylonghand.ink.calligrapher

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class EngineTests {
    private val model = CalligrapherModel(Fixtures.assets)

    @Test
    fun writesALineAndTerminatesNaturally() {
        val offsets = model.write("hello world", seed = 42u)
        assertTrue(offsets.size > 50)
        assertTrue(offsets.size <= 40 * "hello world".length)
        assertTrue(offsets.all { it.dx.isFinite() && it.dy.isFinite() })
        assertTrue(offsets.count { it.eos } > 3)
    }

    @Test
    fun isDeterministicPerSeedIncludingRandomStyle() {
        // style null draws the style from the seed, so it must reproduce too.
        val first = model.write("hello", seed = 7u)
        val second = model.write("hello", seed = 7u)
        val different = model.write("hello", seed = 8u)
        assertEquals(first, second)
        assertNotEquals(first, different)
    }

    @Test
    fun encodesWithMarkersAndUnknownFallback() {
        assertContentEquals(intArrayOf(2, 30, 13, 3), model.encode("hi"))
        assertContentEquals(intArrayOf(2, 30, 1, 13, 3), model.encode("h~i"))
        assertTrue(model.supports('h'))
        assertFalse(model.supports('~'))
        assertEquals(80, model.styles.size)
    }

    @Test
    fun rejectsUnknownStyles() {
        assertFailsWith<CalligrapherError> {
            model.writer("hi", style = 99)
        }
    }

    /**
     * Real-time streaming needs 125 steps/sec (the web app reveals one
     * step per 8ms). The Swift port gates this in release builds only; on
     * the JVM the JIT-compiled test run is the release analog, so the gate
     * always runs here.
     */
    @Test
    fun sustainsAtLeast125StepsPerSecond() {
        val writer = model.writer(
            "the quick brown fox jumps over the lazy dog then keeps on going",
            bias = 0.75,
            style = 3,
            seed = 1u,
        )
        repeat(30) { writer.step() } // warmup
        var steps = 0
        val start = System.nanoTime()
        while (steps < 600 && writer.step() != null) steps += 1
        val elapsed = (System.nanoTime() - start) * 1e-9
        val stepsPerSecond = steps.toDouble() / maxOf(elapsed, 1e-9)
        println("engine speed: ${stepsPerSecond.toInt()} steps/sec over $steps steps")
        assertTrue(stepsPerSecond > 125)
    }
}
