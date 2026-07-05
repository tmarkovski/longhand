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
/// the same points — and uses plain loops so summation order matches too.

import Foundation
import InkCore

let HIDDEN = 256
let ATTENTION_MIXTURES = 10
let OUTPUT_MIXTURES = 20
let MDN_OUTPUTS = 121

private let SKIP = (0.5 as Double).squareRoot()

public final class CellState {
    var h1: [Float]
    var c1: [Float]
    var h2: [Float]
    var c2: [Float]
    var h3: [Float]
    var c3: [Float]
    /// Attention window from the previous step.
    var window: [Float]
    var kappa: [Float]
    /// Attention grid positions: [-0.5, 0.5, ..., n - 0.5] (n+1 values).
    let grid: [Float]
    /// Style conditioning vector, added to every input projection.
    let z: [Float]

    init(
        h1: [Float], c1: [Float], h2: [Float], c2: [Float], h3: [Float], c3: [Float],
        window: [Float], kappa: [Float], grid: [Float], z: [Float]
    ) {
        self.h1 = h1
        self.c1 = c1
        self.h2 = h2
        self.c2 = c2
        self.h3 = h3
        self.c3 = c3
        self.window = window
        self.kappa = kappa
        self.grid = grid
        self.z = z
    }
}

private func mapv(_ values: [Float], _ fn: (Double) -> Double) -> [Float] {
    var out = [Float](repeating: 0, count: values.count)
    for i in 0 ..< values.count { out[i] = Float(fn(Double(values[i]))) }
    return out
}

private func sigmoidV(_ values: [Float]) -> [Float] {
    mapv(values) { 1 / (1 + exp(-$0)) }
}

private func softplusV(_ values: [Float]) -> [Float] {
    mapv(values) { log(1 + exp($0)) }
}

// The reference computes tanh via (e^2v - 1) / (e^2v + 1); kept verbatim so
// edge behavior (overflow to NaN included) matches.
private func tanhV(_ values: [Float]) -> [Float] {
    mapv(values) { value in
        let e = exp(2 * value)
        return (e - 1) / (e + 1)
    }
}

private func addV(_ a: [Float], _ b: [Float]) -> [Float] {
    var out = [Float](repeating: 0, count: a.count)
    for i in 0 ..< a.count { out[i] = Float(Double(a[i]) + Double(b[i])) }
    return out
}

private func mulV(_ a: [Float], _ b: [Float]) -> [Float] {
    var out = [Float](repeating: 0, count: a.count)
    for i in 0 ..< a.count { out[i] = Float(Double(a[i]) * Double(b[i])) }
    return out
}

private func scaleV(_ a: [Float], _ s: Double) -> [Float] {
    var out = [Float](repeating: 0, count: a.count)
    for i in 0 ..< a.count { out[i] = Float(Double(a[i]) * s) }
    return out
}

private func softmaxV(_ values: [Float]) -> [Float] {
    var out = [Float](repeating: 0, count: values.count)
    var total = 0.0
    for i in 0 ..< values.count {
        out[i] = Float(exp(Double(values[i])))
        total += Double(out[i])
    }
    for i in 0 ..< out.count { out[i] = Float(Double(out[i]) / total) }
    return out
}

// The two matvecs dominate generation time, so they run over unsafe buffer
// pointers: identical arithmetic and summation order, minus the per-element
// bounds checks that make -Onone builds crawl.

/// Dense matvec, weights laid out [input, output] row-major.
private func matvec(_ x: [Float], _ weights: [Float], _ outDim: Int) -> [Float] {
    var out = [Float](repeating: 0, count: outDim)
    let inDim = x.count
    x.withUnsafeBufferPointer { xBuffer in
        weights.withUnsafeBufferPointer { weightBuffer in
            out.withUnsafeMutableBufferPointer { outBuffer in
                for o in 0 ..< outDim {
                    var sum = 0.0
                    for i in 0 ..< inDim {
                        sum += Double(xBuffer[i]) * Double(weightBuffer[i * outDim + o])
                    }
                    outBuffer[o] = Float(sum)
                }
            }
        }
    }
    return out
}

