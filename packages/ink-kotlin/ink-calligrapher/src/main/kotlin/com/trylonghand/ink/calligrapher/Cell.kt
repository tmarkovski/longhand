/// The calligrapher network, ported line-by-line from
/// packages/ink-calligrapher/src/cell.ts (itself a transliteration of the
/// vendored calligrapher.ai reference):
///
///   x(3) -> input projection + learned style vector
///     -> LSTM1(256) -> Gaussian-window attention over a conv-encoded
///        text matrix -> LSTM2(256) -> LSTM3(256), with sqrt(0.5)-scaled
///        skip mixing between every stage
///     -> 20-component bivariate MDN + pen bit (121 outputs)
///
/// Attention also feeds a sigmoid "text exhausted" head whose output is
/// the generation termination signal (> 0.5 means stop).
///
/// Precision discipline: the TS engine stores every intermediate in a
/// Float32Array with double math in between (plus explicit Math.fround at
/// attention hot spots), so it stays bit-compatible with the reference.
/// This port mirrors that exactly — Double arithmetic, Float storage at
/// the same points, identical summation order. The elementwise chains are
/// fused into single loops, but every place the TS code lands in a
/// Float32Array still gets an explicit toFloat() rounding here.
///
/// Everything a step touches lives in FloatArray/DoubleArray scratch owned
/// by the CellState, allocated once up front: zero per-step allocation on
/// the generation path.

package com.trylonghand.ink.calligrapher

import com.trylonghand.ink.core.Rng
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sqrt

internal const val HIDDEN: Int = 256
internal const val ATTENTION_MIXTURES: Int = 10
internal const val OUTPUT_MIXTURES: Int = 20
internal const val MDN_OUTPUTS: Int = 121

private val SKIP: Double = sqrt(0.5)

/// CSR kernel for the hot matvec loops. Values are pre-widened to Double
/// (exact) so the accumulation loop carries no per-element conversion; the
/// sums are bit-identical either way.
internal class SparseKernel(tensor: SparseTensor) {
    val rows: Int = tensor.rows
    val values: DoubleArray = DoubleArray(tensor.values.size) { tensor.values[it].toDouble() }
    val colIndex: IntArray = tensor.colIndex
    val rowPtr: IntArray = tensor.rowPtr
}

// Scalar activations, Double in / Double out; callers apply the toFloat()
// rounding at the same points the TS code stores into a Float32Array.
private fun sigmoidD(v: Double): Double = 1 / (1 + exp(-v))

private fun softplusD(v: Double): Double = ln(1 + exp(v))

// The reference computes tanh via (e^2v - 1) / (e^2v + 1); kept verbatim so
// edge behavior (overflow to NaN included) matches.
private fun tanhD(v: Double): Double {
    val e = exp(2 * v)
    return (e - 1) / (e + 1)
}

/// Widen a Float vector to Double (exact). The hot matvecs take Double
/// inputs so the inner loops are pure loads and multiply-adds.
private fun widen(x: FloatArray, count: Int, out: DoubleArray, outOffset: Int = 0) {
    var i = 0
    while (i < count) {
        out[outOffset + i] = x[i].toDouble()
        i += 1
    }
}

/// Dense matvec, weights laid out [input, output] row-major.
private fun matvec(x: DoubleArray, inDim: Int, weights: DoubleArray, outDim: Int, out: FloatArray) {
    var o = 0
    while (o < outDim) {
        var sum = 0.0
        var i = 0
        var w = o
        while (i < inDim) {
            sum += x[i] * weights[w]
            i += 1
            w += outDim
        }
        out[o] = sum.toFloat()
        o += 1
    }
}

private fun csrMatvec(x: DoubleArray, m: SparseKernel, out: FloatArray) {
    val values = m.values
    val columns = m.colIndex
    val rowPtr = m.rowPtr
    var row = 0
    while (row < m.rows) {
        var sum = 0.0
        val end = rowPtr[row + 1]
        var i = rowPtr[row]
        while (i < end) {
            sum += values[i] * x[columns[i]]
            i += 1
        }
        out[row] = sum.toFloat()
        row += 1
    }
}

