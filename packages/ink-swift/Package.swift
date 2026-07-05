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
        .library(name: "InkGraves", targets: ["InkGraves"])
    ],
    targets: [
        .target(name: "InkGraves"),
        .testTarget(name: "InkGravesTests", dependencies: ["InkGraves"]),
    ]
)
