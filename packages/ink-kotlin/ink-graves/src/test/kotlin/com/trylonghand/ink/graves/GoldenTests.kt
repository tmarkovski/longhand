/// Golden parity with the MLX reference, ported from
/// packages/ink-graves/test/golden.test.ts: teacher-force the recorded
/// inputs through the cell and compare every attention and MDN output per
/// timestep against the recorded MLX values.

package com.trylonghand.ink.graves

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

private const val ATOL = 2e-3
private const val RTOL = 2e-2

class GoldenTests {
    @Test
    fun parsesTheBundledWeightsContainer() {
        val assets = Fixtures.assets
        assertEquals(Cell.alphabetSize, assets.alphabet.size)
        // maxCharLen is the training-time text limit (75), unrelated to the
        // cell's 120-slot phi buffer.
        assertTrue(assets.maxCharLen > 0)
        assertTrue(assets.styles.isNotEmpty())
        val lstm1 = assets.tensors["lstm1_kernel"] ?: fail("missing lstm1_kernel")
        assertEquals(listOf(476, 1600), lstm1.shape)
        assertEquals(476 * 1600, lstm1.data.size)
        // The v2 container carries a baked primed state per style:
        // h1 c1 h2 c2 h3 c3 kappa w.
        val primedLength = 6 * Cell.hidden + Cell.attentionMixtures + Cell.alphabetSize
        for (style in assets.styles) {
            val name = style.primed ?: fail("style ${style.id} carries no primed tensor")
            val primed = assets.tensors[name] ?: fail("missing tensor $name")
            assertEquals(primedLength, primed.data.size)
        }
    }

    @Test
    fun matchesGoldenWithinToleranceUnprimed() {
        matchesGoldenWithinTolerance("unprimed-bias075")
    }

    @Test
    fun matchesGoldenWithinTolerancePrimed() {
        matchesGoldenWithinTolerance("primed9-bias10")
    }

    private fun matchesGoldenWithinTolerance(name: String) {
        // The f32 fixture, not the shipped q8 asset: quantization noise is
        // far outside the porting tolerances these goldens pin.
        val assets = Fixtures.referenceAssets
        val golden = loadGolden(name)
        val model = GravesModel(assets)
        assertContentEquals(golden.encoded, model.encode(golden.charsText))

        val cell = Cell(assets)
        val state = cell.initialState()
        val params = cell.newMdnParams()
        val chars = IntArray(Cell.maxChars)
        golden.encoded.copyInto(chars)

        val failures = mutableListOf<String>()
        var argmaxMismatches = 0

        for ((t, expected) in golden.steps.withIndex()) {
            val input = golden.inputs[t]
            cell.step(state, dx = input[0], dy = input[1], eos = input[2], chars = chars, charLength = golden.charLen)
            cell.mdnParse(h3 = state.h3, bias = golden.bias, out = params)

            val checks: List<Triple<String, FloatArray, FloatArray>> = listOf(
                Triple("kappa", state.kappa, expected.kappa),
                Triple("phi", state.phi, expected.phi),
                Triple("window", state.w, expected.window),
                Triple("pi", params.pi, expected.pi),
                Triple("muX", params.muX, expected.muX),
                Triple("muY", params.muY, expected.muY),
                Triple("sigmaX", params.sigmaX, expected.sigmaX),
                Triple("sigmaY", params.sigmaY, expected.sigmaY),
                Triple("rho", params.rho, expected.rho),
                Triple("eos", floatArrayOf(params.eos), floatArrayOf(expected.eos)),
            )
            for ((label, actual, want) in checks) {
                val worst = worstDeviation(actual, want, atol = ATOL, rtol = RTOL)
                if (worst.score > 1) {
                    failures.add(
                        "step $t $label[${worst.index}]: got ${worst.actual}, " +
                            "want ${worst.expected} (score ${"%.2f".format(worst.score)})"
                    )
                }
            }

            var argmax = 0
            for (u in 1 until Cell.maxChars) {
                if (state.phi[u] > state.phi[argmax]) argmax = u
            }
            if (argmax != expected.phiArgmax) argmaxMismatches += 1
        }

        assertTrue(
            failures.isEmpty(),
            "${failures.size} deviations: ${failures.take(10).joinToString("; ")}",
        )
        assertTrue(argmaxMismatches <= 1)
    }
}
