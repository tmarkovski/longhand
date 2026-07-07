package com.trylonghand.longhand.example

import com.trylonghand.ink.calligrapher.CalligrapherModel
import com.trylonghand.ink.calligrapher.bundledCalligrapherWeights
import com.trylonghand.ink.calligrapher.parseCalligrapherWeights
import com.trylonghand.ink.core.InkStroke
import com.trylonghand.ink.core.offsetsToLine
import com.trylonghand.ink.graves.GravesModel
import com.trylonghand.ink.graves.bundledGravesWeights
import com.trylonghand.ink.graves.parseModelAssets
import com.trylonghand.ink.render.alignLine
import com.trylonghand.ink.render.polishLine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The two handwriting engines, mirroring the web app's model picker. */
enum class Engine(val label: String) {
    CALLIGRAPHER("calligrapher"),
    LONGHAND("longhand");

    /** Label for the null style: the engine's unstyled/random mode. */
    val defaultStyleName: String
        get() = when (this) {
            CALLIGRAPHER -> "random"
            LONGHAND -> "freehand"
        }
}

/**
 * Owns the models and keeps generation off the main thread. The weights
 * come from the engine modules' bundled resources (the same committed
 * binaries the web app syncs into its public/model directory), so the app
 * bundles nothing of its own.
 */
class InkEngine {
    private var calligrapher: CalligrapherModel? = null
    private var graves: GravesModel? = null

    /** Loads the engine's model and returns the style ids to offer. */
    suspend fun prepare(engine: Engine): List<Int> = withContext(Dispatchers.Default) {
        when (engine) {
            Engine.CALLIGRAPHER -> {
                loadedCalligrapher()
                CalligrapherModel.exposedStyles
            }
            Engine.LONGHAND -> loadedGraves().styles
        }
    }

    /**
     * Generate a line and prepare it for the engine's renderer, like the
     * web app's layout step: the ribbon look levels the baseline only
     * (leveling is a pure rotation, so the ribbon's speed-shaped widths
     * are untouched); the pen look also smooths sampling jitter first.
     */
    suspend fun write(
        engine: Engine,
        text: String,
        bias: Double,
        style: Int?,
        seed: UInt,
    ): List<InkStroke> = withContext(Dispatchers.Default) {
        when (engine) {
            Engine.CALLIGRAPHER ->
                alignLine(offsetsToLine(loadedCalligrapher().write(text, bias = bias, style = style, seed = seed)))
            Engine.LONGHAND ->
                polishLine(offsetsToLine(loadedGraves().write(text, bias = bias, style = style, seed = seed)))
        }
    }

    private fun loadedCalligrapher(): CalligrapherModel =
        calligrapher ?: CalligrapherModel(parseCalligrapherWeights(bundledCalligrapherWeights()))
            .also { calligrapher = it }

    private fun loadedGraves(): GravesModel =
        graves ?: GravesModel(parseModelAssets(bundledGravesWeights()))
            .also { graves = it }
}
