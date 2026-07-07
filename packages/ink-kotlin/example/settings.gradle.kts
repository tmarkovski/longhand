// The Android example app is its own Gradle build, compositing the repo
// root build in — the same build remote consumers get from the GitHub URL —
// so the app consumes com.trylonghand:ink-* exactly like a third-party app
// would, and the root build stays pure JVM (no Android SDK required to use
// or test the libraries).
pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
    versionCatalogs {
        create("libs") {
            from(files("../../../gradle/libs.versions.toml"))
        }
    }
}

rootProject.name = "longhand-example"

includeBuild("../../..")
include(":app")
