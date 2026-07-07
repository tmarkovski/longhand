plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `maven-publish`
}

group = "com.trylonghand"
version = "0.1.0"

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
    api(project(":ink-core"))
    // JSON is test-only here: the golden fixtures are JSON files.
    testImplementation(kotlin("test"))
    testImplementation(libs.kotlinx.serialization.json)
}

tasks.test {
    useJUnitPlatform()
    systemProperty("longhand.repoRoot", rootDir.absolutePath)
}

publishing {
    publications {
        create<MavenPublication>("maven") { from(components["java"]) }
    }
}
