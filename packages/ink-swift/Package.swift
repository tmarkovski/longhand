// swift-tools-version: 6.0
// Native Swift port of the Longhand ink engines. InkGraves mirrors
// packages/ink-graves (the TS port of the MLX reference) and consumes the
// same CALW weights container and golden fixtures, so parity is checked
// against the exact artifacts the web app ships.
import PackageDescription

let package = Package(
    name: "ink-swift",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "InkCore", targets: ["InkCore"]),
        .library(name: "InkGraves", targets: ["InkGraves"]),
        .library(name: "InkCalligrapher", targets: ["InkCalligrapher"]),
    ],
    targets: [
        .target(name: "InkCore"),
        .target(name: "InkGraves", dependencies: ["InkCore"]),
        .target(name: "InkCalligrapher", dependencies: ["InkCore"]),
        .testTarget(name: "InkGravesTests", dependencies: ["InkGraves"]),
        .testTarget(name: "InkCalligrapherTests", dependencies: ["InkCalligrapher"]),
    ]
)