/// Per-writer state: recurrent tensors plus every scratch buffer a step
/// needs, allocated once up front.
internal class CellState(
    charCount: Int,
    z: FloatArray,
    grid: FloatArray,
    h1: FloatArray,
    c1: FloatArray,
    h2: FloatArray,
    c2: FloatArray,
    h3: FloatArray,
    c3: FloatArray,
    window: FloatArray,
) {
    // Recurrent state.
    val h1: FloatArray = h1.copyOf()
    val c1: FloatArray = c1.copyOf()
    val h2: FloatArray = h2.copyOf()
    val c2: FloatArray = c2.copyOf()
    val h3: FloatArray = h3.copyOf()
    val c3: FloatArray = c3.copyOf()

    /** Attention window from the previous step. */
    val window: FloatArray = window.copyOf()
    val kappa: FloatArray = FloatArray(ATTENTION_MIXTURES)

    /** Attention grid positions: [-0.5, 0.5, ..., n - 0.5] (n+1 values). */
    val grid: FloatArray = grid.copyOf()

    /** Style conditioning vector, added to every input projection. */
    val z: FloatArray = z.copyOf()

    /** Last sampled offset [dx, dy, pen], the next step's input. Starts [0, 0, 1]. */
    val input: FloatArray = floatArrayOf(0f, 0f, 1f)

    /** The 121 raw MDN outputs of the latest step, consumed by sample(). */
    val output: FloatArray = FloatArray(MDN_OUTPUTS)

    // Step scratch. concat is Double: it feeds the matvecs, whose inputs
    // are widened once per call instead of once per multiply.
    val t: FloatArray = FloatArray(HIDDEN)
    val concat: DoubleArray = DoubleArray(3 * HIDDEN)
    // (concat also serves as the widening scratch for the dense matvecs.)
    val gates: FloatArray = FloatArray(4 * HIDDEN)
    val mixed: FloatArray = FloatArray(HIDDEN)
    val raw: FloatArray = FloatArray(3 * ATTENTION_MIXTURES)
    val alpha: FloatArray = FloatArray(ATTENTION_MIXTURES)
    val beta: FloatArray = FloatArray(ATTENTION_MIXTURES)
    val kappaStep: FloatArray = FloatArray(ATTENTION_MIXTURES)
    val phi: FloatArray = FloatArray(charCount)
    val cdf: FloatArray = FloatArray(charCount + 1)
    val logPi: FloatArray = FloatArray(OUTPUT_MIXTURES)
}

/// One sampled offset: pen movement delta and pen bit, all Float like the
/// reference's Float32Array-backed stream.
internal class SampledOffset(val dx: Float, val dy: Float, val pen: Float)

internal class CalligrapherCell(assets: CalligrapherAssets) {
    companion object {
        const val hidden: Int = HIDDEN
        const val attentionMixtures: Int = ATTENTION_MIXTURES
        const val outputMixtures: Int = OUTPUT_MIXTURES
        const val mdnOutputs: Int = MDN_OUTPUTS
    }

    // Sparse kernels (CSR).
    private val kernel1: SparseKernel
    private val kernel2: SparseKernel
    private val kernel3: SparseKernel
    private val mixKernel: SparseKernel

    // Dense tensors on the per-step path, resolved once by their
    // single-letter container names. Kernels feeding matvecs are widened
    // to Double at load (exact); biases stay Float, added elementwise.
    private val inputKernel: DoubleArray // i
    private val inputBias: FloatArray // W
    private val lstm1Bias: FloatArray // p
    private val lstm2Bias: FloatArray // q
    private val lstm3Bias: FloatArray // f
    private val attentionKernel: DoubleArray // h
    private val attentionBias: FloatArray // n
    private val mixBias: FloatArray // Q
    private val terminationKernel: DoubleArray // c
    private val terminationBias: FloatArray // u
    private val mdnKernel: DoubleArray // z
    private val mdnBias: FloatArray // v

