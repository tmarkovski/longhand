import Foundation
import InkGraves

/// Owns the (non-Sendable) model so generation runs off the main actor.
/// The weights ship in the app bundle: the project references the same
/// graves-v1.bin the web app uses, from packages/ink-graves/assets.
actor InkEngine {
    private var model: GravesModel?

    func prepare() throws {
        _ = try loadedModel()
    }

    func write(_ text: String, bias: Double, seed: UInt32) throws -> [InkStroke] {
        offsetsToLine(try loadedModel().write(text, bias: bias, seed: seed))
    }

    private func loadedModel() throws -> GravesModel {
        if let model { return model }
        guard let url = Bundle.main.url(forResource: "graves-v1", withExtension: "bin") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [
                NSLocalizedDescriptionKey: "graves-v1.bin is not in the app bundle"
            ])
        }
        let loaded = try GravesModel(assets: parseModelAssets(Data(contentsOf: url)))
        model = loaded
        return loaded
    }
}
