/// High-level generation API over the Cell, mirroring the TS engine
/// (packages/ink-graves/src/engine.ts): optional style priming,
/// autoregressive sampling with bias sharpening, and attention-based
/// termination.

import Foundation
import InkCore

public let STEPS_PER_CHARACTER = 40

public enum GravesError: Error, CustomStringConvertible {
    case unknownStyle(Int)
    case missingStyleTensor(String)
    case textTooLong(encodedLength: Int, max: Int)
    case missingBundledWeights

    public var description: String {
        switch self {
        case .unknownStyle(let style): return "unknown style \(style)"
        case .missingStyleTensor(let name): return "missing style tensor \(name)"
        case .textTooLong(let encodedLength, let max):
            return "encoded text length \(encodedLength) exceeds \(max)"
        case .missingBundledWeights:
            return "graves-v1.bin is missing from the package resources"
        }
    }
}

public final class GravesModel {
    public let assets: ModelAssets
    private let cell: Cell
    private let charToIndex: [Character: Int32]

    public init(assets: ModelAssets) throws {
        self.assets = assets
        self.cell = try Cell(assets: assets)
        var map = [Character: Int32](minimumCapacity: assets.alphabet.count)
        for (index, entry) in assets.alphabet.enumerated() {
            if entry.count == 1, let character = entry.first {
                map[character] = Int32(index)
            }
        }
        self.charToIndex = map
    }

    public var styles: [Int] {
        assets.styles.map(\.id)
    }

    /// Encode text to alphabet indices with the trailing 0 terminator.
    public func encode(_ text: String) -> [Int32] {
        var encoded = [Int32](repeating: 0, count: text.count + 1)
        for (index, character) in text.enumerated() {
            encoded[index] = charToIndex[character] ?? 0
        }
        return encoded
    }

    /// Characters the model was trained on. Anything else must be substituted.
    public func supports(_ character: Character) -> Bool {
        charToIndex[character] != nil
    }

    public func writer(
        _ text: String,
        bias: Double = 0.5,
        style: Int? = nil,
        seed: UInt32 = 0
    ) throws -> GravesWriter {
        try GravesWriter(model: self, cell: cell, text: text, bias: bias, style: style, seed: seed)
    }

    /// Generate a full line synchronously.
    public func write(
        _ text: String,
        bias: Double = 0.5,
        style: Int? = nil,
        seed: UInt32 = 0
    ) throws -> [StrokeOffset] {
        try writer(text, bias: bias, style: style, seed: seed).run()
    }
}

public final class GravesWriter {
    public let text: String
    public let bias: Double
    public private(set) var done = false

    private let cell: Cell
    private var rng: Rng
    private let state: CellState
    private var chars: [Int32]
    private let charLength: Int
    private let params: MdnParams
    private var lastInput: (dx: Float, dy: Float, eos: Float) = (0, 0, 1)

    init(model: GravesModel, cell: Cell, text: String, bias: Double, style: Int?, seed: UInt32) throws {
        self.text = text
        self.bias = bias
        self.cell = cell
        self.rng = Rng(seed: seed)
        self.state = cell.initialState()
        self.params = cell.newMdnParams()

        let encoded: [Int32]
        var primeStrokes: [Float]? = nil
        if let style {
            guard let styleInfo = model.assets.styles.first(where: { $0.id == style }) else {
                throw GravesError.unknownStyle(style)
            }
            guard let tensor = model.assets.tensors[styleInfo.tensor] else {
                throw GravesError.missingStyleTensor(styleInfo.tensor)
            }
            primeStrokes = tensor.data
            encoded = model.encode(styleInfo.primer + " " + text)
        } else {
            encoded = model.encode(text)
        }
        guard encoded.count <= Cell.maxChars else {
            throw GravesError.textTooLong(encodedLength: encoded.count, max: Cell.maxChars)
        }
        var chars = [Int32](repeating: 0, count: Cell.maxChars)
        chars.replaceSubrange(0 ..< encoded.count, with: encoded)
        self.chars = chars
        self.charLength = encoded.count

        if let primeStrokes { prime(primeStrokes) }
    }

    /// Teacher-force the style's pen data through the cell, then draw the
    /// first free-run input from the primed state (it is consumed as input,
    /// never emitted — matching the reference).
    private func prime(_ strokes: [Float]) {
        let steps = strokes.count / 3
        for t in 0 ..< steps {
            cell.step(
                state,
                dx: strokes[3 * t],
                dy: strokes[3 * t + 1],
                eos: strokes[3 * t + 2],
                chars: chars,
                charLength: charLength
            )
        }
        cell.mdnParse(h3: state.h3, bias: bias, into: params)
        let sample = cell.mdnSample(params, rng: &rng)
        lastInput = (Float(sample.dx), Float(sample.dy), sample.eos ? 1 : 0)
    }

    /// Advance one timestep. Returns the sampled offset, or nil once done.
    public func step() -> StrokeOffset? {
        if done { return nil }
        cell.step(state, dx: lastInput.dx, dy: lastInput.dy, eos: lastInput.eos, chars: chars, charLength: charLength)
        cell.mdnParse(h3: state.h3, bias: bias, into: params)
        let offset = cell.mdnSample(params, rng: &rng)
        lastInput = (Float(offset.dx), Float(offset.dy), offset.eos ? 1 : 0)

        // Termination mirrors Generator._flush: attention argmax past the end,
        // or on the final character while the pen lifts.
        var argmax = 0
        var best = state.phi[0]
        for u in 1 ..< Cell.maxChars {
            if state.phi[u] > best {
                best = state.phi[u]
                argmax = u
            }
        }
        let pastFinal = argmax >= charLength
        let finalWithEos = argmax >= charLength - 1 && offset.eos
        if pastFinal || finalWithEos { done = true }

        return offset
    }

    /// Run to termination (or the step budget) and return all offsets.
    /// The default budget floors at 4 characters — very short text often
    /// needs more than its own step allowance to finish a stroke — and
    /// matches the TS engine and the web app's worker, so a `write()`
    /// reproduces an on-screen take exactly.
    public func run(maxSteps: Int? = nil) -> [StrokeOffset] {
        let limit = maxSteps ?? STEPS_PER_CHARACTER * max(text.count, 4)
        var offsets: [StrokeOffset] = []
        for _ in 0 ..< limit {
            guard let offset = step() else { break }
            offsets.append(offset)
        }
        return offsets
    }
}
