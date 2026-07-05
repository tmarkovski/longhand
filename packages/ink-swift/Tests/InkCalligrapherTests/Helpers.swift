/// Fixtures shared with the TS engine: the weights are the committed
/// package asset the web app also serves, and the parity fixtures are
/// dumped from the TS engine (which test/parity.test.ts holds bit-compatible
/// with the vendored calligrapher.ai reference) by
/// packages/ink-calligrapher/scripts/export_swift_goldens.ts.

import Foundation
import InkCalligrapher

private let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // InkCalligrapherTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // ink-swift
    .deletingLastPathComponent() // packages
    .deletingLastPathComponent() // repo root

enum Fixtures {
    /// Loaded through the public bundled-resource accessor, so the parity
    /// suite also proves the bundle ships the canonical committed weights
    /// (packages/ink-calligrapher/assets) — drifted bytes could not match
    /// the TS-dumped fixtures.
    static let assets: CalligrapherAssets = {
        do {
            return try parseCalligrapherWeights(bundledCalligrapherWeights())
        } catch {
            fatalError("failed to load bundled calligrapher weights: \(error)")
        }
    }()
}

struct ParityCase: Decodable {
    let text: String
    let bias: Double
    let style: Int?
    let seed: UInt32
    let offsets: [[Double]]
}

func loadParityCases() throws -> [ParityCase] {
    let url = repoRoot.appendingPathComponent("packages/ink-calligrapher/test/goldens/swift-parity.json")
    guard let data = try? Data(contentsOf: url) else {
        fatalError("missing \(url.path) — run scripts/export_swift_goldens.ts in packages/ink-calligrapher")
    }
    return try JSONDecoder().decode([ParityCase].self, from: data)
}
