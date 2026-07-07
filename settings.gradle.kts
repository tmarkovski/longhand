// Kotlin/JVM port of the Longhand ink engines, mirroring the TypeScript
// packages (ink-graves ⇄ InkGraves, etc.) and held to the same golden
// fixtures. The settings file lives at the repo root for the same reason
// Package.swift does: so the repo itself is a Gradle dependency —
// consumable as a source dependency (sourceControl { gitRepository(…) })
// or built by JitPack straight from the GitHub URL.
//
// Only the pure-JVM library modules live in this build; the Android
// example app is its own build (packages/ink-kotlin/example) that
// composites this one in via includeBuild, so consuming the libraries
// never requires the Android SDK.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "longhand"

include(":ink-core", ":ink-graves", ":ink-calligrapher", ":ink-render")
project(":ink-core").projectDir = file("packages/ink-kotlin/ink-core")
project(":ink-graves").projectDir = file("packages/ink-kotlin/ink-graves")
project(":ink-calligrapher").projectDir = file("packages/ink-kotlin/ink-calligrapher")
project(":ink-render").projectDir = file("packages/ink-kotlin/ink-render")
