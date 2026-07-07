/// Test fixtures shared with the TS engine: the CALW weights come from the
/// module's bundled resource, and the MLX-generated golden vectors plus the
/// f32 reference container live in packages/ink-graves/test/goldens
/// (gitignored; regenerate with `pnpm gen:goldens` / `pnpm gen:weights`),
/// located here via the longhand.repoRoot system property.

package com.trylonghand.ink.graves

import java.io.File
import kotlin.math.abs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val packagesDirectory: File =
    File(System.getProperty("longhand.repoRoot")).resolve("packages")

internal object Fixtures {
    /**
     * The shipped asset (q8 weights + baked primed states), loaded through
     * the public bundled-resource accessor, so the suite also proves the
     * bundle ships the canonical committed weights
     * (packages/ink-graves/assets).
     */
    val assets: ModelAssets by lazy {
        try {
            parseModelAssets(bundledGravesWeights())
        } catch (error: Exception) {
            throw IllegalStateException("failed to load bundled graves weights: $error", error)
        }
    }

    /**
     * The float32 reference fixture: MLX golden parity only holds against
     * unquantized weights.
     */
    val referenceAssets: ModelAssets by lazy {
        val file = packagesDirectory.resolve("ink-graves/test/goldens/graves-f32.bin")
        try {
            parseModelAssets(file.readBytes())
        } catch (error: Exception) {
            throw IllegalStateException(
                "failed to load the f32 reference weights (regenerate with `pnpm gen:weights`): $error",
                error,
            )
        }
    }
}

@Serializable
internal class GoldenStep(
    val kappa: FloatArray,
    val phi: FloatArray,
    val phiArgmax: Int,
    val window: FloatArray,
    val pi: FloatArray,
    val muX: FloatArray,
    val muY: FloatArray,
    val sigmaX: FloatArray,
    val sigmaY: FloatArray,
    val rho: FloatArray,
    val eos: Float,
)

@Serializable
internal class GoldenCase(
    val name: String,
    val charsText: String,
    val encoded: IntArray,
    val charLen: Int,
    val bias: Double,
    val inputs: List<FloatArray>,
    val steps: List<GoldenStep>,
)

private val goldenJson = Json { ignoreUnknownKeys = true }

internal fun loadGolden(name: String): GoldenCase {
    val file = packagesDirectory.resolve("ink-graves/test/goldens/$name.json")
    return goldenJson.decodeFromString(GoldenCase.serializer(), file.readText())
}

internal class Deviation(
    val score: Double = 0.0,
    val index: Int = -1,
    val actual: Float = 0f,
    val expected: Float = 0f,
)

/** Largest |a-b| scaled by (atol + rtol * |b|); <= 1 means within tolerance. */
internal fun worstDeviation(actual: FloatArray, expected: FloatArray, atol: Double, rtol: Double): Deviation {
    var worst = Deviation()
    for (i in expected.indices) {
        val score = abs(actual[i] - expected[i]).toDouble() / (atol + rtol * abs(expected[i]).toDouble())
        if (score > worst.score) {
            worst = Deviation(score = score, index = i, actual = actual[i], expected = expected[i])
        }
    }
    return worst
}