    // Init-time tensors (text encoding and state construction).
    private val embedding: FloatArray // s
    private val convKernel: FloatArray // b
    private val convBias: FloatArray // t
    private val projection: FloatArray // j
    private val projectionBias: FloatArray // E
    private val styleKernel: FloatArray // k
    private val styleBias: FloatArray // R
    private val styleEmbeddings: FloatArray // g
    private val initialC1: FloatArray // d
    private val initialC2: FloatArray // o
    private val initialC3: FloatArray // e
    private val initialH1: FloatArray // m
    private val initialH2: FloatArray // x
    private val initialH3: FloatArray // a
    private val initialWindow: FloatArray // T

    init {
        fun dense(name: String): FloatArray =
            assets.dense[name]?.data ?: throw CalligrapherError.MissingTensor(name)
        fun sparse(name: String): SparseKernel =
            assets.sparse[name]?.let(::SparseKernel)
                ?: throw CalligrapherError.MissingSparseTensor(name)
        fun widened(data: FloatArray): DoubleArray =
            DoubleArray(data.size) { data[it].toDouble() }
        kernel1 = sparse("y")
        kernel2 = sparse("w")
        kernel3 = sparse("r")
        mixKernel = sparse("l")
        inputKernel = widened(dense("i"))
        inputBias = dense("W")
        lstm1Bias = dense("p")
        lstm2Bias = dense("q")
        lstm3Bias = dense("f")
        attentionKernel = widened(dense("h"))
        attentionBias = dense("n")
        mixBias = dense("Q")
        terminationKernel = widened(dense("c"))
        terminationBias = dense("u")
        mdnKernel = widened(dense("z"))
        mdnBias = dense("v")
        embedding = dense("s")
        convKernel = dense("b")
        convBias = dense("t")
        projection = dense("j")
        projectionBias = dense("E")
        styleKernel = dense("k")
        styleBias = dense("R")
        styleEmbeddings = dense("g")
        initialC1 = dense("d")
        initialC2 = dense("o")
        initialC3 = dense("e")
        initialH1 = dense("m")
        initialH2 = dense("x")
        initialH3 = dense("a")
        initialWindow = dense("T")
    }

    /// Encode text ids into the attention memory: embedding lookup with one
    /// pad row on each side, a width-3 conv + tanh over the embeddings, the
    /// conv output concatenated back onto each embedding, then projected
    /// 512 -> 256. Returns an (n, 256) row-major matrix. Runs once per
    /// writer, so freshly allocated arrays are fine here.
    fun encodeText(ids: IntArray): FloatArray {
        val n = ids.size
        val padded = IntArray(n + 2)
        for (i in 0 until n) padded[i + 1] = ids[i]

        val embedded = FloatArray((n + 2) * HIDDEN)
        for (row in 0 until n + 2) {
            val source = padded[row] * HIDDEN
            for (i in 0 until HIDDEN) embedded[row * HIDDEN + i] = embedding[source + i]
        }

        val conv = FloatArray(n * HIDDEN)
        for (row in 0 until n) {
            val windowBase = row * HIDDEN
            for (out in 0 until HIDDEN) {
                var sum = 0.0
                for (i in 0 until 3 * HIDDEN) {
                    sum += embedded[windowBase + i].toDouble() * convKernel[out + HIDDEN * i].toDouble()
                }
                conv[row * HIDDEN + out] = sum.toFloat()
            }
        }
        for (row in 0 until n) {
            for (i in 0 until HIDDEN) {
                val biased = conv[row * HIDDEN + i].toDouble() + convBias[i].toDouble()
                conv[row * HIDDEN + i] = tanhD(biased.toFloat().toDouble()).toFloat()
            }
        }

        val encoded = FloatArray(n * HIDDEN)
        val combined = FloatArray(2 * HIDDEN)
        for (row in 0 until n) {
            // Row = [embedding without pads | conv], projected 512 -> 256.
            for (i in 0 until HIDDEN) {
                combined[i] = embedded[(row + 1) * HIDDEN + i]
                combined[HIDDEN + i] = conv[row * HIDDEN + i]
            }
            for (o in 0 until HIDDEN) {
                var sum = 0.0
                for (i in 0 until 2 * HIDDEN) {
                    sum += combined[i].toDouble() * projection[i * HIDDEN + o].toDouble()
                }
                encoded[row * HIDDEN + o] = sum.toFloat()
            }
            for (i in 0 until HIDDEN) {
                encoded[row * HIDDEN + i] =
                    (encoded[row * HIDDEN + i].toDouble() + projectionBias[i].toDouble()).toFloat()
            }
        }
        return encoded
    }

