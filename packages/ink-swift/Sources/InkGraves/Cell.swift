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
/// products go through vDSP where available (fast even in debug builds);
/// the nonlinear tails run in Double like the JS engine's number math.

import Foundation
#if canImport(Accelerate)
import Accelerate
#endif

let HIDDEN = 400
let ATTENTION_MIXTURES = 10
let OUTPUT_MIXTURES = 20
let ALPHABET_SIZE = 73
let MAX_CHARS = 120

private let GATES = 4 * HIDDEN
private let EPSILON = 1e-8
private let SIGMA_FLOOR = 1e-4

public final class CellState {
    public var h1 = [Float](repeating: 0, count: HIDDEN)
    public var c1 = [Float](repeating: 0, count: HIDDEN)
    public var h2 = [Float](repeating: 0, count: HIDDEN)
    public var c2 = [Float](repeating: 0, count: HIDDEN)
    public var h3 = [Float](repeating: 0, count: HIDDEN)
    public var c3 = [Float](repeating: 0, count: HIDDEN)
    public var kappa = [Float](repeating: 0, count: ATTENTION_MIXTURES)
    public var w = [Float](repeating: 0, count: ALPHABET_SIZE)
    public var phi = [Float](repeating: 0, count: MAX_CHARS)
}

public final class MdnParams {
    public var pi = [Float](repeating: 0, count: OUTPUT_MIXTURES)
    public var muX = [Float](repeating: 0, count: OUTPUT_MIXTURES)
    public var muY = [Float](repeating: 0, count: OUTPUT_MIXTURES)
    public var sigmaX = [Float](repeating: 0, count: OUTPUT_MIXTURES)
    public var sigmaY = [Float](repeating: 0, count: OUTPUT_MIXTURES)
    public var rho = [Float](repeating: 0, count: OUTPUT_MIXTURES)
    public var eos: Float = 0
}

/// One raw model output row: pen movement delta and end-of-stroke flag.
public struct StrokeOffset: Equatable, Sendable {
    public let dx: Double
    public let dy: Double
    public let eos: Bool

    public init(dx: Double, dy: Double, eos: Bool) {
        self.dx = dx
        self.dy = dy
        self.eos = eos
    }
}

@inline(__always) private func sigmoid(_ v: Double) -> Double {
    1 / (1 + exp(-v))
}

@inline(__always) private func softplus(_ v: Double) -> Double {
    v > 30 ? v : log1p(exp(v))
}

/// y[0..<nOut] += x @ kernel[rowOffset ..< rowOffset + x.count], kernel
/// row-major (rows, nOut).
private func accumulate(
    _ y: inout [Float],
    kernel: [Float],
    rowOffset: Int,
    nOut: Int,
    x: [Float],
    scratch: inout [Float]
) {
    #if canImport(Accelerate)
    kernel.withUnsafeBufferPointer { kernelBuffer in
        x.withUnsafeBufferPointer { xBuffer in
            scratch.withUnsafeMutableBufferPointer { scratchBuffer in
                vDSP_mmul(
                    xBuffer.baseAddress!, 1,
                    kernelBuffer.baseAddress! + rowOffset * nOut, 1,
                    scratchBuffer.baseAddress!, 1,
                    1, vDSP_Length(nOut), vDSP_Length(x.count)
                )
                y.withUnsafeMutableBufferPointer { yBuffer in
                    vDSP_vadd(
                        yBuffer.baseAddress!, 1,
                        scratchBuffer.baseAddress!, 1,
                        yBuffer.baseAddress!, 1,
                        vDSP_Length(nOut)
                    )
                }
            }
        }
    }
    #else
    for i in 0 ..< x.count {
        let xi = x[i]
        if xi == 0 { continue }
        let base = (rowOffset + i) * nOut
        for j in 0 ..< nOut { y[j] += kernel[base + j] * xi }
    }
    #endif
}

@inline(__always) private func load(_ destination: inout [Float], from source: [Float]) {
    destination.withUnsafeMutableBufferPointer { destinationBuffer in
        source.withUnsafeBufferPointer { sourceBuffer in
            destinationBuffer.baseAddress!.update(from: sourceBuffer.baseAddress!, count: sourceBuffer.count)
        }
    }
}

public final class Cell {
    public static let hidden = HIDDEN
    public static let attentionMixtures = ATTENTION_MIXTURES
    public static let outputMixtures = OUTPUT_MIXTURES
    public static let alphabetSize = ALPHABET_SIZE
    public static let maxChars = MAX_CHARS

