/// Fixtures shared with the web app and the TS engine: the weights are the
/// same calligrapher-v1.bin the site serves, and the parity fixtures are
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
    static let assets: CalligrapherAssets = {
        let url = repoRoot.appendingPathComponent("apps/web/public/model/calligrapher-v1.bin")
        guard let data = try? Data(contentsOf: url) else {
            fatalError("missing \(url.path) — the web app's model download provides it")
        }
        do {
            return try parseCalligrapherWeights(data)
        } catch {
            fatalError("failed to parse \(url.path): \(error)")
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
