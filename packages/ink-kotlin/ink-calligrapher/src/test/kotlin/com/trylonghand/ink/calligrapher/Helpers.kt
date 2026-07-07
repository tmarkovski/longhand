/// Fixtures shared with the TS engine: the weights are the committed
/// package asset the web app also serves, and the parity fixtures are
/// dumped from the TS engine (which test/parity.test.ts holds bit-compatible
/// with the vendored calligrapher.ai reference) by
/// packages/ink-calligrapher/scripts/export_swift_goldens.ts.

package com.trylonghand.ink.calligrapher

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val repoRoot = File(System.getProperty("longhand.repoRoot"))

private val json = Json { ignoreUnknownKeys = true }

internal object Fixtures {
    /**
     * Loaded through the public bundled-resource accessor, so the parity
     * suite also proves the JAR ships the canonical committed weights
     * (packages/ink-calligrapher/assets) — drifted bytes could not match
     * the TS-dumped fixtures.
     */
    val assets: CalligrapherAssets by lazy {
        parseCalligrapherWeights(bundledCalligrapherWeights())
    }
}

@Serializable
internal class ParityCase(
    val text: String,
    val bias: Double,
    val style: Int? = null,
    val seed: UInt,
    val offsets: List<List<Double>>,
)

internal fun loadParityCases(): List<ParityCase> {
    val file = repoRoot.resolve("packages/ink-calligrapher/test/goldens/swift-parity.json")
    check(file.exists()) {
        "missing ${file.path} — run scripts/export_swift_goldens.ts in packages/ink-calligrapher"
    }
    return json.decodeFromString(file.readText())
}
