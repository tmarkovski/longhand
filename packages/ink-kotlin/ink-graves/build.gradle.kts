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

// The committed weights (the same binary the web app serves and the Swift
// target bundles) ship inside the JAR, so consumers who add the package
// from git load the model with no downloads or file wrangling.
sourceSets.main {
    resources.srcDir(rootDir.resolve("packages/ink-graves/assets"))
}

dependencies {
    api(project(":ink-core"))
    // The CALW container carries a JSON header describing its tensors.
    implementation(libs.kotlinx.serialization.json)
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    systemProperty("longhand.repoRoot", rootDir.absolutePath)
    // The MDN math dominates; keep golden replays quick even under -ea.
    maxHeapSize = "1g"
}

publishing {
    publications {
        create<MavenPublication>("maven") { from(components["java"]) }
    }
}
