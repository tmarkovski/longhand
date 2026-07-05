/// Fixtures shared with the TS ink-render package: test/golden.json pins
/// smoothing/alignment to scipy/numpy, and test/goldens/swift-parity.json
/// (dumped by scripts/export_swift_goldens.ts) carries the TS package's
/// own geometry outputs over to this port.

import Foundation
import InkCore

private let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // InkRenderTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // ink-swift
    .deletingLastPathComponent() // packages
    .deletingLastPathComponent() // repo root

func fixtureData(_ relativePath: String, hint: String) -> Data {
    let url = repoRoot.appendingPathComponent(relativePath)
    guard let data = try? Data(contentsOf: url) else {
        fatalError("missing \(url.path) — \(hint)")
    }
    return data
}

struct ScipyGolden: Decodable {
    struct Savgol: Decodable {
        let input: [Double]
        let expected: [Double]
    }
    struct Align: Decodable {
        let input: [[Double]]
        let expected: [[Double]]
    }
    let savgol: [Savgol]
    let align: Align
}

func loadScipyGolden() throws -> ScipyGolden {
    try JSONDecoder().decode(
        ScipyGolden.self,
        from: fixtureData(
            "packages/ink-render/test/golden.json",
            hint: "committed with the TS ink-render package"
        )
    )
}

struct RenderParity: Decodable {
    struct Layout: Decodable {
        let width: Double
        let height: Double
        let placed: [[[Double]]]
    }
    struct Touchdown: Decodable {
        let x: Double
        let y: Double
        let r: Double
        let index: Int
    }
    struct Run: Decodable {
        let width: Double
        let startIndex: Int
        let endIndex: Int
        let length: Double
        let pointCount: Int
    }
    struct StrokeParts: Decodable {
        let touchdown: Touchdown
        let runs: [Run]
    }
    struct Ribbon: Decodable {
        let top: [[Double]]
        let bottom: [[Double]]
    }
    let line: [[[Double]]]
    let polished: [[[Double]]]
    let penWidths: [[Double]]
    let layout: Layout
    let penRuns: [StrokeParts]
    let ribbons: [Ribbon?]
}

func loadRenderParity() throws -> RenderParity {
    try JSONDecoder().decode(
        RenderParity.self,
        from: fixtureData(
            "packages/ink-render/test/goldens/swift-parity.json",
            hint: "run scripts/export_swift_goldens.ts in packages/ink-render"
        )
    )
}

func strokesOf(_ raw: [[[Double]]]) -> [InkStroke] {
    raw.map { stroke in
        InkStroke(points: stroke.map { SIMD2($0[0], $0[1]) })
    }
}

/// Worst absolute coordinate deviation between two lines (must have
/// identical structure; returns .infinity on shape mismatch).
func worstDeviation(_ actual: [InkStroke], _ expected: [[[Double]]]) -> Double {
    guard actual.count == expected.count else { return .infinity }
    var worst = 0.0
    for (stroke, expectedPoints) in zip(actual, expected) {
        guard stroke.points.count == expectedPoints.count else { return .infinity }
        for (point, expectedPoint) in zip(stroke.points, expectedPoints) {
            worst = max(worst, abs(point.x - expectedPoint[0]), abs(point.y - expectedPoint[1]))
        }
    }
    return worst
}