    private let k1: [Float]
    private let b1: [Float]
    private let k2: [Float]
    private let b2: [Float]
    private let k3: [Float]
    private let b3: [Float]
    private let kAtt: [Float]
    private let bAtt: [Float]
    private let kGmm: [Float]
    private let bGmm: [Float]

    // Per-step scratch, reused across calls.
    private var gates = [Float](repeating: 0, count: GATES)
    private var attRaw = [Float](repeating: 0, count: 3 * ATTENTION_MIXTURES)
    private var gmmRaw = [Float](repeating: 0, count: 6 * OUTPUT_MIXTURES + 1)
    private var windowScratch = [Float](repeating: 0, count: ALPHABET_SIZE)
    private var inputScratch = [Float](repeating: 0, count: 3)
    private var matvecScratch = [Float](repeating: 0, count: GATES)

    public init(assets: ModelAssets) throws {
        func tensor(_ name: String) throws -> [Float] {
            guard let found = assets.tensors[name] else { throw CALWError.missingTensor(name) }
            return found.data
        }
        k1 = try tensor("lstm1_kernel")
        b1 = try tensor("lstm1_bias")
        k2 = try tensor("lstm2_kernel")
        b2 = try tensor("lstm2_bias")
        k3 = try tensor("lstm3_kernel")
        b3 = try tensor("lstm3_bias")
        kAtt = try tensor("attention_weights")
        bAtt = try tensor("attention_biases")
        kGmm = try tensor("gmm_weights")
        bGmm = try tensor("gmm_biases")
    }

    public func initialState() -> CellState {
        CellState()
    }

    public func newMdnParams() -> MdnParams {
        MdnParams()
    }

    /// In-place LSTM update from the fused gate buffer, TF gate order (i, j, f, o).
    private func applyLstm(hidden: inout [Float], cell: inout [Float]) {
        for m in 0 ..< HIDDEN {
            let inputGate = sigmoid(Double(gates[m]))
            let candidate = tanh(Double(gates[HIDDEN + m]))
            let forgetGate = sigmoid(Double(gates[2 * HIDDEN + m]))
            let outputGate = sigmoid(Double(gates[3 * HIDDEN + m]))
            let newCell = forgetGate * Double(cell[m]) + inputGate * candidate
            cell[m] = Float(newCell)
            hidden[m] = Float(outputGate * tanh(newCell))
        }
    }

    /// One timestep. Mutates `state` in place. `chars` holds alphabet indices
    /// (the encoded text, zero-padded to maxChars); `charLength` is the true
    /// encoded length.
    public func step(
        _ state: CellState,
        dx: Float,
        dy: Float,
        eos: Float,
        chars: [Int32],
        charLength: Int
    ) {
        inputScratch[0] = dx
        inputScratch[1] = dy
        inputScratch[2] = eos

        // LSTM 1: [w_prev, x, h1_prev]
        load(&gates, from: b1)
        accumulate(&gates, kernel: k1, rowOffset: 0, nOut: GATES, x: state.w, scratch: &matvecScratch)
        accumulate(&gates, kernel: k1, rowOffset: ALPHABET_SIZE, nOut: GATES, x: inputScratch, scratch: &matvecScratch)
        accumulate(&gates, kernel: k1, rowOffset: ALPHABET_SIZE + 3, nOut: GATES, x: state.h1, scratch: &matvecScratch)
        applyLstm(hidden: &state.h1, cell: &state.c1)

        // Attention: [w_prev, x, h1] -> softplus -> (alpha, beta, kappa step)
        load(&attRaw, from: bAtt)
        accumulate(&attRaw, kernel: kAtt, rowOffset: 0, nOut: 30, x: state.w, scratch: &matvecScratch)
        accumulate(&attRaw, kernel: kAtt, rowOffset: ALPHABET_SIZE, nOut: 30, x: inputScratch, scratch: &matvecScratch)
        accumulate(&attRaw, kernel: kAtt, rowOffset: ALPHABET_SIZE + 3, nOut: 30, x: state.h1, scratch: &matvecScratch)
        for i in 0 ..< 30 { attRaw[i] = Float(softplus(Double(attRaw[i]))) }
        for k in 0 ..< ATTENTION_MIXTURES {
            state.kappa[k] = Float(Double(state.kappa[k]) + Double(attRaw[20 + k]) / 25.0)
            if attRaw[10 + k] < 0.01 { attRaw[10 + k] = 0.01 } // beta floor
        }
        for u in 0 ..< MAX_CHARS {
            var sum = 0.0
            for k in 0 ..< ATTENTION_MIXTURES {
                let diff = Double(state.kappa[k]) - Double(u)
                sum += Double(attRaw[k]) * exp(-(diff * diff) / Double(attRaw[10 + k]))
            }
            state.phi[u] = Float(sum)
        }
        for i in 0 ..< ALPHABET_SIZE { windowScratch[i] = 0 }
        for u in 0 ..< charLength {
            windowScratch[Int(chars[u])] += state.phi[u]
        }
        load(&state.w, from: windowScratch)

        // LSTM 2: [x, h1, w, h2_prev]
        load(&gates, from: b2)
        accumulate(&gates, kernel: k2, rowOffset: 0, nOut: GATES, x: inputScratch, scratch: &matvecScratch)
        accumulate(&gates, kernel: k2, rowOffset: 3, nOut: GATES, x: state.h1, scratch: &matvecScratch)
        accumulate(&gates, kernel: k2, rowOffset: 3 + HIDDEN, nOut: GATES, x: state.w, scratch: &matvecScratch)
        accumulate(&gates, kernel: k2, rowOffset: 3 + HIDDEN + ALPHABET_SIZE, nOut: GATES, x: state.h2, scratch: &matvecScratch)
        applyLstm(hidden: &state.h2, cell: &state.c2)

        // LSTM 3: [x, h2, w, h3_prev]
        load(&gates, from: b3)
        accumulate(&gates, kernel: k3, rowOffset: 0, nOut: GATES, x: inputScratch, scratch: &matvecScratch)
        accumulate(&gates, kernel: k3, rowOffset: 3, nOut: GATES, x: state.h2, scratch: &matvecScratch)
        accumulate(&gates, kernel: k3, rowOffset: 3 + HIDDEN, nOut: GATES, x: state.w, scratch: &matvecScratch)
        accumulate(&gates, kernel: k3, rowOffset: 3 + HIDDEN + ALPHABET_SIZE, nOut: GATES, x: state.h3, scratch: &matvecScratch)
        applyLstm(hidden: &state.h3, cell: &state.c3)
    }