private func csrMatvec(_ x: [Float], _ m: SparseTensor) -> [Float] {
    var out = [Float](repeating: 0, count: m.rows)
    x.withUnsafeBufferPointer { xBuffer in
        m.values.withUnsafeBufferPointer { valueBuffer in
            m.colIndex.withUnsafeBufferPointer { columnBuffer in
                m.rowPtr.withUnsafeBufferPointer { rowBuffer in
                    out.withUnsafeMutableBufferPointer { outBuffer in
                        for row in 0 ..< m.rows {
                            var sum = 0.0
                            let end = Int(rowBuffer[row + 1])
                            var i = Int(rowBuffer[row])
                            while i < end {
                                sum += Double(valueBuffer[i]) * Double(xBuffer[Int(columnBuffer[i])])
                                i += 1
                            }
                            outBuffer[row] = Float(sum)
                        }
                    }
                }
            }
        }
    }
    return out
}

public final class CalligrapherCell {
    public static let hidden = HIDDEN
    public static let attentionMixtures = ATTENTION_MIXTURES
    public static let outputMixtures = OUTPUT_MIXTURES
    public static let mdnOutputs = MDN_OUTPUTS

    // Sparse kernels (CSR).
    private let kernel1: SparseTensor
    private let kernel2: SparseTensor
    private let kernel3: SparseTensor
    private let mixKernel: SparseTensor

    // Dense tensors, resolved once by their single-letter container names.
    private let inputKernel: [Float] // i
    private let inputBias: [Float] // W
    private let lstm1Bias: [Float] // p
    private let lstm2Bias: [Float] // q
    private let lstm3Bias: [Float] // f
    private let attentionKernel: [Float] // h
    private let attentionBias: [Float] // n
    private let mixBias: [Float] // Q
    private let terminationKernel: [Float] // c
    private let terminationBias: [Float] // u
    private let mdnKernel: [Float] // z
    private let mdnBias: [Float] // v
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

    public init(assets: CalligrapherAssets) throws {
        func dense(_ name: String) throws -> [Float] {
            guard let tensor = assets.dense[name] else {
                throw CalligrapherError.missingTensor(name)
            }
            return tensor.data
        }
        func sparse(_ name: String) throws -> SparseTensor {
            guard let tensor = assets.sparse[name] else {
                throw CalligrapherError.missingSparseTensor(name)
            }
            return tensor
        }
        kernel1 = try sparse("y")
        kernel2 = try sparse("w")
        kernel3 = try sparse("r")
        mixKernel = try sparse("l")
        inputKernel = try dense("i")
        inputBias = try dense("W")
        lstm1Bias = try dense("p")
        lstm2Bias = try dense("q")
        lstm3Bias = try dense("f")
        attentionKernel = try dense("h")
        attentionBias = try dense("n")
        mixBias = try dense("Q")
        terminationKernel = try dense("c")
        terminationBias = try dense("u")
        mdnKernel = try dense("z")
        mdnBias = try dense("v")
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
    /// 512 -> 256. Returns an (n, 256) row-major matrix.
    public func encodeText(_ ids: [Int32]) -> [Float] {
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
                conv[row * HIDDEN + i] = Float(Double(conv[row * HIDDEN + i]) + Double(convBias[i]))
            }
        }
        let activated = tanhV(conv)

