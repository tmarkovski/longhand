# Longhand on Android and the JVM

`packages/ink-kotlin` is the Kotlin port of the four TypeScript packages,
the same way `packages/ink-swift` is the Swift one: `ink-core`,
`ink-graves`, `ink-calligrapher`, and `ink-render`, held to the same golden
fixtures and parity-locked to the float. A pinned seed writes the same
strokes as the web app and the Swift port.

The library modules are pure Kotlin/JVM (no Android dependency anywhere),
compiled to Java 11 bytecode with minSdk-26-friendly APIs. They run in
Android apps and on desktop JVMs alike, and the engine JARs bundle their
weights as resources (`graves-v2.bin` 3.6 MB, `calligrapher-v1.bin`
2.6 MB), so `bundledGravesWeights()` / `bundledCalligrapherWeights()` work
with nothing to download or copy.

## Referencing the repo by GitHub URL

Gradle has no direct SwiftPM-style git dependency, but the repo is set up
so the GitHub URL is still the only address you need. The root
`settings.gradle.kts` plays the role `Package.swift` does for SwiftPM: the
repo itself is a valid Gradle build.

**JitPack (the everyday path).** JitPack clones the GitHub URL, runs the
root build (`jitpack.yml` pins JDK 21 and skips tests, whose golden
fixtures are gitignored), and serves each module as a Maven artifact:

```kotlin
// settings.gradle.kts or build.gradle.kts
repositories { maven("https://jitpack.io") }

// build.gradle.kts: pick the engines you ship; each bundles its weights
dependencies {
    implementation("com.github.tmarkovski.longhand:ink-calligrapher:main-SNAPSHOT")
    implementation("com.github.tmarkovski.longhand:ink-render:main-SNAPSHOT")
}
```

`main-SNAPSHOT` tracks the branch; pin a tag or a short commit hash to
stay put. The first resolve of a new version takes a minute while JitPack
builds it; after that it is cached on their CDN.

**Gradle source dependencies (native git).** Because the settings file is
at the repo root, Gradle's own git support also works, with no third
party involved:

```kotlin
// settings.gradle.kts
sourceControl {
    gitRepository(uri("https://github.com/tmarkovski/longhand")) {
        producesModule("com.trylonghand:ink-calligrapher")
        producesModule("com.trylonghand:ink-render")
        producesModule("com.trylonghand:ink-core")
    }
}
```

with normal `com.trylonghand:<module>:<version>` dependencies in the build
file. Gradle clones and builds from source on your machine.

**Submodule / local checkout (what the example app does).** Add the repo
as a git submodule and composite it in; dependency substitution maps the
`com.trylonghand` coordinates onto the local build:

```kotlin
// settings.gradle.kts
includeBuild("third_party/longhand")
```

## The example app

`packages/ink-kotlin/example` is a Jetpack Compose app mirroring the
SwiftUI example: engine and style pickers, Write/Replay, and a canvas
that replays strokes at authentic pen pace (8 ms per model timestep).
The calligrapher gets the ribbon look, longhand the pen look.

It is deliberately its own Gradle build that consumes the libraries via
`includeBuild("../../..")`, exactly like a third-party app would. That
also keeps the root build free of the Android Gradle plugin, so using or
testing the libraries never requires an Android SDK. Open the `example`
directory in Android Studio (not the repo root), or:

```sh
cd packages/ink-kotlin/example
./gradlew :app:assembleDebug          # needs ANDROID_HOME or local.properties
```

The app uses AGP 9's built-in Kotlin; only the Compose compiler plugin is
applied on top. Versions for both builds are pinned in one place,
`gradle/libs.versions.toml` at the repo root.

## Developing the port

```sh
./gradlew test        # at the repo root; runs all four modules' suites
```

Run `pnpm gen:goldens` and `pnpm gen:weights` first (once). The graves
golden tests replay MLX-generated vectors against the gitignored float32
reference container, and the calligrapher/render parity tests read
TS-dumped fixtures from the sibling packages. The suites mirror the Swift
ones case for case; unlike Swift there is no debug/release split to think
about, since the JIT runs the engines at full speed (hundreds of steps
per second, against a 125 steps/sec gate).

The toolchain runs on any JDK 17+; Android Studio's bundled JetBrains
Runtime works out of the box (`JAVA_HOME=/Applications/Android
Studio.app/Contents/jbr/Contents/Home`). Publishing is plain
`maven-publish`: `./gradlew publishToMavenLocal` drops the four modules
into `~/.m2`, which is also exactly what JitPack runs, so a green local
publish means the remote one builds too.
