/// High-level generation API over the Cell, mirroring the TS engine
/// (packages/ink-graves/src/engine.ts): optional style priming,
/// autoregressive sampling with bias sharpening, and attention-based
/// termination.

package com.trylonghand.ink.graves

import com.trylonghand.ink.core.Rng
import com.trylonghand.ink.core.StrokeOffset
import kotlin.math.max

public const val STEPS_PER_CHARACTER: Int = 40

public sealed class GravesError(message: String) : Exception(message) {
    public class UnknownStyle(style: Int) : GravesError("unknown style $style")
    public class StylePrimingUnavailable(style: Int) : GravesError("style $style carries no priming data")
    public class MissingStyleTensor(name: String) : GravesError("missing style tensor $name")
    public class PrimedStateLength(got: Int, expected: Int) :
        GravesError("primed state length $got, expected $expected")
    public class TextTooLong(encodedLength: Int, max: Int) :
        GravesError("encoded text length $encodedLength exceeds $max")
    public class MissingBundledWeights : GravesError("graves-v2.bin is missing from the package resources")
}

public class GravesModel(public val assets: ModelAssets) {
    private val cell: Cell = Cell(assets)
    private val charToIndex: Map<Char, Int>

    init {
        val map = HashMap<Char, Int>(assets.alphabet.size)
        for ((index, entry) in assets.alphabet.withIndex()) {
            if (entry.length == 1) map[entry[0]] = index
        }
        charToIndex = map
    }

    public val styles: List<Int>
        get() = assets.styles.map(StyleInfo::id)

    /** Encode text to alphabet indices with the trailing 0 terminator. */
    public fun encode(text: String): IntArray {
        val encoded = IntArray(text.length + 1)
        for (index in text.indices) {
            encoded[index] = charToIndex[text[index]] ?: 0
        }
        return encoded
    }

    /** Characters the model was trained on. Anything else must be substituted. */
    public fun supports(character: Char): Boolean = charToIndex.containsKey(character)

    public fun writer(
        text: String,
        bias: Double = 0.5,
        style: Int? = null,
        seed: UInt = 0u,
    ): GravesWriter = GravesWriter(model = this, cell = cell, text = text, bias = bias, style = style, seed = seed)

    /** Generate a full line synchronously. */
    public fun write(
        text: String,
        bias: Double = 0.5,
        style: Int? = null,
        seed: UInt = 0u,
    ): List<StrokeOffset> = writer(text, bias = bias, style = style, seed = seed).run()
}

public class GravesWriter internal constructor(
    model: GravesModel,
    private val cell: Cell,
    public val text: String,
    public val bias: Double,
    style: Int?,
    seed: UInt,
) {
    public var done: Boolean = false
        private set

    private val rng: Rng = Rng(seed)
    private val state: CellState = cell.initialState()
    private val chars: IntArray
    private val charLength: Int
    private val params: MdnParams = cell.newMdnParams()
    private var lastDx: Float = 0f
    private var lastDy: Float = 0f
    private var lastEos: Float = 1f

    init {
        val encoded: IntArray
        var primeStrokes: FloatArray? = null
        var primedState: FloatArray? = null
        if (style != null) {
            val styleInfo = model.assets.styles.firstOrNull { it.id == style }
                ?: throw GravesError.UnknownStyle(style)
            val tensorName = styleInfo.primed ?: styleInfo.tensor
                ?: throw GravesError.StylePrimingUnavailable(style)
            val tensor = model.assets.tensors[tensorName]
                ?: throw GravesError.MissingStyleTensor(tensorName)
            if (styleInfo.primed != null) primedState = tensor.data else primeStrokes = tensor.data
            encoded = model.encode(styleInfo.primer + " " + text)
        } else {
            encoded = model.encode(text)
        }
        if (encoded.size > Cell.maxChars) {
            throw GravesError.TextTooLong(encodedLength = encoded.size, max = Cell.maxChars)
        }
        val chars = IntArray(Cell.maxChars)
        encoded.copyInto(chars)
        this.chars = chars
        this.charLength = encoded.size

        if (primedState != null) {
            restore(primedState)
        } else if (primeStrokes != null) {
            prime(primeStrokes)
        }
    }

    /// Teacher-force the style's pen data through the cell (v1 containers),
    /// then hand off to free running.
    private fun prime(strokes: FloatArray) {
        val steps = strokes.size / 3
        for (t in 0 until steps) {
            cell.step(
                state,
                dx = strokes[3 * t],
                dy = strokes[3 * t + 1],
                eos = strokes[3 * t + 2],
                chars = chars,
                charLength = charLength,
            )
        }
        handoff()
    }

    /// Restore a baked primed state (v2 containers): the export pipeline
    /// already teacher-forced the style's strokes, so styled writes start
    /// instantly. Slice order must match STATE_LAYOUT in export_weights.py:
    /// h1 c1 h2 c2 h3 c3 kappa w.
    private fun restore(baked: FloatArray) {
        val slices = listOf(
            state::h1, state::c1, state::h2, state::c2, state::h3, state::c3, state::kappa, state::w,
        )
        val expected = slices.sumOf { it.get().size }
        if (baked.size != expected) {
            throw GravesError.PrimedStateLength(got = baked.size, expected = expected)
        }
        var offset = 0
        for (slice in slices) {
            val count = slice.get().size
            slice.set(baked.copyOfRange(offset, offset + count))
            offset += count
        }
        handoff()
    }

    /// Shared tail of both priming paths: draw the first free-run input
    /// from the primed state (it is consumed as input, never emitted —
    /// matching the reference).
    private fun handoff() {
        cell.mdnParse(h3 = state.h3, bias = bias, out = params)
        val sample = cell.mdnSample(params, rng)
        lastDx = sample.dx.toFloat()
        lastDy = sample.dy.toFloat()
        lastEos = if (sample.eos) 1f else 0f
    }

    /** Advance one timestep. Returns the sampled offset, or null once done. */
    public fun step(): StrokeOffset? {
        if (done) return null
        cell.step(state, dx = lastDx, dy = lastDy, eos = lastEos, chars = chars, charLength = charLength)
        cell.mdnParse(h3 = state.h3, bias = bias, out = params)
        val offset = cell.mdnSample(params, rng)
        lastDx = offset.dx.toFloat()
        lastDy = offset.dy.toFloat()
        lastEos = if (offset.eos) 1f else 0f

        // Termination mirrors Generator._flush: attention argmax past the end,
        // or on the final character while the pen lifts.
        var argmax = 0
        var best = state.phi[0]
        for (u in 1 until Cell.maxChars) {
            if (state.phi[u] > best) {
                best = state.phi[u]
                argmax = u
            }
        }
        val pastFinal = argmax >= charLength
        val finalWithEos = argmax >= charLength - 1 && offset.eos
        if (pastFinal || finalWithEos) done = true

        return offset
    }

    /**
     * Run to termination (or the step budget) and return all offsets.
     * The default budget floors at 4 characters — very short text often
     * needs more than its own step allowance to finish a stroke — and
     * matches the TS engine and the web app's worker, so a `write()`
     * reproduces an on-screen take exactly.
     */
    public fun run(maxSteps: Int? = null): List<StrokeOffset> {
        val limit = maxSteps ?: (STEPS_PER_CHARACTER * max(text.length, 4))
        val offsets = mutableListOf<StrokeOffset>()
        for (i in 0 until limit) {
            val offset = step() ?: break
            offsets.add(offset)
        }
        return offsets
    }
}
