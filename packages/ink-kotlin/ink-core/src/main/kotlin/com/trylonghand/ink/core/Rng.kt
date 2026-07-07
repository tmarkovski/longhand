/// Deterministic RNG for sampling: sfc32 seeded via splitmix32, normal
/// deviates via Box-Muller. A port of packages/ink-graves/src/rng.ts; the
/// integer path is bit-identical (32-bit wrapping arithmetic, which Kotlin's
/// UInt operators give natively), so a seed consumes the uniform stream in
/// the same order as the web engine.

package com.trylonghand.ink.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.sin
import kotlin.math.sqrt

public class Rng(seed: UInt) {
    private var a: UInt = 0u
    private var b: UInt = 0u
    private var c: UInt = 0u
    private var d: UInt = 0u
    private var spare: Double? = null

    init {
        // splitmix32 to spread one 32-bit seed into four state words
        var s = seed
        fun split(): UInt {
            s += 0x9e37_79b9u
            var z = s
            z = (z xor (z shr 16)) * 0x21f0_aaadu
            z = (z xor (z shr 15)) * 0x735a_2d97u
            return z xor (z shr 15)
        }
        a = split()
        b = split()
        c = split()
        d = split()
        repeat(12) { uniform() }
    }

    /** Uniform in [0, 1). */
    public fun uniform(): Double {
        val t = a + b
        a = b xor (b shr 9)
        b = c + (c shl 3)
        c = (c shl 21) or (c shr 11)
        d += 1u
        val out = t + d
        c += out
        return out.toDouble() / 4294967296.0
    }

    /** Standard normal deviate. */
    public fun normal(): Double {
        spare?.let {
            spare = null
            return it
        }
        var u1 = uniform()
        while (u1 == 0.0) u1 = uniform()
        val u2 = uniform()
        val radius = sqrt(-2 * ln(u1))
        spare = radius * sin(2 * PI * u2)
        return radius * cos(2 * PI * u2)
    }

    /** Sample an index proportionally to non-negative weights. */
    public fun categorical(weights: FloatArray): Int {
        var total = 0.0
        for (weight in weights) total += weight.toDouble()
        var target = uniform() * total
        for (index in weights.indices) {
            target -= weights[index].toDouble()
            if (target < 0) return index
        }
        return weights.size - 1
    }
}
