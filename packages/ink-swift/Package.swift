// swift-tools-version: 6.0
// Native Swift port of the Longhand ink engines. InkGraves mirrors
// packages/ink-graves (the TS port of the MLX reference) and consumes the
// same CALW weights container and golden fixtures, so parity is checked
// against the exact artifacts the web app ships.
import PackageDescription

/// Optimize the engine targets even in debug configuration, like a Cargo
/// profile override: -Onone runs the samplers an order of magnitude below
/// release, and nobody debugs a transliterated matvec. Swift has no
/// fast-math, so optimization does not change floating-point results (the
/// parity suites pin that down). Note unsafeFlags means this package can
/// only be consumed as a local/path dependency, which is how the repo and
/// the example app use it.
let engineSwiftSettings: [SwiftSetting] = [
    .unsafeFlags(["-O"], .when(configuration: .debug))
]

let package = Package(
    name: "ink-swift",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "InkCore", targets: ["InkCore"]),
        .library(name: "InkGraves", targets: ["InkGraves"]),
        .library(name: "InkCalligrapher", targets: ["InkCalligrapher"]),
        .library(name: "InkRender", targets: ["InkRender"]),
    ],
    targets: [
        .target(name: "InkCore"),
        .target(name: "InkGraves", dependencies: ["InkCore"], swiftSettings: engineSwiftSettings),
        .target(name: "InkCalligrapher", dependencies: ["InkCore"], swiftSettings: engineSwiftSettings),
        .target(name: "InkRender", dependencies: ["InkCore"]),
        .testTarget(name: "InkGravesTests", dependencies: ["InkGraves"]),
        .testTarget(name: "InkCalligrapherTests", dependencies: ["InkCalligrapher"]),
        .testTarget(name: "InkRenderTests", dependencies: ["InkRender"]),
    ]
)