    /// Fresh state for a text of `charCount` encoded ids, conditioned on a style.
    fun initialState(charCount: Int, styleIndex: Int): CellState {
        val styleVector = styleEmbeddings.copyOfRange(styleIndex * 64, (styleIndex + 1) * 64)
        val z = FloatArray(HIDDEN)
        for (o in 0 until HIDDEN) {
            var sum = 0.0
            for (i in 0 until 64) sum += styleVector[i].toDouble() * styleKernel[i * HIDDEN + o].toDouble()
            z[o] = (sum.toFloat().toDouble() + styleBias[o].toDouble()).toFloat()
        }
        val grid = FloatArray(charCount + 1)
        for (i in 0..charCount) grid[i] = (i.toDouble() - 0.5).toFloat()
        return CellState(
            charCount = charCount, z = z, grid = grid,
            h1 = initialH1, c1 = initialC1,
            h2 = initialH2, c2 = initialC2,
            h3 = initialH3, c3 = initialC3,
            window = initialWindow,
        )
    }

    /// One LSTM layer: gates from CSR matvec over [input | h], then the
    /// fused elementwise update, writing h and c in place. Gate slices and
    /// rounding points match the TS addV/mulV/sigmoidV/tanhV chain exactly.
    private fun lstm(
        state: CellState, inputLength: Int,
        h: FloatArray, c: FloatArray,
        kernel: SparseKernel, bias: FloatArray,
    ) {
        val concat = state.concat
        val gates = state.gates
        widen(h, HIDDEN, concat, outOffset = inputLength)
        csrMatvec(concat, kernel, gates)
        var g = 0
        while (g < 4 * HIDDEN) {
            gates[g] = (gates[g].toDouble() + bias[g].toDouble()).toFloat()
            g += 1
        }
        for (i in 0 until HIDDEN) {
            val inGate = sigmoidD(gates[i].toDouble()).toFloat()
            val candidate = tanhD(gates[HIDDEN + i].toDouble()).toFloat()
            val forgetGate = sigmoidD(gates[2 * HIDDEN + i].toDouble()).toFloat()
            val outGate = sigmoidD(gates[3 * HIDDEN + i].toDouble()).toFloat()
            val retained = (forgetGate.toDouble() * c[i].toDouble()).toFloat()
            val written = (inGate.toDouble() * candidate.toDouble()).toFloat()
            val cNext = (retained.toDouble() + written.toDouble()).toFloat()
            c[i] = cNext
            h[i] = (outGate.toDouble() * tanhD(cNext.toDouble()).toFloat().toDouble()).toFloat()
        }
    }