        var encoded = [Float](repeating: 0, count: n * HIDDEN)
        var combined = [Float](repeating: 0, count: 2 * HIDDEN)
        for row in 0 ..< n {
            // Row = [embedding without pads | conv], projected 512 -> 256.
            for i in 0 ..< HIDDEN {
                combined[i] = embedded[(row + 1) * HIDDEN + i]
                combined[HIDDEN + i] = activated[row * HIDDEN + i]
            }
            let projected = matvec(combined, projection, HIDDEN)
            for i in 0 ..< HIDDEN {
                encoded[row * HIDDEN + i] = Float(Double(projected[i]) + Double(projectionBias[i]))
            }
        }
        return encoded
    }

    /// Fresh state for a text of `charCount` encoded ids, conditioned on a style.
    public func initialState(charCount: Int, styleIndex: Int) -> CellState {
        let styleVector = Array(styleEmbeddings[styleIndex * 64 ..< (styleIndex + 1) * 64])
        let z = addV(matvec(styleVector, styleKernel, HIDDEN), styleBias)
        var grid = [Float](repeating: 0, count: charCount + 1)
        for i in 0 ... charCount { grid[i] = Float(Double(i) - 0.5) }
        return CellState(
            h1: initialH1, c1: initialC1,
            h2: initialH2, c2: initialC2,
            h3: initialH3, c3: initialC3,
            window: initialWindow,
            kappa: [Float](repeating: 0, count: ATTENTION_MIXTURES),
            grid: grid,
            z: z
        )
    }

    private func lstm(
        _ input: [Float],
        _ h: [Float],
        _ c: [Float],
        _ kernel: SparseTensor,
        _ bias: [Float]
    ) -> ([Float], [Float]) {
        let gates = addV(csrMatvec(input + h, kernel), bias)
        let inGate = Array(gates[0 ..< HIDDEN])
        let candidate = Array(gates[HIDDEN ..< 2 * HIDDEN])
        let forgetGate = Array(gates[2 * HIDDEN ..< 3 * HIDDEN])
        let outGate = Array(gates[3 * HIDDEN ..< 4 * HIDDEN])
        let cNext = addV(mulV(sigmoidV(forgetGate), c), mulV(sigmoidV(inGate), tanhV(candidate)))
        let hNext = mulV(sigmoidV(outGate), tanhV(cNext))
        return (hNext, cNext)
    }

    /// Gaussian-window attention (difference-of-sigmoids form): 10 mixtures
    /// with monotonically advancing kappa, soft-attending over the encoded
    /// text. Updates state.kappa and returns the new 256-dim window.
    private func attend(
        _ h2: [Float],
        _ state: CellState,
        _ encoded: [Float],
        _ charCount: Int
    ) -> [Float] {
        let raw = addV(matvec(h2, attentionKernel, 3 * ATTENTION_MIXTURES), attentionBias)
        let alpha = softmaxV(Array(raw[0 ..< ATTENTION_MIXTURES]))
        let beta = softplusV(Array(raw[ATTENTION_MIXTURES ..< 2 * ATTENTION_MIXTURES]))
        let kappaStep = softplusV(Array(raw[2 * ATTENTION_MIXTURES ..< 3 * ATTENTION_MIXTURES]))
        var kappa = [Float](repeating: 0, count: ATTENTION_MIXTURES)
        for k in 0 ..< ATTENTION_MIXTURES {
            kappa[k] = Float(Double(state.kappa[k]) + Double(Float(Double(kappaStep[k]) / 15)))
        }
        state.kappa = kappa

        // phi[e] = sum_k alpha_k * (cdf_k(grid[e+1]) - cdf_k(grid[e]))
        var phi = [Float](repeating: 0, count: charCount)
        var cdf = [Float](repeating: 0, count: charCount + 1)
        for k in 0 ..< ATTENTION_MIXTURES {
            for e in 0 ... charCount {
                let centered = Float(Double(state.grid[e]) - Double(kappa[k]))
                cdf[e] = Float(1 / (1 + exp(-Double(Float(Double(centered) / Double(beta[k]))))))
            }
            for e in 0 ..< charCount {
                phi[e] = Float(
                    Double(phi[e]) + Double(Float(Double(alpha[k]) * Double(Float(Double(cdf[e + 1]) - Double(cdf[e])))))
                )
            }
        }

        var window = [Float](repeating: 0, count: HIDDEN)
        for e in 0 ..< charCount {
            let weight = phi[e]
            for i in 0 ..< HIDDEN {
                window[i] = Float(Double(window[i]) + Double(Float(Double(weight) * Double(encoded[e * HIDDEN + i]))))
            }
        }
        return window
    }

    /// One timestep. Consumes the previous offset [dx, dy, pen], mutates the
    /// state, and returns the 121 raw MDN outputs plus the termination
    /// probability (attention past the end of the text).
    public func step(
        _ state: CellState,
        input: [Float],
        encoded: [Float],
        charCount: Int
    ) -> (output: [Float], termination: Float) {
        var t = addV(matvec(input, inputKernel, HIDDEN), inputBias)
        t = scaleV(addV(t, state.z), SKIP)

        let (h1, c1) = lstm(t, state.h1, state.c1, kernel1, lstm1Bias)
        state.h1 = h1
        state.c1 = c1
        t = scaleV(addV(t, h1), SKIP)

        let (h2, c2) = lstm(t + state.window, state.h2, state.c2, kernel2, lstm2Bias)
        state.h2 = h2
        state.c2 = c2

        let window = attend(h2, state, encoded, charCount)
        state.window = window

        let mixed = tanhV(addV(csrMatvec(h2 + window, mixKernel), mixBias))
        t = scaleV(addV(t, mixed), SKIP)

        let termination = sigmoidV(addV(matvec(window, terminationKernel, 1), terminationBias))[0]

        let (h3, c3) = lstm(t, state.h3, state.c3, kernel3, lstm3Bias)
        state.h3 = h3
        state.c3 = c3
        t = scaleV(addV(t, h3), SKIP)

        return (addV(matvec(t, mdnKernel, MDN_OUTPUTS), mdnBias), termination)
    }

    /// Sample an offset from the 121 raw outputs. Random draws (order and
    /// formulas) mirror the reference exactly: one uniform for the pen bit,
    /// one Gumbel per mixture component, then four uniforms for the two
    /// correlated normals.
    public func sample(_ output: [Float], bias: Double, rng: inout Rng) -> [Float] {
        let penProbability = sigmoidV([output[120]])[0]
        let pen: Float = rng.uniform() < Double(penProbability) ? 1 : 0

        var pi = [Float](repeating: 0, count: OUTPUT_MIXTURES)
        var sigma = [Float](repeating: 0, count: 2 * OUTPUT_MIXTURES)
        var rho = [Float](repeating: 0, count: OUTPUT_MIXTURES)
        var mu = [Float](repeating: 0, count: 2 * OUTPUT_MIXTURES)
        for k in 0 ..< OUTPUT_MIXTURES {
            pi[k] = output[6 * k]
            sigma[2 * k] = output[6 * k + 1]
            sigma[2 * k + 1] = output[6 * k + 2]
            rho[k] = output[6 * k + 3]
            mu[2 * k] = output[6 * k + 4]
            mu[2 * k + 1] = output[6 * k + 5]
        }

        let rhoT = tanhV(rho)
        let sharpSigma = mapv(softplusV(sigma)) { $0 / exp(bias) }
        var logPi = mapv(softmaxV(pi)) { log($0) }
        logPi = scaleV(logPi, 1 + bias)
        let cutoff = log(0.02)
        for k in 0 ..< OUTPUT_MIXTURES {
            if Double(logPi[k]) < cutoff { logPi[k] = Float(Double(logPi[k]) - 100) }
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

        let sx = sharpSigma[2 * pick]
        let sy = sharpSigma[2 * pick + 1]
        let r = rhoT[pick]
        let chol: [Float] = [
            sx,
            Float(Double(r) * Double(sy)),
            0,
            Float(Double(sy) * (1 - Double(r) * Double(r)).squareRoot()),
        ]
        var noise = [Float](repeating: 0, count: 2)
        for i in 0 ..< 2 {
            let u1 = 1 - rng.uniform()
            let u2 = 1 - rng.uniform()
            noise[i] = Float((-2 * log(u1)).squareRoot() * cos(2 * .pi * u2))
        }
        let offset = addV(Array(mu[2 * pick ..< 2 * pick + 2]), matvec(noise, chol, 2))
        return [offset[0], offset[1], pen]
    }
}
