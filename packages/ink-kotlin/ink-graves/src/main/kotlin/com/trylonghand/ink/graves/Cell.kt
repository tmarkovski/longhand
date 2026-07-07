/// The Graves handwriting cell: 3 stacked LSTMs + Gaussian window attention
/// + mixture density head. A line-by-line port of the TS engine
/// (packages/ink-graves/src/cell.ts), which is itself a port of the MLX
/// reference; concat row orders must match the saved kernel layouts exactly:
///
///   lstm1 rows:     [w_prev(73), x(3), h1_prev(400)]          -> (476, 1600)
///   attention rows: [w_prev(73), x(3), h1(400)]               -> (476, 30)
///   lstm2 rows:     [x(3), h1(400), w(73), h2_prev(400)]      -> (876, 1600)
///   lstm3 rows:     [x(3), h2(400), w(73), h3_prev(400)]      -> (876, 1600)
///   gmm rows:       [h3(400)]                                 -> (400, 121)
///
/// Everything is batch-size 1 and allocation-free per step. The matrix-vector
/// products are plain Kotlin loops (the JIT vectorizes the saxpy inner loop);
/// the nonlinear tails run in Double like the JS engine's number math.

package com.trylonghand.ink.graves

import com.trylonghand.ink.core.Rng
import com.trylonghand.ink.core.StrokeOffset
import kotlin.math.exp
import kotlin.math.ln1p
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlin.math.tanh

internal const val HIDDEN: Int = 400
internal const val ATTENTION_MIXTURES: Int = 10
internal const val OUTPUT_MIXTURES: Int = 20
internal const val ALPHABET_SIZE: Int = 73
internal const val MAX_CHARS: Int = 120

private const val GATES: Int = 4 * HIDDEN
private const val EPSILON: Double = 1e-8
private const val SIGMA_FLOOR: Double = 1e-4

public class CellState internal constructor() {
    public var h1: FloatArray = FloatArray(HIDDEN)
    public var c1: FloatArray = FloatArray(HIDDEN)
    public var h2: FloatArray = FloatArray(HIDDEN)
    public var c2: FloatArray = FloatArray(HIDDEN)
    public var h3: FloatArray = FloatArray(HIDDEN)
    public var c3: FloatArray = FloatArray(HIDDEN)
    public var kappa: FloatArray = FloatArray(ATTENTION_MIXTURES)
    public var w: FloatArray = FloatArray(ALPHABET_SIZE)
    public var phi: FloatArray = FloatArray(MAX_CHARS)
}

public class MdnParams internal constructor() {
    public var pi: FloatArray = FloatArray(OUTPUT_MIXTURES)
    public var muX: FloatArray = FloatArray(OUTPUT_MIXTURES)
    public var muY: FloatArray = FloatArray(OUTPUT_MIXTURES)
    public var sigmaX: FloatArray = FloatArray(OUTPUT_MIXTURES)
    public var sigmaY: FloatArray = FloatArray(OUTPUT_MIXTURES)
    public var rho: FloatArray = FloatArray(OUTPUT_MIXTURES)
    public var eos: Float = 0f
}

private fun sigmoid(v: Double): Double = 1 / (1 + exp(-v))

private fun softplus(v: Double): Double = if (v > 30) v else ln1p(exp(v))

/// y[0 until nOut] += x @ kernel[rowOffset until rowOffset + x.size], kernel
/// row-major (rows, nOut).
private fun accumulate(
    y: FloatArray,
    kernel: FloatArray,
    rowOffset: Int,
    nOut: Int,
    x: FloatArray,
) {
    for (i in x.indices) {
        val xi = x[i]
        if (xi == 0f) continue
        val base = (rowOffset + i) * nOut
        for (j in 0 until nOut) y[j] += kernel[base + j] * xi
    }
}

private fun load(destination: FloatArray, source: FloatArray) {
    source.copyInto(destination)
}

public class Cell(assets: ModelAssets) {
    public companion object {
        public const val hidden: Int = HIDDEN
        public const val attentionMixtures: Int = ATTENTION_MIXTURES
        public const val outputMixtures: Int = OUTPUT_MIXTURES
        public const val alphabetSize: Int = ALPHABET_SIZE
        public const val maxChars: Int = MAX_CHARS
    }

