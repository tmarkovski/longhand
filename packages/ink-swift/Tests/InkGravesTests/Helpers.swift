/// Test fixtures shared with the TS engine: the CALW weights come from the
/// target's bundled resource, and the MLX-generated golden vectors plus the
/// f32 reference container live in packages/ink-graves/test/goldens
/// (gitignored; regenerate with `pnpm gen:goldens` / `pnpm gen:weights`),
/// located here relative to this source file.

import Foundation
import InkGraves

private let packagesDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // InkGravesTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // ink-swift
    .deletingLastPathComponent() // packages

enum Fixtures {
    /// The shipped asset (q8 weights + baked primed states), loaded through
    /// the public bundled-resource accessor, so the suite also proves the
    /// bundle ships the canonical committed weights
    /// (packages/ink-graves/assets).
    static let assets: ModelAssets = {
        do {
            return try parseModelAssets(bundledGravesWeights())
        } catch {
            fatalError("failed to load bundled graves weights: \(error)")
        }
    }()

    /// The float32 reference fixture: MLX golden parity only holds against
    /// unquantized weights.
    static let referenceAssets: ModelAssets = {
        let url = packagesDirectory.appendingPathComponent("ink-graves/test/goldens/graves-f32.bin")
        do {
            return try parseModelAssets(Data(contentsOf: url))
        } catch {
            fatalError("failed to load the f32 reference weights (regenerate with `pnpm gen:weights`): \(error)")
        }
    }()
}

struct GoldenStep: Decodable {
    let kappa: [Float]
    let phi: [Float]
    let phiArgmax: Int
    let window: [Float]
    let pi: [Float]
    let muX: [Float]
    let muY: [Float]
    let sigmaX: [Float]
    let sigmaY: [Float]
    let rho: [Float]
    let eos: Float
}

struct GoldenCase: Decodable {
    let name: String
    let charsText: String
    let encoded: [Int32]
    let charLen: Int
    let bias: Double
    let inputs: [[Float]]
    let steps: [GoldenStep]
}

func loadGolden(_ name: String) throws -> GoldenCase {
    let url = packagesDirectory.appendingPathComponent("ink-graves/test/goldens/\(name).json")
    return try JSONDecoder().decode(GoldenCase.self, from: Data(contentsOf: url))
}

struct Deviation {
    var score = 0.0
    var index = -1
    var actual: Float = 0
    var expected: Float = 0
}

/// Largest |a-b| scaled by (atol + rtol * |b|); <= 1 means within tolerance.
func worstDeviation(_ actual: [Float], _ expected: [Float], atol: Double, rtol: Double) -> Deviation {
    var worst = Deviation()
    for i in 0 ..< expected.count {
        let score = Double(abs(actual[i] - expected[i])) / (atol + rtol * Double(abs(expected[i])))
        if score > worst.score {
            worst = Deviation(score: score, index: i, actual: actual[i], expected: expected[i])
        }
    }
    return worst
}
