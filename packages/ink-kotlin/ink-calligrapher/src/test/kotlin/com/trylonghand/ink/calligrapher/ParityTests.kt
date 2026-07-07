/// Stroke-stream parity with the TS engine (and through it, the vendored
/// calligrapher.ai reference): same seeds must produce the same number of
/// steps, identical pen bits, and near-identical coordinates. A divergent
/// mixture pick anywhere would desync the stream and fail loudly on count
/// or pen bits, so the tight coordinate tolerance only absorbs transcendental
/// rounding differences between JS and the JVM.

package com.trylonghand.ink.calligrapher

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ParityTests {
    @Test
    fun parsesTheSharedWeightsContainer() {
        val assets = Fixtures.assets
        assertEquals(80, assets.styleCount)
        assertEquals(listOf("l", "r", "w", "y"), assets.sparse.keys.sorted())
        assertEquals(listOf(80, 64), assets.dense["g"]?.shape)
    }

    @Test
    fun matchesTypeScriptStrokeStreams() {
        val model = CalligrapherModel(Fixtures.assets)
        for (parityCase in loadParityCases()) {
            val offsets = model.write(
                parityCase.text,
                bias = parityCase.bias,
                style = parityCase.style,
                seed = parityCase.seed,
            )
            assertEquals(
                parityCase.offsets.size, offsets.size,
                "${parityCase.text} seed ${parityCase.seed}: ${offsets.size} steps vs TS ${parityCase.offsets.size}",
            )
            if (offsets.size != parityCase.offsets.size) continue

            var worst = 0.0
            var penMismatches = 0
            for ((index, expected) in parityCase.offsets.withIndex()) {
                val actual = offsets[index]
                worst = maxOf(worst, abs(actual.dx - expected[0]), abs(actual.dy - expected[1]))
                if (actual.eos != (expected[2] == 1.0)) penMismatches += 1
            }
            assertEquals(0, penMismatches, "${parityCase.text}: $penMismatches pen-bit mismatches")
            assertTrue(worst < 1e-3, "${parityCase.text}: worst coordinate deviation $worst")
        }
    }
}
