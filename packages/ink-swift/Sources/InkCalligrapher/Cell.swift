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
/// Float32Array still gets an explicit Float() rounding here.
///
/// Everything a step touches lives in preallocated RawBuffers indexed
/// through raw pointers: zero per-step allocation and no -Onone bounds
/// checks, which is what keeps debug builds at generation speed.

import Foundation
import InkCore

let HIDDEN = 256
let ATTENTION_MIXTURES = 10
let OUTPUT_MIXTURES = 20
let MDN_OUTPUTS = 121

private let SKIP = (0.5 as Double).squareRoot()

/// Owned fixed-size storage accessed through a raw pointer.
final class RawBuffer<Element> {
    let p: UnsafeMutablePointer<Element>
    let count: Int

    init(repeating value: Element, count: Int) {
        self.count = count
        p = .allocate(capacity: max(count, 1))
        p.initialize(repeating: value, count: count)
    }

    init(copying values: [Element]) {
        count = values.count
        p = .allocate(capacity: max(count, 1))
        values.withUnsafeBufferPointer { buffer in
            if let base = buffer.baseAddress {
                p.initialize(from: base, count: buffer.count)
            }
        }
    }

    deinit {
        p.deinitialize(count: count)
        p.deallocate()
    }
}

/// CSR kernel with pointer-backed storage for the hot matvec loops. Values
/// are pre-widened to Double (exact) so the accumulation loop carries no
/// per-element conversion; the sums are bit-identical either way.
struct SparseKernel {
    let rows: Int
    let values: RawBuffer<Double>
    let colIndex: RawBuffer<Int32>
    let rowPtr: RawBuffer<Int32>

    init(_ tensor: SparseTensor) {
        rows = tensor.rows
        values = RawBuffer(copying: tensor.values.map(Double.init))
        colIndex = RawBuffer(copying: tensor.colIndex)
        rowPtr = RawBuffer(copying: tensor.rowPtr)
    }
}

// Scalar activations, Double in / Double out; callers apply the Float()
// rounding at the same points the TS code stores into a Float32Array.
@inline(__always) private func sigmoidD(_ v: Double) -> Double {
    1 / (1 + exp(-v))
}

@inline(__always) private func softplusD(_ v: Double) -> Double {
    log(1 + exp(v))
}

// The reference computes tanh via (e^2v - 1) / (e^2v + 1); kept verbatim so
// edge behavior (overflow to NaN included) matches.
@inline(__always) private func tanhD(_ v: Double) -> Double {
    let e = exp(2 * v)
    return (e - 1) / (e + 1)
}

/// Widen a Float vector to Double (exact). The hot matvecs take Double
/// inputs so the inner loops are pure loads and FMAs even at -Onone.
@inline(__always) private func widen(
    _ x: UnsafePointer<Float>, _ count: Int,
    into out: UnsafeMutablePointer<Double>
) {
    var i = 0
    while i < count {
        out[i] = Double(x[i])
        i += 1
    }
}

/// Dense matvec, weights laid out [input, output] row-major.
private func matvec(
    _ x: UnsafePointer<Double>, _ inDim: Int,
    _ weights: UnsafePointer<Double>, _ outDim: Int,
    into out: UnsafeMutablePointer<Float>
) {
    var o = 0
    while o < outDim {
        var sum = 0.0
        var i = 0
        var w = o
        while i < inDim {
            sum += x[i] * weights[w]
            i += 1
            w += outDim
        }
        out[o] = Float(sum)
        o += 1
    }
}

private func csrMatvec(
    _ x: UnsafePointer<Double>, _ m: SparseKernel,
    into out: UnsafeMutablePointer<Float>
) {
    let values = m.values.p
    let columns = m.colIndex.p
    let rowPtr = m.rowPtr.p
    var row = 0
    while row < m.rows {
        var sum = 0.0
        let end = Int(rowPtr[row + 1])
        var i = Int(rowPtr[row])
        while i < end {
            sum += values[i] * x[Int(columns[i])]
            i += 1
        }
        out[row] = Float(sum)
        row += 1
    }
}