    private val k1: FloatArray
    private val b1: FloatArray
    private val k2: FloatArray
    private val b2: FloatArray
    private val k3: FloatArray
    private val b3: FloatArray
    private val kAtt: FloatArray
    private val bAtt: FloatArray
    private val kGmm: FloatArray
    private val bGmm: FloatArray

    // Per-step scratch, reused across calls.
    private val gates = FloatArray(GATES)
    private val attRaw = FloatArray(3 * ATTENTION_MIXTURES)
    private val gmmRaw = FloatArray(6 * OUTPUT_MIXTURES + 1)
    private val windowScratch = FloatArray(ALPHABET_SIZE)
    private val inputScratch = FloatArray(3)

    init {
        fun tensor(name: String): FloatArray =
            assets.tensors[name]?.data ?: throw CALWError.MissingTensor(name)
        k1 = tensor("lstm1_kernel")
        b1 = tensor("lstm1_bias")
        k2 = tensor("lstm2_kernel")
        b2 = tensor("lstm2_bias")
        k3 = tensor("lstm3_kernel")
        b3 = tensor("lstm3_bias")
        kAtt = tensor("attention_weights")
        bAtt = tensor("attention_biases")
        kGmm = tensor("gmm_weights")
        bGmm = tensor("gmm_biases")
    }

    public fun initialState(): CellState = CellState()

    public fun newMdnParams(): MdnParams = MdnParams()

    /// In-place LSTM update from the fused gate buffer, TF gate order (i, j, f, o).
    private fun applyLstm(hidden: FloatArray, cell: FloatArray) {
        for (m in 0 until HIDDEN) {
            val inputGate = sigmoid(gates[m].toDouble())
            val candidate = tanh(gates[HIDDEN + m].toDouble())
            val forgetGate = sigmoid(gates[2 * HIDDEN + m].toDouble())
            val outputGate = sigmoid(gates[3 * HIDDEN + m].toDouble())
            val newCell = forgetGate * cell[m].toDouble() + inputGate * candidate
            cell[m] = newCell.toFloat()
            hidden[m] = (outputGate * tanh(newCell)).toFloat()
        }
    }

    /**
     * One timestep. Mutates `state` in place. `chars` holds alphabet indices
     * (the encoded text, zero-padded to maxChars); `charLength` is the true
     * encoded length.
     */
    public fun step(
        state: CellState,
        dx: Float,
        dy: Float,
        eos: Float,
        chars: IntArray,
        charLength: Int,
    ) {
        inputScratch[0] = dx
        inputScratch[1] = dy
        inputScratch[2] = eos

        // LSTM 1: [w_prev, x, h1_prev]
        load(gates, b1)
        accumulate(gates, kernel = k1, rowOffset = 0, nOut = GATES, x = state.w)
        accumulate(gates, kernel = k1, rowOffset = ALPHABET_SIZE, nOut = GATES, x = inputScratch)
        accumulate(gates, kernel = k1, rowOffset = ALPHABET_SIZE + 3, nOut = GATES, x = state.h1)
        applyLstm(hidden = state.h1, cell = state.c1)

        // Attention: [w_prev, x, h1] -> softplus -> (alpha, beta, kappa step)
        load(attRaw, bAtt)
        accumulate(attRaw, kernel = kAtt, rowOffset = 0, nOut = 30, x = state.w)
        accumulate(attRaw, kernel = kAtt, rowOffset = ALPHABET_SIZE, nOut = 30, x = inputScratch)
        accumulate(attRaw, kernel = kAtt, rowOffset = ALPHABET_SIZE + 3, nOut = 30, x = state.h1)
        for (i in 0 until 30) attRaw[i] = softplus(attRaw[i].toDouble()).toFloat()
        for (k in 0 until ATTENTION_MIXTURES) {
            state.kappa[k] = (state.kappa[k].toDouble() + attRaw[20 + k].toDouble() / 25.0).toFloat()
            if (attRaw[10 + k] < 0.01f) attRaw[10 + k] = 0.01f // beta floor
        }
        for (u in 0 until MAX_CHARS) {
            var sum = 0.0
            for (k in 0 until ATTENTION_MIXTURES) {
                val diff = state.kappa[k].toDouble() - u
                sum += attRaw[k].toDouble() * exp(-(diff * diff) / attRaw[10 + k].toDouble())
            }
            state.phi[u] = sum.toFloat()
        }
        for (i in 0 until ALPHABET_SIZE) windowScratch[i] = 0f
        for (u in 0 until charLength) {
            windowScratch[chars[u]] += state.phi[u]
        }
        load(state.w, windowScratch)

        // LSTM 2: [x, h1, w, h2_prev]
        load(gates, b2)
        accumulate(gates, kernel = k2, rowOffset = 0, nOut = GATES, x = inputScratch)
        accumulate(gates, kernel = k2, rowOffset = 3, nOut = GATES, x = state.h1)
        accumulate(gates, kernel = k2, rowOffset = 3 + HIDDEN, nOut = GATES, x = state.w)
        accumulate(gates, kernel = k2, rowOffset = 3 + HIDDEN + ALPHABET_SIZE, nOut = GATES, x = state.h2)
        applyLstm(hidden = state.h2, cell = state.c2)

        // LSTM 3: [x, h2, w, h3_prev]
        load(gates, b3)
        accumulate(gates, kernel = k3, rowOffset = 0, nOut = GATES, x = inputScratch)
        accumulate(gates, kernel = k3, rowOffset = 3, nOut = GATES, x = state.h2)
        accumulate(gates, kernel = k3, rowOffset = 3 + HIDDEN, nOut = GATES, x = state.w)
        accumulate(gates, kernel = k3, rowOffset = 3 + HIDDEN + ALPHABET_SIZE, nOut = GATES, x = state.h3)
        applyLstm(hidden = state.h3, cell = state.c3)
    }

