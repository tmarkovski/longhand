// swift-tools-version: 6.0
// Native Swift port of the Longhand ink engines, mirroring the TypeScript
// packages (InkGraves ⇄ ink-graves, etc.) and held to the same golden
// fixtures, so parity is checked against the exact artifacts the web app
// ships.
//
// The manifest lives at the repo root so the repo itself is a SwiftPM
// dependency: .package(url: "https://github.com/tmarkovski/longhand", …).
// Remote consumption is also why there are no unsafeFlags here (SwiftPM
// rejects them in anything but a local path dependency) — which means
// debug builds run the engines at -Onone, an order of magnitude below
// release. Run `swift test -c release` for the fast loop; the perf gate
// compiles out of debug builds.
import PackageDescription

let package = Package(
    name: "longhand",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "InkCore", targets: ["InkCore"]),
        .library(name: "InkGraves", targets: ["InkGraves"]),
        .library(name: "InkCalligrapher", targets: ["InkCalligrapher"]),
        .library(name: "InkRender", targets: ["InkRender"]),
    ],
    targets: [
        .target(
            name: "InkCore",
            path: "packages/ink-swift/Sources/InkCore"
        ),
        .target(
            name: "InkGraves",
            dependencies: ["InkCore"],
            path: "packages/ink-swift/Sources/InkGraves",
            resources: [.copy("../../../ink-graves/assets/graves-v1.bin")]
        ),
        .target(
            name: "InkCalligrapher",
            dependencies: ["InkCore"],
            path: "packages/ink-swift/Sources/InkCalligrapher",
            resources: [.copy("../../../ink-calligrapher/assets/calligrapher-v1.bin")]
        ),
        .target(
            name: "InkRender",
            dependencies: ["InkCore"],
            path: "packages/ink-swift/Sources/InkRender"
        ),
        .testTarget(
            name: "InkGravesTests",
            dependencies: ["InkGraves"],
            path: "packages/ink-swift/Tests/InkGravesTests"
        ),
        .testTarget(
            name: "InkCalligrapherTests",
            dependencies: ["InkCalligrapher"],
            path: "packages/ink-swift/Tests/InkCalligrapherTests"
        ),
        .testTarget(
            name: "InkRenderTests",
            dependencies: ["InkRender"],
            path: "packages/ink-swift/Tests/InkRenderTests"
        ),
    ]
)
