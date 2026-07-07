plugins {
    alias(libs.plugins.kotlin.jvm)
    `maven-publish`
}

group = "com.trylonghand"
version = "0.1.0"

// Java 11 bytecode: runs anywhere an Android app's own toolchain does,
// while the build itself runs on whatever modern JDK is present (e.g.
// Android Studio's bundled JBR) — no toolchain provisioning.
kotlin {
    explicitApi()
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11
    }
}
java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    // Golden fixtures live in the sibling TS packages; tests resolve them
    // from the repo root (the root settings file makes rootDir the repo).
    systemProperty("longhand.repoRoot", rootDir.absolutePath)
}

publishing {
    publications {
        create<MavenPublication>("maven") { from(components["java"]) }
    }
}