/// Per-writer state: recurrent tensors plus every scratch buffer a step
/// needs, allocated once up front.
final class CellState {
    // Recurrent state.
    let h1, c1, h2, c2, h3, c3: RawBuffer<Float>
    /// Attention window from the previous step.
    let window: RawBuffer<Float>
    let kappa: RawBuffer<Float>
    /// Attention grid positions: [-0.5, 0.5, ..., n - 0.5] (n+1 values).
    let grid: RawBuffer<Float>
    /// Style conditioning vector, added to every input projection.
    let z: RawBuffer<Float>
    /// Last sampled offset [dx, dy, pen], the next step's input. Starts [0, 0, 1].
    let input: RawBuffer<Float>
    /// The 121 raw MDN outputs of the latest step, consumed by sample().
    let output: RawBuffer<Float>

    // Step scratch. concat is Double: it feeds the matvecs, whose inputs
    // are widened once per call instead of once per multiply.
    let concat: RawBuffer<Double>
    let t, gates, mixed: RawBuffer<Float>
    let raw, alpha, beta, kappaStep: RawBuffer<Float>
    let phi, cdf: RawBuffer<Float>
    let logPi: RawBuffer<Float>

    init(charCount: Int, z: [Float], grid: [Float], h1: [Float], c1: [Float], h2: [Float], c2: [Float], h3: [Float], c3: [Float], window: [Float]) {
        self.h1 = RawBuffer(copying: h1)
        self.c1 = RawBuffer(copying: c1)
        self.h2 = RawBuffer(copying: h2)
        self.c2 = RawBuffer(copying: c2)
        self.h3 = RawBuffer(copying: h3)
        self.c3 = RawBuffer(copying: c3)
        self.window = RawBuffer(copying: window)
        self.kappa = RawBuffer(repeating: 0, count: ATTENTION_MIXTURES)
        self.grid = RawBuffer(copying: grid)
        self.z = RawBuffer(copying: z)
        self.input = RawBuffer(copying: [0, 0, 1])
        self.output = RawBuffer(repeating: 0, count: MDN_OUTPUTS)
        self.t = RawBuffer(repeating: 0, count: HIDDEN)
        self.concat = RawBuffer(repeating: 0, count: 3 * HIDDEN)
        // (concat also serves as the widening scratch for the dense matvecs.)
        self.gates = RawBuffer(repeating: 0, count: 4 * HIDDEN)
        self.mixed = RawBuffer(repeating: 0, count: HIDDEN)
        self.raw = RawBuffer(repeating: 0, count: 3 * ATTENTION_MIXTURES)
        self.alpha = RawBuffer(repeating: 0, count: ATTENTION_MIXTURES)
        self.beta = RawBuffer(repeating: 0, count: ATTENTION_MIXTURES)
        self.kappaStep = RawBuffer(repeating: 0, count: ATTENTION_MIXTURES)
        self.phi = RawBuffer(repeating: 0, count: charCount)
        self.cdf = RawBuffer(repeating: 0, count: charCount + 1)
        self.logPi = RawBuffer(repeating: 0, count: OUTPUT_MIXTURES)
    }
}

final class CalligrapherCell {
    static let hidden = HIDDEN
    static let attentionMixtures = ATTENTION_MIXTURES
    static let outputMixtures = OUTPUT_MIXTURES
    static let mdnOutputs = MDN_OUTPUTS

    // Sparse kernels (CSR).
    private let kernel1: SparseKernel
    private let kernel2: SparseKernel
    private let kernel3: SparseKernel
    private let mixKernel: SparseKernel

    // Dense tensors on the per-step path, resolved once by their
    // single-letter container names. Kernels feeding matvecs are widened
    // to Double at load (exact); biases stay Float, added elementwise.
    private let inputKernel: RawBuffer<Double> // i
    private let inputBias: RawBuffer<Float> // W
    private let lstm1Bias: RawBuffer<Float> // p
    private let lstm2Bias: RawBuffer<Float> // q
    private let lstm3Bias: RawBuffer<Float> // f
    private let attentionKernel: RawBuffer<Double> // h
    private let attentionBias: RawBuffer<Float> // n
    private let mixBias: RawBuffer<Float> // Q
    private let terminationKernel: RawBuffer<Double> // c
    private let terminationBias: RawBuffer<Float> // u
    private let mdnKernel: RawBuffer<Double> // z
    private let mdnBias: RawBuffer<Float> // v

