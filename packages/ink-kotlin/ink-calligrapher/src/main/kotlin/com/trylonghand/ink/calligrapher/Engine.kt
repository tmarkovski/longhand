/// Generation API over the calligrapher cell, ported from
/// packages/ink-calligrapher/src/engine.ts: encode [START, ...text, END],
/// condition on one of the 80 learned style vectors (or a seed-picked
/// random one), then autoregressively sample until the attention head
/// signals the text is exhausted or the step budget runs out. The
/// terminating step's sample is discarded, exactly like the reference.

package com.trylonghand.ink.calligrapher

import com.trylonghand.ink.core.Rng
import com.trylonghand.ink.core.StrokeOffset
import kotlin.math.floor

public sealed class CalligrapherError(message: String) : Exception(message) {
    public class MissingTensor(name: String) :
        CalligrapherError("missing tensor $name")

    public class MissingSparseTensor(name: String) :
        CalligrapherError("missing sparse tensor $name")

    public class UnknownStyle(style: Int) :
        CalligrapherError("unknown style $style")

    public class MissingBundledWeights :
        CalligrapherError("calligrapher-v1.bin is missing from the package resources")
}

public class CalligrapherModel(public val assets: CalligrapherAssets) {
    public companion object {
        public const val stepsPerCharacter: Int = 40

        /**
         * The model has 80 learned styles, but many are near-duplicates or
         * rough; calligrapher.ai's own picker exposes only these (plus random),
         * so ours does too. The engine itself accepts any id 0-79.
         */
        public val exposedStyles: List<Int> = listOf(1, 2, 3, 4, 5, 6, 7, 8, 9)
    }

    public val alphabet: List<Char> = calligrapherAlphabet
    private val cell: CalligrapherCell = CalligrapherCell(assets)

    public val styles: List<Int>
        get() = (0 until assets.styleCount).toList()

    /** Encode text to model ids, wrapped in start/end markers. */
    public fun encode(text: String): IntArray {
        val encoded = IntArray(text.length + 2)
        encoded[0] = START
        for ((index, character) in text.withIndex()) {
            encoded[index + 1] = charToId[character] ?: UNKNOWN
        }
        encoded[text.length + 1] = END
        return encoded
    }

    public fun supports(character: Char): Boolean = charToId[character] != null

    public fun writer(
        text: String,
        bias: Double = 0.75,
        style: Int? = null,
        seed: UInt = 0u,
    ): CalligrapherWriter = CalligrapherWriter(this, cell, text, bias, style, seed)

    /** Generate a full line synchronously. */
    public fun write(
        text: String,
        bias: Double = 0.75,
        style: Int? = null,
        seed: UInt = 0u,
    ): List<StrokeOffset> {
        val writer = writer(text, bias = bias, style = style, seed = seed)
        val offsets = mutableListOf<StrokeOffset>()
        while (true) {
            val offset = writer.step() ?: break
            offsets.add(offset)
        }
        return offsets
    }
}

public class CalligrapherWriter internal constructor(
    model: CalligrapherModel,
    private val cell: CalligrapherCell,
    public val text: String,
    public val bias: Double,
    style: Int?,
    seed: UInt,
) {
    public val style: Int

    public var done: Boolean = false
        private set

    private val rng: Rng
    private val state: CellState
    private val encoded: FloatArray
    private val charCount: Int
    private val maxSteps: Int
    private var steps: Int = 0

    init {
        // The reference picks a random style with one uniform draw before
        // anything else; matching that keeps null-style runs reproducible.
        val rng = Rng(seed)
        val chosen = style ?: floor(model.assets.styleCount.toDouble() * rng.uniform()).toInt()
        this.rng = rng
        if (chosen < 0 || chosen >= model.assets.styleCount) {
            throw CalligrapherError.UnknownStyle(chosen)
        }
        this.style = chosen

        val ids = model.encode(text)
        charCount = ids.size
        encoded = cell.encodeText(ids)
        state = cell.initialState(charCount = charCount, styleIndex = chosen)
        maxSteps = CalligrapherModel.stepsPerCharacter * text.length
    }

    /** Advance one timestep. Returns the sampled offset, or null once done. */
    public fun step(): StrokeOffset? {
        if (done) return null
        val termination = cell.step(state, encoded = encoded, charCount = charCount)
        val offset = cell.sample(state, bias = bias, rng = rng)
        steps += 1
        if (steps > maxSteps || termination > 0.5f) {
            done = true
            return null
        }
        val input = state.input
        input[0] = offset.dx
        input[1] = offset.dy
        input[2] = offset.pen
        return StrokeOffset(dx = offset.dx.toDouble(), dy = offset.dy.toDouble(), eos = offset.pen == 1f)
    }
}