    /// MDN head with the Graves bias (sharpness) trick. Matches the reference:
    /// pi logits scaled by (1 + bias), log-sigmas shifted down by bias, then
    /// pi and eos snapped to zero below 0.01 (pi is NOT renormalized).
    public func mdnParse(h3: [Float], bias: Double, into out: MdnParams) {
        load(&gmmRaw, from: bGmm)
        accumulate(&gmmRaw, kernel: kGmm, rowOffset: 0, nOut: 6 * OUTPUT_MIXTURES + 1, x: h3, scratch: &matvecScratch)
        let raw = gmmRaw

        let M = OUTPUT_MIXTURES
        var maxLogit = -Double.infinity
        for m in 0 ..< M {
            let logit = Double(raw[m]) * (1 + bias)
            out.pi[m] = Float(logit)
            if logit > maxLogit { maxLogit = logit }
        }
        var total = 0.0
        for m in 0 ..< M {
            let value = exp(Double(out.pi[m]) - maxLogit)
            out.pi[m] = Float(value)
            total += value
        }
        for m in 0 ..< M {
            let p = Double(out.pi[m]) / total
            out.pi[m] = p < 0.01 ? 0 : Float(p)
            out.sigmaX[m] = Float(max(exp(Double(raw[M + m]) - bias), SIGMA_FLOOR))
            out.sigmaY[m] = Float(max(exp(Double(raw[2 * M + m]) - bias), SIGMA_FLOOR))
            let tanhRho = tanh(Double(raw[3 * M + m]))
            out.rho[m] = Float(min(max(tanhRho, EPSILON - 1), 1 - EPSILON))
            out.muX[m] = raw[4 * M + m]
            out.muY[m] = raw[5 * M + m]
        }
        let eosProbability = min(max(sigmoid(Double(raw[6 * M])), EPSILON), 1 - EPSILON)
        out.eos = eosProbability < 0.01 ? 0 : Float(eosProbability)
    }

    /// Draw one (Δx, Δy, eos) from parsed MDN params.
    public func mdnSample(_ params: MdnParams, rng: inout Rng) -> StrokeOffset {
        let component = rng.categorical(params.pi)
        let z1 = rng.normal()
        let z2 = rng.normal()
        let rho = Double(params.rho[component])
        let dx = Double(params.muX[component]) + Double(params.sigmaX[component]) * z1
        let dy = Double(params.muY[component])
            + Double(params.sigmaY[component]) * (rho * z1 + max(1 - rho * rho, 0).squareRoot() * z2)
        let eos = rng.uniform() < Double(params.eos)
        return StrokeOffset(dx: dx, dy: dy, eos: eos)
    }
}