    // Init-time tensors (text encoding and state construction).
    private let embedding: [Float] // s
    private let convKernel: [Float] // b
    private let convBias: [Float] // t
    private let projection: [Float] // j
    private let projectionBias: [Float] // E
    private let styleKernel: [Float] // k
    private let styleBias: [Float] // R
    private let styleEmbeddings: [Float] // g
    private let initialC1: [Float] // d
    private let initialC2: [Float] // o
    private let initialC3: [Float] // e
    private let initialH1: [Float] // m
    private let initialH2: [Float] // x
    private let initialH3: [Float] // a
    private let initialWindow: [Float] // T

    init(assets: CalligrapherAssets) throws {
        func dense(_ name: String) throws -> [Float] {
            guard let tensor = assets.dense[name] else {
                throw CalligrapherError.missingTensor(name)
            }
            return tensor.data
        }
        func sparse(_ name: String) throws -> SparseKernel {
            guard let tensor = assets.sparse[name] else {
                throw CalligrapherError.missingSparseTensor(name)
            }
            return SparseKernel(tensor)
        }
        kernel1 = try sparse("y")
        kernel2 = try sparse("w")
        kernel3 = try sparse("r")
        mixKernel = try sparse("l")
        inputKernel = RawBuffer(copying: try dense("i").map(Double.init))
        inputBias = RawBuffer(copying: try dense("W"))
        lstm1Bias = RawBuffer(copying: try dense("p"))
        lstm2Bias = RawBuffer(copying: try dense("q"))
        lstm3Bias = RawBuffer(copying: try dense("f"))
        attentionKernel = RawBuffer(copying: try dense("h").map(Double.init))
        attentionBias = RawBuffer(copying: try dense("n"))
        mixBias = RawBuffer(copying: try dense("Q"))
        terminationKernel = RawBuffer(copying: try dense("c").map(Double.init))
        terminationBias = RawBuffer(copying: try dense("u"))
        mdnKernel = RawBuffer(copying: try dense("z").map(Double.init))
        mdnBias = RawBuffer(copying: try dense("v"))
        embedding = try dense("s")
        convKernel = try dense("b")
        convBias = try dense("t")
        projection = try dense("j")
        projectionBias = try dense("E")
        styleKernel = try dense("k")
        styleBias = try dense("R")
        styleEmbeddings = try dense("g")
        initialC1 = try dense("d")
        initialC2 = try dense("o")
        initialC3 = try dense("e")
        initialH1 = try dense("m")
        initialH2 = try dense("x")
        initialH3 = try dense("a")
        initialWindow = try dense("T")
    }

    /// Encode text ids into the attention memory: embedding lookup with one
    /// pad row on each side, a width-3 conv + tanh over the embeddings, the
    /// conv output concatenated back onto each embedding, then projected
    /// 512 -> 256. Returns an (n, 256) row-major matrix. Runs once per
    /// writer, so plain arrays are fine here.
    func encodeText(_ ids: [Int32]) -> [Float] {
        let n = ids.count
        var padded = [Int32](repeating: 0, count: n + 2)
        for i in 0 ..< n { padded[i + 1] = ids[i] }

        var embedded = [Float](repeating: 0, count: (n + 2) * HIDDEN)
        for row in 0 ..< (n + 2) {
            let source = Int(padded[row]) * HIDDEN
            for i in 0 ..< HIDDEN { embedded[row * HIDDEN + i] = embedding[source + i] }
        }

        var conv = [Float](repeating: 0, count: n * HIDDEN)
        embedded.withUnsafeBufferPointer { embeddedBuffer in
            convKernel.withUnsafeBufferPointer { kernelBuffer in
                conv.withUnsafeMutableBufferPointer { convBuffer in
                    for row in 0 ..< n {
                        let windowBase = row * HIDDEN
                        for out in 0 ..< HIDDEN {
                            var sum = 0.0
                            for i in 0 ..< (3 * HIDDEN) {
                                sum += Double(embeddedBuffer[windowBase + i]) * Double(kernelBuffer[out + HIDDEN * i])
                            }
                            convBuffer[row * HIDDEN + out] = Float(sum)
                        }
                    }
                }
            }
        }
        for row in 0 ..< n {
            for i in 0 ..< HIDDEN {
                let biased = Double(conv[row * HIDDEN + i]) + Double(convBias[i])
                conv[row * HIDDEN + i] = Float(tanhD(Double(Float(biased))))
            }
        }

        var encoded = [Float](repeating: 0, count: n * HIDDEN)
        var combined = [Float](repeating: 0, count: 2 * HIDDEN)
        for row in 0 ..< n {
            // Row = [embedding without pads | conv], projected 512 -> 256.
            for i in 0 ..< HIDDEN {
                combined[i] = embedded[(row + 1) * HIDDEN + i]
                combined[HIDDEN + i] = conv[row * HIDDEN + i]
            }
            combined.withUnsafeBufferPointer { combinedBuffer in
                projection.withUnsafeBufferPointer { projectionBuffer in
                    encoded.withUnsafeMutableBufferPointer { encodedBuffer in
                        for o in 0 ..< HIDDEN {
                            var sum = 0.0
                            for i in 0 ..< 2 * HIDDEN {
                                sum += Double(combinedBuffer[i]) * Double(projectionBuffer[i * HIDDEN + o])
                            }
                            encodedBuffer[row * HIDDEN + o] = Float(sum)
                        }
                    }
                }
            }
            for i in 0 ..< HIDDEN {
                encoded[row * HIDDEN + i] = Float(Double(encoded[row * HIDDEN + i]) + Double(projectionBias[i]))
            }
        }
        return encoded
    }

