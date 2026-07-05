import Foundation
import InkCalligrapher
import InkCore
import InkGraves
import InkRender

/// The two handwriting engines, mirroring the web app's model picker.
enum Engine: String, CaseIterable, Identifiable {
    case calligrapher
    case longhand

    var id: String { rawValue }

    /// Label for the nil style: the engine's unstyled/random mode.
    var defaultStyleName: String {
        switch self {
        case .calligrapher: return "random"
        case .longhand: return "freehand"
        }
    }

    /// Each engine's tuned ink look, mirroring the web app's defaults:
    /// the calligrapher paints speed-shaped filled ribbons, longhand
    /// strokes a smoothed line with speed-based pen widths.
    var renderer: InkRenderer {
        switch self {
        case .calligrapher: return .ribbon
        case .longhand: return .pen
        }
    }
}

/// Owns the (non-Sendable) models so generation runs off the main actor.
/// The weights come from the engine targets' bundled resources (the same
/// committed binaries the web app syncs into its public/model directory),
/// so the app bundles nothing of its own.
actor InkEngine {
    private var calligrapher: CalligrapherModel?
    private var graves: GravesModel?

    /// Loads the engine's model and returns the style ids to offer.
    func prepare(_ engine: Engine) throws -> [Int] {
        switch engine {
        case .calligrapher:
            _ = try loadedCalligrapher()
            return CalligrapherModel.exposedStyles
        case .longhand:
            return try loadedGraves().styles
        }
    }

    /// Generate a line and prepare it for the engine's renderer, like the
    /// web app's layout step: the ribbon look levels the baseline only
    /// (leveling is a pure rotation, so the ribbon's speed-shaped widths
    /// are untouched); the pen look also smooths sampling jitter first.
    func write(_ engine: Engine, text: String, bias: Double, style: Int?, seed: UInt32) throws -> [InkStroke] {
        switch engine {
        case .calligrapher:
            return alignLine(offsetsToLine(try loadedCalligrapher().write(text, bias: bias, style: style, seed: seed)))
        case .longhand:
            return polishLine(offsetsToLine(try loadedGraves().write(text, bias: bias, style: style, seed: seed)))
        }
    }

    private func loadedCalligrapher() throws -> CalligrapherModel {
        if let calligrapher { return calligrapher }
        let loaded = try CalligrapherModel(assets: parseCalligrapherWeights(bundledCalligrapherWeights()))
        calligrapher = loaded
        return loaded
    }

    private func loadedGraves() throws -> GravesModel {
        if let graves { return graves }
        let loaded = try GravesModel(assets: parseModelAssets(bundledGravesWeights()))
        graves = loaded
        return loaded
    }
}
