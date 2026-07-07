package com.trylonghand.ink.calligrapher

/**
 * The weights committed with the repo (packages/ink-calligrapher/assets),
 * bundled into this module's JAR as a resource — consumers who add the
 * package load the model with no downloads or file wrangling:
 *
 *     val model = CalligrapherModel(parseCalligrapherWeights(bundledCalligrapherWeights()))
 */
public fun bundledCalligrapherWeights(): ByteArray {
    val stream = object {}.javaClass.getResourceAsStream("/calligrapher-v1.bin")
        ?: throw CalligrapherError.MissingBundledWeights()
    return stream.use { it.readBytes() }
}
