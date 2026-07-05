import Foundation
import InkCalligrapher
import InkCore
import InkGraves

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
}

/// Owns the (non-Sendable) models so generation runs off the main actor.
/// Both weight files ship in the app bundle: the project references the
/// same binaries the web app serves.
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

    func write(_ engine: Engine, text: String, bias: Double, style: Int?, seed: UInt32) throws -> [InkStroke] {
        switch engine {
        case .calligrapher:
            return offsetsToLine(try loadedCalligrapher().write(text, bias: bias, style: style, seed: seed))
        case .longhand:
            return offsetsToLine(try loadedGraves().write(text, bias: bias, style: style, seed: seed))
        }
    }

    private func bundledWeights(_ resource: String) throws -> Data {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "bin") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [
                NSLocalizedDescriptionKey: "\(resource).bin is not in the app bundle"
            ])
        }
        return try Data(contentsOf: url)
    }

    private func loadedCalligrapher() throws -> CalligrapherModel {
        if let calligrapher { return calligrapher }
        let loaded = try CalligrapherModel(assets: parseCalligrapherWeights(bundledWeights("calligrapher-v1")))
        calligrapher = loaded
        return loaded
    }

    private func loadedGraves() throws -> GravesModel {
        if let graves { return graves }
        let loaded = try GravesModel(assets: parseModelAssets(bundledWeights("graves-v1")))
        graves = loaded
        return loaded
    }
}