    /// Gaussian-window attention (difference-of-sigmoids form): 10 mixtures
    /// with monotonically advancing kappa, soft-attending over the encoded
    /// text. Updates state.kappa and writes the new 256-dim window into
    /// state.window.
    private fun attend(state: CellState, encoded: FloatArray, charCount: Int) {
        val raw = state.raw
        val alpha = state.alpha
        val beta = state.beta
        val kappaStep = state.kappaStep
        val kappa = state.kappa
        val grid = state.grid
        val phi = state.phi
        val cdf = state.cdf
        val window = state.window
        val concat = state.concat

        widen(state.h2, HIDDEN, concat)
        matvec(concat, HIDDEN, attentionKernel, 3 * ATTENTION_MIXTURES, raw)
        var total = 0.0
        for (k in 0 until ATTENTION_MIXTURES) {
            val biased = (raw[k].toDouble() + attentionBias[k].toDouble()).toFloat()
            alpha[k] = exp(biased.toDouble()).toFloat()
            total += alpha[k].toDouble()
        }
        for (k in 0 until ATTENTION_MIXTURES) {
            alpha[k] = (alpha[k].toDouble() / total).toFloat()
            val betaRaw =
                (raw[ATTENTION_MIXTURES + k].toDouble() + attentionBias[ATTENTION_MIXTURES + k].toDouble()).toFloat()
            beta[k] = softplusD(betaRaw.toDouble()).toFloat()
            val kappaRaw =
                (raw[2 * ATTENTION_MIXTURES + k].toDouble() + attentionBias[2 * ATTENTION_MIXTURES + k].toDouble()).toFloat()
            kappaStep[k] = softplusD(kappaRaw.toDouble()).toFloat()
            kappa[k] = (kappa[k].toDouble() + (kappaStep[k].toDouble() / 15).toFloat().toDouble()).toFloat()
        }

        // phi[e] = sum_k alpha_k * (cdf_k(grid[e+1]) - cdf_k(grid[e]))
        for (e in 0 until charCount) phi[e] = 0f
        for (k in 0 until ATTENTION_MIXTURES) {
            for (e in 0..charCount) {
                val centered = (grid[e].toDouble() - kappa[k].toDouble()).toFloat()
                cdf[e] =
                    (1 / (1 + exp(-(centered.toDouble() / beta[k].toDouble()).toFloat().toDouble()))).toFloat()
            }
            for (e in 0 until charCount) {
                phi[e] = (
                    phi[e].toDouble() +
                        (alpha[k].toDouble() * (cdf[e + 1].toDouble() - cdf[e].toDouble()).toFloat().toDouble()).toFloat().toDouble()
                    ).toFloat()
            }
        }

        for (i in 0 until HIDDEN) window[i] = 0f
        for (e in 0 until charCount) {
            val weight = phi[e]
            for (i in 0 until HIDDEN) {
                window[i] = (
                    window[i].toDouble() +
                        (weight.toDouble() * encoded[e * HIDDEN + i].toDouble()).toFloat().toDouble()
                    ).toFloat()
            }
        }
    }

    /// One timestep. Consumes state.input (the previous offset), mutates the
    /// state, leaves the 121 raw MDN outputs in state.output, and returns
    /// the termination probability (attention past the end of the text).
    fun step(state: CellState, encoded: FloatArray, charCount: Int): Float {
        val t = state.t
        val concat = state.concat
        val window = state.window
        val mixed = state.mixed
        val z = state.z

        // Input projection + style vector, sqrt(0.5)-scaled.
        widen(state.input, 3, concat)
        matvec(concat, 3, inputKernel, HIDDEN, t)
        for (i in 0 until HIDDEN) {
            val projected = (t[i].toDouble() + inputBias[i].toDouble()).toFloat()
            t[i] = ((projected.toDouble() + z[i].toDouble()).toFloat().toDouble() * SKIP).toFloat()
        }

        widen(t, HIDDEN, concat)
        lstm(state, inputLength = HIDDEN, state.h1, state.c1, kernel1, lstm1Bias)
        val h1 = state.h1
        for (i in 0 until HIDDEN) {
            t[i] = ((t[i].toDouble() + h1[i].toDouble()).toFloat().toDouble() * SKIP).toFloat()
        }

        // LSTM2 sees [t | previous window].
        widen(t, HIDDEN, concat)
        widen(window, HIDDEN, concat, outOffset = HIDDEN)
        lstm(state, inputLength = 2 * HIDDEN, state.h2, state.c2, kernel2, lstm2Bias)

        attend(state, encoded, charCount)

        // Mix [h2 | new window] back into the skip path.
        widen(state.h2, HIDDEN, concat)
        widen(window, HIDDEN, concat, outOffset = HIDDEN)
        csrMatvec(concat, mixKernel, mixed)
        for (i in 0 until HIDDEN) {
            val biased = (mixed[i].toDouble() + mixBias[i].toDouble()).toFloat()
            mixed[i] = tanhD(biased.toDouble()).toFloat()
        }
        for (i in 0 until HIDDEN) {
            t[i] = ((t[i].toDouble() + mixed[i].toDouble()).toFloat().toDouble() * SKIP).toFloat()
        }

        var terminationSum = 0.0
        for (i in 0 until HIDDEN) {
            terminationSum += window[i].toDouble() * terminationKernel[i]
        }
        val terminationRaw = (terminationSum.toFloat().toDouble() + terminationBias[0].toDouble()).toFloat()
        val termination = sigmoidD(terminationRaw.toDouble()).toFloat()

        widen(t, HIDDEN, concat)
        lstm(state, inputLength = HIDDEN, state.h3, state.c3, kernel3, lstm3Bias)
        val h3 = state.h3
        for (i in 0 until HIDDEN) {
            t[i] = ((t[i].toDouble() + h3[i].toDouble()).toFloat().toDouble() * SKIP).toFloat()
        }

        val output = state.output
        widen(t, HIDDEN, concat)
        matvec(concat, HIDDEN, mdnKernel, MDN_OUTPUTS, output)
        for (i in 0 until MDN_OUTPUTS) {
            output[i] = (output[i].toDouble() + mdnBias[i].toDouble()).toFloat()
        }
        return termination
    }