    /// Fresh state for a text of `charCount` encoded ids, conditioned on a style.
    func initialState(charCount: Int, styleIndex: Int) -> CellState {
        let styleVector = Array(styleEmbeddings[styleIndex * 64 ..< (styleIndex + 1) * 64])
        var z = [Float](repeating: 0, count: HIDDEN)
        for o in 0 ..< HIDDEN {
            var sum = 0.0
            for i in 0 ..< 64 { sum += Double(styleVector[i]) * Double(styleKernel[i * HIDDEN + o]) }
            z[o] = Float(Double(Float(sum)) + Double(styleBias[o]))
        }
        var grid = [Float](repeating: 0, count: charCount + 1)
        for i in 0 ... charCount { grid[i] = Float(Double(i) - 0.5) }
        return CellState(
            charCount: charCount, z: z, grid: grid,
            h1: initialH1, c1: initialC1,
            h2: initialH2, c2: initialC2,
            h3: initialH3, c3: initialC3,
            window: initialWindow
        )
    }

    /// One LSTM layer: gates from CSR matvec over [input | h], then the
    /// fused elementwise update, writing h and c in place. Gate slices and
    /// rounding points match the TS addV/mulV/sigmoidV/tanhV chain exactly.
    private func lstm(
        _ state: CellState, inputLength: Int,
        _ h: UnsafeMutablePointer<Float>, _ c: UnsafeMutablePointer<Float>,
        _ kernel: SparseKernel, _ bias: RawBuffer<Float>
    ) {
        let concat = state.concat.p
        let gates = state.gates.p
        let biasP = bias.p
        widen(h, HIDDEN, into: concat + inputLength)
        csrMatvec(concat, kernel, into: gates)
        var g = 0
        while g < 4 * HIDDEN {
            gates[g] = Float(Double(gates[g]) + Double(biasP[g]))
            g += 1
        }
        for i in 0 ..< HIDDEN {
            let inGate = Float(sigmoidD(Double(gates[i])))
            let candidate = Float(tanhD(Double(gates[HIDDEN + i])))
            let forgetGate = Float(sigmoidD(Double(gates[2 * HIDDEN + i])))
            let outGate = Float(sigmoidD(Double(gates[3 * HIDDEN + i])))
            let retained = Float(Double(forgetGate) * Double(c[i]))
            let written = Float(Double(inGate) * Double(candidate))
            let cNext = Float(Double(retained) + Double(written))
            c[i] = cNext
            h[i] = Float(Double(outGate) * Double(Float(tanhD(Double(cNext)))))
        }
    }