    /**
     * MDN head with the Graves bias (sharpness) trick. Matches the reference:
     * pi logits scaled by (1 + bias), log-sigmas shifted down by bias, then
     * pi and eos snapped to zero below 0.01 (pi is NOT renormalized).
     */
    public fun mdnParse(h3: FloatArray, bias: Double, out: MdnParams) {
        load(gmmRaw, bGmm)
        accumulate(gmmRaw, kernel = kGmm, rowOffset = 0, nOut = 6 * OUTPUT_MIXTURES + 1, x = h3)
        val raw = gmmRaw

        val M = OUTPUT_MIXTURES
        var maxLogit = Double.NEGATIVE_INFINITY
        for (m in 0 until M) {
            val logit = raw[m].toDouble() * (1 + bias)
            out.pi[m] = logit.toFloat()
            if (logit > maxLogit) maxLogit = logit
        }
        var total = 0.0
        for (m in 0 until M) {
            val value = exp(out.pi[m].toDouble() - maxLogit)
            out.pi[m] = value.toFloat()
            total += value
        }
        for (m in 0 until M) {
            val p = out.pi[m].toDouble() / total
            out.pi[m] = if (p < 0.01) 0f else p.toFloat()
            out.sigmaX[m] = max(exp(raw[M + m].toDouble() - bias), SIGMA_FLOOR).toFloat()
            out.sigmaY[m] = max(exp(raw[2 * M + m].toDouble() - bias), SIGMA_FLOOR).toFloat()
            val tanhRho = tanh(raw[3 * M + m].toDouble())
            out.rho[m] = min(max(tanhRho, EPSILON - 1), 1 - EPSILON).toFloat()
            out.muX[m] = raw[4 * M + m]
            out.muY[m] = raw[5 * M + m]
        }
        val eosProbability = min(max(sigmoid(raw[6 * M].toDouble()), EPSILON), 1 - EPSILON)
        out.eos = if (eosProbability < 0.01) 0f else eosProbability.toFloat()
    }

    /** Draw one (Δx, Δy, eos) from parsed MDN params. */
    public fun mdnSample(params: MdnParams, rng: Rng): StrokeOffset {
        val component = rng.categorical(params.pi)
        val z1 = rng.normal()
        val z2 = rng.normal()
        val rho = params.rho[component].toDouble()
        val dx = params.muX[component].toDouble() + params.sigmaX[component].toDouble() * z1
        val dy = params.muY[component].toDouble() +
            params.sigmaY[component].toDouble() * (rho * z1 + sqrt(max(1 - rho * rho, 0.0)) * z2)
        val eos = rng.uniform() < params.eos.toDouble()
        return StrokeOffset(dx = dx, dy = dy, eos = eos)
    }
}