    /// Sample an offset from the 121 raw outputs in state.output. Random
    /// draws (order and formulas) mirror the reference exactly: one uniform
    /// for the pen bit, one Gumbel per mixture component, then four
    /// uniforms for the two correlated normals. Only the picked component's
    /// sigma/rho/mu get transformed, which is safe because those transforms
    /// are elementwise.
    fun sample(state: CellState, bias: Double, rng: Rng): SampledOffset {
        val output = state.output
        val logPi = state.logPi

        val penProbability = sigmoidD(output[120].toDouble()).toFloat()
        val pen: Float = if (rng.uniform() < penProbability.toDouble()) 1f else 0f

        // Softmax over the mixture logits (output[6k]), then log, sharpen
        // by (1 + bias), and push near-zero components out of reach.
        var total = 0.0
        for (k in 0 until OUTPUT_MIXTURES) {
            logPi[k] = exp(output[6 * k].toDouble()).toFloat()
            total += logPi[k].toDouble()
        }
        val cutoff = ln(0.02)
        for (k in 0 until OUTPUT_MIXTURES) {
            val soft = (logPi[k].toDouble() / total).toFloat()
            var sharpened = (ln(soft.toDouble()).toFloat().toDouble() * (1 + bias)).toFloat()
            if (sharpened.toDouble() < cutoff) sharpened = (sharpened.toDouble() - 100).toFloat()
            logPi[k] = sharpened
        }

        // Gumbel-max over the sharpened log-weights.
        var best = -1e6
        var pick = 0
        for (k in 0 until OUTPUT_MIXTURES) {
            val perturbed = logPi[k].toDouble() + -ln(-ln(rng.uniform()))
            if (perturbed > best) {
                best = perturbed
                pick = k
            }
        }

        val sx = (softplusD(output[6 * pick + 1].toDouble()).toFloat().toDouble() / exp(bias)).toFloat()
        val sy = (softplusD(output[6 * pick + 2].toDouble()).toFloat().toDouble() / exp(bias)).toFloat()
        val r = tanhD(output[6 * pick + 3].toDouble()).toFloat()
        // Cholesky factor [sx, r*sy; 0, sy*sqrt(1 - r^2)] applied to two
        // Box-Muller normals.
        val chol1 = (r.toDouble() * sy.toDouble()).toFloat()
        val chol3 = (sy.toDouble() * sqrt(1 - r.toDouble() * r.toDouble())).toFloat()
        var noise0 = 0f
        var noise1 = 0f
        for (i in 0 until 2) {
            val u1 = 1 - rng.uniform()
            val u2 = 1 - rng.uniform()
            val value = (sqrt(-2 * ln(u1)) * cos(2 * PI * u2)).toFloat()
            if (i == 0) noise0 = value else noise1 = value
        }
        val spreadX = (noise0.toDouble() * sx.toDouble() + noise1.toDouble() * 0).toFloat()
        val spreadY = (noise0.toDouble() * chol1.toDouble() + noise1.toDouble() * chol3.toDouble()).toFloat()
        val dx = (output[6 * pick + 4].toDouble() + spreadX.toDouble()).toFloat()
        val dy = (output[6 * pick + 5].toDouble() + spreadY.toDouble()).toFloat()
        return SampledOffset(dx = dx, dy = dy, pen = pen)
    }
}