    /// Gaussian-window attention (difference-of-sigmoids form): 10 mixtures
    /// with monotonically advancing kappa, soft-attending over the encoded
    /// text. Updates state.kappa and writes the new 256-dim window into
    /// state.window.
    private func attend(
        _ state: CellState,
        _ encoded: UnsafePointer<Float>,
        _ charCount: Int
    ) {
        let raw = state.raw.p
        let alpha = state.alpha.p
        let beta = state.beta.p
        let kappaStep = state.kappaStep.p
        let kappa = state.kappa.p
        let grid = state.grid.p
        let phi = state.phi.p
        let cdf = state.cdf.p
        let window = state.window.p
        let concat = state.concat.p

        widen(state.h2.p, HIDDEN, into: concat)
        matvec(concat, HIDDEN, attentionKernel.p, 3 * ATTENTION_MIXTURES, into: raw)
        var total = 0.0
        for k in 0 ..< ATTENTION_MIXTURES {
            let biased = Float(Double(raw[k]) + Double(attentionBias.p[k]))
            alpha[k] = Float(exp(Double(biased)))
            total += Double(alpha[k])
        }
        for k in 0 ..< ATTENTION_MIXTURES {
            alpha[k] = Float(Double(alpha[k]) / total)
            let betaRaw = Float(Double(raw[ATTENTION_MIXTURES + k]) + Double(attentionBias.p[ATTENTION_MIXTURES + k]))
            beta[k] = Float(softplusD(Double(betaRaw)))
            let kappaRaw = Float(Double(raw[2 * ATTENTION_MIXTURES + k]) + Double(attentionBias.p[2 * ATTENTION_MIXTURES + k]))
            kappaStep[k] = Float(softplusD(Double(kappaRaw)))
            kappa[k] = Float(Double(kappa[k]) + Double(Float(Double(kappaStep[k]) / 15)))
        }

        // phi[e] = sum_k alpha_k * (cdf_k(grid[e+1]) - cdf_k(grid[e]))
        for e in 0 ..< charCount { phi[e] = 0 }
        for k in 0 ..< ATTENTION_MIXTURES {
            for e in 0 ... charCount {
                let centered = Float(Double(grid[e]) - Double(kappa[k]))
                cdf[e] = Float(1 / (1 + exp(-Double(Float(Double(centered) / Double(beta[k]))))))
            }
            for e in 0 ..< charCount {
                phi[e] = Float(
                    Double(phi[e]) + Double(Float(Double(alpha[k]) * Double(Float(Double(cdf[e + 1]) - Double(cdf[e])))))
                )
            }
        }

        for i in 0 ..< HIDDEN { window[i] = 0 }
        for e in 0 ..< charCount {
            let weight = phi[e]
            for i in 0 ..< HIDDEN {
                window[i] = Float(Double(window[i]) + Double(Float(Double(weight) * Double(encoded[e * HIDDEN + i]))))
            }
        }
    }

    /// One timestep. Consumes state.input (the previous offset), mutates the
    /// state, leaves the 121 raw MDN outputs in state.output, and returns
    /// the termination probability (attention past the end of the text).
    func step(
        _ state: CellState,
        encoded: UnsafePointer<Float>,
        charCount: Int
    ) -> Float {
        let t = state.t.p
        let concat = state.concat.p
        let window = state.window.p
        let mixed = state.mixed.p
        let z = state.z.p

        // Input projection + style vector, sqrt(0.5)-scaled.
        widen(state.input.p, 3, into: concat)
        matvec(concat, 3, inputKernel.p, HIDDEN, into: t)
        for i in 0 ..< HIDDEN {
            let projected = Float(Double(t[i]) + Double(inputBias.p[i]))
            t[i] = Float(Double(Float(Double(projected) + Double(z[i]))) * SKIP)
        }

        widen(t, HIDDEN, into: concat)
        lstm(state, inputLength: HIDDEN, state.h1.p, state.c1.p, kernel1, lstm1Bias)
        let h1 = state.h1.p
        for i in 0 ..< HIDDEN {
            t[i] = Float(Double(Float(Double(t[i]) + Double(h1[i]))) * SKIP)
        }

        // LSTM2 sees [t | previous window].
        widen(t, HIDDEN, into: concat)
        widen(window, HIDDEN, into: concat + HIDDEN)
        lstm(state, inputLength: 2 * HIDDEN, state.h2.p, state.c2.p, kernel2, lstm2Bias)

        attend(state, encoded, charCount)

        // Mix [h2 | new window] back into the skip path.
        widen(state.h2.p, HIDDEN, into: concat)
        widen(window, HIDDEN, into: concat + HIDDEN)
        csrMatvec(concat, mixKernel, into: mixed)
        for i in 0 ..< HIDDEN {
            let biased = Float(Double(mixed[i]) + Double(mixBias.p[i]))
            mixed[i] = Float(tanhD(Double(biased)))
        }
        for i in 0 ..< HIDDEN {
            t[i] = Float(Double(Float(Double(t[i]) + Double(mixed[i]))) * SKIP)
        }

        var terminationSum = 0.0
        for i in 0 ..< HIDDEN {
            terminationSum += Double(window[i]) * terminationKernel.p[i]
        }
        let terminationRaw = Float(Double(Float(terminationSum)) + Double(terminationBias.p[0]))
        let termination = Float(sigmoidD(Double(terminationRaw)))

        widen(t, HIDDEN, into: concat)
        lstm(state, inputLength: HIDDEN, state.h3.p, state.c3.p, kernel3, lstm3Bias)
        let h3 = state.h3.p
        for i in 0 ..< HIDDEN {
            t[i] = Float(Double(Float(Double(t[i]) + Double(h3[i]))) * SKIP)
        }

        let output = state.output.p
        widen(t, HIDDEN, into: concat)
        matvec(concat, HIDDEN, mdnKernel.p, MDN_OUTPUTS, into: output)
        for i in 0 ..< MDN_OUTPUTS {
            output[i] = Float(Double(output[i]) + Double(mdnBias.p[i]))
        }
        return termination
    }

