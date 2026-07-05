/// Generation API over the calligrapher cell, ported from
/// packages/ink-calligrapher/src/engine.ts: encode [START, ...text, END],
/// condition on one of the 80 learned style vectors (or a seed-picked
/// random one), then autoregressively sample until the attention head
/// signals the text is exhausted or the step budget runs out. The
/// terminating step's sample is discarded, exactly like the reference.

import Foundation
import InkCore

public enum CalligrapherError: Error, CustomStringConvertible {
    case missingTensor(String)
    case missingSparseTensor(String)
    case unknownStyle(Int)

    public var description: String {
        switch self {
        case .missingTensor(let name): return "missing tensor \(name)"
        case .missingSparseTensor(let name): return "missing sparse tensor \(name)"
        case .unknownStyle(let style): return "unknown style \(style)"
        }
    }
}

public final class CalligrapherModel {
    public static let stepsPerCharacter = 40

    /// The model has 80 learned styles, but many are near-duplicates or
    /// rough; calligrapher.ai's own picker exposes only these (plus random),
    /// so ours does too. The engine itself accepts any id 0-79.
    public static let exposedStyles: [Int] = [1, 2, 3, 4, 5, 6, 7, 8, 9]

    public let assets: CalligrapherAssets
    public let alphabet: [Character] = calligrapherAlphabet
    private let cell: CalligrapherCell

    public init(assets: CalligrapherAssets) throws {
        self.assets = assets
        self.cell = try CalligrapherCell(assets: assets)
    }

    public var styles: [Int] {
        Array(0 ..< assets.styleCount)
    }

    /// Encode text to model ids, wrapped in start/end markers.
    public func encode(_ text: String) -> [Int32] {
        var encoded = [Int32](repeating: 0, count: text.count + 2)
        encoded[0] = START
        for (index, character) in text.enumerated() {
            encoded[index + 1] = charToId[character] ?? UNKNOWN
        }
        encoded[text.count + 1] = END
        return encoded
    }

    public func supports(_ character: Character) -> Bool {
        charToId[character] != nil
    }

    public func writer(
        _ text: String,
        bias: Double = 0.75,
        style: Int? = nil,
        seed: UInt32 = 0
    ) throws -> CalligrapherWriter {
        try CalligrapherWriter(model: self, cell: cell, text: text, bias: bias, style: style, seed: seed)
    }

    /// Generate a full line synchronously.
    public func write(
        _ text: String,
        bias: Double = 0.75,
        style: Int? = nil,
        seed: UInt32 = 0
    ) throws -> [StrokeOffset] {
        let writer = try writer(text, bias: bias, style: style, seed: seed)
        var offsets: [StrokeOffset] = []
        while let offset = writer.step() {
            offsets.append(offset)
        }
        return offsets
    }
}

public final class CalligrapherWriter {
    public let text: String
    public let bias: Double
    public let style: Int
    public private(set) var done = false

    private let cell: CalligrapherCell
    private var rng: Rng
    private let state: CellState
    private let encoded: RawBuffer<Float>
    private let charCount: Int
    private let maxSteps: Int
    private var steps = 0

    init(model: CalligrapherModel, cell: CalligrapherCell, text: String, bias: Double, style: Int?, seed: UInt32) throws {
        self.text = text
        self.bias = bias
        self.cell = cell
        // The reference picks a random style with one uniform draw before
        // anything else; matching that keeps null-style runs reproducible.
        var rng = Rng(seed: seed)
        let chosen = style ?? Int((Double(model.assets.styleCount) * rng.uniform()).rounded(.down))
        self.rng = rng
        guard chosen >= 0, chosen < model.assets.styleCount else {
            throw CalligrapherError.unknownStyle(chosen)
        }
        self.style = chosen

        let ids = model.encode(text)
        self.charCount = ids.count
        self.encoded = RawBuffer(copying: cell.encodeText(ids))
        self.state = cell.initialState(charCount: charCount, styleIndex: chosen)
        self.maxSteps = CalligrapherModel.stepsPerCharacter * text.count
    }

    /// Advance one timestep. Returns the sampled offset, or nil once done.
    public func step() -> StrokeOffset? {
        if done { return nil }
        let termination = cell.step(state, encoded: encoded.p, charCount: charCount)
        let offset = cell.sample(state, bias: bias, rng: &rng)
        steps += 1
        if steps > maxSteps || termination > 0.5 {
            done = true
            return nil
        }
        let input = state.input.p
        input[0] = offset.dx
        input[1] = offset.dy
        input[2] = offset.pen
        return StrokeOffset(dx: Double(offset.dx), dy: Double(offset.dy), eos: offset.pen == 1)
    }
}
