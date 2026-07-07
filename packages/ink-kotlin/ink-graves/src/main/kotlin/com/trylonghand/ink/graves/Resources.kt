package com.trylonghand.ink.graves

/**
 * The weights committed with the repo (packages/ink-graves/assets),
 * bundled into this module as a JAR resource — consumers who add the
 * package from git load the model with no downloads or file wrangling:
 *
 *     val model = GravesModel(parseModelAssets(bundledGravesWeights()))
 */
public fun bundledGravesWeights(): ByteArray {
    val stream = object {}.javaClass.getResourceAsStream("/graves-v2.bin")
        ?: throw GravesError.MissingBundledWeights()
    return stream.use { it.readBytes() }
}