    /// Sample an offset from the 121 raw outputs in state.output. Random
    /// draws (order and formulas) mirror the reference exactly: one uniform
    /// for the pen bit, one Gumbel per mixture component, then four
    /// uniforms for the two correlated normals. Only the picked component's
    /// sigma/rho/mu get transformed, which is safe because those transforms
    /// are elementwise.
    func sample(_ state: CellState, bias: Double, rng: inout Rng) -> (dx: Float, dy: Float, pen: Float) {
        let output = state.output.p
        let logPi = state.logPi.p

        let penProbability = Float(sigmoidD(Double(output[120])))
        let pen: Float = rng.uniform() < Double(penProbability) ? 1 : 0

        // Softmax over the mixture logits (output[6k]), then log, sharpen
        // by (1 + bias), and push near-zero components out of reach.
        var total = 0.0
        for k in 0 ..< OUTPUT_MIXTURES {
            logPi[k] = Float(exp(Double(output[6 * k])))
            total += Double(logPi[k])
        }
        let cutoff = log(0.02)
        for k in 0 ..< OUTPUT_MIXTURES {
            let soft = Float(Double(logPi[k]) / total)
            var sharpened = Float(Double(Float(log(Double(soft)))) * (1 + bias))
            if Double(sharpened) < cutoff { sharpened = Float(Double(sharpened) - 100) }
            logPi[k] = sharpened
        }

        // Gumbel-max over the sharpened log-weights.
        var best = -1e6
        var pick = 0
        for k in 0 ..< OUTPUT_MIXTURES {
            let perturbed = Double(logPi[k]) + -log(-log(rng.uniform()))
            if perturbed > best {
                best = perturbed
                pick = k
            }
        }

        let sx = Float(Double(Float(softplusD(Double(output[6 * pick + 1])))) / exp(bias))
        let sy = Float(Double(Float(softplusD(Double(output[6 * pick + 2])))) / exp(bias))
        let r = Float(tanhD(Double(output[6 * pick + 3])))
        // Cholesky factor [sx, r*sy; 0, sy*sqrt(1 - r^2)] applied to two
        // Box-Muller normals.
        let chol1 = Float(Double(r) * Double(sy))
        let chol3 = Float(Double(sy) * (1 - Double(r) * Double(r)).squareRoot())
        var noise = (Float(0), Float(0))
        for i in 0 ..< 2 {
            let u1 = 1 - rng.uniform()
            let u2 = 1 - rng.uniform()
            let value = Float((-2 * log(u1)).squareRoot() * cos(2 * .pi * u2))
            if i == 0 { noise.0 = value } else { noise.1 = value }
        }
        let spreadX = Float(Double(noise.0) * Double(sx) + Double(noise.1) * 0)
        let spreadY = Float(Double(noise.0) * Double(chol1) + Double(noise.1) * Double(chol3))
        let dx = Float(Double(output[6 * pick + 4]) + Double(spreadX))
        let dy = Float(Double(output[6 * pick + 5]) + Double(spreadY))
        return (dx: dx, dy: dy, pen: pen)
    }
}
